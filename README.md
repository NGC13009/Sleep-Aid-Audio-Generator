# Noise Simulator - Sleep Aid Audio Generator

[中文](README_CN.md)
[EN](README.md)

A pure front-end noise simulator: synthesizes white noise, pink noise, brown noise, as well as natural / environmental sounds such as rain, ocean waves, and wind in real time in the browser. It also supports custom power spectra and all-night playback with the screen locked.

No build, no dependencies, no backend. Noise is treated as a wide-sense stationary random process. After specifying its power spectral density, it is synthesized by inverse Fourier transform with random phase, so the generated audio is inherently periodic, seamless, and can loop infinitely.

Click the link below to try it immediately:

[Simulator - Sleep Aid Audio Generator](https://ngc13009.github.io/Sleep-Aid-Audio-Generator/)

[TOC]

## Quick Start

Try it [via this site](https://ngc13009.github.io/Sleep-Aid-Audio-Generator/).

Or download the source code and self-host it: simply open `index.html` directly in a browser (it can also be hosted on any static server).

Basic usage:

1. In "Preset Noise Options", click one or more noises to make them light up green (Pink Noise is selected by default).
2. Click **▶ Live Preview** for instant preview and parameter tuning; when you need all-night playback, click **🌙 Enter Sleep Mode**. Once you confirm sound is playing, just lock the screen.
3. Use **⬇ Export Current Mix WAV** to save the current mix as a local file for offline loop playback, completely free from browser restrictions.

## Detailed Description

### Interface Composition

The page is divided into three cards:

- **Player Control Panel**: Live Preview / Sleep Mode toggle, master volume, sleep timer, status indicators (engine, screen wake lock, page visibility, system media controls, elapsed playback time), WAV export, and an overnight use and permissions guide.
- **Power Spectrum Designer / Viewer**: displays the real-time spectrum of the currently selected presets (in preview mode, it is a real-time bar equalizer). For custom presets, you can drag the dots to edit a smooth power spectrum curve, and choose the base sample rate and loop length.
- **Preset Noise Options**: grouped by "Basic Noise / Natural Sounds / Environmental Sounds / Custom". Click to select and add to the mix (a bright green vertical line appears on the left). Each preset can have its volume adjusted independently (slider, numeric input, or mouse-wheel fine adjustment).

### Noise Types

| Category | Presets |
| --- | --- |
| Basic Noise | White Noise, Pink Noise, Brown Noise |
| Natural Sounds | Light Rain, Heavy Rain, Distant Thunderstorm, Ocean Waves, Wind, Rustling Leaves |
| Environmental Sounds | Fan, Air Conditioner, Hair Dryer, Airplane Cabin |
| Custom | Random processes with freely editable power spectrum curves; multiple can be added or removed |

### Two Playback Engines

- **Live Preview (RT)**: Everything runs on the Web Audio audio thread; each layer loops seamlessly using `AudioBufferSourceNode.loop`; the main thread only handles UI; parameter changes take effect immediately. It may be suspended by the system when backgrounded / screen-locked.
- **Sleep Mode (Sleep)**: First renders the entire current mix as a single PCM segment, then uses a single `AudioBufferSourceNode.loop` for **sample-level seamless looping**. At the same time, it attaches a hidden `<audio>` media element (routed through Web Audio at 0 gain, muted) as a media session anchor, registers lock-screen / system playback controls, and reduces the chance of the tab being reclaimed. If the system still suspends the `AudioContext`, it automatically falls back to native `<audio loop>` (sound can play, but the loop point has roughly a 20–80 ms gap).

If the page is sent to the background during Live Preview, it automatically switches to the sleep engine.

### Other Capabilities

- **Night Mode**: one-click dark theme, persisted with settings.
- **Sleep Timer**: fades out and stops at the set time; the default "Off" means all-night playback.
- **Screen Wake Lock**: automatically requested while the screen is on to prevent auto screen-off; if unsupported, Sleep Mode is unaffected.
- **Settings Persistence**: all buttons, options, volumes, spectra, collapsed states, etc. are written to cookies (kept for 90 days) and automatically restored the next time you open the page.

## System Architecture Overview

| File | Description |
| --- | --- |
| `index.html` | Page structure: three cards + hidden `<audio>` playback element |
| `style.css` | All styles (including dark mode variables, multi-column responsive layout) |
| `script.js` | All logic, divided top-down into several blocks |

Main blocks in `script.js`:

| Module | Description |
| --- | --- |
| Utilities | DOM/Toast/status text/timer formatting |
| DSP Core | FFT, random-phase spectrum synthesis, filtering, envelope, control point interpolation |
| Noise Type Registry | `NOISES` object, one `gen(params, preset)` per noise type |
| State and Persistence | `state`, preset add/delete/modify, Cookie read/write |
| Render Parameters / Cache | `renderParams`, `layerCache` (cache single-layer buffers by preset + parameters) |
| Mixdown Rendering | Full-segment PCM rendering and WAV encoding for sleep mode / export |
| Real-time Engine | `AudioContext`, `masterGain`, one `AudioBufferSourceNode` per layer |
| Sleep Engine | Web Audio seamless loop, media session anchor, native fallback |
| Wake Lock / Timer | `requestWakeLock`, `ticker` fade-out |
| Visualization | Power spectrum curve + real-time equalizer bar rendering, control point dragging |
| UI and Initialization | Preset row construction, state refresh, event binding, card collapsing |

Data flow: `preset list → layerBuffer() (calls gen, normalizes RMS/peak) → single-layer cache → mixdown (RT layer-by-layer superposition; Sleep renders the whole segment) → output (Web Audio / WAV)`.

### Random-Phase Power Spectrum Synthesis

Core function `synthPeriodic(N, rate, ampFn)`:

1. Construct a complex array of length \(N\) in the frequency domain. For each frequency bin \(k\), obtain amplitude \(a\) from \(\operatorname{ampFn}(f)\), assign random phase \(\varphi\), i.e.
   \[
   X[k]=a_k e^{j\varphi_k},\qquad j=\sqrt{-1}.
   \]

2. Fill in a conjugate-symmetric pair \(\operatorname{re}[k]/\operatorname{im}[k]\) and \(\operatorname{re}[N-k]/\operatorname{im}[N-k]\), satisfying
   \[
   \operatorname{re}[N-k]=\operatorname{re}[k],\qquad
   \operatorname{im}[N-k]=-\operatorname{im}[k],
   \]
   thereby ensuring that the inverse transform result is a real signal:
   \[
   x[n]=\operatorname{IFFT}\{X[k]\}\in\mathbb{R}.
   \]

3. Call the self-implemented iterative FFT (`fftCore`) to perform the inverse transform, obtaining samples of an approximately Gaussian random process with the specified power spectrum.

Since the spectrum is discrete and closed, the result is naturally periodic with period \(N\), and the loop boundary is fully continuous:
\[
x[n+N]=x[n].
\]
Moreover,
\[
N=\operatorname{nextPow2}(\mathrm{loopSec}\times \mathrm{rate}),
\]
so the actual loop length can only jump in powers of two; the seconds displayed in the dropdown are approximate, and `#loopInfo` gives the actual length).

### Control Point Interpolation

The custom spectrum uses \([f,\mathrm{dB}]\) control points to perform monotone cubic interpolation in the **logarithmic frequency domain**.
The custom spectrum uses `[f, dB]` control points to perform monotone cubic interpolation (PCHIP, `makeSmoothDb`) in the **logarithmic frequency domain**, avoiding overshoot; `pointsToAmp` then converts relative dB to amplitude. If the amplitude is \(a\), the corresponding relation is
\[
\mathrm{dB}=20\log_{10}a
\quad\Longleftrightarrow\quad
a=10^{\mathrm{dB}/20}.
\]

### Control-Point Interpolation

Custom spectra use `[f, dB]` control points with monotone cubic interpolation (PCHIP, `makeSmoothDb`) in the log-frequency domain to avoid overshoot; `pointsToAmp` then converts relative dB to amplitude.

### Filtering and Natural Sounds

`lp1 / hp1 / lp1mod` are first-order low-pass / high-pass filters (processed twice to eliminate initial transients and ensure loop boundary continuity). `slowNoise` generates low-frequency band-limited slow envelopes, `addBursts` overlays random pulse clusters (raindrops, thunder), and `humTones` overlays sinusoidal harmonics aligned to FFT bins (fan, air-conditioner hum). Natural / environmental presets combine these to create slow fluctuations, gusts, swells, and other characteristics.

## Development Notes

- **Zero build**: no Node/npm required; directly edit `index.html`, `style.css`, and `script.js`; refresh the browser to take effect.
- **No external dependencies**: FFT, WAV encoding, PCHIP, and drawing are all hand-written; no libraries are introduced.
- **Browser requirements**: modern browsers supporting Web Audio and Wake Lock (Chrome / Edge / Safari, etc.). Some capabilities (Wake Lock, MediaSession) may be unavailable in private mode or older browsers; fallbacks are handled in the code.
- **Notes**: audio playback must be triggered by a user gesture; `createMediaElementSource` can only be called once for the same element; Sleep Mode must keep the `AudioContext` in the `running` state and cannot rely on `suspend()` to save power. For more audio engine details and pitfalls, see [`.agents/Audio Playback and Seamless Looping Notes.md`](.agents/音频播放与无缝循环说明.md).
- **Testing**: the project is a single-page demo and currently has no automated tests; after changing the audio engine, it is recommended to manually verify the four paths: "Realtime / Sleep / Lock-screen switching / Export".

## Author Information

[NGC13009](https://github.com/NGC13009)

[limitless © Copyright 2021~2026 All rights reserved](https://limitless.net.cn)

"Noise Simulator - Sleep Aid Audio Generator" open-source license: [GPLv3](https://www.gnu.org/licenses/quick-guide-gplv3.html)

The introduction to and experience with this project on the [Limitless Blog](https://limitless.net.cn/?p=4743).
