#!/usr/bin/env node
// Builds the standalone double-click executables.
//
// pkg's bytecode compilation of multiple ESM ".mjs" files is unreliable (it can
// produce broken output that throws at runtime), so instead of handing pkg the raw
// source files we first bundle everything into a single CommonJS file with esbuild
// (pkg's original, well-supported use case), then run pkg on just that one file.
//
// The ffmpeg-static/ffprobe-static binaries can't be inlined by esbuild (they're not
// JS), so they're copied next to the bundle and embedded via pkg's "assets" instead.
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const stageDir = join(rootDir, 'dist', 'stage')
const outDir = join(rootDir, 'dist', 'bin')

const ALL_TARGETS = {
  linux: 'node22-linux-x64',
  'macos-x64': 'node22-macos-x64',
  'macos-arm64': 'node22-macos-arm64',
  win: 'node22-win-x64'
}

async function main() {
  const requested = process.argv.slice(2)
  const targets = requested.length > 0
    ? requested.map((name) => {
      const target = ALL_TARGETS[name]
      if (!target) throw new Error(`Unknown target "${name}". Known targets: ${Object.keys(ALL_TARGETS).join(', ')}`)
      return target
    })
    : Object.values(ALL_TARGETS)

  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  console.log('Bundling app into a single CommonJS file...')
  await build({
    entryPoints: [join(rootDir, 'launcher.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: join(stageDir, 'bundle.cjs'),
    logLevel: 'info'
  })

  console.log('Copying ffmpeg/ffprobe static binaries...')
  cpSync(join(rootDir, 'node_modules', 'ffmpeg-static'), join(stageDir, 'node_modules', 'ffmpeg-static'), { recursive: true })
  cpSync(join(rootDir, 'node_modules', 'ffprobe-static'), join(stageDir, 'node_modules', 'ffprobe-static'), { recursive: true })

  writeFileSync(join(stageDir, 'package.json'), JSON.stringify({
    name: 'power-hour-exporter',
    version: '1.0.0',
    bin: 'bundle.cjs',
    pkg: {
      assets: [
        'node_modules/ffmpeg-static/**/*',
        'node_modules/ffprobe-static/**/*'
      ]
    }
  }, null, 2))

  for (const target of targets) {
    const outputName = target.includes('win') ? 'power-hour-exporter.exe' : `power-hour-exporter-${target.replace('node22-', '')}`
    console.log(`Packaging ${target}...`)
    const result = spawnSync('node', [
      join(rootDir, 'node_modules', '.bin', 'pkg'),
      'bundle.cjs',
      '--config', 'package.json',
      '--targets', target,
      '--output', join(outDir, outputName)
    ], { cwd: stageDir, stdio: 'inherit' })
    if (result.status !== 0) {
      throw new Error(`pkg failed for target ${target} (exit ${result.status})`)
    }
  }

  console.log(`Done. Executables are in ${outDir}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
