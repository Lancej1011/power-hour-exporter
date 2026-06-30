#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov', '.m4v']
const AUDIO_EXTENSIONS = ['.m4a', '.mp3', '.aac', '.wav', '.flac', '.ogg', '.opus']
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]

const DEFAULT_VIDEO_FILTER = [
  'scale=1280:720:force_original_aspect_ratio=decrease',
  'pad=1280:720:(ow-iw)/2:(oh-ih)/2',
  'setsar=1',
  'format=yuv420p'
].join(',')

const usage = `Power Hour Exporter

Usage:
  node tools/power-hour-exporter/exporter.mjs render <playlist.json> --media <dir> --out <file>
  node tools/power-hour-exporter/exporter.mjs inspect <playlist.json>
  node tools/power-hour-exporter/exporter.mjs list <backup-or-playlist.json>

Options:
  --media <dir>       Directory containing source media files named by YouTube/source id.
                      May be provided more than once.
  --out <file>        Output file. Defaults to "<playlist-name>.mp4".
  --audio-only        Render audio only.
  --format <format>   mp4, m4a, or mp3. Inferred from --out when omitted.
  --playlist-id <id>  Pick a playlist from a backup/export containing many playlists.
  --playlist-name <n> Pick a playlist by exact or case-insensitive name.
  --playlist-index <i>
                      Pick a playlist by zero-based index from a backup/export.
  --download          Use yt-dlp to fetch missing source media. Only use for content
                      you own, control, or are otherwise authorized to download.
  --download-sections With --download, ask yt-dlp to download each needed segment
                      time range instead of full source media. Requires ffmpeg.
  --yt-dlp-bin <bin>  yt-dlp binary. Defaults to "yt-dlp".
  --ffmpeg-bin <bin>  ffmpeg binary. Defaults to "ffmpeg".
  --ffprobe-bin <bin> ffprobe binary. Defaults to "ffprobe".
  --workdir <dir>     Temp/download directory. Defaults to ".power-hour-export".
  --keep-temp         Keep intermediate clips and concat list.
  --dry-run           Validate and print the render plan without invoking ffmpeg.
  --concurrency <n>   Number of segments to download in parallel. Defaults to 3.
  --progress-events   Emit machine-readable progress lines (used by the GUI server).
  --no-fade           Disable the fade-to-black transition between clips (on by default,
                      matching the site's playback transition).
  --fade-duration <s> Fade duration in seconds. Defaults to 0.4.
  --help              Show this help.

Examples:
  node tools/power-hour-exporter/exporter.mjs list ./playlists.json
  node tools/power-hour-exporter/exporter.mjs inspect ./playlist.json
  node tools/power-hour-exporter/exporter.mjs inspect ./playlists.json --playlist-name "TV Tunes"
  node tools/power-hour-exporter/exporter.mjs render ./playlist.json --media ./media --out ./exports/hour.mp4
  node tools/power-hour-exporter/exporter.mjs render ./playlists.json --playlist-id 3cSQX2hlxcD9Dt7q2UoC --out ./exports/tv-tunes.mp4
  node tools/power-hour-exporter/exporter.mjs render ./playlist.json --media ./media --download --out ./exports/hour.m4a --audio-only
  node tools/power-hour-exporter/exporter.mjs render ./playlist.json --download --download-sections --out ./exports/hour.mp4
`

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(usage)
    return
  }

  const command = argv.shift()
  const input = argv.shift()
  if (!input || !['list', 'inspect', 'render'].includes(command)) {
    fail('Expected "list <json>", "inspect <playlist.json>", or "render <playlist.json>".')
  }

  const options = parseOptions(argv)
  if (command === 'list') {
    printPlaylistsCommand(input)
    return
  }

  const playlist = readPlaylist(input, options)
  const segments = buildSegments(playlist)

  if (command === 'inspect' || options.dryRun) {
    printPlan(playlist, segments)
    if (command === 'inspect') return
  }

  if (command === 'render') {
    await renderPlaylist(playlist, segments, options)
  }
}

