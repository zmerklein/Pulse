<p align="center"><img src="docs/icon.png" width="112" alt="Pulse icon"></p>

<h1 align="center">Pulse</h1>
<p align="center">A gapless FLAC music player for Windows and macOS, with a reactive visualizer.</p>

<p align="center"><img src="docs/album.jpg" alt="Album view with now-playing bar" width="860"></p>

## Features

- **Music library**: point it at your music folders and browse by album, artist or song, with search. It reads tags and embedded cover art, or a `cover.jpg` / `folder.jpg` next to the files. Files are never modified.
- **Gapless playback**: tracks are decoded ahead of time and the next one is scheduled to start on the exact sample the current one ends.
- **Format readout**: shows the source format (e.g. `FLAC 24/96`), with hi-res albums marked in gold.
- **ReplayGain**: Track, Album or Off, with a preamp, a fallback gain for untagged files and clipping prevention from peak tags.
- **10-band equalizer** with presets and a preamp.
- **Playlists and queue**: drag to reorder, drag albums onto playlists, Play next, shuffle, repeat all / one. The session is restored on relaunch.
- **3D visualizer (WebGPU)**: rendered on your graphics card in HDR with bloom and filmic tone mapping:
  - **Particle Galaxy**: up to 4 million particles simulated on the GPU with compute shaders. Each frequency band orbits at its own radius, and bass, treble and beats drive the motion.
  - **Spectral Landscape**: a 3D terrain built from a scrolling spectrogram, flown over under a synthwave sun.
  - **Fractal Core**: a ray-marched Mandelbulb whose shape, glow and surface lighting follow the music.
  - Drag to orbit and scroll to zoom. Quality tiers are **Low / High / Ultra** (particle count, render scale and ray-march steps). Press **I** for live FPS / GPU stats.
  - The four classic 2D visuals (Nebula, Spectrum Ring, Tunnel, Bars) are still included, and are used automatically on GPUs without WebGPU.
- Media keys, the OS now-playing overlay, and opening `.flac` files from Explorer or Finder.

Supported formats: FLAC, MP3, AAC/M4A, WAV, OGG, Opus.

| Spectral Landscape (3D) | Fractal Core (3D) |
|---|---|
| ![Spectral Landscape](docs/landscape.jpg) | ![Fractal Core](docs/fractal.jpg) |

| Classic visualizer | Sound settings | Playlist |
|---|---|---|
| ![Visualizer](docs/visualizer.jpg) | ![Sound panel](docs/sound.jpg) | ![Playlist](docs/playlist.jpg) |

## Download

Get the latest installers from the [Releases](../../releases) page:

- **Windows:** `Pulse-Setup-x.y.z.exe` (installer) or `Pulse-Portable-x.y.z.exe` (no install needed)
- **macOS:** `Pulse-x.y.z-universal.dmg` (runs on both Apple Silicon and Intel)

The builds are not code-signed:

- **Windows:** if SmartScreen says *"Windows protected your PC"*, click **More info → Run anyway**.
- **macOS:** on first launch, **right-click the app → Open**. If macOS says the app is damaged, run `xattr -cr /Applications/Pulse.app` in Terminal.

## Build from source

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start            # run the app
npm run dist:win     # Windows installer + portable exe  → dist/
npm run dist:mac     # macOS universal .dmg             → dist/   (must be run on a Mac)
```

### Automated builds

The included GitHub Actions workflow (`.github/workflows/build.yml`) builds Windows and macOS on every push. Download the results from the **Actions** tab → the run → **Artifacts**.

To publish a release, tag a version and push it:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow creates a GitHub Release with the installers attached.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| Ctrl/⌘ + → / ← | Next / previous track |
| → / ← | Seek ±10 s |
| Ctrl/⌘ + ↑ / ↓ | Volume |
| S / R | Shuffle / repeat |
| V | Visualizer (N next visual, Q quality, I stats, F full screen, Esc close; drag to orbit, scroll to zoom) |
| Ctrl/⌘ + F | Search |
| Backspace | Back |

## How it works

| File | Role |
|---|---|
| `main.js` | Electron main process: window, library scanner ([music-metadata](https://github.com/borewit/music-metadata)), a `pulse://` protocol that serves the UI, cover art and audio with HTTP range support, and playlist storage |
| `preload.js` | Minimal context-isolated bridge between the UI and the main process |
| `src/engine.js` | Web Audio engine: gapless scheduling, a streaming fallback for very long tracks, ReplayGain, 10-band EQ and an analyser |
| `src/app.js` | The interface: library views, a virtualized track list, queue, playlists, sound panel |
| `src/gpuviz.js` | WebGPU 3D visualizer: compute-shader particle simulation, spectrogram terrain, ray-marched fractal, HDR bloom and ACES tone mapping |
| `src/visualizer.js` | Classic WebGL fragment-shader visualizer with frame feedback (also the fallback when WebGPU is unavailable) |

The signal path is: source → ReplayGain → EQ preamp → 10 biquad bands → analyser → volume → output.

Playback runs in 32-bit float at the system output rate. Sources at other rates are resampled, and the original format is always shown. This is not an exclusive-mode (WASAPI exclusive / CoreAudio hog mode) bit-perfect output.

Tracks whose decoded size would exceed about 700 MB (roughly an hour or more of hi-res audio) stream through an `<audio>` element instead. Transitions around those tracks are near-gapless rather than sample-exact.

The app asks the OS for the high-performance GPU, so laptops with two graphics chips use the discrete card. If the driver resets the GPU (e.g. Ultra is too heavy), Pulse drops one quality level and continues.

User data lives in `%APPDATA%\Pulse` (Windows) or `~/Library/Application Support/Pulse` (macOS).

## License

[MIT](LICENSE)
