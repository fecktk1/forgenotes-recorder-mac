const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createAnalytics } = require('../renderer/product-analytics.js')

function fixture() {
  const calls = []
  const analytics = createAnalytics({ platform: 'windows', version: '1.1.0', rpc: async (name, args, identity) => {
    calls.push({ name, args, identity })
    if (name === 'get_product_analytics_consent') return { allowed: true }
    return args.p_allowed === true
  } })
  return { analytics, calls, captures: () => calls.filter(call => call.name === 'capture_product_event') }
}
test('default off; authenticated consent; no titles or tokens forwarded', async () => {
  const f = fixture()
  await f.analytics.capture('recording_started'); assert.equal(f.captures().length, 0)
  await f.analytics.identify('a')
  await f.analytics.capture('notes_action_succeeded', { feature: 'meeting_created', title: 'SECRET', token: 'SECRET' })
  assert.equal(f.captures().length, 2)
  assert.equal(f.captures()[1].identity, 'a')
  assert.equal(JSON.stringify(f.captures()).includes('SECRET'), false)
  await f.analytics.setEnabled(false)
  await f.analytics.capture('recording_started'); assert.equal(f.captures().length, 2)
})
test('operation result and error survive telemetry; polling is excluded', async () => {
  const f = fixture(); await f.analytics.identify('a')
  const result = { id: 'private' }
  assert.equal(await f.analytics.operation('forgenotes-create-session', async () => result), result)
  const error = new Error('SECRET')
  await assert.rejects(f.analytics.operation('forgenotes-finalize-session', async () => { throw error }), e => e === error)
  await f.analytics.operation('forgenotes-list-sessions', async () => [])
  assert.deepEqual(f.captures().map(c => c.args.p_event), ['app_opened','notes_action_succeeded','notes_action_failed'])
})
test('account replacement and logout discard earlier operation completions', async () => {
  const f = fixture(); await f.analytics.identify('a')
  let resolve
  const operation = f.analytics.operation('forgenotes-create-session', () => new Promise(r => { resolve = r }))
  await f.analytics.identify('b'); resolve({}); await operation
  assert.equal(f.captures().filter(c => c.args.p_event === 'notes_action_succeeded').length, 0)
  f.analytics.reset(); await f.analytics.capture('recording_stopped')
  assert.equal(f.analytics.enabled(), false)
})
