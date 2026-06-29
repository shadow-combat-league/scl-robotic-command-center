#!/usr/bin/env python3
"""
SCL Robotic Command Center — Meshcat motion preview backend.

    BVH (LAFAN1) --load--> frames --GMR.retarget--> qpos
                 --> MuJoCo model (FK) --> Meshcat web viewer

Renders the SAME MuJoCo model GMR retargets onto — a single source of truth, so
there's no separate URDF and **no pinocchio**. Deps: mujoco, mink (via GMR),
meshcat, numpy, scipy. Prints `MESHCAT_URL=...` for the app to embed in its iframe.

GMR's own viewer is a native MuJoCo window (not iframe-able); this mirrors the
model's geometry into Meshcat (web) instead.

NOTE (input): GMR loads BVH (official LAFAN1). For a human-mocap .csv, add a
loader returning GMR's per-frame human_data dict (see load_bvh_file).
"""

import argparse
import os
import sys
import time

import numpy as np


def die(msg: str) -> None:
    print(f"[meshcat-preview] ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def rgb_hex(rgba) -> int:
    r, g, b = (int(max(0.0, min(1.0, float(c))) * 255) for c in rgba[:3])
    return (r << 16) | (g << 8) | b


def rot_x(angle: float) -> np.ndarray:
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]], dtype=float)


def _mesh_geometry(model, mesh_id, mg):
    va, vn = int(model.mesh_vertadr[mesh_id]), int(model.mesh_vertnum[mesh_id])
    fa, fn = int(model.mesh_faceadr[mesh_id]), int(model.mesh_facenum[mesh_id])
    verts = np.array(model.mesh_vert[va : va + vn]).reshape(-1, 3).astype(np.float32)
    faces = np.array(model.mesh_face[fa : fa + fn]).reshape(-1, 3).astype(np.uint32)
    return mg.TriangularMeshGeometry(verts, faces)


def build_scene(vis, model, mj, mg):
    """Create one Meshcat object per visible geom; return {geom_id: local_transform}."""
    G = mj.mjtGeom
    geom_local = {}
    for gid in range(model.ngeom):
        rgba = model.geom_rgba[gid]
        if float(rgba[3]) == 0.0:
            continue  # invisible (usually collision geoms)
        gtype = int(model.geom_type[gid])
        size = model.geom_size[gid]
        material = mg.MeshLambertMaterial(color=rgb_hex(rgba), opacity=float(rgba[3]))
        local = np.eye(4)
        obj = None
        if gtype == G.mjGEOM_SPHERE:
            obj = mg.Sphere(float(size[0]))
        elif gtype == G.mjGEOM_BOX:
            obj = mg.Box([float(2 * size[0]), float(2 * size[1]), float(2 * size[2])])
        elif gtype in (G.mjGEOM_CYLINDER, G.mjGEOM_CAPSULE):
            obj = mg.Cylinder(float(2 * size[1]), float(size[0]))  # capsule ≈ cylinder
            local = rot_x(np.pi / 2)  # meshcat cylinder is +Y, mujoco is +Z
        elif gtype == G.mjGEOM_ELLIPSOID:
            obj = mg.Sphere(1.0)
            local = np.diag([float(size[0]), float(size[1]), float(size[2]), 1.0])
        elif gtype == G.mjGEOM_MESH:
            obj = _mesh_geometry(model, int(model.geom_dataid[gid]), mg)
        else:
            continue  # skip planes / heightfields
        vis["robot"][str(gid)].set_object(obj, material)
        geom_local[gid] = local
    return geom_local


def update_scene(vis, model, data, geom_local):
    for gid, local in geom_local.items():
        T = np.eye(4)
        T[:3, :3] = np.array(data.geom_xmat[gid]).reshape(3, 3)
        T[:3, 3] = np.array(data.geom_xpos[gid])
        vis["robot"][str(gid)].set_transform((T @ local).astype(float))


# Robot model XML (relative to the bundled/source GMR root), per robot key.
ROBOT_XML_REL = {
    "unitree_g1": "assets/unitree_g1/g1_mocap_29dof.xml",
    "engineai_pm01": "assets/engineai_pm01/pm_v2.xml",
}


def resolve_model_xml(gmr_root: str, robot: str) -> str:
    rel = ROBOT_XML_REL.get(robot, ROBOT_XML_REL["unitree_g1"])
    return os.path.join(gmr_root, rel)


