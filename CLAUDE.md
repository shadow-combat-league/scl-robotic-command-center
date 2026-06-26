# CLAUDE.md

Guidance for working in the **SCL Robotic Command Center** — a Tauri 2 + SvelteKit (Svelte 5 runes) + TypeScript desktop app for non-technical operators to onboard and command robots (Unitree G1, EngineAI T800). See `README.md` for the overview.

## Verify before finishing

Always run both and keep them green (the bar is **0 errors, 0 warnings**):

```bash
pnpm check     # svelte-kit sync + svelte-check (types + a11y)
pnpm build     # vite production build
```

Don't launch `pnpm tauri dev` to "verify" routine changes — it needs the Rust toolchain + webkit and is slow. `pnpm dev` (browser at `:1420`) is fine for a visual check.

## Architecture

- **Mock-first.** The UI is built against a transport-agnostic service layer in `src/lib/services/`. Each service exposes reactive state + async-ish methods whose bodies **simulate** the backend. Real transport (Tauri Rust: SSH, network scan, Meshcat, Isaac Lab) will replace those method bodies **without changing the components or types**. Preserve this seam — keep new logic in services, keep components dumb.
- **Reactivity:** Svelte 5 runes. Shared state lives in `*.svelte.ts` modules as `$state` class fields, exported as a singleton (e.g. `robot`, `library`, `onboarding`). Read them directly in components.
- **Per-robot state:** connection, telemetry, posture and teleop are keyed **by robot id** (`robot.connections[id]`, etc.) so multiple robots run at once. There is **no single "active robot."** Use the `*Of(id)` accessors and fleet getters (`onlineCount`, `anyOnline`, `allEstopped`, …).
- **Persistence:** robot profiles go through `services/db.ts` (currently `localStorage` key `scl-ccc.profiles`; swappable for `tauri-plugin-sql`). A profile is only created when onboarding **completes** — there are no partial profiles, and no `onboarded` flag.
- **3D / sim views:** `components/StreamView.svelte` embeds an external web viewport in an `<iframe>` with a toolbar. Used for **Meshcat** (motion preview + teleop) and **Isaac Lab** (policy rollout). Don't build a custom three.js renderer — Meshcat/Isaac Lab are the standard and we embed their web viewers.

## Conventions

- **Styling:** plain scoped `<style>` + CSS custom properties from `src/app.css` (`--gold`, `--bg-elev-1`, `--text-secondary`, `--r-md`, …). No CSS framework. Aesthetic = dark/navy base, gold/amber primary, green success, cyan info, red danger, uppercase mono labels.
- **Components** are small and presentational; pass callbacks (`onStop`, `onDelete`, `onConfirm`) and data in via props/snippets. Reuse existing primitives: `Button`, `Panel`, `PageHeader`, `StatusPill`, `Icon`, `Field`, `Spinner`, `Stepper`, `ConfirmDialog`, `StreamView`, `RobotCard`.
- **Icons** are inline SVG paths in `components/Icon.svelte` (`ICONS` map) — add a new entry there rather than importing an icon lib.
- **No account system.** No login/users/roles. Don't reintroduce "Admin"/sign-in concepts; device config lives under **Settings**.
- **Routing:** SvelteKit file routes. `/setup` (onboarding) is intentionally chrome-light — the **sidebar is hidden** when there are no robots and on `/setup`; it's reached via "Add Robot" buttons, not a nav item.
- Avoid `Date.now()`/`Math.random()` only inside Workflow scripts (a sandbox limitation) — they're fine in normal app code here.

## Domain notes

- Two robot types in `services/robotTypes.ts`: **Unitree G1** (`192.168.123.164`, ssh `unitree`) and **EngineAI T800** (default IP is an **unconfirmed placeholder**, ssh `root`). IPs/users are editable in the wizard.
- **Motions** = LAFAN1 `.csv` (parsed in-JS for frames/duration at 30 fps) → Meshcat preview. **Policies** = `.onnx`; importing one **explicitly asks G1 vs T800**, then previews the rollout in embedded Isaac Lab.
- Part of the SCL (Shadow Combat League) ecosystem (alongside BRAINDANCE motion capture, the heartbeat bridge, the NestJS backend, and Unitree/GR00T/lerobot stacks).

## Gotchas

- **Resetting data:** profiles live in the app's localStorage. When `pnpm tauri dev` is running it holds that store open, so deleting files on disk won't stick — clear via the app's DevTools console: `localStorage.clear(); location.reload()`.
- **Embedding caveat:** iframing `http://127.0.0.1:<port>` (Meshcat / Isaac Lab) works under `pnpm dev`. In a packaged Tauri build (custom `tauri://` scheme) it may hit mixed-content/CSP limits — revisit when wiring the real backends. `src-tauri/tauri.conf.json` currently sets `csp: null`.
- **Fonts** use system stacks (`Inter`/`ui-monospace` fallbacks) — no bundled web fonts, so it works offline.
