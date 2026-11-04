// The one Supabase key a recorder build may carry: the project's PUBLIC publishable key
// (sb_publishable_…). Imported by write-production-config.mjs; tested by test-supabase-key.mjs.
//
// Supabase disabled this project's legacy JWT keys (the old `anon` and `service_role` JWTs)
// on 2026-10-21. A build that still carries one is refused by the API gateway on every call,
// sign-in included, so a JWT is a hard failure here even when its role is `anon`. A secret key
// (sb_secret_…) would hand every installer full database access and is refused for that reason.
export function assertPublishableKey(value) {
  const key = String(value || '').trim()
  if (!key) {
    throw new Error(
      'Missing FORGENOTES_SUPABASE_ANON_KEY (or a local config.json). ' +
      'The production build will not be created without the public publishable key (sb_publishable_…).',
    )
  }
  if (key.startsWith('sb_secret_')) {
    throw new Error('Refusing to package a Supabase secret key (sb_secret_…); use the public publishable key (sb_publishable_…).')
  }
  if (key.split('.').length === 3) {
    throw new Error(
      'Refusing to package a legacy Supabase JWT key: the project disabled them on 2026-10-21, so every ' +
      'sign-in from this build would fail. Set FORGENOTES_SUPABASE_ANON_KEY to the publishable key (sb_publishable_…).',
    )
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('The Supabase key must be the public publishable key (sb_publishable_…).')
  }
  return key
}
