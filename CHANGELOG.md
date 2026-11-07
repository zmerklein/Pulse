# Changelog

## Unreleased
- Chord colors: real-time major/minor chord detection drives the visualizer palette (pitch → color, circle of fifths; minor = less saturated). Works in all 3D and classic visuals; chord name shown on screen; toggle with C or the Chord colors button

## 1.1.0
- New 3D visualizer engine (WebGPU) with HDR rendering, bloom and ACES tone mapping
  - Particle Galaxy: up to 4M GPU-simulated particles (compute shaders), audio-driven orbits, turbulence and beat kicks
  - Spectral Landscape: 3D spectrogram terrain with a synthwave sky
  - Fractal Core: ray-marched Mandelbulb that follows the music
- Orbit camera (drag / scroll), Low / High / Ultra quality, live FPS and GPU stats (I)
- Uses the high-performance GPU on dual-GPU laptops
- Automatically lowers quality if the GPU driver resets; falls back to the classic visuals if WebGPU is unavailable

## 1.0.0
- First release: library, gapless playback, ReplayGain, 10-band EQ, playlists, queue, classic visualizer
