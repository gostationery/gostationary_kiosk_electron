/**
 * printed-slips-store.js
 *
 * Remembers which token slips have already been handed to the printer, keyed by
 * `${jobId}:${slipId}` (jobId is the order id, so keys never repeat across
 * orders). Persisted to disk so the guarantee holds across a renderer reload or
 * app restart: a slip that already printed is never printed a second time, no
 * matter how many times the kiosk UI re-issues it.
 *
 * Entries older than TTL are dropped. Writes are atomic (tmp + rename) so a
 * power cut cannot leave a half-written file; a corrupt/missing file just
 * starts empty.
 */
const fs = require('fs')

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

function createPrintedSlipsStore(filePath, log = () => {}, ttlMs = DEFAULT_TTL_MS, now = Date.now) {
  /** @type {Map<string, number>} */
  const entries = new Map()

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    for (const [k, at] of Object.entries(raw || {})) {
      if (typeof at === 'number') entries.set(k, at)
    }
  } catch {
    /* first run or unreadable file: start empty */
  }

  function prune() {
    const cutoff = now() - ttlMs
    for (const [k, at] of entries) if (at < cutoff) entries.delete(k)
  }

  function persist() {
    try {
      const tmp = `${filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)))
      fs.renameSync(tmp, filePath)
    } catch (err) {
      log('printed-slips-store: persist failed', String(err?.message || err))
    }
  }

  const keyOf = (jobId, slipId) => `${jobId}:${slipId}`

  return {
    has(jobId, slipId) {
      prune()
      return entries.has(keyOf(jobId, slipId))
    },
    add(jobId, slipId) {
      prune()
      entries.set(keyOf(jobId, slipId), now())
      persist()
    },
  }
}

module.exports = { createPrintedSlipsStore }
