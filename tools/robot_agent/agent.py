#!/usr/bin/env python3
"""
SCL Robotic Command Center — on-robot telemetry agent.

A tiny, dependency-free HTTP server that runs ON the robot's onboard computer
and reports live telemetry to the command center. Deployed + registered as a
systemd service during onboarding (see tools/robot_onboard/onboard.py).

  GET /telemetry  -> JSON telemetry (see snapshot()).
  GET /health     -> {"ok": true}

OS metrics (CPU %, memory %, uptime, hostname) use only the Python standard
library + /proc, so NOTHING needs to be pip-installed on the robot.

Robot state (battery, temperatures, joint status, E-stop) is read best-effort
from the Unitree `rt/lowstate` DDS topic IF `unitree_sdk2py` is importable. If
it isn't (e.g. running on a plain Linux box for testing), those fields are null
and `robotStateAvailable` is false — the HTTP server still serves OS metrics.

  python3 agent.py --port 8472
"""

import argparse
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ----------------------------------------------------------------------------
# OS metrics (stdlib + /proc, always available on Linux)
# ----------------------------------------------------------------------------


class CpuSampler:
    """Background sampler turning /proc/stat deltas into a CPU-busy percentage."""

    def __init__(self, interval=1.0):
        self.interval = interval
        self.percent = 0.0
        self._prev = self._read()
        t = threading.Thread(target=self._loop, daemon=True)
        t.start()

    @staticmethod
    def _read():
        try:
            with open("/proc/stat", "r") as f:
                parts = f.readline().split()[1:]  # drop the "cpu" label
            vals = [int(x) for x in parts]
            idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle + iowait
            return sum(vals), idle
        except Exception:
            return None

    def _loop(self):
        while True:
            time.sleep(self.interval)
            cur = self._read()
            if cur and self._prev:
                d_total = cur[0] - self._prev[0]
                d_idle = cur[1] - self._prev[1]
                if d_total > 0:
                    self.percent = round(100.0 * (d_total - d_idle) / d_total, 1)
            if cur:
                self._prev = cur


def read_memory_percent():
    """Used memory as a percentage, from /proc/meminfo."""
    try:
        info = {}
        with open("/proc/meminfo", "r") as f:
            for line in f:
                k, _, rest = line.partition(":")
                info[k.strip()] = int(rest.split()[0])  # kB
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", info.get("MemFree", 0))
        if total > 0:
            return round(100.0 * (total - avail) / total, 1)
    except Exception:
        pass
    return None


def read_uptime_sec():
    try:
        with open("/proc/uptime", "r") as f:
            return int(float(f.readline().split()[0]))
    except Exception:
        return 0


# ----------------------------------------------------------------------------
# Robot state + control via Unitree DDS (best-effort, optional)
# ----------------------------------------------------------------------------

_DDS_LOCK = threading.Lock()
_DDS_READY = False


def ensure_dds(domain=0, iface=None):
    """Initialize the Unitree DDS channel factory exactly once per process
    (shared by the lowstate subscriber and the loco command client)."""
    global _DDS_READY
    with _DDS_LOCK:
        if _DDS_READY:
            return
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize  # type: ignore

        if not iface:
            iface = _find_dds_iface()
        if iface:
            ChannelFactoryInitialize(domain, iface)
        else:
            ChannelFactoryInitialize(domain)
        _DDS_READY = True


def _find_dds_iface(prefix="192.168.123."):
    """Name of the interface on the Unitree internal network (where rt/lowstate is
    published). Binding DDS to it explicitly avoids a boot race where cyclonedds
    auto-selects Wi-Fi/loopback before this NIC is up and then never rebinds."""
    import subprocess

    try:
        out = subprocess.run(
            ["ip", "-4", "-o", "addr", "show"], capture_output=True, text=True, timeout=5
        ).stdout
        for line in out.splitlines():
            parts = line.split()
            if "inet" in parts:
                addr = parts[parts.index("inet") + 1].split("/")[0]
                if addr.startswith(prefix):
                    return parts[1]
    except Exception:
        pass
    return None


