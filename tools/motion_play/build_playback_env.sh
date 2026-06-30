#!/usr/bin/env bash
#
# Build the embedded Python 3.10 motion-PLAYBACK env, separate from the 3.11
# preview/onboarding env, because the secure motion inferencer is a cpython-310
# .so (it cannot load under 3.11).
#
# Bundles into src-tauri/resources/:
#   pyenv310/          relocatable standalone Python 3.10 + inferencer deps
#   motion_play/       motion_play.py + utils/inference*.so + models/model.enc
#                      + assets/g1 (URDF + meshes)
#
# The inferencer needs only: numpy, scipy, onnxruntime, cryptography, cython,
# pinocchio(+hppfcl) — NO torch (model.enc is an encrypted ONNX policy).
#
#   bash tools/motion_play/build_playback_env.sh
#
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RES="$REPO/src-tauri/resources"
WBC="${SCL_WBC_ROOT:-/home/victor/SCL/WBC_Pico_Record}"
PYVER="${PYVER:-3.10}"

command -v uv >/dev/null || { echo "ERROR: 'uv' not found"; exit 1; }
[ -d "$WBC" ] || { echo "ERROR: WBC_Pico_Record not at $WBC (set SCL_WBC_ROOT)"; exit 1; }
SO="$(ls "$WBC"/utils/inference.cpython-310*.so 2>/dev/null | head -1)"
[ -n "${SO:-}" ] || { echo "ERROR: secure inferencer .so not found in $WBC/utils"; exit 1; }

echo "==> creating relocatable standalone Python $PYVER -> $RES/pyenv310"
rm -rf "$RES/pyenv310"
uv venv --python "$PYVER" --relocatable "$RES/pyenv310"
PY="$RES/pyenv310/bin/python"

echo "==> installing inferencer deps (CPU; no torch)"
uv pip install --python "$PY" \
  numpy==1.26.1 scipy==1.15.2 onnxruntime==1.23.2 cryptography==46.0.3 cython==3.2.2 pin

echo "==> bundling motion_play.py + secure inferencer + model + URDF/meshes"
rm -rf "$RES/motion_play"
mkdir -p "$RES/motion_play/utils" "$RES/motion_play/models" "$RES/motion_play/assets"
cp "$HERE/motion_play.py" "$RES/motion_play/"
cp "$SO" "$RES/motion_play/utils/"
cp "$WBC/models/model.enc" "$RES/motion_play/models/"
cp -r "$WBC/assets/g1" "$RES/motion_play/assets/g1"

echo "==> smoke test: instantiate SecureMotionInferencer inside the bundled 3.10 env"
( cd "$RES/motion_play" && "$PY" -c "
from utils.inference import SecureMotionInferencer
SecureMotionInferencer('assets/g1/g1_body29_hand14.urdf', 'models/model.enc')
print('OK: SecureMotionInferencer loaded in pyenv310')
" )
echo "==> done. bundle size:"; du -sh "$RES/pyenv310" "$RES/motion_play"
