/**
 * Linux printer monitor: CUPS jobs + USB thermal status (via printer-monitor-cli.py).
 * Tracks job start/end and appends to a ring-buffer log for the setup page.
 */

const { BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const POLL_MS = 3000
const LOG_MAX = 80
const CLI_PATH = path.join(__dirname, 'scripts', 'printer-monitor-cli.py')

const JOB_STATE_LABELS = {
  3: 'pending',
  4: 'held',
  5: 'printing',
  6: 'stopped',
  7: 'cancelled',
  8: 'failed',
  9: 'completed',
}

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null
/** @type {Map<string, { state: number, name: string }>} */
const prevJobs = new Map()
/** @type {object | null} */
let prevHardware = null
/** @type {Array<{ at: string, level: string, message: string }>} */
const logs = []

let snapshot = {
  supported: process.platform === 'linux',
  hardware: null,
  jobs: [],
  activeJobs: [],
  incompleteJobs: [],
  lastJob: null,
  jobStatusLabel: '—',
  alerts: [],
  errors: [],
  updatedAt: null,
}

function pushLog(level, message) {
  logs.unshift({
    at: new Date().toISOString(),
    level,
    message: String(message),
  })
  if (logs.length > LOG_MAX) logs.length = LOG_MAX
}

function broadcast() {
  const payload = getPrinterMonitorSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('printer-monitor-update', payload)
    }
  }
}

function hardwareAlerts(hw) {
  if (!hw || !hw.found) return ['Printer not found on USB']
  const alerts = []
  if (hw.error && typeof hw.error === 'string') alerts.push(hw.error)
  if (!hw.online) alerts.push('Printer offline')
  if (hw.doorOpen) alerts.push('Door is open')
  if (hw.paperEnd) alerts.push('Paper empty')
  if (hw.paperLow) alerts.push('Paper low')
  if (hw.hardwareError) alerts.push('Printer error flag set')
  return alerts
}

function processJobTransitions(jobs) {
  const byId = new Map(jobs.map((j) => [j.id, j]))
  let lastJob = snapshot.lastJob
  let jobStatusLabel = snapshot.jobStatusLabel

  for (const job of jobs) {
    const prev = prevJobs.get(job.id)
    const prevState = prev?.state ?? 0
    const state = job.state

    if (state === 5 && prevState !== 5) {
      pushLog('info', `Job started: ${job.name}`)
      lastJob = { id: job.id, name: job.name, state, stateLabel: job.stateLabel }
      jobStatusLabel = 'PRINTING…'
    } else if (state === 9 && prevState !== 9) {
      pushLog('success', `Job completed: ${job.name}`)
      lastJob = { id: job.id, name: job.name, state, stateLabel: job.stateLabel }
      jobStatusLabel = 'Completed'
    } else if (state === 7 && prevState !== 7) {
      pushLog('warn', `Job cancelled: ${job.name}`)
      jobStatusLabel = 'Cancelled'
    } else if (state === 8 && prevState !== 8) {
      pushLog('error', `Job failed: ${job.name}`)
      jobStatusLabel = 'FAILED'
    }
  }

  for (const [id, prev] of prevJobs) {
    if (!byId.has(id) && prev.state === 5) {
      pushLog('info', `Job removed from queue (was printing): ${prev.name}`)
    }
  }

  prevJobs.clear()
  for (const job of jobs) {
    prevJobs.set(job.id, { state: job.state, name: job.name })
  }

  return { lastJob, jobStatusLabel }
}

function processHardwareTransitions(hw) {
  if (!hw || !prevHardware) {
    prevHardware = hw ? { ...hw } : null
    return
  }
  if (hw.doorOpen && !prevHardware.doorOpen) {
    pushLog('error', 'PRINTER ALERT: Door is OPEN')
  } else if (!hw.doorOpen && prevHardware.doorOpen) {
    pushLog('success', 'Door is now closed')
  }
  if (hw.paperEnd && !prevHardware.paperEnd) {
    pushLog('error', 'PRINTER ALERT: Paper is EMPTY')
  } else if (!hw.paperEnd && prevHardware.paperEnd) {
    pushLog('success', 'Paper loaded')
  }
  if (hw.paperLow && !prevHardware.paperLow) {
    pushLog('warn', 'PRINTER WARNING: Paper is LOW')
  }
  prevHardware = { ...hw }
}

