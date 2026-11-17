// Dependency audit gate, run by CI and by the release workflow (npm run audit:gate).
//
// Every advisory npm audit reports fails the gate, at any severity, as `npm audit
// --audit-level=low` did. On top of that:
//   * What ships inside the app (dependencies) must be clean. No exception applies there.
//   * A build-time tool (devDependencies) may carry an advisory listed in EXCEPTIONS, and
//     only until its review date. An exception is for an advisory with no patched version
//     to move to; each one says why the build is not exposed. Exceptions are agreed with
//     the maintainer, never added to get a build through.
// A report that cannot be read (no network, npm error) fails the gate too.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const EXCEPTIONS = {
  // Agreed by the maintainer on 2026-11-17 for the 0.13.1 release.
  'GHSA-fc5q-39xc-vjpf': {
    package: 'picomatch',
    reason: 'ReDoS in repeated extglob patterns. No patched picomatch exists: the advisory covers every release up to 4.0.7, the latest (widened 2026-11-17). Reached only through electron-builder (@electron/rebuild, node-gyp, tinyglobby, fdir), which matches the build\'s own file patterns, never outside input.',
    reviewBy: '2027-01-15',
  },
}

function advisoryId(via) {
  const match = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(String(via.url || ''))
  return match ? match[0] : `npm-${via.source}`
}

// The advisories in an `npm audit --json` report. Entries whose `via` is a package name
// only depend on a vulnerable package; the advisory itself is listed under that package.
export function advisories(report) {
  if (!report || typeof report !== 'object' || !report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    throw new Error(`npm audit gave no report${report && report.error ? `: ${report.error.summary || report.error.code || 'error'}` : ''}`)
  }
  const found = new Map()
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of vulnerability.via || []) {
      if (!via || typeof via !== 'object') continue
      const id = advisoryId(via)
      if (!found.has(id)) found.set(id, { id, package: via.name, severity: via.severity, title: via.title, url: via.url })
    }
  }
  return [...found.values()]
}

// full: the report for every dependency; shipped: the report with --omit=dev.
export function evaluate(full, shipped, { today = new Date(), exceptions = EXCEPTIONS } = {}) {
  const problems = []
  const excused = []
  const shippedAdvisories = advisories(shipped)
  for (const a of shippedAdvisories) {
    problems.push(`${a.id} (${a.severity}) in ${a.package} ships in the app: ${a.title}`)
  }
  const shippedIds = new Set(shippedAdvisories.map((a) => a.id))
  for (const a of advisories(full)) {
    if (shippedIds.has(a.id)) continue
    const exception = exceptions[a.id]
    if (!exception) {
      problems.push(`${a.id} (${a.severity}) in ${a.package}: ${a.title} ${a.url || ''}`.trim())
    } else if (exception.package !== a.package) {
      problems.push(`${a.id} is excepted for ${exception.package}, but npm reports it in ${a.package}`)
    } else if (today > new Date(`${exception.reviewBy}T23:59:59Z`)) {
      problems.push(`${a.id} in ${a.package}: its exception was due for review on ${exception.reviewBy}. Check for a patched version, then renew or remove it in scripts/audit-gate.mjs`)
    } else {
      excused.push(`${a.id} (${a.severity}) in ${a.package}, build time only, review by ${exception.reviewBy}: ${exception.reason}`)
    }
  }
  return { ok: problems.length === 0, problems, excused }
}

function audit(args) {
  const result = spawnSync('npm', ['audit', '--json', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`npm audit ${args.join(' ')} did not return JSON (exit ${result.status}): ${String(result.stderr || '').trim().slice(0, 400)}`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { ok, problems, excused } = evaluate(audit([]), audit(['--omit=dev']))
    for (const line of excused) console.log(`excepted: ${line}`)
    for (const line of problems) console.error(`audit: ${line}`)
    console.log(ok ? 'audit gate passed' : 'audit gate failed')
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.error(`audit gate failed: ${e.message}`)
    process.exit(1)
  }
}