function defaultOptions() {
  return {
    mediaDirs: [],
    output: '',
    audioOnly: false,
    format: '',
    playlistId: '',
    playlistName: '',
    playlistIndex: undefined,
    download: false,
    downloadSections: false,
    ytdlpBin: 'yt-dlp',
    ffmpegBin: 'ffmpeg',
    ffprobeBin: 'ffprobe',
    workdir: '.power-hour-export',
    keepTemp: false,
    dryRun: false,
    concurrency: 3,
    progressEvents: false,
    fade: true,
    fadeDuration: 0.4,
    onProgress: undefined
  }
}

function parseOptions(argv) {
  const options = defaultOptions()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--media') options.mediaDirs.push(nextValue(argv, ++index, arg))
    else if (arg === '--out') options.output = nextValue(argv, ++index, arg)
    else if (arg === '--audio-only') options.audioOnly = true
    else if (arg === '--format') options.format = nextValue(argv, ++index, arg).toLowerCase()
    else if (arg === '--playlist-id') options.playlistId = nextValue(argv, ++index, arg)
    else if (arg === '--playlist-name') options.playlistName = nextValue(argv, ++index, arg)
    else if (arg === '--playlist-index') options.playlistIndex = parsePlaylistIndex(nextValue(argv, ++index, arg))
    else if (arg === '--download') options.download = true
    else if (arg === '--download-sections') options.downloadSections = true
    else if (arg === '--yt-dlp-bin') options.ytdlpBin = nextValue(argv, ++index, arg)
    else if (arg === '--ffmpeg-bin') options.ffmpegBin = nextValue(argv, ++index, arg)
    else if (arg === '--ffprobe-bin') options.ffprobeBin = nextValue(argv, ++index, arg)
    else if (arg === '--workdir') options.workdir = nextValue(argv, ++index, arg)
    else if (arg === '--keep-temp') options.keepTemp = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--concurrency') options.concurrency = parseConcurrency(nextValue(argv, ++index, arg))
    else if (arg === '--progress-events') options.progressEvents = true
    else if (arg === '--no-fade') options.fade = false
    else if (arg === '--fade-duration') options.fadeDuration = parseFadeDuration(nextValue(argv, ++index, arg))
    else fail(`Unknown option: ${arg}`)
  }

  options.mediaDirs = options.mediaDirs.map((dir) => resolve(dir))
  options.workdir = resolve(options.workdir)
  if (options.output) options.output = resolve(options.output)
  if (options.downloadSections) options.download = true
  return options
}

function parseConcurrency(value) {
  const concurrency = Number(value)
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail(`Invalid --concurrency value: ${value}`)
  }
  return concurrency
}

function parseFadeDuration(value) {
  const duration = Number(value)
  if (!Number.isFinite(duration) || duration < 0) {
    fail(`Invalid --fade-duration value: ${value}`)
  }
  return duration
}

function parsePlaylistIndex(value) {
  const index = Number(value)
  if (!Number.isInteger(index) || index < 0) {
    fail(`Invalid --playlist-index value: ${value}`)
  }
  return index
}

function nextValue(argv, index, optionName) {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    fail(`Missing value for ${optionName}.`)
  }
  return value
}

function readPlaylist(inputPath, options) {
  const playlists = extractPlaylistCandidates(readJson(inputPath))
  if (playlists.length === 0) {
    fail('No playlists found in JSON. Expected a playlist object, an items[] export, or a Firestore backup with documents[].')
  }

  const picked = pickPlaylist(playlists, options)
  if (picked) return picked

  printPlaylistList(playlists)
  fail('JSON contains multiple playlists. Re-run with --playlist-id, --playlist-name, or --playlist-index.')
}

function pickPlaylist(playlists, options) {
  if (options.playlistId) {
    const match = playlists.find((playlist) => playlist.id === options.playlistId || playlist.originalId === options.playlistId)
    if (!match) fail(`No playlist found with id: ${options.playlistId}`)
    return match
  }

  if (options.playlistName) {
    const normalized = options.playlistName.trim().toLowerCase()
    const match = playlists.find((playlist) => String(playlist.name || '').trim().toLowerCase() === normalized)
      || playlists.find((playlist) => String(playlist.name || '').toLowerCase().includes(normalized))
    if (!match) fail(`No playlist found with name: ${options.playlistName}`)
    return match
  }

  if (typeof options.playlistIndex === 'number') {
    const match = playlists[options.playlistIndex]
    if (!match) fail(`No playlist found at index: ${options.playlistIndex}`)
    return match
  }

  if (playlists.length === 1) return playlists[0]

  return null
}

