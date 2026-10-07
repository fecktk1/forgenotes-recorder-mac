const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createTokenStore, looksLikePlaintextToken } = require('../token-store')

// Stand-in for Electron's safeStorage: "encrypts" into bytes that are not printable ASCII,
// the way a real safeStorage blob is binary.
function fakeSafeStorage({ available = true, encryptThrows = false } = {}) {
  return {
    available,
    isEncryptionAvailable() {
      return this.available
    },
    encryptString(text) {
      if (encryptThrows) throw new Error('keychain locked')
      return Buffer.concat([Buffer.from([0x00, 0xff]), Buffer.from(text, 'utf8').map((b) => b ^ 0x80)])
    },
    decryptString(buf) {
      if (buf[0] !== 0x00 || buf[1] !== 0xff) throw new Error('not an encrypted blob')
      return Buffer.from(buf.subarray(2).map((b) => b ^ 0x80)).toString('utf8')
    },
  }
}

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgenotes-token-test-'))
  try {
    await fn(path.join(dir, 'auth.bin'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const exists = (file) => fs.stat(file).then(() => true, () => false)
const TOKEN = 'v1.refresh-token_ABC123'

test('encrypted at rest when safeStorage can encrypt', () =>
  withDir(async (file) => {
    const safeStorage = fakeSafeStorage()
    await createTokenStore({ file, safeStorage }).set(TOKEN)
    const raw = await fs.readFile(file)
    assert.ok(!raw.toString('latin1').includes(TOKEN), 'token must not be on disk in plaintext')
    assert.equal(await createTokenStore({ file, safeStorage }).get(), TOKEN, 'next launch restores the sign-in')
  }))

test('memory-only for the run when encryption is unavailable, never plaintext on disk', () =>
  withDir(async (file) => {
    const logs = []
    const safeStorage = fakeSafeStorage({ available: false })
    const store = createTokenStore({ file, safeStorage, log: (line) => logs.push(line) })
    assert.equal(await store.set(TOKEN), true)
    assert.equal(await exists(file), false, 'nothing is written')
    assert.equal(await store.get(), TOKEN, 'the token survives for this run')
    assert.equal(await createTokenStore({ file, safeStorage }).get(), null, 'next launch signs in again')
    assert.equal(logs.length, 1, 'the reason is logged once')
    assert.match(logs[0], /encryption \(safeStorage\) is unavailable/)
    assert.match(logs[0], /sign in again/)
  }))

test('memory-only when encrypting throws, and an older token file is removed', () =>
  withDir(async (file) => {
    await createTokenStore({ file, safeStorage: fakeSafeStorage() }).set('older-token')
    const logs = []
    const store = createTokenStore({ file, safeStorage: fakeSafeStorage({ encryptThrows: true }), log: (l) => logs.push(l) })
    await store.set(TOKEN)
    assert.equal(await exists(file), false)
    assert.equal(await store.get(), TOKEN)
    assert.match(logs[0], /encrypting the sign-in failed \(keychain locked\)/)
  }))

test('a plaintext token left by an older version is deleted, not used', () =>
  withDir(async (file) => {
    for (const available of [true, false]) {
      await fs.writeFile(file, TOKEN, 'utf8')
      const logs = []
      const store = createTokenStore({ file, safeStorage: fakeSafeStorage({ available }), log: (l) => logs.push(l) })
      assert.equal(await store.get(), null)
      assert.equal(await exists(file), false, `plaintext file removed (encryption available: ${available})`)
      assert.ok(logs.some((l) => /deleted an unencrypted sign-in token/.test(l)))
    }
  }))

test('an encrypted token is kept while encryption is briefly unavailable', () =>
  withDir(async (file) => {
    const safeStorage = fakeSafeStorage()
    await createTokenStore({ file, safeStorage }).set(TOKEN)
    safeStorage.available = false
    assert.equal(await createTokenStore({ file, safeStorage }).get(), null)
    assert.equal(await exists(file), true, 'ciphertext is not mistaken for a plaintext token')
    safeStorage.available = true
    assert.equal(await createTokenStore({ file, safeStorage }).get(), TOKEN)
  }))

test('clear forgets the token in memory and on disk', () =>
  withDir(async (file) => {
    const store = createTokenStore({ file, safeStorage: fakeSafeStorage() })
    await store.set(TOKEN)
    await store.clear()
    assert.equal(await exists(file), false)
    assert.equal(await store.get(), null)
    const memoryOnly = createTokenStore({ file, safeStorage: fakeSafeStorage({ available: false }) })
    await memoryOnly.set(TOKEN)
    await memoryOnly.clear()
    assert.equal(await memoryOnly.get(), null)
  }))

test('plaintext detection', () => {
  assert.equal(looksLikePlaintextToken(Buffer.from(TOKEN)), true)
  assert.equal(looksLikePlaintextToken(Buffer.from([0x76, 0x31, 0x30, 0x9c, 0x02])), false)
  assert.equal(looksLikePlaintextToken(Buffer.alloc(0)), false)
  assert.equal(looksLikePlaintextToken(Buffer.from('two words')), false)
})