class RobotState:
    """
    Subscribes to the Unitree `rt/lowstate` DDS topic (unitree_hg / humanoid) and
    caches the latest frame. Everything is wrapped so a missing SDK, a failed DDS
    init, or an unexpected schema can never take down the HTTP server.

    Reboot robustness: the agent (a systemd service) can start before the robot's
    internal NIC / lowstate publisher is up. cyclonedds binds its interface ONCE
    at init and never rebinds, so we wait for that NIC to appear, then bind to it.
    Availability is based on frame *freshness*, so a dropped link reports
    unavailable and recovers on its own when frames resume.
    """

    def __init__(self, domain=0, iface=None):
        self.domain = domain
        self.iface = iface
        self.error = ""
        self._sub = None
        self._msg = None
        self._ts = 0.0  # monotonic time of the last frame
        self._lock = threading.Lock()

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            from unitree_sdk2py.core.channel import ChannelSubscriber  # type: ignore
            from unitree_sdk2py.idl.unitree_hg.msg.dds_ import LowState_  # type: ignore
        except Exception as e:  # noqa: BLE001
            self.error = f"SDK import failed: {e}"
            return

        # Wait for the robot's internal NIC before binding DDS (avoids latching
        # onto loopback/Wi-Fi at boot). Fall back to auto-detect if not found.
        iface = self.iface
        if not iface:
            for _ in range(30):
                iface = _find_dds_iface()
                if iface:
                    break
                time.sleep(1)

        try:
            ensure_dds(self.domain, iface)
            self._sub = ChannelSubscriber("rt/lowstate", LowState_)
            self._sub.Init(self._on_msg, 10)
        except Exception as e:  # noqa: BLE001
            self.error = f"{type(e).__name__}: {e}"
            return
        while True:
            time.sleep(3600)  # keep the thread (and subscriber) alive

    def _on_msg(self, msg):
        with self._lock:
            self._msg = msg
            self._ts = time.monotonic()

    def snapshot(self):
        """{available, battery, temperature, jointsOk, estop}. `available` is true
        only when a frame arrived recently, so a dropped DDS link shows as
        unavailable rather than serving stale values."""
        out = {
            "available": False,
            "battery": None,
            "temperature": None,
            "jointsOk": None,
            "estop": None,
        }
        with self._lock:
            msg = self._msg
            age = (time.monotonic() - self._ts) if self._ts else 1e9
        if msg is None or age > 5.0:
            return out
        out["available"] = True
        out["battery"] = _safe(lambda: float(msg.bms_state.soc))
        out["temperature"] = _safe(lambda: _temperature(msg))
        out["jointsOk"] = _safe(lambda: _joints_ok(msg))
        out["estop"] = _safe(lambda: _estop(msg), default=False)
        return out


def _safe(fn, default=None):
    try:
        v = fn()
        return v if v is not None else default
    except Exception:
        return default


def _temperature(msg):
    """Highest of IMU + motor temperatures, °C (best-effort)."""
    temps = []
    try:
        temps.append(float(msg.imu_state.temperature))
    except Exception:
        pass
    try:
        for m in msg.motor_state:
            t = m.temperature
            temps.extend(float(x) for x in (t if hasattr(t, "__iter__") else [t]))
    except Exception:
        pass
    temps = [t for t in temps if t and t > 0]
    return round(max(temps), 1) if temps else None


def _joints_ok(msg):
    """True when every motor reports a nominal (non-lost) state."""
    motors = list(msg.motor_state)
    if not motors:
        return None
    for m in motors:
        if getattr(m, "lost", 0):
            return False
    return True


def _estop(msg):
    # Best-effort; refine against a live G1 FSM. Default not-stopped.
    return False


