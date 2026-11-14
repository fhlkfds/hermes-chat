#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const GIT_DIR = process.env.HERMES_GIT
const HEAD = 'b200f5bc60e31588ba2cb60e288029c4a54ba5fa'
const DEPLOYED = [
  { key: 'bf02', release: 'v0.22.5' },
  { key: 'f0d9', release: 'v0.22.6' },
]

const git = (...args) => {
  const run = spawnSync('git', ['--git-dir', GIT_DIR, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: run.status, out: (run.stdout ?? '').trim() }
}
if (!GIT_DIR || git('cat-file', '-e', `${HEAD}^{commit}`).status !== 0) {
  console.error('Set HERMES_GIT to the git dir of a full clone of hermes-agent that holds b200f5bc.')
  process.exit(2)
}

const releases = git('for-each-ref', '--merged', HEAD, '--sort=creatordate', '--format=%(refname:short)\t%(creatordate:short)', 'refs/tags')
  .out.split('\n').map((line) => line.split('\t'))
  .filter(([name]) => /^v\d/.test(name) && !name.includes('+') && !name.includes('rc'))
  .map(([name, date]) => ({ name, date }))
for (const name of ['v0.22.5', 'v0.22.6', 'v0.22.7']) {
  if (!releases.some((release) => release.name === name)) throw new Error(`the release list has no ${name}`)
}
const indexOfRelease = (name) => releases.findIndex((release) => release.name === name)

const grep = (rev, token, pathspecs) => {
  const run = git('grep', '-F', '-q', '-e', token, rev, '--', ...pathspecs)
  if (run.status !== 0 && run.status !== 1) throw new Error(`git grep failed at ${rev} for ${token}`)
  return run.status === 0
}
const fileExists = (rev, path) => git('cat-file', '-e', `${rev}:${path}`).status === 0
const firstIndex = (test) => {
  let low = 0
  let high = releases.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (test(releases[mid].name)) high = mid
    else low = mid + 1
  }
  return low
}
const stamp = (release) => `\`${release.name}\` (${release.date})`

const firstReleaseElsewhere = (token, extension, movedIn) => {
  const anyFile = [`*${extension}`, ':!tests', ':!website']
  const earliest = firstIndex((rev) => grep(rev, token, anyFile))
  return { label: `${stamp(releases[earliest])}${earliest === 0 ? ' or earlier' : ''}, in another file until \`${movedIn.name}\``, index: earliest }
}

const firstReleaseInCitedFiles = (token, citedFiles) => {
  if (!grep(HEAD, token, citedFiles)) return { label: 'INCONCLUSIVE: the token is not in the cited file at b200f5bc', index: -1 }
  const index = firstIndex((rev) => grep(rev, token, citedFiles))
  const citedFilesAreNew = index > 0 && !citedFiles.some((path) => fileExists(releases[index - 1].name, path))
  if (citedFilesAreNew) {
    const extension = extname(citedFiles[0]) || '.py'
    if (grep(releases[index - 1].name, token, [`*${extension}`, ':!tests', ':!website'])) {
      return firstReleaseElsewhere(token, extension, releases[index])
    }
  }
  return { label: `${stamp(releases[index])}${index === 0 ? ' or earlier' : ''}`, index }
}

const out = ['file\titem\ttoken\tadded_in']
let inconclusive = 0
let contradictions = 0

for (const tsv of readdirSync(here).filter((name) => /^\d\d-.*\.tsv$/.test(name)).sort()) {
  const [header, ...body] = readFileSync(join(here, tsv), 'utf8').replace(/\n+$/, '').split('\n')
  const columns = header.split('\t')
  for (const line of body) {
    const row = Object.fromEntries(line.split('\t').map((cell, i) => [columns[i], cell.trim()]))
    let label = 'Not in Hermes'
    if (row.b200_file !== '') {
      const found = firstReleaseInCitedFiles(row.token, [...new Set([row.b200_file, row.f0d9_file, row.bf02_file].filter(Boolean))])
      label = found.label
      if (found.index === -1) inconclusive += 1
      else {
        for (const { key, release } of DEPLOYED) {
          const present = row[`${key}_status`] !== 'absent'
          if (present !== (found.index <= indexOfRelease(release))) {
            contradictions += 1
            console.log(`CONTRADICTION ${tsv}: "${row.item}" is ${row[`${key}_status`]} at ${release} in the survey, but history dates it ${label}`)
          }
        }
      }
    }
    out.push([tsv, row.item, row.token, label].join('\t'))
  }
}

writeFileSync(join(here, 'added.tsv'), `${out.join('\n')}\n`)
console.log(`${releases.length} releases from ${releases[0].name} to ${releases.at(-1).name}`)
console.log(`${out.length - 1} rows, ${inconclusive} inconclusive, ${contradictions} contradiction(s)`)
process.exit(inconclusive === 0 && contradictions === 0 ? 0 : 1)
