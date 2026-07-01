#!/usr/bin/env bash
#
# Bundle the `wbc_pico` conda env + the WBC_Pico_Record project into the app so
# live teleoperation needs NO machine setup. Produces:
#   src-tauri/resources/teleop/env/   -- relocatable conda-packed wbc_pico env
#   src-tauri/resources/teleop/wbc/   -- the WBC project (script + assets + deps)
#
# The three editable deps (general_motion_retargeting, unitree_sdk2py,
# inspire_sdkpy) can't be conda-packed (editable installs), but they're pure
# python living inside the WBC project — so we exclude them from the pack and
# make them importable at runtime via PYTHONPATH (see resolve_teleop in lib.rs).
#
# Re-run this per OS. Output lives under src-tauri/resources (git-ignored).
set -euo pipefail

CONDA="${CONDA_ROOT:-$HOME/miniconda3}"
ENV_NAME="${WBC_ENV:-wbc_pico}"
WBC="${WBC_DIR:-$HOME/SCL/WBC_Pico_Record}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DEST="$REPO/src-tauri/resources/teleop"

echo "[teleop-bundle] conda=$CONDA  env=$ENV_NAME  wbc=$WBC"
echo "[teleop-bundle] dest=$DEST"

command -v rsync >/dev/null || { echo "[teleop-bundle] rsync is required"; exit 1; }
[ -d "$CONDA/envs/$ENV_NAME" ] || { echo "[teleop-bundle] env not found: $CONDA/envs/$ENV_NAME"; exit 1; }
[ -d "$WBC" ] || { echo "[teleop-bundle] WBC dir not found: $WBC"; exit 1; }

# 1) conda-pack the env (relocatable), skipping the editable packages.
"$CONDA/bin/pip" show conda-pack >/dev/null 2>&1 || "$CONDA/bin/pip" install -q conda-pack
echo "[teleop-bundle] packing env (a few minutes)…"
PACK="/tmp/${ENV_NAME}_pack.tar.gz"
# --ignore-missing-files: the env has pip-over-conda clobbered metadata
# (setuptools/numpy) which is harmless for packing; --ignore-editable-packages:
# GMR/unitree_sdk2py/inspire_sdkpy are bundled via source + PYTHONPATH instead.
"$CONDA/bin/conda-pack" -n "$ENV_NAME" \
  --ignore-editable-packages --ignore-missing-files \
  --format tar.gz -o "$PACK" --force
rm -rf "$DEST/env"; mkdir -p "$DEST/env"
tar -xzf "$PACK" -C "$DEST/env"
"$DEST/env/bin/conda-unpack"
rm -f "$PACK"

# Prune broken symlinks (e.g. lib/libarcher.so -> libarcher.so.bak). Tauri's
# `resources/**/*` bundler calls exists() on every entry and aborts on a dangling
# link ("resource path ... doesn't exist"). A broken link is unusable anyway.
find "$DEST/env" -type l ! -exec test -e {} \; -delete 2>/dev/null || true

# 2) copy the WBC project (skip huge recording dirs + caches).
echo "[teleop-bundle] copying WBC project…"
rm -rf "$DEST/wbc"; mkdir -p "$DEST/wbc"
rsync -a \
  --exclude 'instances/' --exclude 'data/' --exclude '.git/' \
  --exclude '__pycache__/' --exclude '*.pyc' \
  --exclude '/core' --exclude 'core.[0-9]*' \
  "$WBC/" "$DEST/wbc/"

# 3) sanity: the bundled python imports every teleop dep from the bundle.
PP="$DEST/wbc/third_party/GMR:$DEST/wbc/third_party/unitree_sdk2_python:$DEST/wbc/eef/inspire/inspire_hand_ws/inspire_hand_sdk"
echo "[teleop-bundle] verifying imports…"
( cd "$DEST/wbc" && PYTHONPATH="$PP" "$DEST/env/bin/python" -c \
  "import pinocchio, onnxruntime, xrobotoolkit_sdk, general_motion_retargeting, unitree_sdk2py, meshcat; print('[teleop-bundle] imports OK')" )

echo "[teleop-bundle] done."
du -sh "$DEST/env" "$DEST/wbc" 2>/dev/null || true
