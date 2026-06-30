#!/usr/bin/env python3
"""
DDS-UDP bridge for G1 whole-body teleop.  Runs on the G1's NX computer.

Bridges the following between a remote PC (running whole_body_teleop_record.py
with --robot_ip) and the G1's MCU via DDS:

  NX -> PC (UDP):
    port 9501  rt/lowstate   (IMU quaternion + gyroscope + motor q)
    port 9505  hand state    (hand motor positions & commands)

  PC -> NX (UDP):
    port 9601  rt/cmd_latent        (JSON string)
    port 9602  rt/fsm/teleop/cmd    (JSON string)
    port 9603  locomotion commands   (FSM switch / Move)
    port 9604  hand commands         (gripper ratios / open pose)
    port 9606  audio TTS text

Usage on G1 NX:
    python dds_bridge_nx.py --pc_ip 10.42.0.1 --iface eth0 --eef inspire
"""

import argparse
import os
import socket
import struct
import sys
import threading
import time

import numpy as np

# ---------------------------------------------------------------------------
# Project root (for hand-controller imports)
# ---------------------------------------------------------------------------
ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from unitree_sdk2py.core.channel import (
    ChannelFactoryInitialize,
    ChannelPublisher,
    ChannelSubscriber,
)
from unitree_sdk2py.idl.std_msgs.msg.dds_ import String_
from unitree_sdk2py.idl.unitree_hg.msg.dds_ import LowState_ as LowStateHG
from unitree_sdk2py.g1.loco.g1_loco_client import LocoClient

# ---------------------------------------------------------------------------
# UDP port assignments  (must match whole_body_teleop_record.py)
# ---------------------------------------------------------------------------
LOWSTATE_PORT   = 9501   # NX -> PC
HAND_STATE_PORT = 9505   # NX -> PC
CMD_LATENT_PORT = 9601   # PC -> NX
TELEOP_CMD_PORT = 9602   # PC -> NX
LOCO_CMD_PORT   = 9603   # PC -> NX
HAND_CMD_PORT   = 9604   # PC -> NX
AUDIO_CMD_PORT  = 9606   # PC -> NX

NUM_MOTORS = 29

# Binary formats
LOWSTATE_FMT   = f"<4f3f{NUM_MOTORS}f"   # quat(4) + gyro(3) + motor_q(29)
HAND_STATE_FMT = "<24f"                    # l_state(6)+r_state(6)+l_cmd(6)+r_cmd(6)


def _pad6(arr):
    """Pad / trim *arr* to exactly 6 float64 values."""
    out = np.zeros(6, dtype=np.float64)
    flat = np.atleast_1d(np.asarray(arr, dtype=np.float64)).flatten()
    n = min(len(flat), 6)
    out[:n] = flat[:n]
    return out


