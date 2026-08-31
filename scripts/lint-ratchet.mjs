import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { ESLint } from 'eslint'

const root = process.cwd()
const baselinePath = path.join(root, 'config', 'eslint-debt-baseline.json')
const update = process.argv.includes('--update')

function relativeFile(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function keyFor(file, message) {
  const portableMessage = message.message.split(root).join('<root>')
  return JSON.stringify([
    file,
    message.severity,
    message.ruleId ?? '<parser>',
    portableMessage,
  ])
}

function summarize(results) {
  const diagnostics = new Map()
  let errors = 0
  let warnings = 0

  for (const result of results) {
    const file = relativeFile(result.filePath)
    for (const message of result.messages) {
      if (message.severity === 2) errors += 1
      if (message.severity === 1) warnings += 1
      const key = keyFor(file, message)
      diagnostics.set(key, (diagnostics.get(key) ?? 0) + 1)
    }
  }

  return {
    version: 1,
    errors,
    warnings,
    diagnostics: Object.fromEntries([...diagnostics.entries()].sort(([a], [b]) => a.localeCompare(b))),
  }
}

const eslint = new ESLint()
const current = summarize(await eslint.lintFiles(['.']))

if (update) {
  await mkdir(path.dirname(baselinePath), { recursive: true })
  await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
  console.log(`Updated ESLint debt baseline: ${current.errors} errors, ${current.warnings} warnings.`)
  process.exit(0)
}

let baseline
try {
  baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
} catch (error) {
  console.error(`Unable to read ${path.relative(root, baselinePath)}. Run npm run lint:baseline once.`)
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const regressions = []
for (const [key, count] of Object.entries(current.diagnostics)) {
  const allowed = baseline.diagnostics[key] ?? 0
  if (count > allowed) {
    const [file, severity, ruleId, message] = JSON.parse(key)
    regressions.push({ file, severity, ruleId, message, added: count - allowed })
  }
}

if (current.errors > baseline.errors) {
  regressions.push({
    file: '<repository>',
    severity: 2,
    ruleId: '<total-errors>',
    message: `Error count increased from ${baseline.errors} to ${current.errors}.`,
    added: current.errors - baseline.errors,
  })
}

if (current.warnings > baseline.warnings) {
  regressions.push({
    file: '<repository>',
    severity: 1,
    ruleId: '<total-warnings>',
    message: `Warning count increased from ${baseline.warnings} to ${current.warnings}.`,
    added: current.warnings - baseline.warnings,
  })
}

if (regressions.length > 0) {
  console.error('ESLint debt increased:')
  for (const item of regressions) {
    const level = item.severity === 2 ? 'error' : 'warning'
    console.error(`- ${item.file}: ${level} ${item.ruleId} (+${item.added}) ${item.message}`)
  }
  console.error('Fix the new diagnostics. Only update the baseline after reducing existing debt.')
  process.exit(1)
}

const errorReduction = baseline.errors - current.errors
const warningReduction = baseline.warnings - current.warnings
console.log(
  `ESLint debt did not increase: ${current.errors} errors (${errorReduction} removed), ` +
    `${current.warnings} warnings (${warningReduction} removed).`,
)
