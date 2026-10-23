/**
 * post-print-check.js
 *
 * Decides, right after the spooler accepted a slip, whether it really printed.
 *
 *  - Healthy reading after the print            -> printed.
 *  - Paper-out / cover-open / offline reading    -> could be a REAL fault (paper ran
 *    out mid-token: the slip is cut short and must be reprinted fresh) or a sensor
 *    glitch that clears by itself right after a good print (a reprint would then be a
 *    duplicate token). Tell them apart by looking again after a short pause:
 *      still bad  -> real fault: the slip FAILS, is not remembered as printed, and the
 *                    kiosk retries it once the printer is ready again.
 *      cleared    -> glitch: the slip counts as printed (no duplicate).
 *
 * The pause is an async sleep, so the main thread is never held during it. A second
 * printer read only happens in the rare bad-reading case.
 */
const BAD_STATUSES = new Set(['PAPER_OUT', 'COVER_OPEN', 'OFF'])

/**
 * @param {{ readStatus: () => string, sleep: (ms:number)=>Promise<void>, recheckMs?: number }} deps
 * @returns {Promise<{ printed: boolean, status: string, glitchCleared: boolean }>}
 */
async function checkAfterPrint({ readStatus, sleep, recheckMs = 1500 }) {
  const first = readStatus()
  if (!BAD_STATUSES.has(first)) return { printed: true, status: first, glitchCleared: false }
  await sleep(recheckMs)
  const second = readStatus()
  if (BAD_STATUSES.has(second)) return { printed: false, status: second, glitchCleared: false }
  return { printed: true, status: second, glitchCleared: true }
}

module.exports = { checkAfterPrint, BAD_STATUSES }
