# Power Hour Exporter

Turn a Power Hour playlist export into a real video file (`.mp4`) and audio file
(`.m4a`) you can save and share — no editing software required.

## Download

Grab the build for your computer from the [latest release](../../releases/latest):

- **Windows** — `power-hour-exporter-win.zip`
- **Mac** — `power-hour-exporter-macos-arm64.zip` (Apple Silicon: M1/M2/M3/M4) or
  `power-hour-exporter-macos-x64.zip` (Intel Mac)
- **Linux** — `power-hour-exporter-linux.zip`

Unzip it, then double-click the app inside.

The first time you open it, your operating system will probably warn you that it's
from an "unidentified developer" — that's normal for a small free tool like this one
that isn't signed by a paid certificate. Here's how to get past it:

- **Windows**: click **"More info"** then **"Run anyway"** on the SmartScreen popup.
- **Mac**: right-click (or Control-click) the app and choose **"Open"**, then confirm
  **"Open"** again in the dialog. (If macOS still blocks it, go to **System
  Settings → Privacy & Security** and click **"Open Anyway"** next to the app's name.)
- **Linux**: you may need to mark the file as executable first
  (`chmod +x power-hour-exporter-linux-x64`), then run it from a terminal or your
  file manager.

A console/terminal window will open and stay open — that's expected, it shows what
the app is doing. Leave it open while exporting.

## Using it

1. Export your playlist from the Power Hour website.
2. Open the app — it'll open a page in your browser automatically.
3. Drop the exported JSON file onto the page.
4. Choose a folder to save into.
5. Click **"Create video and audio"** and wait — it downloads each clip, cuts it to
   the right length, fades between clips, and stitches everything together. Progress
   is shown on screen.
6. When it's done, you'll have a `.mp4` and a `.m4a` in the folder you picked.

The very first export also downloads a small helper tool (`yt-dlp`, used to fetch
clips) automatically — that only happens once.

**Only export content you own, control, or are otherwise authorized to download and
redistribute.**

## Command-line usage

If you'd rather not use the browser GUI, the exporter also works from a terminal:

```bash
node exporter.mjs render <playlist.json> --media <dir> --out <file>
node exporter.mjs inspect <playlist.json>
node exporter.mjs list <backup-or-playlist.json>
```

Run `node exporter.mjs --help` for the full option list (output format, fade
duration, download concurrency, picking a specific playlist out of a multi-playlist
backup, etc).

This needs `ffmpeg`, `ffprobe`, and (for `--download`) `yt-dlp` on your `PATH` — the
packaged GUI app bundles all of that for you instead.

### Running from source

```bash
npm install
npm start        # GUI, opens a browser
npm run cli       # CLI (node exporter.mjs ...)
```

### Building the packaged executables yourself

```bash
npm install
node scripts/package.mjs            # all 4 targets
node scripts/package.mjs linux      # just one: linux, macos-x64, macos-arm64, or win
```

Output goes to `dist/bin/`. ffmpeg/ffprobe for the target platform come from the
`ffmpeg-static`/`ffprobe-static` npm packages, so each target should be built on a
matching host OS (see `.github/workflows/release.yml` for the CI matrix that does
this for every tagged release).

## Notes

- Source media is matched to local files by `--media <dir>` first; `--download` (via
  `yt-dlp`) fills in anything missing.
- Drinking clips are inserted after each music segment when the playlist export
  includes a drinking clip assignment.
- Every clip fades to/from black at its edges, matching the site's own playback
  transition (disable with `--no-fade`, or uncheck the box in the GUI).
- Section downloads are cached, and reused between the video and audio renders of the
  same playlist, so re-running an export (or producing both outputs) doesn't
  re-download clips it already has.

