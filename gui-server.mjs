#!/usr/bin/env node
import express from 'express'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listPlaylists, renderExport } from './exporter.mjs'

const jobs = new Map()
let activeJobId = null
let binaryPaths = { ffmpegBin: 'ffmpeg', ytdlpBin: 'yt-dlp', ffprobeBin: 'ffprobe' }

export function createApp() {
  const app = express()
  app.use(express.json({ limit: '200mb' }))

  app.get('/', (_req, res) => {
    res.type('html').send(pageHtml())
  })

  app.post('/api/render', async (req, res) => {
    const { fileName, content, outputDir, fade } = req.body || {}
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'Choose a playlist export JSON file first.' })
      return
    }
    if (!outputDir || typeof outputDir !== 'string') {
      res.status(400).json({ error: 'Enter an output folder.' })
      return
    }
    if (activeJobId) {
      res.status(409).json({ error: 'An export is already running. Wait for it to finish first.' })
      return
    }

    const resolvedOutputDir = resolve(outputDir)
    const jobId = randomUUID()
    const job = {
      id: jobId,
      status: 'queued',
      lines: [],
      outputs: [],
      progress: { percent: 0, phase: '', label: '' }
    }
    jobs.set(jobId, job)
    activeJobId = jobId
    res.json({ jobId })

    runJob(job, {
      fileName: fileName || 'playlist-export.json',
      content,
      outputDir: resolvedOutputDir,
      fade: fade !== false
    }).catch((error) => {
      append(job, `Failed: ${error.message}`)
      job.status = 'failed'
    }).finally(() => {
      if (activeJobId === jobId) activeJobId = null
    })
  })

  app.get('/api/jobs/:id/events', (req, res) => {
    const job = jobs.get(req.params.id)
    if (!job) {
      res.status(404).end()
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    let cursor = 0
    const send = () => {
      const payload = {
        status: job.status,
        lines: job.lines.slice(cursor),
        outputs: job.outputs,
        progress: job.progress
      }
      cursor = job.lines.length
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
      if (job.status === 'complete' || job.status === 'failed') {
        clearInterval(interval)
        res.end()
      }
    }

    const interval = setInterval(send, 1000)
    send()
    req.on('close', () => clearInterval(interval))
  })

  app.post('/api/quit', (_req, res) => {
    if (activeJobId) {
      res.status(409).json({ error: 'An export is still running. Wait for it to finish before quitting.' })
      return
    }
    res.json({ ok: true })
    // Give the response time to flush before the process exits. The packaged
    // Windows build runs with no visible console window, so this button is the
    // only way to stop it short of Task Manager.
    setTimeout(() => process.exit(0), 200)
  })

  return app
}