function readJson(inputPath) {
  const absolute = resolve(inputPath)
  if (!existsSync(absolute)) fail(`Playlist JSON not found: ${absolute}`)

  let data
  try {
    data = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch (error) {
    fail(`Could not parse JSON: ${error.message}`)
  }

  if (data?.content && data?.mimeType === 'application/json') {
    try {
      data = JSON.parse(data.content)
    } catch (error) {
      fail(`Could not parse wrapped JSON export content: ${error.message}`)
    }
  }

  if (!data || typeof data !== 'object') fail('Playlist JSON must be an object.')
  return data
}

function extractPlaylistCandidates(data) {
  if (!data || typeof data !== 'object') return []

  if (isRenderablePlaylist(data)) return [data]

  const arrays = []
  if (Array.isArray(data)) arrays.push(data)
  if (Array.isArray(data.items)) arrays.push(data.items)
  if (Array.isArray(data.playlists)) arrays.push(data.playlists)
  if (Array.isArray(data.documents)) arrays.push(data.documents)

  const candidates = arrays
    .flat()
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      if (entry.data && typeof entry.data === 'object') return { id: entry.id || entry.data.id, ...entry.data }
      return entry
    })
    .filter((entry) => entry && typeof entry === 'object' && looksLikePlaylist(entry))

  return candidates
}

function isRenderablePlaylist(value) {
  return looksLikePlaylist(value) && (
    hasArray(value.items) ||
    hasArray(value.musicClips) ||
    hasArray(value.clips) ||
    hasArray(value.videos)
  )
}

function looksLikePlaylist(value) {
  return !!value && typeof value === 'object' && (
    typeof value.name === 'string' ||
    hasArray(value.items) ||
    hasArray(value.musicClips) ||
    hasArray(value.clips) ||
    hasArray(value.videos) ||
    hasArray(value.playOrder)
  )
}

function hasArray(value) {
  return Array.isArray(value) && value.length > 0
}

function printPlaylistsCommand(inputPath) {
  const playlists = extractPlaylistCandidates(readJson(inputPath))
  if (playlists.length === 0) {
    console.log('No playlists found.')
    return
  }
  printPlaylistList(playlists)
}

// Library API for embedding (used by gui-server.mjs / launcher.mjs instead of
// shelling out to a second process, which doesn't work once this is bundled into
// a single packaged executable).

export function listPlaylists(inputPath) {
  return extractPlaylistCandidates(readJson(inputPath)).map((playlist, index) => ({
    index,
    id: playlist.id || playlist.originalId || '',
    name: playlist.name || 'Playlist',
    clipCount: playlist.items?.length || playlist.musicClips?.length || playlist.clips?.length || playlist.videos?.length || playlist.clipCount || 0
  }))
}

export async function renderExport(inputPath, overrides = {}) {
  const options = { ...defaultOptions(), ...overrides }
  options.mediaDirs = (options.mediaDirs || []).map((dir) => resolve(dir))
  options.workdir = resolve(options.workdir)
  if (options.output) options.output = resolve(options.output)
  if (options.downloadSections) options.download = true

  const playlists = extractPlaylistCandidates(readJson(inputPath))
  if (playlists.length === 0) {
    fail('No playlists found in JSON. Expected a playlist object, an items[] export, or a Firestore backup with documents[].')
  }
  const playlist = pickPlaylist(playlists, options) || playlists[0]
  const segments = buildSegments(playlist)
  await renderPlaylist(playlist, segments, options)
  return options.output
}

function printPlaylistList(playlists) {
  playlists.forEach((playlist, index) => {
    const clipCount = playlist.items?.length || playlist.musicClips?.length || playlist.clips?.length || playlist.videos?.length || playlist.clipCount || 0
    const id = playlist.id || playlist.originalId || '(no-id)'
    const name = playlist.name || '(untitled)'
    console.log(`${String(index).padStart(3, '0')}  ${id}  ${clipCount} clips  ${name}`)
  })
}

