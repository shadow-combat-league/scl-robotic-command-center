#!/usr/bin/env python3
"""
SCL Robotic Command Center — on-robot motion playback.

Trimmed, app-driven version of WBC_Pico_Record/bvh_teleop.py (the `--qpos_csv`
path only): stream an already-retargeted G1 qpos CSV to a real Unitree G1.

Pipeline (identical to the VR/BVH teleop): load the qpos CSV -> resample to the
60 Hz control rate -> run each frame through the SecureMotionInferencer (the
encrypted ONNX policy + pinocchio kinematics) -> stream JSON teleop frames over
UDP to dds_bridge_nx.py on the robot's NX, which forwards them to the MCU while
the robot is in FSM 504 (motion tracking). On stop the robot returns to FSM 801.

Unlike bvh_teleop.py this is NOT interactive: it is controlled by the command
center over stdin (one command per line):

  start            ramp 2 s from the robot's live pose into frame 0, then hold
  play | pause     advance / hold the motion
  reset            jump to frame 0 (and hold)
  loop on | off    toggle looping
  speed <x>        playback speed multiplier (0.25 .. 2.0)
  stop             stop streaming, switch robot back to FSM 801
  quit             stop + exit

It prints `PLAYBACK_READY` to stdout once the inferencer + robot link are up,
and `STATUS ...` / `EVENT ...` lines the parent can surface. Secrets/paths come
from CLI args; the bundle (inferencer .so, model.enc, URDF) is resolved relative
to this file unless overridden.

  python motion_play.py --motion frames.csv --robot_ip 192.168.123.164
"""

import argparse
import json
import os
import signal
import socket
import struct
import sys
import threading
import time
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation as R
from scipy.spatial.transform import Slerp

HERE = Path(__file__).parent.resolve()

# --- transport ports (match dds_bridge_nx.py / bvh_teleop.py) ---
LOWSTATE_PORT = 9501
TELEOP_CMD_PORT = 9602
LOCO_CMD_PORT = 9603

_LOWSTATE_FMT = f"<4f3f{29}f"
_LOWSTATE_SIZE = struct.calcsize(_LOWSTATE_FMT)

# --- robot FSM ids ---
FSM_TELEOP = 504  # motion tracking (robot follows streamed frames)
FSM_LOCO = 801    # locomotion / damp standing (safe idle)
# Seconds to let the robot actually engage FSM 504 before any frames flow, so
# the ramp blends from the robot's *current* pose and it doesn't jump. In
# bvh_teleop.py this is the human gap between pressing 'f' and 's'.
FSM_SETTLE = 1.5


def emit(kind, msg):
    """One structured line to stdout for the parent (command center) to parse."""
    print(f"{kind} {msg}", flush=True)


# ---------------------------------------------------------------------------
# UDP transport to dds_bridge_nx.py on the robot's NX
# ---------------------------------------------------------------------------
class UDPRobotLink:
    def __init__(self, robot_ip, connect_timeout=15.0):
        self.robot_ip = robot_ip
        self.current_joint_pos = np.zeros(29)
        self.current_imu_quat = np.array([1.0, 0.0, 0.0, 0.0])
        self._have_state = False

        self._teleop_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._loco_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._ls_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._ls_sock.bind(("0.0.0.0", LOWSTATE_PORT))
        self._ls_sock.settimeout(0.1)
        self._running = True
        threading.Thread(target=self._recv_lowstate, daemon=True).start()

        emit("EVENT", f"waiting for lowstate from bridge at {robot_ip}")
        deadline = time.time() + connect_timeout
        while time.time() < deadline and not self._have_state:
            time.sleep(0.1)
        if not self._have_state:
            emit("ERROR", f"no lowstate from {robot_ip}:{LOWSTATE_PORT} within "
                          f"{connect_timeout}s — is dds_bridge_nx.py running on the robot?")
            sys.exit(2)
        emit("EVENT", f"bridge connected: {robot_ip}")

    def _recv_lowstate(self):
        while self._running:
            try:
                data, _ = self._ls_sock.recvfrom(2048)
                if len(data) != _LOWSTATE_SIZE:
                    continue
                v = struct.unpack(_LOWSTATE_FMT, data)
                self.current_imu_quat = np.array(v[0:4])
                self.current_joint_pos = np.array(v[7:7 + 29])
                self._have_state = True
            except (socket.timeout, OSError):
                continue

    def send_teleop_frame(self, json_str):
        self._teleop_sock.sendto(json_str.encode("utf-8"), (self.robot_ip, TELEOP_CMD_PORT))

    def switch_fsm(self, fsm_id):
        emit("EVENT", f"switching FSM to {fsm_id}")
        self._loco_sock.sendto(struct.pack("<Bi", 0x01, fsm_id), (self.robot_ip, LOCO_CMD_PORT))

    def stop(self):
        self._running = False