class LocoController:
    """High-level G1 mode control via the Unitree LocoClient (best-effort).

    Each action is a sequence of ops applied in order (with a short settle delay
    between them). An op is:
      ("fsm", id)            -> SetFsmId(id)
      ("call", name, *args)  -> getattr(client, name)(*args)
    Canonical G1 loco FSM ids (Unitree official C++ SDK g1_loco_client.hpp):
      0 ZeroTorque · 1 Damp · 2 Squat · 3 Sit · 4 StandUp (Locked Standing) · 500 Start
    Balance mode: 0 = static stand (holds still), 1 = continuous stepping gait.
    """

    ACTIONS = {
        "damp": [("call", "Damp")],
        "sit": [("call", "Sit")],
        "stand": [("fsm", 4)],  # Locked Standing (StandUp) — no named python wrapper
        "lockstand": [("fsm", 4)],
        "ready": [("fsm", 4)],
        # Enter main operation control, then static balance so the robot stands
        # still until commanded — no continuous step-in-place gait.
        "run": [("call", "Start"), ("call", "SetBalanceMode", 0)],
        "zero": [("call", "ZeroTorque")],
    }

    def __init__(self, domain=0, iface=None):
        self.domain = domain
        self.iface = iface
        self._client = None
        self._lock = threading.Lock()

    def _ensure(self):
        if self._client is not None:
            return self._client
        ensure_dds(self.domain, self.iface)
        from unitree_sdk2py.g1.loco.g1_loco_client import LocoClient  # type: ignore

        c = LocoClient()
        try:
            c.SetTimeout(10.0)
        except Exception:
            pass
        c.Init()
        self._client = c
        return c

    def command(self, action):
        ops = self.ACTIONS.get(action)
        if ops is None:
            raise ValueError(f"unknown action '{action}'")
        with self._lock:
            client = self._ensure()
            for i, op in enumerate(ops):
                if i:
                    time.sleep(1.0)  # let the FSM settle before the next step
                if op[0] == "fsm":
                    client.SetFsmId(op[1])
                elif op[0] == "call":
                    getattr(client, op[1])(*op[2:])
                else:
                    raise ValueError(f"bad op {op}")
        return True


# ----------------------------------------------------------------------------
# HTTP server
# ----------------------------------------------------------------------------

CPU = None  # set in main()
ROBOT = None  # set in main()
LOCO = None  # set in main()


def snapshot():
    robot = ROBOT.snapshot() if ROBOT else {"available": False}
    return {
        "battery": robot.get("battery"),
        "temperature": robot.get("temperature"),
        "cpuLoad": CPU.percent if CPU else 0.0,
        "memory": read_memory_percent(),
        "uptimeSec": read_uptime_sec(),
        "jointsOk": robot.get("jointsOk"),
        "estop": robot.get("estop"),
        "hostname": socket.gethostname(),
        "robotStateAvailable": bool(robot.get("available")),
        "ts": int(time.time()),
    }


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0 → connection closes after each response; avoids keep-alive
    # threads blocking on readline (and the spurious ConnectionResetError logs).
    protocol_version = "HTTP/1.0"

    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionError):
            pass  # client went away mid-response — ignore

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        if path in ("/telemetry", ""):
            self._send(200, snapshot())
        elif path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        if path != "/command":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b"{}"
            action = json.loads(body or b"{}").get("action", "")
        except Exception as e:
            self._send(400, {"error": f"bad request: {e}"})
            return
        try:
            LOCO.command(action)
            self._send(200, {"ok": True, "action": action})
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except ImportError:
            self._send(503, {"error": "robot control unavailable (Unitree SDK not on robot)"})
        except Exception as e:
            self._send(502, {"error": f"command failed (is the robot's loco service running?): {e}"})

    def log_message(self, *_args):
        pass  # keep the journal quiet


def main():
    global CPU, ROBOT, LOCO
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8472)
    p.add_argument("--dds-domain", type=int, default=0)
    p.add_argument("--dds-iface", default="")
    a = p.parse_args()

    CPU = CpuSampler()
    ROBOT = RobotState(domain=a.dds_domain, iface=a.dds_iface or None)
    ROBOT.start()
    LOCO = LocoController(domain=a.dds_domain, iface=a.dds_iface or None)

    server = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"SCL robot agent listening on {a.host}:{a.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
