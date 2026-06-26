#!/usr/bin/env bash
#
# Build the self-contained Python preview env that ships INSIDE the app, so end
# users need no Python/conda/GMR on their machine.
#
# Run ONCE per OS on a build machine that can install the deps. The output lands
# in src-tauri/resources/ and is bundled by `pnpm tauri build`.
#
# Requires `uv` (https://docs.astral.sh/uv/) for a relocatable standalone Python.
#
#   bash tools/meshcat_preview/build_bundle.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # tools/meshcat_preview
REPO="$(cd "$HERE/../.." && pwd)"                       # repo root
RES="$REPO/src-tauri/resources"

GMR_SRC="${SCL_GMR_ROOT:-/home/victor/SCL/GMR}"
PYVER="${PYVER:-3.11}"

command -v uv >/dev/null || { echo "ERROR: 'uv' not found — install from https://docs.astral.sh/uv/"; exit 1; }

echo "==> resetting $RES"
rm -rf "$RES/pyenv" "$RES/GMR" "$RES/assets" "$RES/meshcat_preview"
mkdir -p "$RES"

echo "==> creating relocatable standalone Python ($PYVER)"
uv venv --python "$PYVER" --relocatable "$RES/pyenv"
PY="$RES/pyenv/bin/python"

echo "==> installing retarget + viewer deps (no pinocchio)"
# Exactly what GMR's package __init__ + our renderer import (not the heavy
# script-only deps: smplx/opencv/redis/ffmpeg).
uv pip install --python "$PY" \
  numpy scipy mujoco mink rich imageio loop-rate-limiters meshcat

echo "==> bundling GMR (package + only the robot assets we use; no .git/other robots)"
mkdir -p "$RES/GMR/assets"
cp -r "$GMR_SRC/general_motion_retargeting" "$RES/GMR/general_motion_retargeting"
for r in unitree_g1 engineai_pm01; do
  [ -d "$GMR_SRC/assets/$r" ] && cp -r "$GMR_SRC/assets/$r" "$RES/GMR/assets/$r"
done

echo "==> patching GMR __init__ so torch-only features are optional (no torch needed)"
"$PY" - "$RES/GMR/general_motion_retargeting/__init__.py" <<'PYEOF'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); t = p.read_text()
t = t.replace("from .kinematics_model import KinematicsModel",
              "try:\n    from .kinematics_model import KinematicsModel\nexcept Exception:\n    KinematicsModel = None")
t = t.replace("from .neck_retarget import human_head_to_robot_neck",
              "try:\n    from .neck_retarget import human_head_to_robot_neck\nexcept Exception:\n    human_head_to_robot_neck = None")
p.write_text(t); print("  patched")
PYEOF

echo "==> bundling preview script"
mkdir -p "$RES/meshcat_preview"
cp "$HERE/meshcat_motion_preview.py" "$RES/meshcat_preview/"

echo "==> done. The app now spawns $PY automatically; 'pnpm tauri build' bundles it."
echo "    NOTE: the relocatable mujoco native lib should be smoke-tested on a clean machine."
