# SCL Robotic Command Center

A desktop application that lets **non-technical operators set up and command robots** quickly — part of the SCL (Shadow Combat League) stack. It handles guided onboarding, a live multi-robot console, teleoperation with a 3D view, and motion/policy import & preview.

Supported robots: **Unitree G1** and **EngineAI T800**.

## Stack

- **[Tauri 2](https://tauri.app)** — native desktop shell (Rust)
- **[SvelteKit](https://svelte.dev/docs/kit)** + **Svelte 5** (runes) + **TypeScript** — frontend (SPA via `adapter-static`, `ssr = false`)
- **Vite** — build/dev
- Visualization: **Meshcat** (motion 3D preview / teleop) and **Isaac Lab** (policy rollouts), embedded as web viewports

> **Status:** the UI is built **mock-first** — every feature runs against a typed service layer with simulated data, so the app is fully clickable without a robot. The seams for the real transport (Tauri Rust ↔ SSH / network scan / Meshcat / Isaac Lab) are in place but not yet wired.

## Prerequisites

- **Node** ≥ 20 and **[pnpm](https://pnpm.io)**
- **Rust** toolchain + Tauri 2 system deps (only needed to run/build the desktop app) — see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On Linux this includes `webkit2gtk`.

## Getting started

```bash
pnpm install

# Frontend only, in a browser at http://localhost:1420
pnpm dev

# Full desktop app (Rust + webview)
pnpm tauri dev
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Vite dev server (frontend only) at `:1420` |
| `pnpm build` | Production build of the frontend → `build/` |
| `pnpm preview` | Preview the production build |
| `pnpm check` | `svelte-kit sync` + `svelte-check` (type + a11y check) |
| `pnpm tauri dev` | Run the full desktop app |
| `pnpm tauri build` | Package the desktop app |

## Project structure

```
src/
  app.css                  # global theme tokens (dark/gold tactical) + reset
  routes/
    +layout.svelte         # app shell: TopBar + Sidebar + content
    +page.svelte           # Home — dashboard / first-run empty state
    setup/                 # Onboarding wizard (no sidebar)
    robot/                 # Robot console — per-robot telemetry & controls
    teleoperate/           # Teleop + Meshcat 3D view (has fullscreen)
    motions/               # Motions (.csv -> Meshcat) & Policies (.onnx -> Isaac Lab)
    settings/              # Settings (placeholder)
  lib/
    components/            # UI primitives (Button, Panel, StreamView, ...)
    services/              # Reactive state + mock backends (see below)
src-tauri/                 # Rust side (Tauri config, commands)
```

### Services (the data layer)

All UI talks to a transport-agnostic service layer so the mock backends can be swapped for real ones without touching components:

- `services/types.ts` — domain types
- `services/robotTypes.ts` — supported-robot registry (G1, T800) + defaults
- `services/db.ts` — robot-profile persistence (currently `localStorage` key `scl-ccc.profiles`)
- `services/robot.svelte.ts` — reactive robot service: per-robot connection, telemetry, posture & teleop state
- `services/onboarding.svelte.ts` — onboarding wizard state machine
- `services/motions.svelte.ts` — motion & policy library + preview state

## Key behaviors

- **First run** starts with zero robots; the sidebar appears only after the first robot is onboarded.
- **Onboarding** (Add Robot → `/setup`): create profile (name + type) → ethernet scan → SSH auth → Wi-Fi → done. The profile is saved only on completion.
- **Multi-robot:** connection, telemetry and teleop are tracked **per robot**; operate two (or more) at once. A global **ALL-STOP** is always reachable.

## License

MIT
