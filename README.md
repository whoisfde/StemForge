# StemForge — Sound Design Plugin for Adobe Premiere Pro

A Premiere Pro panel for sound designers: drag in an audio file to
**separate it into stems** (drums / bass / vocals / other, or a 6-stem
model that adds guitar/piano), and to **detect its BPM and musical key**
so you can render a version pitched/time-stretched to a target BPM/key.

## Why this is two projects

Premiere Pro plugins run on Adobe's **UXP** framework, which executes the
panel's JS in a locked-down sandbox — it cannot run ML models (PyTorch)
or spawn processes. Stem separation and audio analysis need real signal
processing, so the heavy lifting runs in a small **local companion
service** that the panel talks to over `http://localhost:17890`.

```
Premiere Pro
 └─ StemForge panel (UXP: HTML/CSS/JS)   ──HTTP──▶  companion-server (Python/FastAPI)
                                                       ├─ Demucs (stem separation)
                                                       ├─ librosa (BPM + key detection)
                                                       └─ librosa (time-stretch / pitch-shift)
```

Both processes run entirely on the user's machine — no audio ever leaves
the computer.

- [`premiere-plugin/`](premiere-plugin/) — the UXP panel loaded into Premiere Pro.
- [`companion-server/`](companion-server/) — the local Python service doing the actual audio work.

## Setup

### 1. Start the companion service

```bash
cd companion-server
./start_server.sh
```

First run creates a virtual environment and installs dependencies
(including PyTorch — a multi-GB download, so this can take a while on
first launch). On a Mac you can instead double-click
**`Start StemForge Server.command`**. Leave this running in the
background while you use the plugin; it serves `http://localhost:17890`.

Check it's up: open `http://localhost:17890/health` in a browser — you
should see `{"status":"ok"}`.

### 2. Load the panel into Premiere Pro

1. Install the [Adobe UXP Developer Tool (UDT)](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/) (free, from Adobe).
2. In UDT, click **Add Plugin** and select `premiere-plugin/manifest.json`.
3. Click **Load** next to the plugin, with Premiere Pro already running.
4. The **StemForge** panel appears under Premiere's `Window > Extensions` menu.

### Everyday use

1. Open Premiere Pro, launch the companion service, load the panel.
2. Drag an audio file onto the panel (or use **Browse…**).
3. **Analyze** to detect BPM/key, or set a target BPM/key and **Render
   Transformed Audio**, or **Separate Stems**.
4. Click **Import** next to any result to bring it straight into the
   active Premiere project as a new bin item.

## Current scope / next steps

- Stem model defaults to Demucs `htdemucs` (4 stems); `htdemucs_6s` is
  available for guitar/piano separation, at the cost of speed.
- Key detection uses the classic Krumhansl-Schmuckler profile-matching
  algorithm on chroma features — solid for tonal material, less
  meaningful on atonal SFX/noise.
- BPM/key transform uses librosa's phase-vocoder time-stretch and
  pitch-shift. If quality needs to go up a notch later, swapping in
  `rubberband`/`pyrubberband` is a drop-in change in
  `companion-server/app/transform.py`.
- Separation runs synchronously per request; for very long files you may
  want to add a background job queue + progress polling later, but this
  keeps the first version simple.
- No app icon design pass yet — `premiere-plugin/icons/` has generated
  placeholders so the manifest is valid; swap in real artwork anytime.

## Known limitation to verify in your environment

I scaffolded and syntax-checked all the code here, but I don't have
Premiere Pro or the UXP Developer Tool available to actually run this
end-to-end. Two spots worth a first-run sanity check inside real
Premiere Pro:

1. **Drag-and-drop file object shape** — `premiere-plugin/js/main.js`
   assumes `event.dataTransfer.files[0]` behaves like a standard Web
   `File` (usable directly in `FormData`). This matches current UXP
   panel behavior, but if your UXP/Premiere version differs, that's the
   first place to look.
2. **`premierepro` import API** — `Project.getActiveProject()` /
   `project.importFiles(paths)` reflects Adobe's documented Premiere Pro
   scripting API shape; confirm against the API version installed with
   your Premiere Pro release if imports don't fire.

## Import staging (installed vs. UXP Developer Tool)

`project.importFiles()` will only bring in files the running plugin is
allowed to reach. A plugin **loaded through the UXP Developer Tool** can
hand Premiere any absolute path, so importing straight from the companion
server's `work/` directory worked there. A plugin **installed as a normal
extension** cannot — those paths are outside its sandbox, and the import
silently does nothing.

So the panel no longer imports the server's paths directly. After a
`/separate` or `/transform`, it downloads each result from the server's
`http://localhost:17890/files/…` mount and re-writes it into the plugin's
own persistent data folder (`getDataFolder()/imports/<track>/…`), then
imports that copy. Basenames are also stripped of `#[]()` on the way in,
since Premiere's importer treats those as frame/sequence tokens. See
`stageForImport` in `premiere-plugin/js/main.js`.
