/**
 * HTTP client for pos-printer-service (raw ESC/POS over USB).
 * @see ../pos-printer-service/printer_service.py
 */

const DEFAULT_URL = 'http://127.0.0.1:6173'

const JOB_POLL_MS = 150
const JOB_DONE_TIMEOUT_MS = 25000
const HTTP_TIMEOUT_MS = 45000

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_URL).replace(/\/$/, '')
}

function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  )
}

async function fetchHealth(baseUrl = DEFAULT_URL) {
  const url = `${normalizeBaseUrl(baseUrl)}/health`
  const res = await fetchWithTimeout(url, { method: 'GET' }, 8000)
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(data.detail || res.statusText)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

async function isServerAvailable(baseUrl = DEFAULT_URL) {
  try {
    const r = await fetchHealth(baseUrl)
    return r?.status === 'ok'
  } catch {
    return false
  }
}

/**
 * @returns {Promise<object>} health payload
 * @throws {Error} with errorType when service or USB printer is not ready
 */
async function assertPrinterReady(baseUrl = DEFAULT_URL) {
  const h = await fetchHealth(baseUrl)
  if (h?.status !== 'ok') {
    const err = new Error('POS printer service is not responding')
    err.errorType = 'printer-server-unavailable'
    throw err
  }
  if (h?.printer?.connected !== true) {
    const err = new Error(
      'USB printer is offline. Check power/USB, wait for “Printer ready” in logs, and disable the CUPS queue on this device.',
    )
    err.errorType = 'printer-offline'
    throw err
  }
  return h
}

async function printRaw(baseUrl, data) {
  const url = `${normalizeBaseUrl(baseUrl)}/print/raw`
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    },
    HTTP_TIMEOUT_MS,
  )
  const text = await res.text()
  let parsed = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(parsed.detail || res.statusText)
    err.status = res.status
    err.errorType =
      res.status === 503 ? 'printer-offline' : 'print-submit-failed'
    err.data = parsed
    throw err
  }
  return parsed
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function friendlyJobError(errorText) {
  const s = String(errorText || '')
  if (/errno 110|timed out/i.test(s)) {
    return 'printer-write-timeout'
  }
  return errorText || 'job-failed'
}

async function waitForJob(baseUrl, jobId, timeoutMs = JOB_DONE_TIMEOUT_MS) {
  const base = normalizeBaseUrl(baseUrl)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let res
    try {
      res = await fetchWithTimeout(
        `${base}/jobs/${encodeURIComponent(jobId)}`,
        { method: 'GET' },
        8000,
      )
    } catch (e) {
      return {
        success: false,
        errorType: e.name === 'AbortError' ? 'job-status-timeout' : String(e.message),
        jobId,
      }
    }
    const text = await res.text()
    let row = {}
    try {
      row = text ? JSON.parse(text) : {}
    } catch {
      row = {}
    }
    if (!res.ok) {
      return {
        success: false,
        errorType: row.detail || 'job-status-error',
        jobId,
      }
    }
    const status = row.status
    if (status === 'done') {
      return { success: true, jobId }
    }
    if (status === 'failed') {
      return {
        success: false,
        errorType: friendlyJobError(row.error),
        jobId,
        message: row.error,
      }
    }
    if (status === 'retrying' || status === 'printing' || status === 'pending') {
      await sleep(JOB_POLL_MS)
      continue
    }
    await sleep(JOB_POLL_MS)
  }
  return { success: false, errorType: 'job-timeout', jobId, pending: true }
}

/**
 * Queue raw ESC/POS. By default waits briefly for completion; returns queued on slow USB.
 * @param {string} baseUrl
 * @param {Buffer} escpos
 * @param {{ wait?: boolean, waitTimeoutMs?: number }} [options]
 */
async function printEscPos(baseUrl, escpos, options = {}) {
  const wait = options.wait !== false
  const waitTimeoutMs = options.waitTimeoutMs ?? JOB_DONE_TIMEOUT_MS

  const queued = await printRaw(baseUrl, escpos)
  const jobId = queued?.job_id
  if (!jobId) {
    return { success: true, queued: true }
  }
  if (!wait) {
    return { success: true, jobId, queued: true }
  }

  const done = await waitForJob(baseUrl, jobId, waitTimeoutMs)
  if (done.success) {
    return done
  }
  if (done.pending && done.errorType === 'job-timeout') {
    return {
      success: true,
      jobId,
      queued: true,
      pending: true,
      warning: 'Print queued — still processing on the printer service',
    }
  }
  return done
}

module.exports = {
  DEFAULT_URL,
  fetchHealth,
  isServerAvailable,
  assertPrinterReady,
  printRaw,
  printEscPos,
  waitForJob,
}
