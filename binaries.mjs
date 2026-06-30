// Resolves the ffmpeg/ffprobe/yt-dlp binaries the exporter needs, without requiring
// the end user to install anything themselves.
//
// ffmpeg and ffprobe come from the `ffmpeg-static`/`ffprobe-static` npm packages,
// which are bundled into the packaged executable at build time (see package.json's
// "pkg.assets"). They never need a network call on the user's machine.
//
// yt-dlp changes too often (YouTube anti-bot workarounds) to bundle a fixed copy
// safely, so it's downloaded from the latest GitHub release the first time it's
// needed and cached locally after that.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs'
import { arch, homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

// When run as plain ESM (dev mode), use import.meta.url. When bundled into a single
// CommonJS file for packaging (see scripts/package.mjs), esbuild empties
// import.meta.url, but the real __dirname Node provides for CJS modules works fine —
// `typeof __dirname` only stays safe here because we never declare our own
// same-named binding in this scope (that would shadow it and break under TDZ).
const appDir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(homedir(), '.power-hour-exporter', 'bin')

function binaryName(base) {
  return platform() === 'win32' ? `${base}.exe` : base
}

function isWorking(path, versionArg) {
  if (!path || !existsSync(path)) return false
  const result = spawnSync(path, [versionArg], { stdio: 'ignore' })
  return !result.error && result.status === 0
}

async function ensureCachedCopy(sourcePath, cachedName) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const cachedPath = join(CACHE_DIR, cachedName)
  if (!existsSync(cachedPath)) {
    copyFileSync(sourcePath, cachedPath)
    if (platform() !== 'win32') chmodSync(cachedPath, 0o755)
  }
  return cachedPath
}

async function downloadFile(url, destPath, onLog) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  const tmpPath = `${destPath}.download`
  await pipeline(response.body, createWriteStream(tmpPath))
  renameSync(tmpPath, destPath)
  onLog?.(`Saved ${destPath}`)
}

// Paths are computed directly (matching ffmpeg-static/ffprobe-static's own internal
// layout) rather than `import()`-ing those packages at runtime. Dynamic `import()` of
// a CJS dependency isn't supported once this file is bundled into the packaged
// executable, but plain fs paths work fine since the packages are embedded as assets.
function ffmpegStaticAssetPath() {
  return join(appDir, 'node_modules', 'ffmpeg-static', binaryName('ffmpeg'))
}

function ffprobeStaticAssetPath() {
  return join(appDir, 'node_modules', 'ffprobe-static', 'bin', platform(), arch(), binaryName('ffprobe'))
}

export async function resolveFfmpeg() {
  const assetPath = ffmpegStaticAssetPath()
  if (existsSync(assetPath)) {
    const cached = await ensureCachedCopy(assetPath, binaryName('ffmpeg'))
    if (isWorking(cached, '-version')) return cached
  }
  if (isWorking('ffmpeg', '-version')) return 'ffmpeg'
  throw new Error('Could not find a working ffmpeg binary. Reinstall the app, or install ffmpeg yourself and make sure it is on your PATH.')
}

export async function resolveFfprobe() {
  const assetPath = ffprobeStaticAssetPath()
  if (existsSync(assetPath)) {
    const cached = await ensureCachedCopy(assetPath, binaryName('ffprobe'))
    if (isWorking(cached, '-version')) return cached
  }
  if (isWorking('ffprobe', '-version')) return 'ffprobe'
  throw new Error('Could not find a working ffprobe binary. Reinstall the app, or install ffmpeg (which includes ffprobe) yourself and make sure it is on your PATH.')
}

function ytDlpAssetName() {
  const os = platform()
  if (os === 'win32') return 'yt-dlp.exe'
  if (os === 'darwin') return 'yt-dlp_macos'
  return arch() === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

export async function resolveYtDlp(onLog) {
  const cachedPath = join(CACHE_DIR, binaryName('yt-dlp'))
  if (isWorking(cachedPath, '--version')) return cachedPath
  if (isWorking('yt-dlp', '--version')) return 'yt-dlp'

  mkdirSync(CACHE_DIR, { recursive: true })
  onLog?.('Downloading yt-dlp (one-time setup)...')
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytDlpAssetName()}`
  await downloadFile(url, cachedPath, onLog)
  if (platform() !== 'win32') chmodSync(cachedPath, 0o755)
  if (!isWorking(cachedPath, '--version')) {
    throw new Error('Downloaded yt-dlp, but it did not run correctly on this machine.')
  }
  onLog?.('yt-dlp ready.')
  return cachedPath
}

export async function resolveAllBinaries(onLog) {
  onLog?.('Checking for ffmpeg...')
  const ffmpegBin = await resolveFfmpeg()
  onLog?.('Checking for ffprobe...')
  const ffprobeBin = await resolveFfprobe()
  onLog?.('Checking for yt-dlp...')
  const ytdlpBin = await resolveYtDlp(onLog)
  return { ffmpegBin, ffprobeBin, ytdlpBin }
}
