// Sign-in (Supabase refresh token) persistence for the main process.
//
// The token is written to disk only when the OS can encrypt it (Electron safeStorage:
// DPAPI on Windows, the Keychain on macOS). When it cannot, the token is kept in memory
// for this run only and the user signs in again on the next launch: plaintext is never
// written. A plaintext token left on disk by an older version is deleted, never read.
const fs = require('node:fs/promises')
const path = require('node:path')

// A safeStorage blob is binary (a version prefix, then nonce/ciphertext bytes); a refresh
// token is a short run of printable ASCII. Only used to recognise the plaintext file that
// versions before this change wrote when encryption was unavailable.
function looksLikePlaintextToken(buf) {
  if (!buf || buf.length === 0 || buf.length > 4096) return false
  for (const byte of buf) {
    if (byte < 0x21 || byte > 0x7e) return false
  }
  return true
}

function createTokenStore({ file, safeStorage, log = () => {} }) {
  let memoryToken = null
  let warnedMemoryOnly = false

  function encryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable() === true
    } catch {
      return false
    }
  }

  function memoryOnly(reason) {
    if (warnedMemoryOnly) return
    warnedMemoryOnly = true
    log(
      `auth: ${reason}. The sign-in is kept in memory for this run only and is not written to disk; ` +
        'you will be asked to sign in again the next time the app starts.',
    )
  }

  async function removeFile() {
    try {
      await fs.unlink(file)
    } catch {
      // already gone, or not removable: nothing more to do
    }
  }

  async function discardIfPlaintext(buf) {
    if (!looksLikePlaintextToken(buf)) return
    await removeFile()
    log('auth: deleted an unencrypted sign-in token written by an older version; please sign in again.')
  }

  async function get() {
    if (memoryToken) return memoryToken
    let buf
    try {
      buf = await fs.readFile(file)
    } catch {
      return null
    }
    if (!encryptionAvailable()) {
      memoryOnly('OS encryption (safeStorage) is unavailable, so the saved sign-in cannot be read')
      await discardIfPlaintext(buf)
      return null
    }
    try {
      return safeStorage.decryptString(buf)
    } catch {
      await discardIfPlaintext(buf)
      return null
    }
  }

  async function set(token) {
    if (!token) return false
    memoryToken = String(token)
    let data = null
    if (encryptionAvailable()) {
      try {
        data = safeStorage.encryptString(memoryToken)
      } catch (e) {
        memoryOnly(`encrypting the sign-in failed (${(e && e.message) || e})`)
      }
    } else {
      memoryOnly('OS encryption (safeStorage) is unavailable')
    }
    if (!data) {
      // Never leave an older token (or an old plaintext file) on disk beside this one.
      await removeFile()
      return true
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, data)
    return true
  }

  async function clear() {
    memoryToken = null
    await removeFile()
    return true
  }

  return { get, set, clear }
}

module.exports = { createTokenStore, looksLikePlaintextToken }