function buildSegments(playlist) {
  const musicSegments = getMusicSegments(playlist)
  const segments = []

  for (const [index, music] of musicSegments.entries()) {
    segments.push({ ...music, sequence: segments.length })
    const drinking = getDrinkingSegmentForMinute(playlist, index)
    if (drinking) {
      segments.push({ ...drinking, sequence: segments.length })
    }
  }

  if (segments.length === 0) {
    fail('No renderable music segments found in playlist JSON.')
  }

  return segments
}

function getMusicSegments(playlist) {
  if (Array.isArray(playlist.items) && playlist.items.length > 0) {
    return playlist.items
      .filter((item) => ['music', 'video'].includes(item?.type))
      .sort((a, b) => numberOr(a.order, 0) - numberOr(b.order, 0))
      .map((item, index) => {
        const source = item.source || {}
        const sourceId = extractSourceId({
          ...source,
          youtubeId: source.youtubeId || source.videoId || source.id,
          url: source.url || source.originalUrl
        })
        const startTime = numberOr(item.startTime, numberOr(source.startTime, 0))
        const duration = resolveDuration(item, source, playlist)
        return buildSegment({
          type: 'music',
          source,
          sourceId,
          title: item.customTitle || source.title || `Track ${index + 1}`,
          startTime,
          duration,
          order: numberOr(item.order, index)
        })
      })
      .filter(Boolean)
  }

  const musicClips = Array.isArray(playlist.musicClips) && playlist.musicClips.length > 0
    ? playlist.musicClips
    : Array.isArray(playlist.clips) && playlist.clips.length > 0
      ? playlist.clips
      : Array.isArray(playlist.videos)
        ? playlist.videos
        : []

  if (Array.isArray(playlist.playOrder) && playlist.playOrder.length > 0 && Array.isArray(playlist.musicClips)) {
    const byId = new Map(playlist.musicClips.map((clip) => [clip.id, clip]))
    return playlist.playOrder
      .filter((item) => item?.type === 'music')
      .sort((a, b) => numberOr(a.order, 0) - numberOr(b.order, 0))
      .map((orderItem, index) => {
        const clip = byId.get(orderItem.clipId)
        if (!clip) return null
        return clipToMusicSegment(clip, playlist, numberOr(orderItem.order, index), orderItem)
      })
      .filter(Boolean)
  }

  return musicClips.map((clip, index) => clipToMusicSegment(clip, playlist, index)).filter(Boolean)
}

function clipToMusicSegment(clip, playlist, order, orderItem = {}) {
  const source = clip.source || clip
  const sourceId = extractSourceId({
    ...clip,
    ...source,
    url: clip.url || clip.youtubeUrl || source.originalUrl || source.url
  })
  if (!sourceId && !source.url && !clip.url) return null

  const startTime = numberOr(clip.startTime, numberOr(source.startTime, 0))
  const duration = numberOr(orderItem.customDuration, numberOr(orderItem.duration, resolveDuration(clip, source, playlist)))

  return buildSegment({
    type: 'music',
    source,
    sourceId,
    title: clip.title || clip.name || source.title || `Track ${order + 1}`,
    startTime,
    duration,
    order,
    url: clip.url || clip.youtubeUrl || source.originalUrl || source.url
  })
}

function getDrinkingSegmentForMinute(playlist, minuteIndex) {
  const embedded = playlist.drinkingClipConfig
  if (embedded && (embedded.rotation?.length || embedded.pins?.length)) {
    const clip = resolveDrinkingClipFromConfig(embedded, minuteIndex)
    if (clip) return clipToDrinkingSegment(clip, minuteIndex)
  }

  if (playlist.drinkingSound) {
    const clip = parseMaybeJson(playlist.drinkingSound)
    if (clip) return clipToDrinkingSegment(clip, minuteIndex)
  }

  if (playlist.drinkingClipId && Array.isArray(playlist.drinkingClips)) {
    const clip = playlist.drinkingClips.find((item) => item.id === playlist.drinkingClipId)
    if (clip) return clipToDrinkingSegment(clip, minuteIndex)
  }

  if (Array.isArray(playlist.drinkingClips) && playlist.drinkingClips.length === 1) {
    return clipToDrinkingSegment(playlist.drinkingClips[0], minuteIndex)
  }

  return null
}