def load_csv_qpos(path: str, nq: int):
    """Read an already-retargeted robot-qpos CSV (N x [pos3, quat_xyzw 4, dof…])."""
    arr = np.loadtxt(path, delimiter=",")
    if arr.ndim == 1:
        arr = arr[None, :]
    frames = []
    for row in arr:
        q = np.zeros(nq, dtype=float)
        ncol = len(row)
        if ncol >= 7:
            q[0:3] = row[0:3]
            # CSV root quat is xyzw; MuJoCo qpos wants wxyz (scalar first).
            q[3], q[4], q[5], q[6] = row[6], row[3], row[4], row[5]
            ndof = min(nq - 7, ncol - 7)
            if ndof > 0:
                q[7 : 7 + ndof] = row[7 : 7 + ndof]
        else:
            q[: min(nq, ncol)] = row[: min(nq, ncol)]
        frames.append(q)
    return frames


def main() -> None:
    ap = argparse.ArgumentParser(description="GMR/MuJoCo -> Meshcat motion preview")
    ap.add_argument("--motion", required=True, help="motion file: .csv (robot qpos) or .bvh (LAFAN1)")
    ap.add_argument("--format", default="lafan1", choices=["lafan1", "nokov"])
    ap.add_argument("--robot", default="unitree_g1", help="GMR robot key")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--start-paused", action="store_true",
                    help="render the first frame, then wait for a 'resume' before playing")
    args = ap.parse_args()

    try:
        import mujoco as mj
        import meshcat
        import meshcat.geometry as mg
    except Exception as e:  # noqa: BLE001
        die(f"missing dependency ({e}). See requirements.txt / README.md.")

    gmr_root = os.environ.get("SCL_GMR_ROOT", "/home/victor/SCL/GMR")
    if gmr_root and gmr_root not in sys.path:
        sys.path.insert(0, gmr_root)

    ext = os.path.splitext(args.motion)[1].lower()
    print(f"[meshcat-preview] loading {args.motion} ({ext})")

    if ext == ".csv":
        # Already-retargeted robot motion — just play it (no GMR/retarget needed).
        model = mj.MjModel.from_xml_path(resolve_model_xml(gmr_root, args.robot))
        qpos_frames = load_csv_qpos(args.motion, model.nq)
        get_qpos = lambda i: qpos_frames[i]  # noqa: E731
        n = len(qpos_frames)
    else:
        # Raw human mocap — retarget each frame with GMR.
        try:
            from general_motion_retargeting import GeneralMotionRetargeting as GMR
            from general_motion_retargeting.utils.lafan1 import load_bvh_file
            from general_motion_retargeting.params import ROBOT_XML_DICT
        except Exception as e:  # noqa: BLE001
            die(f"GMR not importable ({e}). Set SCL_GMR_ROOT or install GMR's deps (mink…).")
        bvh_frames, human_height = load_bvh_file(args.motion, format=args.format)
        retargeter = GMR(src_human=f"bvh_{args.format}", tgt_robot=args.robot,
                         actual_human_height=human_height)
        model = mj.MjModel.from_xml_path(str(ROBOT_XML_DICT[args.robot]))
        get_qpos = lambda i: retargeter.retarget(bvh_frames[i])  # noqa: E731
        n = len(bvh_frames)

    data = mj.MjData(model)
    vis = meshcat.Visualizer()
    print(f"[meshcat-preview] MESHCAT_URL={vis.url()}", flush=True)
    geom_local = build_scene(vis, model, mj, mg)

    # Ensure the meshcat server subprocess dies with us (on SIGTERM / clean exit),
    # so it doesn't leak. The app stops us with a graceful SIGTERM.
    import atexit
    import signal

    def _shutdown(*_):
        try:
            proc = getattr(getattr(vis, "window", None), "server_proc", None)
            if proc is not None:
                proc.terminate()
        except Exception:
            pass
        os._exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    atexit.register(_shutdown)

    # Control channel: the app writes pause/resume/stop lines to stdin.
    import threading

    paused = threading.Event()

    def _stdin_control():
        try:
            for line in sys.stdin:
                cmd = line.strip().lower()
                if cmd == "pause":
                    paused.set()
                elif cmd == "resume":
                    paused.clear()
                elif cmd == "stop":
                    os._exit(0)
        except Exception:
            pass

    threading.Thread(target=_stdin_control, daemon=True).start()

    # Render the starting pose so the popup shows the robot before playback; if
    # armed, hold there until the app sends "resume" (the popup's Play button).
    if n > 0:
        q0 = get_qpos(0)
        data.qpos[: len(q0)] = q0
        mj.mj_forward(model, data)
        update_scene(vis, model, data, geom_local)
    if args.start_paused:
        paused.set()

    dt = 1.0 / args.fps
    i = 0
    print(f"[meshcat-preview] playing {n} frames @ {args.fps}fps")
    while True:
        if paused.is_set():
            time.sleep(0.05)  # hold the current pose
            continue
        qpos = get_qpos(i)
        data.qpos[: len(qpos)] = qpos
        mj.mj_forward(model, data)
        update_scene(vis, model, data, geom_local)
        time.sleep(dt)
        i += 1
        if i >= n:
            if not args.loop:
                break
            i = 0


if __name__ == "__main__":
    main()
