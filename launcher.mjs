#!/usr/bin/env node
// Entry point for the packaged double-click app: resolves ffmpeg/ffprobe/yt-dlp
// (downloading what's missing), starts the GUI server, and opens the browser.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAllBinaries } from './binaries.mjs'
import { startServer } from './gui-server.mjs'

const logDir = join(homedir(), '.power-hour-exporter')
const logPath = join(logDir, 'log.txt')

// On Windows the packaged app is launched with no visible console window (see
// power-hour-exporter.vbs), so console output alone isn't visible to the user.
// Mirror everything into a log file they can check if something goes wrong.
function setupLogging() {
  mkdirSync(logDir, { recursive: true })
  writeFileSync(logPath, '')
  const real = { log: console.log, error: console.error }
  const write = (...args) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${args.map(String).join(' ')}\n`)
    } catch {
      // Logging is best-effort — don't let a write failure break the app.
    }
  }
  console.log = (...args) => { real.log(...args); write(...args) }
  console.error = (...args) => { real.error(...args); write(...args) }
}

async function main() {
  setupLogging()
  console.log('Power Hour Exporter')
  console.log(`Log file: ${logPath}`)
  console.log('Setting up...')

  const binaries = await resolveAllBinaries((line) => console.log(line))

  const portArgIndex = process.argv.indexOf('--port')
  const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 17860

  await startServer({ port, ...binaries, openBrowser: true })

  console.log('Quit from the page in your browser when you are done.')
}

main().catch(async (error) => {
  console.error('Failed to start Power Hour Exporter:')
  console.error(error.message)
  process.exitCode = 1
  // On Windows, double-clicking the .exe closes the console window the instant the
  // process exits, so a startup error would flash by unread. Wait for a keypress
  // when running interactively so the message stays visible.
  if (process.stdin.isTTY) {
    console.error('\nPress Enter to close this window.')
    await new Promise((resolvePromise) => process.stdin.once('data', resolvePromise))
  }
})