# ===========================================================================
def main(pc_ip: str, iface: str, eef_type: str, domain_id: int = 0):
    # --- DDS ---
    ChannelFactoryInitialize(domain_id, iface)
    print(f"[bridge] DDS initialised on {iface}")

    # --- LocoClient ---
    loco = LocoClient()
    loco.SetTimeout(10.0)
    loco.Init()
    print("[bridge] LocoClient ready")

    # --- AudioClient (best-effort) ---
    audio = None
    try:
        from unitree_sdk2py.g1.audio.g1_audio_client import AudioClient
        audio = AudioClient()
        audio.SetTimeout(10.0)
        audio.Init()
        audio.SetVolume(100)
        print("[bridge] AudioClient ready")
    except Exception as e:
        print(f"[bridge] AudioClient unavailable: {e}")

    # --- Hand controller ---
    hand = None
    try:
        if eef_type == "inspire":
            from eef.inspire.ftp_hand import InspireFTPHandController
            hand = InspireFTPHandController()
            hand.set_gripper_ratios(0.0, 0.0)
        elif eef_type == "dex1":
            from eef.dex1.dex1 import Dex1
            hand = Dex1()
            hand.set_gripper_ratios(5.5, 5.5)
        elif eef_type == "brainco":
            from eef.brainco.brainco import Brainco
            hand = Brainco()
            hand.set_gripper_ratios(0.0, 0.0)
        print(f"[bridge] Hand controller ({eef_type}) ready")
    except Exception as e:
        print(f"[bridge] Hand controller failed: {e}")

    # =================================================================
    #  NX -> PC : rt/lowstate
    # =================================================================
    udp_state = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    _st_cnt = [0]
    _st_t   = [time.time()]

    def _on_lowstate(msg: LowStateHG):
        quat    = list(msg.imu_state.quaternion[:4])
        gyro    = list(msg.imu_state.gyroscope[:3])
        motor_q = [msg.motor_state[i].q for i in range(NUM_MOTORS)]
        pkt = struct.pack(LOWSTATE_FMT, *quat, *gyro, *motor_q)
        udp_state.sendto(pkt, (pc_ip, LOWSTATE_PORT))
        _st_cnt[0] += 1
        now = time.time()
        if now - _st_t[0] >= 5.0:
            print(f"[bridge] lowstate -> PC  {_st_cnt[0]} pkts/5s "
                  f"({_st_cnt[0] / 5:.0f} Hz)")
            _st_cnt[0] = 0
            _st_t[0] = now

    ls_sub = ChannelSubscriber("rt/lowstate", LowStateHG)
    ls_sub.Init(_on_lowstate, 10)
    print(f"[bridge] rt/lowstate -> {pc_ip}:{LOWSTATE_PORT}")

    # =================================================================
    #  PC -> NX : rt/cmd_latent
    # =================================================================
    cl_pub = ChannelPublisher("rt/cmd_latent", String_)
    cl_pub.Init()
    cl_msg = String_(data="")

    def _recv_cmd_latent():
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("0.0.0.0", CMD_LATENT_PORT))
        print(f"[bridge] Listening cmd_latent :{CMD_LATENT_PORT}")
        while True:
            data, _ = sock.recvfrom(65535)
            cl_msg.data = data.decode("utf-8")
            cl_pub.Write(cl_msg)

    threading.Thread(target=_recv_cmd_latent, daemon=True).start()

    # =================================================================
    #  PC -> NX : rt/fsm/teleop/cmd
    # =================================================================
    tc_pub = ChannelPublisher("rt/fsm/teleop/cmd", String_)
    tc_pub.Init()
    tc_msg = String_(data="")

    def _recv_teleop_cmd():
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("0.0.0.0", TELEOP_CMD_PORT))
        print(f"[bridge] Listening teleop_cmd :{TELEOP_CMD_PORT}")
        while True:
            data, _ = sock.recvfrom(65535)
            tc_msg.data = data.decode("utf-8")
            tc_pub.Write(tc_msg)

    threading.Thread(target=_recv_teleop_cmd, daemon=True).start()

    # =================================================================
    #  PC -> NX : locomotion commands
    # =================================================================
    def _recv_loco_cmd():
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("0.0.0.0", LOCO_CMD_PORT))
        print(f"[bridge] Listening loco_cmd :{LOCO_CMD_PORT}")
        while True:
            data, _ = sock.recvfrom(2048)
            if len(data) < 1:
                continue
            cmd = data[0]
            if cmd == 0x01 and len(data) >= 5:       # SetFsmId
                fsm_id = struct.unpack("<i", data[1:5])[0]
                print(f"[bridge] SetFsmId({fsm_id})")
                try:
                    loco.SetTimeout(3.0)
                    loco.SetFsmId(fsm_id)
                    loco.SetTimeout(0.01)
                except Exception as e:
                    print(f"[bridge] SetFsmId error: {e}")
            elif cmd == 0x02 and len(data) >= 13:    # Move
                vx, vy, vyaw = struct.unpack("<3f", data[1:13])
                try:
                    loco.SetTimeout(0.001)
                    loco.Move(vx, vy, vyaw)
                except Exception:
                    pass

    threading.Thread(target=_recv_loco_cmd, daemon=True).start()

    # =================================================================
    #  PC -> NX : hand commands
    # =================================================================
    def _recv_hand_cmd():
        if hand is None:
            return
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("0.0.0.0", HAND_CMD_PORT))
        print(f"[bridge] Listening hand_cmd :{HAND_CMD_PORT}")
        while True:
            data, _ = sock.recvfrom(2048)
            if len(data) < 1:
                continue
            cmd = data[0]
            if cmd == 0x01 and len(data) >= 9:        # set_gripper_ratios
                l, r = struct.unpack("<2f", data[1:9])
                hand.set_gripper_ratios(l, r)
            elif cmd == 0x02 and len(data) >= 5:      # change_open_pose
                mode = struct.unpack("<i", data[1:5])[0]
                hand.change_open_pose(mode)

    threading.Thread(target=_recv_hand_cmd, daemon=True).start()

    # =================================================================
    #  NX -> PC : hand state  (50 Hz poll)
    # =================================================================
    def _send_hand_state():
        if hand is None:
            return
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        while True:
            try:
                ls, rs = hand.get_hand_states()
                lc, rc = hand.l_cmd, hand.r_cmd
                pkt = struct.pack(
                    HAND_STATE_FMT,
                    *_pad6(ls), *_pad6(rs), *_pad6(lc), *_pad6(rc),
                )
                sock.sendto(pkt, (pc_ip, HAND_STATE_PORT))
            except Exception:
                pass
            time.sleep(1.0 / 50)

    threading.Thread(target=_send_hand_state, daemon=True).start()

    # =================================================================
    #  PC -> NX : audio TTS
    # =================================================================
    def _recv_audio():
        if audio is None:
            return
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("0.0.0.0", AUDIO_CMD_PORT))
        print(f"[bridge] Listening audio TTS :{AUDIO_CMD_PORT}")
        while True:
            data, _ = sock.recvfrom(4096)
            text = data.decode("utf-8")
            try:
                audio.TtsMaker(text, 1)
            except Exception as e:
                print(f"[bridge] TTS error: {e}")

    threading.Thread(target=_recv_audio, daemon=True).start()

    # =================================================================
    print("[bridge] DDS <-> UDP bridge running.  Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\n[bridge] Shutting down.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(
        description="G1 DDS-UDP bridge for teleop (runs on NX)"
    )
    p.add_argument("--pc_ip", required=True, help="Remote PC IP address")
    p.add_argument("--iface", default="eth0", help="NX ethernet interface to MCU")
    p.add_argument(
        "--eef",
        default="inspire",
        choices=["inspire", "dex1", "brainco"],
        help="End-effector type",
    )
    p.add_argument("--domain_id", type=int, default=0, help="DDS domain ID")
    a = p.parse_args()
    main(a.pc_ip, a.iface, a.eef, a.domain_id)
