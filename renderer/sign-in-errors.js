// Why a sign-in failed, in words a person can act on. Loaded by index.html before app.js
// (window.FnSignIn) and required by scripts/test-sign-in-errors.cjs. The wording follows the
// iPhone and Android apps (AuthError.userMessage), plus the emailed-link hint this app needs
// because it has no code sign-in of its own.
//
// Two different servers can refuse a sign-in, and they answer in different shapes:
//   - GoTrue, the auth server: {"code":400,"error_code":"invalid_credentials","msg":"…"}, or
//     {"error":"invalid_grant","error_description":"…"} from older builds.
//   - The API gateway in front of it, when it refuses this build's key before GoTrue sees the
//     request: {"message":"Legacy API keys are disabled","hint":"…"} (or "Invalid API key").
// Reading only GoTrue's fields is how this app came to say "Sign-in failed" to everyone with a
// correct password once the project's legacy keys were disabled on 2026-10-21.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.FnSignIn = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const APP_KEY_REFUSED =
    'This version of ForgeNotes Recorder can no longer connect to ForgeNotes. ' +
    'Install the latest version, then sign in again.'
  const OFFLINE = "Couldn't reach ForgeNotes. Check your internet connection and try again."
  const UNAVAILABLE = "Couldn't reach ForgeNotes. Try again in a moment."
  const INVALID_CREDENTIALS =
    'Incorrect email or password. If you usually sign in with an emailed link, ' +
    'set a password in ForgeNotes Settings on the web first.'
  const EMAIL_NOT_CONFIRMED = 'Confirm your email address to finish signing in.'
  const RATE_LIMITED = 'Too many attempts. Wait a few minutes, then try again.'
  const BANNED = "This account can't sign in right now. Contact support for help."

  // The gateway refusing the app's key: a 401 or 403 with the gateway's `message`, none of
  // GoTrue's fields, and wording about the API key. Retyping the password can never fix it.
  function isAppKeyRefused(status, data) {
    if (status !== 401 && status !== 403) return false
    const body = data || {}
    if (body.error_code || body.msg || body.error || body.error_description) return false
    return /api key/i.test(String(body.message || ''))
  }

  // `status` is the HTTP status, `data` the parsed JSON body ({} when it was not JSON).
  function signInFailureMessage(status, data) {
    const body = data || {}
    if (isAppKeyRefused(status, body)) return APP_KEY_REFUSED
    if (status === 429) return RATE_LIMITED
    if (status >= 500) return UNAVAILABLE

    const text = String(body.msg || body.error_description || body.message || '')
    switch (body.error_code) {
      case 'invalid_credentials':
        return INVALID_CREDENTIALS
      case 'email_not_confirmed':
        return EMAIL_NOT_CONFIRMED
      case 'over_request_rate_limit':
        return RATE_LIMITED
      case 'user_banned':
        return BANNED
    }
    // Older GoTrue builds carry no error_code: a 400 on the password grant is bad credentials,
    // unless it says the email is unconfirmed.
    if (!body.error_code && status === 400) {
      return /not confirmed/i.test(text) ? EMAIL_NOT_CONFIRMED : INVALID_CREDENTIALS
    }
    return text || `Sign-in failed (HTTP ${status}).`
  }

  return {
    APP_KEY_REFUSED,
    OFFLINE,
    isAppKeyRefused,
    signInFailureMessage,
  }
})
