#!/usr/bin/env node
// Entry point for the packaged double-click app: resolves ffmpeg/ffprobe/yt-dlp
// (downloading what's missing), starts the GUI server, and opens the browser.
import { resolveAllBinaries } from './binaries.mjs'
import { startServer } from './gui-server.mjs'

async function main() {
  console.log('Power Hour Exporter')
  console.log('Setting up...')

  const binaries = await resolveAllBinaries((line) => console.log(line))

  const portArgIndex = process.argv.indexOf('--port')
  const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 17860

  await startServer({ port, ...binaries, openBrowser: true })

  console.log('Leave this window open while exporting. Close it when you are done.')
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