async function fetchSnapshotFromPython() {
  const py = process.env.PRINTER_MONITOR_PYTHON || 'python3'
  const { stdout } = await execFileAsync(py, [CLI_PATH], {
    timeout: 12000,
    maxBuffer: 2 * 1024 * 1024,
  })
  return JSON.parse(stdout.trim())
}

async function fetchSnapshotFromLpstat() {
  const jobs = []
  const errors = []
  try {
    const { stdout } = await execFileAsync('lpstat', ['-W', 'all', '-o'], {
      timeout: 8000,
    })
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\S+)-(\d+)\s+\S+\s+\d+\s+/)
      if (!m) continue
      const id = m[2]
      const name = line.trim()
      jobs.push({
        id,
        name: name.slice(0, 120),
        state: 5,
        stateLabel: 'active',
      })
    }
  } catch (err) {
    errors.push('lpstat: ' + (err.message || String(err)))
  }
  return { ok: jobs.length > 0, hardware: null, jobs, errors }
}

async function pollOnce() {
  if (process.platform !== 'linux') return

  let raw = null
  try {
    if (fs.existsSync(CLI_PATH)) {
      raw = await fetchSnapshotFromPython()
    }
  } catch (err) {
    pushLog('warn', 'Python monitor: ' + (err.message || String(err)).slice(0, 120))
  }

  if (!raw) {
    try {
      raw = await fetchSnapshotFromLpstat()
    } catch (err) {
      raw = { ok: false, hardware: null, jobs: [], errors: [String(err)] }
    }
  }

  const jobs = Array.isArray(raw.jobs) ? raw.jobs : []
  const hw = raw.hardware || null
  const { lastJob, jobStatusLabel } = processJobTransitions(jobs)
  processHardwareTransitions(hw)

  const activeJobs = jobs.filter((j) => j.state >= 3 && j.state <= 6)
  const incompleteJobs = jobs.filter((j) => j.state === 5)

  const alerts = [...hardwareAlerts(hw)]
  if (incompleteJobs.length) {
    alerts.push(`${incompleteJobs.length} job(s) still printing`)
  }

  if (raw.errors?.length) {
    for (const e of raw.errors) {
      if (!snapshot.errors.includes(e)) pushLog('warn', e)
    }
  }

  snapshot = {
    supported: true,
    hardware: hw,
    jobs,
    activeJobs,
    incompleteJobs,
    lastJob: lastJob || snapshot.lastJob,
    jobStatusLabel,
    alerts,
    errors: raw.errors || [],
    updatedAt: new Date().toISOString(),
  }

  broadcast()
}

function startPrinterMonitor() {
  if (process.platform !== 'linux') {
    snapshot.supported = false
    return
  }
  if (pollTimer) return
  pushLog('info', 'Printer monitor started')
  void pollOnce()
  pollTimer = setInterval(() => {
    void pollOnce()
  }, POLL_MS)
}

function stopPrinterMonitor() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function getPrinterMonitorSnapshot() {
  return {
    ...snapshot,
    logs: [...logs],
  }
}

/**
 * Wait until no CUPS jobs are printing, or timeout.
 * @param {number} timeoutMs
 */
async function waitForPrintQueueIdle(timeoutMs = 90000) {
  if (process.platform !== 'linux') return { ok: true, reason: 'non-linux' }

  const deadline = Date.now() + timeoutMs
  let sawPrinting = false

  while (Date.now() < deadline) {
    await pollOnce()
    const printing = snapshot.incompleteJobs?.length > 0
    if (printing) {
      sawPrinting = true
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    if (sawPrinting || !snapshot.jobs?.length) {
      return { ok: true, completed: true }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }

  return {
    ok: false,
    completed: false,
    error: 'Timed out waiting for print job to finish',
    incompleteJobs: snapshot.incompleteJobs,
  }
}

module.exports = {
  startPrinterMonitor,
  stopPrinterMonitor,
  getPrinterMonitorSnapshot,
  waitForPrintQueueIdle,
  pushLog,
  JOB_STATE_LABELS,
}
