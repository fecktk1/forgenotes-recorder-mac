const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createDeviceIdStore, DEVICE_ID_PATTERN } = require('../device-id')

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgenotes-device-id-test-'))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('made once, in the shape the server accepts, and kept on disk', () =>
  withDir(async (dir) => {
    const id = await createDeviceIdStore({ dir, prefix: 'mac' }).get()
    assert.match(id, /^mac-[0-9a-f-]{36}$/)
    assert.match(id, DEVICE_ID_PATTERN)
    assert.equal((await fs.readFile(path.join(dir, 'device-id.txt'), 'utf8')).trim(), id)
  }))

test('the same id on every later launch', () =>
  withDir(async (dir) => {
    const first = await createDeviceIdStore({ dir, prefix: 'mac' }).get()
    let made = 0
    const later = createDeviceIdStore({ dir, prefix: 'mac', randomUUID: () => { made += 1; return 'never-used-0000' } })
    assert.equal(await later.get(), first)
    assert.equal(await later.get(), first)
    assert.equal(made, 0, 'an existing id is never replaced')
  }))

test('concurrent first calls agree on one id', () =>
  withDir(async (dir) => {
    const store = createDeviceIdStore({ dir, prefix: 'mac' })
    const ids = await Promise.all([store.get(), store.get(), store.get()])
    assert.equal(new Set(ids).size, 1)
    assert.equal(await createDeviceIdStore({ dir, prefix: 'mac' }).get(), ids[0])
  }))

test('a damaged file is replaced by a new id, never sent as is', () =>
  withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'device-id.txt'), 'not a valid id!', 'utf8')
    const id = await createDeviceIdStore({ dir, prefix: 'mac' }).get()
    assert.match(id, /^mac-/)
    assert.equal((await fs.readFile(path.join(dir, 'device-id.txt'), 'utf8')).trim(), id)
  }))

test('when it cannot be kept: no id at all (never a new one per launch), and no error', () =>
  withDir(async (dir) => {
    // A file where the folder should be: nothing can be written under it.
    const blocked = path.join(dir, 'blocked')
    await fs.writeFile(blocked, 'x')
    const logs = []
    const store = createDeviceIdStore({ dir: blocked, prefix: 'mac', log: (line) => logs.push(line) })
    assert.equal(await store.get(), null)
    assert.match(logs[0], /device id not saved/)
    // Not cached: it tries again next time (a full disk may have been cleared).
    await fs.rm(blocked)
    assert.match(await store.get(), /^mac-/)
  }))

test('no temporary file is left behind', () =>
  withDir(async (dir) => {
    await createDeviceIdStore({ dir, prefix: 'mac' }).get()
    assert.deepEqual(await fs.readdir(dir), ['device-id.txt'])
  }))

test('the upload sends it only with the recording start, and never fails over it', async () => {
  const app = await fs.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  assert.ok(app.includes('if (times.started_at) {'), 'device_id rides with started_at only')
  assert.ok(app.includes('Promise.resolve().then(() => window.desktop.deviceId()).catch(() => null)'), 'a failed lookup never blocks the upload')
  assert.ok(app.includes('if (deviceId) body.device_id = deviceId'))
  const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('device-id.js'), 'packaged with the app')
})