# ---------------------------------------------------------------------------
# qpos CSV -> 60 Hz trajectory
# ---------------------------------------------------------------------------
def load_qpos_csv(path):
    """G1 qpos CSV: 36 cols [pos3, quat_xyzw(4), dof(29)] (the command center's
    already-retargeted format). Returns frames in qpos layout with root quat as
    wxyz (qs[:,3]=w, qs[:,4:7]=xyz), matching the teleop resampler."""
    rows = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.replace(",", " ").split()
        try:
            rows.append([float(x) for x in parts])
        except ValueError:
            continue  # header row
    arr = np.asarray(rows, dtype=float)
    if arr.ndim != 2 or arr.shape[1] != 36:
        raise ValueError(f"expected a 36-col G1 qpos CSV (pos3+quat4+dof29), got {arr.shape}")
    qs = np.zeros_like(arr)
    qs[:, 0:3] = arr[:, 0:3]
    qs[:, 3] = arr[:, 6]        # w
    qs[:, 4:7] = arr[:, 3:6]    # x,y,z
    qs[:, 7:36] = arr[:, 7:36]
    return qs


def prepare_qpos_trajectory(path, ctrl_hz, src_fps):
    qs = load_qpos_csv(path)
    src_dt = 1.0 / src_fps
    qs[:, 0:2] -= qs[0, 0:2]  # start in place
    n = len(qs)
    duration = (n - 1) * src_dt
    t_src = np.arange(n) * src_dt
    m = max(2, int(round(duration * ctrl_hz)) + 1)
    t_tgt = np.linspace(0.0, duration, m)
    out = np.zeros((m, qs.shape[1]))
    for c in list(range(0, 3)) + list(range(7, qs.shape[1])):
        out[:, c] = np.interp(t_tgt, t_src, qs[:, c])
    rots = R.from_quat(qs[:, [4, 5, 6, 3]])  # wxyz -> xyzw
    q_xyzw = Slerp(t_src, rots)(t_tgt).as_quat()
    out[:, 3] = q_xyzw[:, 3]
    out[:, 4:7] = q_xyzw[:, 0:3]
    emit("EVENT", f"resampled {n} frames -> {m} control steps @ {ctrl_hz:.0f}Hz ({duration:.1f}s)")
    return out