function resolveDrinkingClipFromConfig(config, minuteIndex) {
  const pinned = (config.pins || []).find((pin) => numberOr(pin.minute, -1) === minuteIndex)
  const clipId = pinned?.clipId || (config.rotation || [])[minuteIndex % (config.rotation || []).length]
  if (!clipId) return null
  return (config.clips || []).find((clip) => clip.id === clipId) || null
}

function clipToDrinkingSegment(clip, minuteIndex) {
  const source = clip.source || clip
  const sourceId = extractSourceId({
    ...clip,
    ...source,
    url: source.originalUrl || source.url || clip.url
  })
  if (!sourceId && !source.url && !clip.url) return null

  const startTime = numberOr(source.startTime, numberOr(clip.startTime, 0))
  const duration = resolveDuration(clip, source, { settings: { videoDuration: clip.duration || 5 } })

  return buildSegment({
    type: 'drinking',
    source,
    sourceId,
    title: clip.name || source.title || `Drinking clip ${minuteIndex + 1}`,
    startTime,
    duration,
    order: minuteIndex,
    url: source.originalUrl || source.url || clip.url
  })
}

function buildSegment({ type, source, sourceId, title, startTime, duration, order, url }) {
  const finalUrl = url || source.originalUrl || source.url || (sourceId ? `https://www.youtube.com/watch?v=${sourceId}` : '')
  return {
    type,
    sourceId: sourceId || safeName(title),
    title,
    url: finalUrl,
    startTime: Math.max(0, Number(startTime) || 0),
    duration: Math.max(0.25, Number(duration) || 60),
    order,
    sourceType: source.type || 'youtube'
  }
}

function resolveDuration(item, source, playlist) {
  const startTime = numberOr(item.startTime, numberOr(source.startTime, 0))
  const endTime = numberOr(item.endTime, numberOr(source.endTime, undefined))
  if (typeof endTime === 'number' && endTime > startTime) return endTime - startTime
  return numberOr(
    item.duration,
    item.clipDuration,
    source.clipDuration,
    playlist?.settings?.videoDuration,
    60
  )
}

function extractSourceId(value) {
  return value.youtubeId ||
    value.videoId ||
    value.sourceId ||
    value.id ||
    extractYouTubeId(value.originalUrl || value.youtubeUrl || value.url || '')
}

function extractYouTubeId(url) {
  if (!url || typeof url !== 'string') return ''
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{6,})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{6,})/
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return ''
}

function reportProgress(options, phase, current, total, label) {
  const evt = { phase, current, total, label }
  options.onProgress?.(evt)
  if (options.progressEvents) {
    console.log(`@@PHP_PROGRESS@@${JSON.stringify(evt)}`)
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function runNext() {
    while (true) {
      const current = nextIndex
      nextIndex += 1
      if (current >= items.length) return
      results[current] = await worker(items[current], current)
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, runNext))
  return results
}

async function renderPlaylist(playlist, segments, options) {
  const format = resolveFormat(options)
  const output = options.output || resolve(`${safeName(playlist.name || 'power-hour')}.${format}`)
  const outputDir = dirname(output)
  mkdirSync(outputDir, { recursive: true })
  mkdirSync(options.workdir, { recursive: true })

  const tempDir = join(options.workdir, `render-${Date.now()}`)
  const downloadsDir = join(options.workdir, 'downloads')
  const sectionDownloadsDir = join(options.workdir, 'section-downloads')
  mkdirSync(tempDir, { recursive: true })
  mkdirSync(downloadsDir, { recursive: true })
  mkdirSync(sectionDownloadsDir, { recursive: true })

  if (options.download) {
    console.warn('Download mode is enabled. Only use it for content you own, control, or are authorized to download.')
  }

  let downloadedCount = 0
  reportProgress(options, 'download', 0, segments.length, 'Starting downloads')
  const resolvedSegments = await mapWithConcurrency(segments, options.concurrency, async (segment) => {
    const resolved = await resolveSegmentMedia(segment, options, downloadsDir, sectionDownloadsDir)
    downloadedCount += 1
    reportProgress(options, 'download', downloadedCount, segments.length, segment.title)
    return resolved
  })

  const missing = resolvedSegments.filter((segment) => !segment.inputPath)
  if (missing.length > 0) {
    const lines = missing.map((segment) => `- ${segment.type}: ${segment.title} (${segment.sourceId})`)
    fail(`Missing source media for ${missing.length} segment(s):\n${lines.join('\n')}`)
  }

  if (options.dryRun) return

  reportProgress(options, 'render', 0, resolvedSegments.length, 'Starting render')
  const clipPaths = resolvedSegments.map((segment, index) => {
    const clipPath = join(tempDir, `${String(index + 1).padStart(3, '0')}-${segment.type}.${format === 'mp4' ? 'mp4' : 'm4a'}`)
    renderSegment(segment, clipPath, format, options)
    reportProgress(options, 'render', index + 1, resolvedSegments.length, segment.title)
    return clipPath
  })

  reportProgress(options, 'concat', 0, 1, 'Combining segments')
  const listPath = join(tempDir, 'concat.txt')
  writeFileSync(listPath, clipPaths.map((clipPath) => `file '${escapeConcatPath(clipPath)}'`).join('\n'))

  const concatArgs = ['-hide_banner', '-loglevel', 'warning', '-y', '-f', 'concat', '-safe', '0', '-i', listPath]
  if (format === 'mp4') {
    concatArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output)
  } else if (format === 'mp3') {
    concatArgs.push('-vn', '-c:a', 'libmp3lame', '-b:a', '192k', output)
  } else {
    concatArgs.push('-vn', '-c:a', 'aac', '-b:a', '192k', output)
  }
  run(options.ffmpegBin, concatArgs)
  reportProgress(options, 'concat', 1, 1, 'Combined segments')

  if (options.keepTemp) {
    console.log(`Temporary files kept in ${tempDir}`)
  } else {
    rmSync(tempDir, { recursive: true, force: true })
  }

  console.log(`Rendered ${resolvedSegments.length} segments to ${output}`)
}

