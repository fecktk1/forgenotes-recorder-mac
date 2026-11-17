import test from 'node:test'
import assert from 'node:assert/strict'
import { advisories, evaluate, EXCEPTIONS } from './audit-gate.mjs'

const clean = { auditReportVersion: 2, vulnerabilities: {} }
const advisory = (name, ghsa, severity = 'high') => ({ source: 1, name, title: `${name} problem`, url: `https://github.com/advisories/${ghsa}`, severity })
const report = (...entries) => ({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(entries.map(([name, via]) => [name, { name, via }])),
})
const exceptions = { 'GHSA-aaaa-bbbb-cccc': { package: 'picomatch', reason: 'no fix', reviewBy: '2027-01-15' } }
const today = new Date('2026-11-17T12:00:00Z')

test('advisories are read once each, and packages that only depend on one are not advisories', () => {
  const r = report(['picomatch', [advisory('picomatch', 'GHSA-aaaa-bbbb-cccc')]], ['fdir', ['picomatch']], ['tinyglobby', ['fdir', 'picomatch']])
  assert.deepEqual(advisories(r).map((a) => a.id), ['GHSA-aaaa-bbbb-cccc'])
})

test('a clean audit passes', () => {
  assert.equal(evaluate(clean, clean, { today, exceptions }).ok, true)
})

test('an excepted build-time advisory passes, and is printed', () => {
  const full = report(['picomatch', [advisory('picomatch', 'GHSA-aaaa-bbbb-cccc')]])
  const result = evaluate(full, clean, { today, exceptions })
  assert.equal(result.ok, true)
  assert.match(result.excused[0], /GHSA-aaaa-bbbb-cccc/)
})

test('any other advisory fails, whatever its severity', () => {
  const full = report(['other', [advisory('other', 'GHSA-dddd-eeee-ffff', 'low')]])
  const result = evaluate(full, clean, { today, exceptions })
  assert.equal(result.ok, false)
  assert.match(result.problems[0], /GHSA-dddd-eeee-ffff/)
})

test('an exception never covers what ships in the app', () => {
  const both = report(['picomatch', [advisory('picomatch', 'GHSA-aaaa-bbbb-cccc')]])
  const result = evaluate(both, both, { today, exceptions })
  assert.equal(result.ok, false)
  assert.match(result.problems[0], /ships in the app/)
})

test('an exception past its review date fails', () => {
  const full = report(['picomatch', [advisory('picomatch', 'GHSA-aaaa-bbbb-cccc')]])
  const result = evaluate(full, clean, { today: new Date('2027-01-16T12:00:00Z'), exceptions })
  assert.equal(result.ok, false)
  assert.match(result.problems[0], /due for review/)
})

test('an exception is for its own package only', () => {
  const full = report(['other', [advisory('other', 'GHSA-aaaa-bbbb-cccc')]])
  assert.equal(evaluate(full, clean, { today, exceptions }).ok, false)
})

test('an unreadable report fails the gate', () => {
  assert.throws(() => evaluate({ error: { code: 'ENOTFOUND', summary: 'offline' } }, clean, { today, exceptions }), /offline/)
})

test('every exception names its package, its reason and a review date', () => {
  for (const [id, exception] of Object.entries(EXCEPTIONS)) {
    assert.match(id, /^GHSA-/)
    assert.ok(exception.package && exception.reason)
    assert.match(exception.reviewBy, /^\d{4}-\d{2}-\d{2}$/)
  }
})