# ---------------------------------------------------------------------------
# Player
# ---------------------------------------------------------------------------
class MotionPlay:
    def __init__(self, args):
        self.args = args
        self.ctrl_dt = 1.0 / args.ctrl_hz
        self.qpos_traj = prepare_qpos_trajectory(args.motion, args.ctrl_hz, args.csv_fps)

        bundle = Path(args.bundle).resolve() if args.bundle else HERE
        urdf = args.urdf or str(bundle / "assets/g1/g1_body29_hand14.urdf")
        model = args.model or str(bundle / "models/model.enc")
        if str(bundle) not in sys.path:
            sys.path.insert(0, str(bundle))
        try:
            from utils.inference import SecureMotionInferencer
        except Exception as e:
            emit("ERROR", f"cannot import SecureMotionInferencer: {e}")
            sys.exit(3)
        try:
            self.inferencer = SecureMotionInferencer(urdf, model)
        except Exception as e:
            emit("ERROR", f"failed to init secure inferencer: {e}")
            sys.exit(3)

        self.robot = None if args.dry_run else UDPRobotLink(args.robot_ip)

        self.lock = threading.Lock()
        self.streaming = False
        self.playing = False
        self.loop = args.loop
        self.speed = 1.0
        self.cursor = 0.0
        self.zero_rotation = None
        self.ramp_total = max(1, int(args.ramp_time * args.ctrl_hz))
        self.ramp_steps_left = 0
        self.ramp_start_qpos = None
        self._last_status = 0.0
        self._stop = False
        self._thread = threading.Thread(target=self._stream_loop, daemon=True)
        self._thread.start()

    def _robot_qpos_estimate(self):
        q = np.zeros(36)
        q[0:3] = [0.0, 0.0, 0.793]
        q[3:7] = self.robot.current_imu_quat if self.robot else [1.0, 0.0, 0.0, 0.0]
        if np.linalg.norm(q[3:7]) < 1e-6:
            q[3:7] = [1.0, 0.0, 0.0, 0.0]
        if self.robot:
            q[7:36] = self.robot.current_joint_pos
        return q

    def _process_and_send(self, qpos):
        motion_vq, root_pose, cmd_wrist, _ = self.inferencer.process(qpos, self.ctrl_dt)
        if motion_vq is None:
            return
        quat_wxyz = root_pose[3:7]
        raw_rot = R.from_quat([quat_wxyz[1], quat_wxyz[2], quat_wxyz[3], quat_wxyz[0]])
        if self.zero_rotation is None:
            self.zero_rotation = raw_rot
        delta = (self.zero_rotation.inv() * raw_rot).as_quat()
        root_pose[3:7] = [delta[3], delta[0], delta[1], delta[2]]
        full = np.concatenate([motion_vq, root_pose, cmd_wrist], axis=-1)
        payload = json.dumps({"frame": full.tolist(), "name": "default"}, separators=(",", ":"))
        if self.robot:
            self.robot.send_teleop_frame(payload)

    def _stream_loop(self):
        next_tick = time.perf_counter()
        while not self._stop:
            now = time.perf_counter()
            if now < next_tick:
                time.sleep(max(0.0, next_tick - now))
                continue
            next_tick += self.ctrl_dt
            with self.lock:
                streaming, playing, speed, idx = self.streaming, self.playing, self.speed, int(self.cursor)
            if not streaming:
                continue
            if now - self._last_status >= 0.1:  # ~10 Hz live status to the UI
                self._last_status = now
                self._status()
            if self.ramp_steps_left > 0:
                a = 1.0 - self.ramp_steps_left / self.ramp_total
                q0, q1 = self.ramp_start_qpos, self.qpos_traj[0]
                q = q0 * (1 - a) + q1 * a
                r0, r1 = R.from_quat(q0[[4, 5, 6, 3]]), R.from_quat(q1[[4, 5, 6, 3]])
                rq = Slerp([0, 1], R.concatenate([r0, r1]))([a]).as_quat()[0]
                q[3], q[4:7] = rq[3], rq[0:3]
                self._process_and_send(q)
                self.ramp_steps_left -= 1
                if self.ramp_steps_left == 0:
                    emit("EVENT", "ramp done — holding frame 0")
                    self._status()
                continue
            self._process_and_send(self.qpos_traj[idx].copy())
            if playing:
                with self.lock:
                    self.cursor += speed
                    if self.cursor >= len(self.qpos_traj) - 1:
                        if self.loop:
                            self.cursor = 0.0
                        else:
                            self.cursor = len(self.qpos_traj) - 1
                            self.playing = False
                            emit("EVENT", "reached end")
                            self._status()

    def _status(self):
        with self.lock:
            emit("STATUS", json.dumps({
                "streaming": self.streaming, "playing": self.playing,
                "frame": int(self.cursor) + 1, "frames": len(self.qpos_traj),
                "loop": self.loop, "speed": round(self.speed, 2),
                "ramping": self.ramp_steps_left > 0,
            }, separators=(",", ":")))

    # --- commands (driven over stdin by the command center) ---
    def start(self):
        with self.lock:
            if self.streaming:
                return
        # Enter teleop/tracking mode FIRST (bvh_teleop.py's 'f'), then let the
        # robot engage FSM 504 before any frames flow — only then capture the
        # ramp start pose and begin streaming (bvh_teleop.py's 's'). This ordering
        # is what makes the robot ramp from its *current* pose without jumping.
        if self.robot:
            self.robot.switch_fsm(FSM_TELEOP)
            emit("EVENT", f"entering teleop (FSM {FSM_TELEOP}) — settling {FSM_SETTLE:.1f}s")
            time.sleep(FSM_SETTLE)
        with self.lock:
            self.zero_rotation = None
            self.ramp_start_qpos = self._robot_qpos_estimate()
            self.ramp_steps_left = self.ramp_total
            self.cursor = 0.0
            self.streaming = True
        emit("EVENT", f"ramping into frame 0 over {self.args.ramp_time:.1f}s")
        self._status()

    def play(self, on):
        # May be set during the ramp; the stream loop only advances once the
        # ramp finishes, so this auto-plays as soon as ramp-in completes.
        with self.lock:
            if self.streaming:
                self.playing = on
        self._status()

    def reset(self):
        with self.lock:
            self.cursor = 0.0
            self.playing = False
        self._status()

    def set_loop(self, on):
        with self.lock:
            self.loop = on
        self._status()

    def set_speed(self, x):
        with self.lock:
            self.speed = max(0.25, min(2.0, x))
        self._status()

    def stop(self):
        with self.lock:
            self.streaming = False
            self.playing = False
        if self.robot:
            self.robot.switch_fsm(FSM_LOCO)
        emit("EVENT", "stopped — robot back in FSM 801")
        self._status()

    def shutdown(self):
        self.stop()
        self._stop = True
        self._thread.join(timeout=1.0)
        if self.robot:
            self.robot.stop()


