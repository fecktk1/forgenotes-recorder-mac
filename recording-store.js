const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Why a recording ended, as the renderer reports it at Stop.
const STOP_REASONS = new Set(['manual', 'silence', 'save_failed', 'device_lost'])

// The fields a finished recording may add to its meta.json, from the renderer: when it
// ended (sent to the server as ended_at) and why. Anything else is dropped.
function finishDetails(details) {
  const out = {}
  if (!details || typeof details !== 'object') return out
  const ended = typeof details.endedAt === 'string' ? Date.parse(details.endedAt) : NaN
  if (Number.isFinite(ended) && ended > 0) out.endedAt = new Date(ended).toISOString()
  if (STOP_REASONS.has(details.stopReason)) out.stopReason = details.stopReason
  return out
}

function recordingStore(root) {
  root = path.resolve(root)
  const queues = new Map()
  function directory(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id || ''))) throw new Error('invalid_local_id')
    const target = path.resolve(root, id)
    if (!target.startsWith(root + path.sep)) throw new Error('invalid_local_path')
    return target
  }
  function segmentName(s) {
    if (!['mic', 'system', 'mixed'].includes(s.track) || !Number.isSafeInteger(s.seq) || s.seq < 0) throw new Error('invalid_segment')
    return `${s.track}-${String(s.seq).padStart(4, '0')}.webm`
  }
  async function atomic(file, data) {
    const temp = file + '.partial'
    const handle = await fs.open(temp, 'w')
    try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
    await fs.rename(temp, file)
  }
  async function metadata(id) { return JSON.parse(await fs.readFile(path.join(directory(id), 'meta.json'), 'utf8')) }
  function serialize(id, action) {
    const prior = queues.get(id) || Promise.resolve()
    const next = prior.catch(() => {}).then(action)
    queues.set(id, next)
    next.finally(() => { if (queues.get(id) === next) queues.delete(id) }).catch(() => {})
    return next
  }
  async function checkpoint(id, meta, segment) {
    return serialize(id, async () => {
      const dir = directory(id)
      await fs.mkdir(dir, { recursive: true })
      let saved = { ...meta, segments: [], state: 'recording' }
      try { saved = await metadata(id) } catch (error) { if (error.code !== 'ENOENT') throw error }
      const filename = segmentName(segment)
      const previous = (saved.segments || []).find(s => s.track === segment.track && s.seq === segment.seq)
      if (previous) {
        const existing = await fs.readFile(path.join(dir, filename))
        if (!existing.equals(Buffer.from(segment.data))) throw new Error('recording_checkpoint_conflict')
        return previous
      }
      await atomic(path.join(dir, filename), Buffer.from(segment.data))
      const record = { track: segment.track, seq: segment.seq, startOffsetMs: segment.startOffsetMs, durationMs: segment.durationMs, bytes: segment.data.byteLength }
      const segments = (saved.segments || []).filter((s) => s.track !== record.track || s.seq !== record.seq)
      segments.push(record)
      segments.sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.track.localeCompare(b.track))
      // checkpointedAt: when the newest segment reached the disk. For a recording cut off by
      // a crash or power loss (no Stop, so no endedAt) it is the best known end.
      await atomic(path.join(dir, 'meta.json'), JSON.stringify({ ...saved, ...meta, state: 'recording', segments,
        tracks: [...new Set(segments.map((s) => s.track))], durationSec: Math.ceil(Math.max(...segments.map((s) => (s.startOffsetMs + s.durationMs) / 1000))),
        checkpointedAt: new Date().toISOString() }))
      return record
    })
  }
  async function update(id, patch) {
    return serialize(id, async () => {
      const saved = await metadata(id)
      await atomic(path.join(directory(id), 'meta.json'), JSON.stringify({ ...saved, ...patch }))
    })
  }
  // Stop: the recording is complete on disk. details: { endedAt, stopReason } (see finishDetails).
  async function finish(id, details) {
    return update(id, { state: 'saved', ...finishDetails(details) })
  }
  async function readSegment(id, segment) {
    const buf = await fs.readFile(path.join(directory(id), segmentName(segment)))
    if (segment.bytes && buf.length !== segment.bytes) throw new Error('recording_segment_incomplete')
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
  async function playback(id) {
    const meta = await metadata(id)
    const files = []
    for (const segment of meta.segments || []) {
      const file = path.join(directory(id), segmentName(segment))
      const stat = await fs.stat(file) // missing chunks must never silently disappear
      if (segment.bytes && stat.size !== segment.bytes) throw new Error('recording_segment_incomplete')
      // writtenAt: when the segment file was written, the end of a recording saved by a build
      // that did not keep endedAt or checkpointedAt.
      files.push({ ...segment, url: pathToFileURL(file).href, writtenAt: stat.mtime.toISOString() })
    }
    return { meta, files }
  }
  return { directory, metadata, checkpoint, update, finish, readSegment, playback }
}
module.exports = { recordingStore, finishDetails }