function resolveFormat(options) {
  if (options.format) return validateFormat(options.format)
  if (options.output) {
    const inferred = extname(options.output).slice(1).toLowerCase()
    if (inferred) return validateFormat(inferred)
  }
  return options.audioOnly ? 'm4a' : 'mp4'
}

function validateFormat(format) {
  if (!['mp4', 'm4a', 'mp3'].includes(format)) {
    fail(`Unsupported output format "${format}". Use mp4, m4a, or mp3.`)
  }
  return format
}

async function resolveSegmentMedia(segment, options, downloadsDir, sectionDownloadsDir) {
  const local = findLocalMedia(segment, options.mediaDirs)
  if (local) return { ...segment, inputPath: local }
  if (!options.download || !segment.url) return { ...segment, inputPath: '' }

  if (options.downloadSections) {
    const sectionPath = await downloadSection(segment, options, sectionDownloadsDir)
    return sectionPath
      ? { ...segment, inputPath: sectionPath, startTime: 0 }
      : { ...segment, inputPath: '' }
  }

  const outputTemplate = join(downloadsDir, `${segment.sourceId}.%(ext)s`)
  await runAsync(options.ytdlpBin, ['--no-playlist', '-f', ytdlpFormat(options), '-o', outputTemplate, segment.url])
  return { ...segment, inputPath: findLocalMedia(segment, [downloadsDir]) }
}

async function downloadSection(segment, options, sectionDownloadsDir) {
  // Sections are always fetched in video format (regardless of --audio-only) so a
  // later audio-only render of the same playlist can reuse this download instead of
  // re-fetching the clip from the source a second time.
  const sectionId = buildSectionDownloadId(segment)
  const sectionSegment = { ...segment, sourceId: sectionId }
  const existing = findLocalMedia(sectionSegment, [sectionDownloadsDir])
  if (existing && validateDownloadedSection(existing, segment, options, false)) {
    console.log(`Reusing downloaded section ${segment.sequence + 1} (${formatClock(segment.startTime)}-${formatClock(segment.startTime + segment.duration)})`)
    return existing
  }
  if (existing) rmSync(existing, { force: true })

  const start = formatTimestamp(segment.startTime)
  const end = formatTimestamp(segment.startTime + segment.duration)
  const outputTemplate = join(sectionDownloadsDir, `${sectionId}.%(ext)s`)
  const args = [
      '--no-playlist',
      '--no-progress',
      '--retries',
      '10',
      '--fragment-retries',
      '10',
      '--extractor-retries',
      '3',
      '--file-access-retries',
      '5',
      '-f',
      sectionYtdlpFormat(),
      '--download-sections',
      `*${start}-${end}`,
      '--force-keyframes-at-cuts',
      '-o',
      outputTemplate,
      segment.url
    ]

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log(`Downloading section ${segment.sequence + 1} (${formatClock(segment.startTime)}-${formatClock(segment.startTime + segment.duration)}), attempt ${attempt}/3`)
    const result = await runAsyncMaybe(options.ytdlpBin, args)
    const downloaded = findLocalMedia(sectionSegment, [sectionDownloadsDir])
    if (result.status === 0 && downloaded && validateDownloadedSection(downloaded, segment, options, true)) {
      return downloaded
    }
    if (downloaded) rmSync(downloaded, { force: true })
    if (result.status !== 0) {
      console.warn(`yt-dlp section download failed with exit code ${result.status}; retrying...`)
    }
  }

  fail(`Could not download a complete ${formatClock(segment.duration)} section for "${segment.title}" (${segment.sourceId}). Try again, or run without --download-sections if you are authorized to download the full source.`)
}

