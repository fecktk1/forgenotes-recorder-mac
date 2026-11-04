// The id this install sends to ForgeNotes as `device_id` (social-os
// internal/forgenotes/one-recording.md): an opaque value made once, kept in userData, and the
// same for every recording from this install. The server uses it only for "one live recording
// at a time per account": two recordings that overlap on DIFFERENT installs of the same
// account mean a login is being shared. It identifies nothing else and is never shown.
//
// Kept in userData/device-id.txt. When that file cannot be written, no id is returned (and
// none is sent): the server never holds a recording without one, while a new id on every
// launch would make one computer look like several.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

// The server's rule for the value (forgenotes-create-session).
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,80}$/

function createDeviceIdStore({ dir, prefix, randomUUID = () => crypto.randomUUID(), log = () => {} }) {
  const file = path.join(dir, 'device-id.txt')
  let cached = null
  let pending = null

  async function read() {
    try {
      const text = (await fs.readFile(file, 'utf8')).trim()
      return DEVICE_ID_PATTERN.test(text) ? text : null
    } catch {
      return null
    }
  }

  async function create() {
    const id = `${prefix}-${randomUUID()}`
    if (!DEVICE_ID_PATTERN.test(id)) throw new Error('generated device id does not match the server pattern')
    await fs.mkdir(dir, { recursive: true })
    // Written whole, then renamed into place, so a crash never leaves half an id.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, id, 'utf8')
    await fs.rename(tmp, file)
    // Read back: if two launches raced, the id on disk is the one from now on.
    return read()
  }

  // The id, made on first use. Never throws.
  async function get() {
    if (cached) return cached
    if (!pending) {
      pending = (async () => {
        const existing = await read()
        if (existing) return existing
        try {
          return await create()
        } catch (e) {
          log(`device id not saved (${e && e.message ? e.message : e}); recordings are sent without one`)
          return null
        }
      })().then((id) => {
        cached = id
        pending = null
        return id
      })
    }
    return pending
  }

  return { get, file }
}

module.exports = { createDeviceIdStore, DEVICE_ID_PATTERN }
