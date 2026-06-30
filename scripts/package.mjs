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
import { exec as pkgExec } from '@yao-pkg/pkg'

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

  // Use pkg's programmatic API instead of shelling out to node_modules/.bin/pkg —
  // that shim is a POSIX shell script on every platform (npm always generates one,
  // even on Windows, alongside the .cmd/.ps1 variants), so invoking it directly with
  // `node <path>` fails on Windows runners with a syntax error.
  const previousCwd = process.cwd()
  process.chdir(stageDir)
  try {
    for (const target of targets) {
      console.log(`Packaging ${target}...`)
      if (target.includes('win')) {
        const exePath = join(outDir, 'power-hour-exporter.exe')
        await pkgExec(['bundle.cjs', '--config', 'package.json', '--targets', target, '--output', exePath])
        writeWindowsLauncher(outDir)
      } else if (target.includes('macos')) {
        const arch = target.includes('arm64') ? 'arm64' : 'x64'
        const appDir = join(outDir, `Power Hour Exporter (${arch}).app`)
        const binPath = join(appDir, 'Contents', 'MacOS', 'power-hour-exporter')
        mkdirSync(dirname(binPath), { recursive: true })
        await pkgExec(['bundle.cjs', '--config', 'package.json', '--targets', target, '--output', binPath])
        writeFileSync(join(appDir, 'Contents', 'Info.plist'), macInfoPlist())
      } else {
        await pkgExec(['bundle.cjs', '--config', 'package.json', '--targets', target, '--output', join(outDir, 'power-hour-exporter-linux-x64')])
      }
    }
  } finally {
    process.chdir(previousCwd)
  }

  console.log(`Done. Executables are in ${outDir}`)
}

// A double-clicked .exe always gets a console window on Windows (it's baked into the
// PE subsystem). Shipping a .vbs launcher that runs the exe hidden avoids that, at the
// cost of users needing to launch the .vbs instead of the .exe directly (documented in
// the README). Startup errors and ongoing activity go to ~/.power-hour-exporter/log.txt
// and the browser GUI instead of a console.
function writeWindowsLauncher(outDir) {
  const script = [
    'Set shell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'exeDir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'shell.Run Chr(34) & exeDir & "\\power-hour-exporter.exe" & Chr(34), 0, False'
  ].join('\r\n')
  writeFileSync(join(outDir, 'power-hour-exporter.vbs'), script)
}

// A bare Unix executable double-clicked in Finder opens Terminal.app to run it. A
// minimal .app bundle (just this Info.plist + the binary in Contents/MacOS) makes
// Finder treat it as a real application instead.
function macInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>power-hour-exporter</string>
  <key>CFBundleIdentifier</key>
  <string>club.powerhour.exporter</string>
  <key>CFBundleName</key>
  <string>Power Hour Exporter</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