def main():
    ap = argparse.ArgumentParser(description="Stream a G1 qpos CSV to a real Unitree G1 (UDP bridge).")
    ap.add_argument("--motion", required=True, help="already-retargeted G1 qpos CSV (36 cols).")
    ap.add_argument("--robot_ip", default=None, help="bridge IP (dds_bridge_nx.py on the robot).")
    ap.add_argument("--csv_fps", type=float, default=30.0)
    ap.add_argument("--ctrl_hz", type=float, default=60.0)
    ap.add_argument("--ramp_time", type=float, default=2.0)
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--bundle", default=None, help="dir with utils/inference*.so, models/, assets/ (default: script dir).")
    ap.add_argument("--urdf", default=None)
    ap.add_argument("--model", default=None)
    ap.add_argument("--dry-run", dest="dry_run", action="store_true",
                    help="skip the robot link/UDP — just load + resample + init inferencer (offline test).")
    ap.add_argument("--autostart", action="store_true", help="begin streaming immediately.")
    args = ap.parse_args()

    if not args.dry_run and not args.robot_ip:
        ap.error("--robot_ip is required unless --dry-run")

    emit("EVENT", "SAFETY: clear the area — the robot moves once FSM 504 receives frames")
    player = MotionPlay(args)

    # On SIGTERM (parent kill), still return the robot to FSM 801 before exiting.
    def _term(*_):
        try:
            player.shutdown()
        finally:
            os._exit(0)

    signal.signal(signal.SIGTERM, _term)
    emit("PLAYBACK_READY", "ok")
    if args.dry_run:
        # Offline self-test: render a few frames through the inferencer, then exit.
        for i in range(min(3, len(player.qpos_traj))):
            player._process_and_send(player.qpos_traj[i].copy())
        emit("EVENT", "dry-run processed frames OK")
        return
    if args.autostart:
        player.start()

    for line in sys.stdin:
        cmd = line.strip().lower()
        if not cmd:
            continue
        if cmd in ("quit", "exit"):
            break
        elif cmd == "start":
            player.start()
        elif cmd == "play":
            player.play(True)
        elif cmd == "pause":
            player.play(False)
        elif cmd == "reset":
            player.reset()
        elif cmd == "stop":
            player.stop()
        elif cmd in ("loop on", "loop"):
            player.set_loop(True)
        elif cmd == "loop off":
            player.set_loop(False)
        elif cmd.startswith("speed "):
            try:
                player.set_speed(float(cmd.split()[1]))
            except (ValueError, IndexError):
                emit("ERROR", "bad speed")
        else:
            emit("ERROR", f"unknown command: {cmd}")

    player.shutdown()


if __name__ == "__main__":
    main()