function buildSectionDownloadId(segment) {
  const start = formatTimestamp(segment.startTime)
  const end = formatTimestamp(segment.startTime + segment.duration)
  const cacheSource = [
    segment.type,
    segment.sourceId,
    segment.url,
    start,
    end
  ].join('|')
  const cacheHash = createHash('sha1').update(cacheSource).digest('hex').slice(0, 12)
  return [
    segment.type,
    safeName(segment.sourceId),
    safeName(`${start}-${end}`),
    cacheHash
  ].join('-')
}

function ytdlpFormat(options) {
  if (options.audioOnly) return 'ba[ext=m4a]/ba/bestaudio/best'
  return 'bv*[height<=720]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/best'
}

function sectionYtdlpFormat() {
  return 'bv*[height<=720]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/best'
}

function validateDownloadedSection(filePath, segment, options, verbose) {
  const actualDuration = probeDuration(filePath, options.ffprobeBin)
  if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
    if (verbose) console.warn(`Downloaded section is unreadable: ${filePath}`)
    return false
  }

  const tolerance = Math.max(0.5, Math.min(1.25, segment.duration * 0.02))
  const minimumDuration = Math.max(0.1, segment.duration - tolerance)
  if (actualDuration + 0.01 < minimumDuration) {
    console.warn(
      `Downloaded section is too short for "${segment.title}": expected ${formatClock(segment.duration)}, got ${formatClock(actualDuration)}.`
    )
    return false
  }

  if (!validateDecodable(filePath, options.ffmpegBin, verbose)) {
    return false
  }

  return true
}

function validateDecodable(filePath, ffmpegBin, verbose) {
  // Use loglevel "warning" (not "error") because corrupted/incomplete fragments
  // typically decode with concealment ("concealing N DC/AC/MV errors", "corrupt
  // decoded frame", "co located POCs unavailable", etc.) which ffmpeg logs as
  // warnings, not errors. At -v error those frames silently pass through as
  // visually corrupted (blocky/green) output instead of failing validation.
  const result = spawnSync(ffmpegBin, [
    '-v',
    'warning',
    '-nostats',
    '-i',
    filePath,
    '-f',
    'null',
    '-'
  ], { encoding: 'utf8' })
  const stderr = String(result.stderr || '').trim()
  if (result.error || result.status !== 0 || stderr.length > 0) {
    if (verbose) {
      const reason = result.error?.message || stderr || `ffmpeg exited with ${result.status}`
      console.warn(`Downloaded section failed decode validation: ${reason}`)
    }
    return false
  }
  return true
}

function probeDuration(filePath, ffprobeBin) {
  const result = spawnSync(ffprobeBin, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath
  ], { encoding: 'utf8' })
  if (result.error || result.status !== 0) return NaN
  return Number.parseFloat(String(result.stdout || '').trim())
}

function findLocalMedia(segment, mediaDirs) {
  const candidates = []
  for (const mediaDir of mediaDirs) {
    for (const ext of MEDIA_EXTENSIONS) {
      candidates.push(join(mediaDir, `${segment.sourceId}${ext}`))
      candidates.push(join(mediaDir, `${safeName(segment.title)}${ext}`))
    }
    candidates.push(join(mediaDir, basename(segment.url || '')))
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) || ''
}

