# Meshcat motion preview (backend)

Renders a real Meshcat 3D view of a LAFAN1 motion retargeted onto a robot, for the
command center's **Motions** preview iframe. This is the backend that makes the
embedded viewer show something instead of "Couldn't reach the viewer".

## Why this exists

The app embeds a Meshcat web viewer (`StreamView` → iframe). Meshcat is a *server*:
nothing renders unless it's up and something publishes to it. Your retargeting tool
**GMR** renders with MuJoCo (a native window), which can't be iframed — so this script
reuses GMR's retargeting and mirrors **the same MuJoCo model's geometry** into Meshcat.
No separate URDF, **no pinocchio**.

## Setup (one-time, dev)

The desktop app spawns this with the **`unitree-rl`** conda env by default (it has
`mujoco`). Add the remaining deps:

```bash
conda activate unitree-rl       # already has mujoco
pip install meshcat mink scipy  # web viewer + GMR's retarget dep (mink)
```

GMR is auto-added from `/home/victor/SCL/GMR` (or `$SCL_GMR_ROOT`); override the
interpreter with `SCL_PREVIEW_PYTHON=/path/to/python`.

## Embedded (shipped inside the app) — preferred

So users need **no Python/conda**, build a self-contained env into the app bundle:

```bash
# requires `uv`  (https://docs.astral.sh/uv/)
bash tools/meshcat_preview/build_bundle.sh
```

This populates `src-tauri/resources/{pyenv,GMR,assets,meshcat_preview}` (git-ignored,
~300 MB–1 GB) and `tauri.conf.json` bundles it. At runtime the Rust command prefers
that bundled interpreter (`resources/pyenv/bin/python`) and only falls back to a dev
Python if it's absent. Build it once **per OS**; the relocatable `mujoco` native lib
should be smoke-tested on a clean machine.

## Run (dev, external Python)

```bash
python meshcat_motion_preview.py --motion /path/to/motion.bvh --robot unitree_g1 --loop
```

It prints `MESHCAT_URL=http://127.0.0.1:7000/static/`. The app's Motions preview
already points its iframe there (`MESHCAT_URL` in `src/lib/services/motions.svelte.ts`),
so once this is running, hit **Retry** in the preview and the robot appears.

## Open questions to finalize

1. **Input format.** GMR loads **BVH** (official LAFAN1). The app currently imports
   `.csv`. If your `.csv` is human mocap, share one sample so I can add a loader that
   returns GMR's per-frame `human_data` dict (mirroring `load_bvh_file`). Otherwise
   the app should accept `.bvh`.
2. **EngineAI T800.** GMR has no T800 model yet (it has `engineai_pm01`). A T800
   MJCF/URDF + an `ik_config` is needed to retarget onto it.
3. **Wiring.** For `pnpm dev` you launch this manually. In the packaged app a Tauri
   Rust command will spawn it on preview and read the printed `MESHCAT_URL`.

## Input formats

- **`.csv`** — already-retargeted **robot qpos** (N × `[root_pos 3, root_quat xyzw 4, dof…]`,
  e.g. G1 = 36 cols). Played directly — no GMR/retarget needed.
- **`.bvh`** — raw human mocap (LAFAN1); retargeted per-frame via GMR.

> Verified headless with the bundled env: imports the full stack (no torch), and a real
> `lafan1.csv` (192 frames) loads → Meshcat server → plays all frames → exits clean.
> Only the in-browser visual is unverified (needs the host GPU). Open: a T800 model in GMR.
