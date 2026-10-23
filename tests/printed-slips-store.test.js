const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createPrintedSlipsStore } = require('../printed-slips-store')

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slips-')), 'printed.json')

test('remembers a slip per job and survives a restart', () => {
  const f = tmpFile()
  const a = createPrintedSlipsStore(f)
  assert.equal(a.has('order-1', 's1'), false)
  a.add('order-1', 's1')
  assert.equal(a.has('order-1', 's1'), true)
  assert.equal(a.has('order-2', 's1'), false, 'same slip id in another order is a different print')
  const b = createPrintedSlipsStore(f)
  assert.equal(b.has('order-1', 's1'), true)
})

test('expires old entries', () => {
  const f = tmpFile()
  let t = 1000
  const s = createPrintedSlipsStore(f, () => {}, 500, () => t)
  s.add('o', 's')
  t = 1400
  assert.equal(s.has('o', 's'), true)
  t = 1600
  assert.equal(s.has('o', 's'), false)
})

test('corrupt file starts empty instead of throwing', () => {
  const f = tmpFile()
  fs.writeFileSync(f, '{not json')
  assert.equal(createPrintedSlipsStore(f).has('o', 's'), false)
})