function buildFadeFilters(segment, options) {
  const videoFadeDuration = options.fade ? Math.min(options.fadeDuration, segment.duration / 2) : 0
  if (videoFadeDuration <= 0) return { videoFilter: '', audioFilter: '' }

  const videoFadeOutStart = Math.max(0, segment.duration - videoFadeDuration)
  const videoFilter = [
    `fade=t=in:st=0:d=${formatSeconds(videoFadeDuration)}`,
    `fade=t=out:st=${formatSeconds(videoFadeOutStart)}:d=${formatSeconds(videoFadeDuration)}`
  ].join(',')

  // A short audio fade avoids an audible click at each cut. The site itself has no
  // audio fade (clips just cut), so keep this much shorter than the video fade.
  const audioFadeDuration = Math.min(0.05, segment.duration / 2)
  const audioFadeOutStart = Math.max(0, segment.duration - audioFadeDuration)
  const audioFilter = [
    `afade=t=in:st=0:d=${formatSeconds(audioFadeDuration)}`,
    `afade=t=out:st=${formatSeconds(audioFadeOutStart)}:d=${formatSeconds(audioFadeDuration)}`
  ].join(',')

  return { videoFilter, audioFilter }
}

function renderSegment(segment, clipPath, format, options) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-ss',
    formatSeconds(segment.startTime),
    '-i',
    segment.inputPath,
    '-t',
    formatSeconds(segment.duration)
  ]

  const { videoFilter, audioFilter } = buildFadeFilters(segment, options)

  if (format === 'mp4' && !options.audioOnly) {
    args.push(
      '-vf',
      [DEFAULT_VIDEO_FILTER, videoFilter].filter(Boolean).join(','),
      '-r',
      '30',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23'
    )
    if (audioFilter) args.push('-af', audioFilter)
    args.push(
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      clipPath
    )
  } else {
    const codecArgs = format === 'mp3'
      ? ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k']
      : ['-vn', '-c:a', 'aac', '-b:a', '192k']
    args.push(...codecArgs)
    if (audioFilter) args.push('-af', audioFilter)
    args.push('-ar', '48000', '-ac', '2', clipPath)
  }

  console.log(`Rendering ${segment.sequence + 1}: ${segment.type} - ${segment.title}`)
  run(options.ffmpegBin, args)
}

function run(command, args) {
  const result = runMaybe(command, args)
  if (result.error) {
    fail(`Could not run ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`Command failed (${result.status}): ${command} ${args.join(' ')}`)
  }
}

function runMaybe(command, args) {
  return spawnSync(command, args, { stdio: 'inherit' })
}

async function runAsync(command, args) {
  const result = await runAsyncMaybe(command, args)
  if (result.error) {
    fail(`Could not run ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`Command failed (${result.status}): ${command} ${args.join(' ')}`)
  }
  return result
}

function runAsyncMaybe(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolvePromise({ status: null, error, stdout, stderr }))
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }))
  })
}

function printPlan(playlist, segments) {
  console.log(`Playlist: ${playlist.name || 'Untitled'}`)
  console.log(`Segments: ${segments.length}`)
  console.log(`Duration: ${formatClock(segments.reduce((sum, segment) => sum + segment.duration, 0))}`)
  console.log('')
  segments.forEach((segment, index) => {
    console.log(
      `${String(index + 1).padStart(2, '0')}. ${segment.type.padEnd(8)} ` +
      `${formatClock(segment.startTime)} + ${formatClock(segment.duration)} ` +
      `${segment.sourceId} - ${segment.title}`
    )
  })
}

function parseMaybeJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function numberOr(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function safeName(value) {
  return String(value || 'item')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item'
}

function formatSeconds(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, '')
}

function formatTimestamp(value) {
  const totalSeconds = Math.max(0, Number(value) || 0)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const secondsText = seconds.toFixed(3).replace(/\.?0+$/, '').padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`
    : `${minutes}:${secondsText}`
}

function formatClock(value) {
  const total = Math.round(Number(value) || 0)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''")
}

function fail(message) {
  // Throws instead of exiting so this module works both as a CLI (caught below
  // and turned into a process exit) and as an in-process library import (caught
  // by the caller, e.g. the GUI server, without killing the whole app).
  throw new Error(message)
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