export async function startServer({ port = 17860, ffmpegBin = 'ffmpeg', ytdlpBin = 'yt-dlp', ffprobeBin = 'ffprobe', openBrowser = false } = {}) {
  binaryPaths = { ffmpegBin, ytdlpBin, ffprobeBin }
  const app = createApp()
  return new Promise((resolvePromise) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`
      console.log(`Power Hour Exporter GUI: ${url}`)
      if (openBrowser) openInBrowser(url)
      resolvePromise(server)
    })
  })
}

function openInBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    // An unhandled 'error' event would crash the whole process — opening the
    // browser is a nice-to-have, not essential, so just swallow failures here.
    child.on('error', () => {})
    child.unref()
  } catch {
    // Non-fatal — the user can still open the printed URL manually.
  }
}

async function runJob(job, { fileName, content, outputDir, fade }) {
  job.status = 'running'
  mkdirSync(outputDir, { recursive: true })

  const workRoot = join(tmpdir(), 'power-hour-exporter-gui')
  mkdirSync(workRoot, { recursive: true })
  const inputPath = join(workRoot, `${Date.now()}-${safeName(fileName)}`)
  writeFileSync(inputPath, content, 'utf8')

  append(job, `Loaded ${fileName}`)
  append(job, `Saving to ${outputDir}`)

  await withCapturedLogs(job, async () => {
    const playlists = listPlaylists(inputPath)
    if (playlists.length === 0) {
      throw new Error('No playlists found in that export file.')
    }

    append(job, `Found ${playlists.length} playlist${playlists.length === 1 ? '' : 's'}.`)

    const playlistSpan = 1 / playlists.length
    for (const [position, playlist] of playlists.entries()) {
      const baseName = `${String(playlist.index + 1).padStart(2, '0')}-${safeName(playlist.name || playlist.id || 'playlist')}`
      const videoOut = join(outputDir, `${baseName}.mp4`)
      const audioOut = join(outputDir, `${baseName}.m4a`)
      // Hash the playlist's content, not inputPath (which embeds Date.now() and is
      // therefore different on every attempt) — otherwise re-running the exact same
      // export starts from an empty cache and re-downloads everything from scratch,
      // even clips a previous attempt already fetched.
      const workdir = join(outputDir, '.power-hour-export-work', hash(`${content}:${playlist.index}`))
      const playlistBase = position * playlistSpan
      const videoSpan = playlistSpan * 0.95

      append(job, `Starting ${playlist.name}`)
      await renderExport(inputPath, {
        playlistIndex: playlist.index,
        download: true,
        downloadSections: true,
        output: videoOut,
        workdir,
        fade,
        concurrency: 3,
        ffmpegBin: binaryPaths.ffmpegBin,
        ytdlpBin: binaryPaths.ytdlpBin,
        ffprobeBin: binaryPaths.ffprobeBin,
        onProgress: (evt) => {
          job.progress = {
            percent: Math.round((playlistBase + videoSpan * localProgressFraction(evt)) * 100),
            phase: evt.phase,
            label: evt.label || ''
          }
        }
      })
      job.outputs.push(videoOut)

      // The mp4's audio track is already the exact codec/bitrate/rate we want for the
      // .m4a, so pull it out with a stream copy instead of re-downloading and
      // re-encoding every clip a second time.
      append(job, `Extracting audio for ${playlist.name}`)
      await extractAudio(videoOut, audioOut)
      job.outputs.push(audioOut)
      job.progress = {
        percent: Math.round((playlistBase + playlistSpan) * 100),
        phase: 'concat',
        label: 'Extracted audio'
      }
      append(job, `Finished ${playlist.name}`)
    }
  })

  job.status = 'complete'
  job.progress = { percent: 100, phase: 'done', label: 'Done' }
  append(job, 'Done.')
}

const PROGRESS_PHASE_WEIGHTS = { download: 0.55, render: 0.4, concat: 0.05 }
const PROGRESS_PHASE_ORDER = ['download', 'render', 'concat']

function localProgressFraction(evt) {
  const phaseIndex = PROGRESS_PHASE_ORDER.indexOf(evt.phase)
  if (phaseIndex === -1) return 0
  const completedWeight = PROGRESS_PHASE_ORDER
    .slice(0, phaseIndex)
    .reduce((sum, phase) => sum + PROGRESS_PHASE_WEIGHTS[phase], 0)
  const within = evt.total > 0 ? evt.current / evt.total : 0
  return completedWeight + PROGRESS_PHASE_WEIGHTS[evt.phase] * within
}

function extractAudio(videoPath, audioPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binaryPaths.ffmpegBin, ['-y', '-loglevel', 'warning', '-i', videoPath, '-vn', '-c:a', 'copy', audioPath])
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
    })
  })
}

// Jobs run one at a time (enforced in the /api/render handler above), so it's safe
// to temporarily redirect console output into the job's log instead of threading a
// logger through every function in exporter.mjs.
async function withCapturedLogs(job, fn) {
  const real = { log: console.log, warn: console.warn, error: console.error }
  const capture = (...args) => append(job, args.map(String).join(' '))
  console.log = (...args) => { real.log(...args); capture(...args) }
  console.warn = (...args) => { real.warn(...args); capture(...args) }
  console.error = (...args) => { real.error(...args); capture(...args) }
  try {
    return await fn()
  } finally {
    console.log = real.log
    console.warn = real.warn
    console.error = real.error
  }
}

function append(job, line) {
  job.lines.push(line)
}

function safeName(value) {
  return String(value || 'playlist')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'playlist'
}

function hash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Power Hour Exporter</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101114;
      --panel: #191b20;
      --panel-2: #20232a;
      --text: #f4f5f7;
      --muted: #a8afbd;
      --line: #343944;
      --accent: #41d6a2;
      --danger: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 32px;
    }
    main {
      width: min(760px, 100%);
      display: grid;
      gap: 16px;
    }
    h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); line-height: 1.5; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
      display: grid;
      gap: 16px;
    }
    .drop {
      min-height: 180px;
      border: 2px dashed #4a5160;
      border-radius: 8px;
      background: var(--panel-2);
      display: grid;
      place-items: center;
      text-align: center;
      padding: 24px;
      cursor: pointer;
    }
    .drop.ready { border-color: var(--accent); }
    label { color: var(--muted); font-size: 13px; }
    input[type="text"] {
      width: 100%;
      border: 1px solid var(--line);
      background: #0d0e11;
      color: var(--text);
      border-radius: 6px;
      padding: 12px 14px;
      font-size: 15px;
    }
    button {
      border: 0;
      background: var(--accent);
      color: #06110d;
      border-radius: 6px;
      padding: 13px 16px;
      font-size: 15px;
      font-weight: 800;
      cursor: pointer;
    }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
      font-size: 14px;
    }
    .checkbox-row input { width: 16px; height: 16px; accent-color: var(--accent); }
    .progress-wrap { display: none; gap: 6px; }
    .progress-wrap.active { display: grid; }
    .progress-track {
      width: 100%;
      height: 10px;
      border-radius: 999px;
      background: var(--panel-2);
      border: 1px solid var(--line);
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      width: 0%;
      background: var(--accent);
      transition: width .3s ease;
    }
    .progress-label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--muted);
    }
    .status {
      min-height: 170px;
      max-height: 340px;
      overflow: auto;
      background: #08090b;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .error { color: var(--danger); }
    .outputs { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
    footer { display: flex; justify-content: flex-end; }
    .quit-button {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--line);
      font-weight: 600;
      padding: 8px 14px;
      font-size: 13px;
    }
    .quit-button:hover { color: var(--danger); border-color: var(--danger); }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Power Hour Exporter</h1>
      <p>Drop a playlist export from the website, choose where to save, then create both video and audio files.</p>
    </section>
    <section class="panel">
      <input id="file" type="file" accept=".json,application/json" hidden />
      <div id="drop" class="drop">
        <div>
          <strong id="fileLabel">Choose or drop export JSON</strong>
          <p>Single playlist exports and playlist backup files are supported.</p>
        </div>
      </div>
      <div>
        <label for="outputDir">Save folder</label>
        <input id="outputDir" type="text" placeholder="/home/you/Videos/power-hour-exports" />
      </div>
      <label class="checkbox-row">
        <input id="fade" type="checkbox" checked />
        Fade between clips
      </label>
      <button id="start" disabled>Create video and audio</button>
    </section>
    <section class="panel">
      <div id="progressWrap" class="progress-wrap">
        <div class="progress-track"><div id="progressFill" class="progress-fill"></div></div>
        <div class="progress-label">
          <span id="progressPhase"></span>
          <span id="progressPercent">0%</span>
        </div>
      </div>
      <div id="status" class="status">Waiting for an export file.</div>
      <div id="outputs" class="outputs"></div>
    </section>
    <footer>
      <button id="quit" class="quit-button">Quit</button>
    </footer>
  </main>
  <script>
    const fileInput = document.getElementById('file')
    const drop = document.getElementById('drop')
    const fileLabel = document.getElementById('fileLabel')
    const outputDir = document.getElementById('outputDir')
    const fade = document.getElementById('fade')
    const start = document.getElementById('start')
    const status = document.getElementById('status')
    const outputs = document.getElementById('outputs')
    const progressWrap = document.getElementById('progressWrap')
    const progressFill = document.getElementById('progressFill')
    const progressPhase = document.getElementById('progressPhase')
    const progressPercent = document.getElementById('progressPercent')
    let selected = null

    const PHASE_LABELS = { download: 'Downloading', render: 'Rendering', concat: 'Combining', done: 'Done' }

    function setProgress(progress) {
      if (!progress) return
      progressWrap.classList.add('active')
      const percent = Math.max(0, Math.min(100, progress.percent || 0))
      progressFill.style.width = percent + '%'
      progressPercent.textContent = percent + '%'
      const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase || ''
      progressPhase.textContent = progress.label ? (phaseLabel + ': ' + progress.label) : phaseLabel
    }

    outputDir.value = localStorage.getItem('power-hour-export-output') || ''
    fade.checked = localStorage.getItem('power-hour-export-fade') !== 'false'
    fade.addEventListener('change', () => {
      localStorage.setItem('power-hour-export-fade', String(fade.checked))
    })

    function updateReady() {
      start.disabled = !selected || !outputDir.value.trim()
      drop.classList.toggle('ready', !!selected)
    }

    async function setFile(file) {
      if (!file) return
      selected = { name: file.name, content: await file.text() }
      fileLabel.textContent = file.name
      status.textContent = 'Ready.'
      updateReady()
    }

    drop.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', () => setFile(fileInput.files[0]))
    outputDir.addEventListener('input', () => {
      localStorage.setItem('power-hour-export-output', outputDir.value)
      updateReady()
    })
    ;['dragenter', 'dragover'].forEach((eventName) => {
      drop.addEventListener(eventName, (event) => {
        event.preventDefault()
        drop.classList.add('ready')
      })
    })
    ;['dragleave', 'drop'].forEach((eventName) => {
      drop.addEventListener(eventName, (event) => {
        event.preventDefault()
        if (!selected) drop.classList.remove('ready')
      })
    })
    drop.addEventListener('drop', (event) => setFile(event.dataTransfer.files[0]))

    start.addEventListener('click', async () => {
      start.disabled = true
      outputs.innerHTML = ''
      status.textContent = 'Starting...\\n'
      progressWrap.classList.add('active')
      setProgress({ percent: 0, phase: '', label: '' })
      const response = await fetch('/api/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: selected.name,
          content: selected.content,
          outputDir: outputDir.value.trim(),
          fade: fade.checked
        })
      })
      const payload = await response.json()
      if (!response.ok) {
        status.innerHTML += '\\n' + (payload.error || 'Failed to start.')
        start.disabled = false
        return
      }

      const events = new EventSource('/api/jobs/' + payload.jobId + '/events')
      events.onmessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.lines?.length) {
          status.textContent += data.lines.join('\\n') + '\\n'
          status.scrollTop = status.scrollHeight
        }
        outputs.innerHTML = data.outputs.map((path) => '<div>' + path + '</div>').join('')
        setProgress(data.progress)
        if (data.status === 'complete' || data.status === 'failed') {
          events.close()
          start.disabled = false
          if (data.status === 'failed') status.classList.add('error')
        }
      }
    })

    document.getElementById('quit').addEventListener('click', async () => {
      if (!confirm('Quit Power Hour Exporter?')) return
      const response = await fetch('/api/quit', { method: 'POST' }).catch(() => null)
      if (response && !response.ok) {
        const payload = await response.json().catch(() => ({}))
        alert(payload.error || 'Could not quit right now.')
        return
      }
      document.body.innerHTML = '<main><section><h1>Power Hour Exporter</h1><p>Closed. You can close this tab.</p></section></main>'
    })

    updateReady()
  </script>
</body>
</html>`
}

// Dev convenience: `node gui-server.mjs` starts the server directly using
// whatever ffmpeg/yt-dlp/ffprobe are on PATH. The packaged app instead goes
// through launcher.mjs, which resolves/downloads those binaries first and opens
// the browser automatically.
const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entryUrl) {
  const portArgIndex = process.argv.indexOf('--port')
  const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 17860
  startServer({ port })
}
