const test = require('node:test')
const assert = require('node:assert')
const { checkAfterPrint } = require('../post-print-check')

const run = (readings) => {
  const calls = { reads: 0, sleeps: [] }
  return checkAfterPrint({
    readStatus: () => readings[Math.min(calls.reads++, readings.length - 1)],
    sleep: async (ms) => { calls.sleeps.push(ms) },
  }).then((r) => ({ ...r, ...calls }))
}

test('healthy reading: printed, one read, no pause', async () => {
  const r = await run(['READY'])
  assert.deepEqual([r.printed, r.reads, r.sleeps.length], [true, 1, 0])
})

test('near-end is still a good print', async () => {
  assert.equal((await run(['NEAR_END'])).printed, true)
})

test('real paper-out mid-token (stays bad): slip FAILS so it is reprinted fresh', async () => {
  const r = await run(['PAPER_OUT', 'PAPER_OUT'])
  assert.equal(r.printed, false)
  assert.equal(r.status, 'PAPER_OUT')
  assert.equal(r.reads, 2)
})

test('momentary glitch that clears: counts as printed, no duplicate', async () => {
  const r = await run(['PAPER_OUT', 'READY'])
  assert.equal(r.printed, true)
  assert.equal(r.glitchCleared, true)
})

test('cover open that stays open fails the slip', async () => {
  assert.equal((await run(['COVER_OPEN', 'COVER_OPEN'])).printed, false)
})
