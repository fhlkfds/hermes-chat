#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const TREES = process.env.HERMES_TREES
if (!TREES || !existsSync(join(TREES, 'b200f5bc'))) {
  console.error('Set HERMES_TREES to a folder that holds b200f5bc/, bf0203a/ and f0d9488/ checkouts of hermes-agent.')
  process.exit(2)
}

const COMMITS = [
  { key: 'b200', tree: 'b200f5bc' },
  { key: 'bf02', tree: 'bf0203a' },
  { key: 'f0d9', tree: 'f0d9488' },
]
const COLUMNS = [
  'item', 'kind', 'token',
  'b200_file', 'b200_line', 'bf02_file', 'bf02_line', 'f0d9_file', 'f0d9_line',
  'bf02_status', 'f0d9_status', 'gate', 'app_uses', 'notes',
]
const KINDS = new Set(['rest', 'ws-method', 'ws-event', 'config', 'cli', 'other'])
const STATUSES = new Set(['same', 'differs', 'absent'])
const WINDOW = 2
const REGISTERS_ROUTE_METHOD_OR_EVENT = /@\w*(app|router|api)\w*\.(get|post|put|patch|delete|websocket|api_route)\(|add_api_route|@_?rpc\(|:\d+:(method|event)\(|@method\(|register_method|\.emit\(|_emit\(/

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : readdirSync(here).filter((name) => /^\d\d-.*\.tsv$/.test(name)).sort().map((name) => join(here, name))

let failures = 0
let rows = 0
const fail = (file, line, message) => {
  failures += 1
  console.log(`FAIL ${file}:${line} ${message}`)
}

const sources = new Map()
const linesOf = (path) => {
  if (!sources.has(path)) sources.set(path, existsSync(path) ? readFileSync(path, 'utf8').split('\n') : null)
  return sources.get(path)
}

const grepTree = (tree, token) => {
  try {
    return execFileSync(
      'grep',
      ['-rnF', '--include=*.py', '--include=*.ts', '--include=*.tsx', '--include=*.yaml', '--include=*.yml',
        '--exclude-dir=tests', '--exclude-dir=website', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude=test_*',
        '--', token, '.'],
      { cwd: join(TREES, tree), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ).split('\n').filter(Boolean)
  } catch (error) {
    if (error.status === 1) return []
    throw error
  }
}

for (const file of files) {
  const [header, ...body] = readFileSync(file, 'utf8').replace(/\n+$/, '').split('\n')
  if (header !== COLUMNS.join('\t')) {
    fail(file, 1, `the header is not the expected columns: ${header}`)
    continue
  }
  body.forEach((raw, index) => {
    const lineNo = index + 2
    const cells = raw.split('\t')
    if (cells.length !== COLUMNS.length) return fail(file, lineNo, `${cells.length} cells, want ${COLUMNS.length}`)
    const row = Object.fromEntries(COLUMNS.map((name, i) => [name, cells[i].trim()]))
    rows += 1
    if (!row.item || !row.token) return fail(file, lineNo, 'empty item or token')
    if (!KINDS.has(row.kind)) fail(file, lineNo, `${row.item}: kind "${row.kind}"`)
    for (const key of ['bf02', 'f0d9']) {
      const status = row[`${key}_status`]
      if (!STATUSES.has(status)) fail(file, lineNo, `${row.item}: ${key}_status "${status}"`)
      if ((status === 'absent') !== (row[`${key}_file`] === '')) {
        fail(file, lineNo, `${row.item}: ${key}_status "${status}" disagrees with ${key}_file "${row[`${key}_file`]}"`)
      }
    }
    for (const { key, tree } of COMMITS) {
      const cited = row[`${key}_file`]
      if (cited === '') {
        const hits = grepTree(tree, row.token).filter((hit) => REGISTERS_ROUTE_METHOD_OR_EVENT.test(hit))
        if (hits.length > 0) fail(file, lineNo, `${row.item}: said absent at ${tree}, but "${row.token}" is defined at ${hits.slice(0, 3).join(' | ')}`)
        continue
      }
      const source = linesOf(join(TREES, tree, cited))
      if (source === null) {
        fail(file, lineNo, `${row.item}: ${tree}:${cited} does not exist`)
        continue
      }
      const at = Number(row[`${key}_line`])
      if (!Number.isInteger(at) || at < 1 || at > source.length) {
        fail(file, lineNo, `${row.item}: ${tree}:${cited} has no line "${row[`${key}_line`]}"`)
        continue
      }
      const nearby = source.slice(Math.max(0, at - 1 - WINDOW), at + WINDOW).join('\n')
      if (!nearby.includes(row.token)) {
        fail(file, lineNo, `${row.item}: "${row.token}" is not within ${WINDOW} lines of ${tree}:${cited}:${at} (the line reads: ${source[at - 1].trim().slice(0, 120)})`)
      }
    }
  })
}

console.log(`${rows} rows in ${files.length} file(s), ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
