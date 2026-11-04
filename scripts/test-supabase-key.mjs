// The build may package only the public publishable key: never a secret key, and never a
// legacy JWT (disabled for this project since 2026-10-21, so a build carrying one fails every
// sign-in), whatever role the JWT claims.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertPublishableKey } from './supabase-key.mjs'

function jwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`
}

test('the publishable key is accepted, trimmed', () => {
  assert.equal(assertPublishableKey('  sb_publishable_mxWEJQs8cIQJgQyrtGt-1A_xPcTviBC\n'), 'sb_publishable_mxWEJQs8cIQJgQyrtGt-1A_xPcTviBC')
})

test('a missing key is refused', () => {
  for (const value of ['', '   ', undefined, null]) {
    assert.throws(() => assertPublishableKey(value), /Missing FORGENOTES_SUPABASE_ANON_KEY/)
  }
})

test('a secret key is refused', () => {
  assert.throws(() => assertPublishableKey('sb_secret_abc123'), /secret key/)
})

test('a legacy JWT is refused, the anon one included', () => {
  for (const role of ['anon', 'service_role', 'authenticated']) {
    assert.throws(() => assertPublishableKey(jwt({ iss: 'supabase', role })), /legacy Supabase JWT/)
  }
})

test('anything else is refused', () => {
  for (const value of ['sb_publishable_', 'sb_publishable_has spaces', 'publishable', 'sb_anon_abc']) {
    assert.throws(() => assertPublishableKey(value), /publishable key/)
  }
})
