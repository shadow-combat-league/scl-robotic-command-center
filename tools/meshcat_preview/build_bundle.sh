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

echo "==> installing CPU torch (needed by smplx; no CUDA)"
uv pip install --python "$PY" torch==2.11.0 --index-url https://download.pytorch.org/whl/cpu \
  || uv pip install --python "$PY" torch --index-url https://download.pytorch.org/whl/cpu

echo "==> installing runtime deps, version-matched to the wbc_pico conda env (CPU-only)"
# Mirrors wbc_pico's pip set; headless opencv avoids system GL deps in the bundle.
# paramiko = SSH for onboarding; cyclonedds/unitree = robot DDS + SDK.
uv pip install --python "$PY" \
  numpy==1.26.1 scipy==1.15.2 mujoco==3.8.0 mink==1.1.0 meshcat==0.3.2 \
  loop-rate-limiters==1.2.0 imageio==2.37.3 imageio-ffmpeg==0.6.0 rich==15.0.0 \
  cyclonedds==0.10.2 onnxruntime==1.23.2 opencv-python-headless==4.13.0.92 paramiko

echo "==> installing smplx (git pin) + unitree_sdk2py (copied from local checkout)"
uv pip install --python "$PY" \
  "smplx @ git+https://github.com/vchoutas/smplx@1265df7ba545e8b00f72e7c557c766e15c71632f"
UNITREE_SRC="${SCL_UNITREE_SDK:-/home/victor/SCL/WBC_Pico_Record/third_party/unitree_sdk2_python}"
if [ -d "$UNITREE_SRC" ]; then
  uv pip install --python "$PY" --no-deps "$UNITREE_SRC"
  echo "==> patching unitree_sdk2py __init__ (its eager go2/b2 import is broken in this fork)"
  SITE="$("$PY" -c 'import site; print(site.getsitepackages()[0])')"
  "$PY" - "$SITE/unitree_sdk2py/__init__.py" <<'PYEOF'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
if p.exists():
    t = p.read_text()
    old = "from . import idl, utils, core, rpc, go2, b2"
    new = ("from . import idl, utils, core, rpc\n"
           "try:\n    from . import go2, b2\nexcept Exception:\n    pass")
    if old in t:
        p.write_text(t.replace(old, new)); print("  patched")
PYEOF
else
  echo "WARN: unitree_sdk2_python not found at $UNITREE_SRC — skipping (set SCL_UNITREE_SDK)"
fi
uv pip install --python "$PY" numpy==1.26.1 scipy==1.15.2   # re-lock pins

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

echo "==> bundling preview + onboarding + agent scripts"
mkdir -p "$RES/meshcat_preview" "$RES/robot_onboard" "$RES/robot_agent"
cp "$HERE/meshcat_motion_preview.py" "$RES/meshcat_preview/"
cp "$REPO/tools/robot_onboard/onboard.py" "$RES/robot_onboard/"
# Deployed onto the robot during onboarding (stdlib-only telemetry server).
cp "$REPO/tools/robot_agent/agent.py" "$RES/robot_agent/"

echo "==> done. The app now spawns $PY automatically; 'pnpm tauri build' bundles it."
echo "    NOTE: the relocatable mujoco native lib should be smoke-tested on a clean machine."
