// Sign-in failures: a key the API gateway refuses must never read as a wrong password, and
// GoTrue's refusals get the same copy as the iPhone and Android apps. The bodies below are the
// servers' real shapes (the first is what every sign-in got after 2026-10-21).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const signIn = require('../renderer/sign-in-errors')

const LEGACY_DISABLED = {
  message: 'Legacy API keys are disabled',
  hint: 'Your legacy API keys (anon, service_role) were disabled on 2026-10-21T22:51:19.754858+00:00. Re-enable them in the Supabase dashboard, or use the new publishable and secret API keys.',
}

test('the gateway refusing the app key says to install the latest version', () => {
  for (const [status, body] of [
    [401, LEGACY_DISABLED],
    [401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }],
    [401, { message: 'No API key found in request' }],
    [403, LEGACY_DISABLED],
  ]) {
    assert.equal(signIn.isAppKeyRefused(status, body), true, body.message)
    assert.equal(signIn.signInFailureMessage(status, body), signIn.APP_KEY_REFUSED)
  }
})

test('only the gateway shape counts as a refused key', () => {
  assert.equal(signIn.isAppKeyRefused(400, LEGACY_DISABLED), false)
  assert.equal(signIn.isAppKeyRefused(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid api key claim' }), false)
  assert.equal(signIn.isAppKeyRefused(401, { message: 'JWT expired' }), false)
  assert.equal(signIn.isAppKeyRefused(401, {}), false)
  assert.equal(signIn.isAppKeyRefused(401, null), false)
})

test('wrong credentials, current and older GoTrue', () => {
  const current = signIn.signInFailureMessage(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
  assert.match(current, /^Incorrect email or password\./)
  assert.match(current, /emailed link/)
  assert.equal(signIn.signInFailureMessage(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }), current)
})

test('an unconfirmed email, current and older GoTrue', () => {
  const expected = 'Confirm your email address to finish signing in.'
  assert.equal(signIn.signInFailureMessage(400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' }), expected)
  assert.equal(signIn.signInFailureMessage(400, { error: 'invalid_grant', error_description: 'Email not confirmed' }), expected)
})

test('rate limits, outages and bans', () => {
  assert.match(signIn.signInFailureMessage(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }), /^Too many attempts/)
  assert.match(signIn.signInFailureMessage(429, {}), /^Too many attempts/)
  assert.match(signIn.signInFailureMessage(502, {}), /^Couldn't reach ForgeNotes\. Try again/)
  assert.match(signIn.signInFailureMessage(400, { code: 400, error_code: 'user_banned', msg: 'User is banned' }), /can't sign in right now/)
})

test('anything else shows the server words, or the status when it sent none', () => {
  assert.equal(signIn.signInFailureMessage(422, { code: 422, error_code: 'validation_failed', msg: 'Unable to validate email address: invalid format' }), 'Unable to validate email address: invalid format')
  assert.equal(signIn.signInFailureMessage(404, {}), 'Sign-in failed (HTTP 404).')
})
