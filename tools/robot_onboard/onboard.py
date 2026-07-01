#!/usr/bin/env python3
"""
SCL Robotic Command Center — onboarding backend (SSH + nmcli via paramiko).

Each subcommand prints ONE JSON object to stdout. ssh-check/scan/connect emit
{"error": "..."} (exit 1) on failure; reachable/host-ssid never error.

  reachable  --host H [--port 22] [--timeout 5]
  ssh-check  --host H --user U                  (env: SCL_SSH_PASSWORD)
  host-ssid                                     (this machine's current Wi-Fi SSID)
  scan       --host H --user U                  (env: SCL_SSH_PASSWORD)
  connect    --host H --user U --ssid S         (env: SCL_SSH_PASSWORD, SCL_WIFI_PASSWORD)

Wi-Fi is managed with NetworkManager (nmcli), matching the team's setup_wifi.sh.
sudo is fed the SSH password via `sudo -S` (works whether or not sudo needs it).
"""

import argparse
import json
import os
import posixpath
import re
import socket
import sys
import time


def out(obj, code=0):
    print(json.dumps(obj), flush=True)
    sys.exit(code)


def err(msg):
    out({"error": str(msg)}, 1)


def _connect(host, user, password):
    import paramiko

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())  # TOFU (LAN only)
    cli.connect(
        host, username=user, password=password, timeout=10,
        banner_timeout=15, auth_timeout=15, look_for_keys=False, allow_agent=False,
    )
    return cli


def _run(cli, cmd, sudo_pw=None, timeout=30):
    stdin, stdout, stderr = cli.exec_command(cmd, timeout=timeout)
    if sudo_pw is not None:
        try:
            stdin.write(sudo_pw + "\n")
            stdin.flush()
        except Exception:
            pass
    rc = stdout.channel.recv_exit_status()
    return rc, stdout.read().decode("utf-8", "replace"), stderr.read().decode("utf-8", "replace")


def _split_terse(line):
    # nmcli -t escapes ':' inside values as '\:'
    return [p.replace("\\:", ":") for p in re.split(r"(?<!\\):", line)]


def _wifi_iface(cli):
    _, o, _ = _run(cli, "nmcli -t -f DEVICE,TYPE device status")
    for line in o.splitlines():
        f = _split_terse(line)
        if len(f) >= 2 and f[1] == "wifi":
            return f[0]
    return "wlan0"


def _classify_wifi_error(text):
    """Map nmcli connect/activation output to a cause: password | ssid | other."""
    t = (text or "").lower()
    if (
        "secrets were required" in t
        or "no-secrets" in t
        or "802-11-wireless-security" in t
        or "key-mgmt" in t and "invalid" in t
        or "psk" in t and "invalid" in t
        or "(7)" in t  # NM activation failure code 7 = missing/incorrect secrets
    ):
        return "password"
    if (
        "no network with ssid" in t
        or "no access point" in t
        or "not found" in t
        or "(53)" in t
    ):
        return "ssid"
    return "other"


def _read_ipv4(cli, iface, tries=12, delay=1.5):
    """Poll the interface for a DHCP-assigned IPv4 (activation may lag slightly)."""
    for _ in range(tries):
        _, o, _ = _run(cli, f"nmcli -t -f IP4.ADDRESS device show {iface}", timeout=15)
        m = re.search(r"(\d+\.\d+\.\d+\.\d+)", o)
        if m:
            return m.group(1)
        time.sleep(delay)
    return ""


def cmd_reachable(a):
    try:
        socket.create_connection((a.host, a.port), timeout=a.timeout).close()
        out({"reachable": True})
    except Exception:
        out({"reachable": False})


def cmd_ssh_check(a):
    pw = os.environ.get("SCL_SSH_PASSWORD", "")
    try:
        cli = _connect(a.host, a.user, pw)
    except Exception as e:
        err(f"SSH failed: {e}")
    try:
        _, o, _ = _run(cli, "hostname")
        out({"ok": True, "hostname": o.strip()})
    finally:
        cli.close()


def cmd_host_ssid(a):
    try:
        import subprocess

        o = subprocess.run(
            ["nmcli", "-t", "-f", "ACTIVE,SSID", "dev", "wifi"],
            capture_output=True, text=True, timeout=8,
        ).stdout
        for line in o.splitlines():
            f = _split_terse(line)
            if len(f) >= 2 and f[0] == "yes":
                out({"ssid": f[1]})
        out({"ssid": ""})
    except Exception:
        out({"ssid": ""})


def cmd_host_psk(a):
    """Saved Wi-Fi PSK for an SSID from THIS machine's NetworkManager, so the
    operator needn't retype it when the robot joins the laptop's own network.
    Best-effort: returns {"psk": ""} if it can't be read (e.g. polkit denies)."""
    import subprocess

    ssid = a.ssid or ""

    def _nmcli(args):
        return subprocess.run(["nmcli", *args], capture_output=True, text=True, timeout=8).stdout

    def _psk(name):
        try:
            return _nmcli(
                ["-s", "-g", "802-11-wireless-security.psk", "connection", "show", "id", name]
            ).strip()
        except Exception:
            return ""

    def _conn_ssid(name):
        try:
            return _nmcli(["-g", "802-11-wireless.ssid", "connection", "show", "id", name]).strip()
        except Exception:
            return ""

    try:
        if ssid:
            # NM names the profile after the SSID by default — try that first.
            p = _psk(ssid)
            if p:
                out({"psk": p})
            # Otherwise find the Wi-Fi profile whose SSID matches.
            o = _nmcli(["-t", "-f", "NAME,TYPE", "connection", "show"])
            for line in o.splitlines():
                f = _split_terse(line)
                if len(f) >= 2 and "wireless" in f[1] and _conn_ssid(f[0]) == ssid:
                    p = _psk(f[0])
                    if p:
                        out({"psk": p})
        out({"psk": ""})
    except Exception:
        out({"psk": ""})


def cmd_scan(a):
    pw = os.environ.get("SCL_SSH_PASSWORD", "")
    try:
        cli = _connect(a.host, a.user, pw)
    except Exception as e:
        err(f"SSH failed: {e}")
    try:
        _run(cli, "sudo -S -p '' nmcli device wifi rescan", sudo_pw=pw, timeout=25)
        time.sleep(2)
        _, o, _ = _run(cli, "nmcli -t -f SSID,SIGNAL,SECURITY device wifi list", timeout=20)
        seen = {}
        for line in o.splitlines():
            f = _split_terse(line)
            if not f or not f[0]:
                continue
            ssid = f[0]
            signal = int(f[1]) if len(f) > 1 and f[1].isdigit() else 0
            secured = bool(f[2].strip()) if len(f) > 2 else False
            if ssid not in seen or signal > seen[ssid]["signal"]:
                seen[ssid] = {"ssid": ssid, "signal": signal, "secured": secured}
        out({"networks": sorted(seen.values(), key=lambda x: -x["signal"])})
    finally:
        cli.close()


def cmd_connect(a):
    pw = os.environ.get("SCL_SSH_PASSWORD", "")
    wpw = os.environ.get("SCL_WIFI_PASSWORD", "")
    try:
        cli = _connect(a.host, a.user, pw)
    except Exception as e:
        err(f"SSH failed: {e}")
    try:
        iface = _wifi_iface(cli)
        ssid = a.ssid.replace('"', '\\"')
        sec = f' password "{wpw}"' if wpw else ""
        # `nmcli ... connect` is synchronous: it blocks until the connection is
        # fully activated (incl. IP config) or fails, so its rc + output are the
        # authoritative outcome. Classify failures so the UI can be specific.
        rc, o1, e1 = _run(
            cli, f'sudo -S -p "" nmcli device wifi connect "{ssid}"{sec} ifname {iface}',
            sudo_pw=pw, timeout=70,
        )
        if rc != 0:
            kind = _classify_wifi_error(o1 + "\n" + e1)
            if kind == "password":
                err(f"Incorrect Wi-Fi password for “{a.ssid}”.")
            # Manual-profile fallback (mirrors setup_wifi.sh; helps hidden SSIDs).
            _run(cli, f'sudo -S -p "" nmcli connection delete "{ssid}"', sudo_pw=pw, timeout=15)
            sec_add = f' wifi-sec.key-mgmt wpa-psk wifi-sec.psk "{wpw}"' if wpw else ""
            _run(
                cli,
                f'sudo -S -p "" nmcli connection add type wifi con-name "{ssid}" '
                f'ifname {iface} ssid "{ssid}"{sec_add}',
                sudo_pw=pw, timeout=20,
            )
            rc3, o3, e3 = _run(cli, f'sudo -S -p "" nmcli connection up "{ssid}"', sudo_pw=pw, timeout=70)
            if rc3 != 0:
                kind3 = _classify_wifi_error(o3 + "\n" + e3)
                if kind3 == "password":
                    err(f"Incorrect Wi-Fi password for “{a.ssid}”.")
                if kind3 == "ssid":
                    err(f"The robot couldn't find “{a.ssid}”. Move it closer to the access point and re-scan.")
                err(f"Wi-Fi connect failed: {(e1 or e3).strip() or 'unknown error'}")
        # Activation succeeded — read the address it was assigned.
        ip = _read_ipv4(cli, iface)
        if not ip:
            err(f"Joined “{a.ssid}”, but no IPv4 address was assigned (DHCP). Check the router's DHCP pool.")
        out({"ip": ip, "ssid": a.ssid})
    finally:
        cli.close()


SYSTEMD_UNIT = """[Unit]
Description=SCL Robot Telemetry Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
{env}ExecStart={python} /opt/scl/robot_agent.py --port {port}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""

# Where the SDK-bearing python might live, beyond the system python3.
_PY_GLOBS = (
    "/home/*/miniconda3/envs/*/bin/python /home/*/anaconda3/envs/*/bin/python "
    "/home/*/venv*/bin/python /opt/*/bin/python /usr/local/bin/python3"
)


def _pick_python(cli, cdds_home=""):
    """Choose a python interpreter on the robot, preferring one that can import
    unitree_sdk2py (→ live DDS telemetry). Returns (abs_path, dds_available).

    The import probe runs with the SAME CycloneDDS env the agent will run with
    (CYCLONEDDS_HOME / LD_LIBRARY_PATH). unitree_sdk2py loads libddsc.so at import
    time, so a from-source CycloneDDS is invisible without it — probing bare would
    wrongly report no SDK and leave the agent without the env it needs."""
    cands = []
    _, sys_py, _ = _run(cli, "command -v python3")
    sys_py = sys_py.strip().splitlines()[0] if sys_py.strip() else ""
    if sys_py:
        cands.append(sys_py)
    _, extra, _ = _run(cli, f"ls {_PY_GLOBS} 2>/dev/null")
    for line in extra.splitlines():
        p = line.strip()
        if p and p not in cands:
            cands.append(p)
    env = ""
    if cdds_home:
        env = f"CYCLONEDDS_HOME={cdds_home} LD_LIBRARY_PATH={cdds_home}/lib "
    for py in cands:
        rc, _, _ = _run(cli, f'{env}{py} -c "import unitree_sdk2py" 2>/dev/null', timeout=20)
        if rc == 0:
            return py, True
    return (cands[0] if cands else "/usr/bin/python3"), False


def _detect_cyclonedds_home(cli, explicit=""):
    """Locate the robot's CycloneDDS install (usually a from-source build) so its
    libddsc.so can be put on LD_LIBRARY_PATH — without it unitree_sdk2py's
    ChannelFactory can't create a domain ('create domain error', surfaced to the
    UI as 'channel factory init error'). Explicit path wins; else probe the usual
    locations; else fall back to the conventional ~/cyclonedds/install."""
    if explicit:
        return explicit
    _, found, _ = _run(
        cli,
        'for d in "$HOME/cyclonedds/install" "$HOME/cyclonedds_ws/install" '
        '/opt/cyclonedds/install /usr/local; do '
        '[ -e "$d/lib/libddsc.so" ] && { echo "$d"; break; }; done',
        timeout=10,
    )
    cdds_home = found.strip()
    if not cdds_home:
        _, home, _ = _run(cli, "echo -n $HOME", timeout=10)
        cdds_home = f"{home.strip() or '/root'}/cyclonedds/install"
    return cdds_home


def cmd_provision(a):
    """Deploy the telemetry agent to the robot and run it as a systemd service."""
    pw = os.environ.get("SCL_SSH_PASSWORD", "")
    agent_src = os.environ.get("SCL_ROBOT_AGENT_CONTENT", "")
    port = a.agent_port
    if not agent_src:
        err("no agent script content provided (SCL_ROBOT_AGENT_CONTENT empty)")
    try:
        cli = _connect(a.host, a.user, pw)
    except Exception as e:
        err(f"SSH failed: {e}")
    try:
        # Upload agent + unit file to /tmp via SFTP (no sudo), then sudo-install
        # them — `sudo -S` reads the password from stdin, so we avoid heredocs
        # (which would hijack stdin).
        sftp = cli.open_sftp()
        with sftp.file("/tmp/scl-robot-agent.py", "w") as f:
            f.write(agent_src)
        # Give the agent the SAME CycloneDDS environment the on-demand bridge
        # sets up (see cmd_bridge_start). A bare systemd ExecStart has no login
        # shell, so CYCLONEDDS_HOME / LD_LIBRARY_PATH are absent and the SDK's
        # ChannelFactory can't create a domain → 'channel factory init error' on
        # every mode command, and rt/lowstate never arrives (battery/temps blank).
        cdds_home = _detect_cyclonedds_home(cli)
        python, dds = _pick_python(cli, cdds_home)
        env_lines = "Environment=PYTHONUNBUFFERED=1\n"
        if dds and cdds_home:
            # systemd runs the interpreter directly (no conda activation), so also
            # put its env's own lib on LD_LIBRARY_PATH — activation-equivalent, so
            # the cyclonedds C extension finds conda-provided libs (libstdc++, …).
            py_lib = posixpath.dirname(posixpath.dirname(python)) + "/lib"
            env_lines += (
                f"Environment=CYCLONEDDS_HOME={cdds_home}\n"
                f"Environment=LD_LIBRARY_PATH={cdds_home}/lib:{py_lib}\n"
            )
        unit = SYSTEMD_UNIT.format(python=python, port=port, env=env_lines)
        with sftp.file("/tmp/scl-robot-agent.service", "w") as f:
            f.write(unit)

        # Stage the on-robot motion-playback bridge for a sudo-install below.
        # Write to /tmp (always world-writable) — a direct SFTP put into
        # ~/dds_bridge fails with EACCES when the dir or existing file is
        # root-owned, which it usually is.
        bridge_src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dds_bridge_nx.py")
        have_bridge = os.path.exists(bridge_src)
        if have_bridge:
            sftp.put(bridge_src, "/tmp/scl-dds-bridge.py")
        sftp.close()

        # Tear down any previous install first, so re-onboarding never inherits a
        # stale agent, unit file, or a process still holding the port. Best-effort:
        # every step is `|| true` so a missing service/binary is not an error.
        teardown = [
            "sudo -S -p '' systemctl stop scl-robot-agent 2>/dev/null || true",
            "sudo -S -p '' systemctl disable scl-robot-agent 2>/dev/null || true",
            "sudo -S -p '' rm -f /etc/systemd/system/scl-robot-agent.service",
            "sudo -S -p '' rm -rf /opt/scl",
            "sudo -S -p '' systemctl daemon-reload",
            "sudo -S -p '' systemctl reset-failed scl-robot-agent 2>/dev/null || true",
            "sudo -S -p '' pkill -f /opt/scl/robot_agent.py 2>/dev/null || true",
            f"sudo -S -p '' fuser -k {port}/tcp 2>/dev/null || true",
        ]
        for cmd in teardown:
            _run(cli, cmd, sudo_pw=pw, timeout=25)  # ignore rc — cleanup is best-effort

        steps = [
            "sudo -S -p '' install -D -m755 /tmp/scl-robot-agent.py /opt/scl/robot_agent.py",
            "sudo -S -p '' install -m644 /tmp/scl-robot-agent.service "
            "/etc/systemd/system/scl-robot-agent.service",
            "sudo -S -p '' systemctl daemon-reload",
            "sudo -S -p '' systemctl enable scl-robot-agent",
            "sudo -S -p '' systemctl restart scl-robot-agent",
        ]
        for cmd in steps:
            rc, _, e = _run(cli, cmd, sudo_pw=pw, timeout=40)
            if rc != 0:
                err(f"provision step failed ({cmd.split('install')[0].strip() or cmd[:40]}): "
                    f"{e.strip() or 'rc=' + str(rc)}")

        # Install the motion-playback bridge into the SSH user's ~/dds_bridge.
        # Best-effort: playback needs it, but the telemetry agent doesn't, so a
        # failure here must NOT fail provisioning. sudo-install handles a dir or
        # file that's root-owned; -D creates ~/dds_bridge if missing; 644 keeps
        # it readable to the user that runs it at play time.
        bridge_deployed = False
        if have_bridge:
            _, home, _ = _run(cli, "echo -n $HOME", timeout=10)
            home = home.strip() or f"/home/{a.user}"
            rc_b, _, _ = _run(
                cli,
                "sudo -S -p '' install -D -m644 /tmp/scl-dds-bridge.py "
                f"{home}/dds_bridge/dds_bridge_nx.py",
                sudo_pw=pw, timeout=20,
            )
            bridge_deployed = rc_b == 0

        # Give it a moment, then confirm it's up and answering HTTP.
        time.sleep(2)
        rc, active, _ = _run(cli, "sudo -S -p '' systemctl is-active scl-robot-agent",
                             sudo_pw=pw, timeout=15)
        if active.strip() != "active":
            _, jlog, _ = _run(cli, "sudo -S -p '' journalctl -u scl-robot-agent -n 15 --no-pager",
                              sudo_pw=pw, timeout=15)
            err(f"agent service not active ({active.strip() or 'unknown'}): {jlog.strip()[-400:]}")
        health = (
            f'{python} -c "import urllib.request,sys;'
            f"sys.stdout.write(urllib.request.urlopen('http://127.0.0.1:{port}/health',timeout=4)"
            '.read().decode())"'
        )
        rc, hbody, _ = _run(cli, health, timeout=15)
        if '"ok"' not in hbody:
            err(f"agent did not answer on port {port} (is it free?). Got: {hbody.strip()[:200]}")
        out({"ok": True, "port": port, "python": python, "ddsAvailable": dds,
             "bridgeDeployed": bridge_deployed})
    finally:
        cli.close()


def cmd_bridge_start(a):
    """Start dds_bridge_nx.py on the robot's NX on demand (for motion playback).
    Computes this computer's IP toward the robot for the bridge's --pc_ip, then
    launches it detached so it survives the SSH session."""
    pw = os.environ.get("SCL_SSH_PASSWORD", "")
    pc_ip = ""
    try:
        sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sk.connect((a.host, 9501))  # no packet sent; just selects the route's local IP
        pc_ip = sk.getsockname()[0]
        sk.close()
    except Exception:
        pass
    if not pc_ip:
        err("could not determine this computer's IP toward the robot")
    try:
        cli = _connect(a.host, a.user, pw)
    except Exception as e:
        err(f"SSH failed: {e}")
    try:
        # Launch through a LOGIN + INTERACTIVE shell (bash -lic) so the user's
        # environment is loaded — conda activation, LD_LIBRARY_PATH, and the
        # CycloneDDS config that `ChannelFactoryInitialize` needs. A bare
        # non-interactive exec misses all of that and CycloneDDS dies with
        # "create domain error". Default to the shell's own `python` (what works
        # when run by hand); `exec` so pgrep/pkill see the python directly.
        # Resolve the NX→MCU ethernet interface. Its name varies by hardware
        # (eth0, enP8p1s0, …) but is always an ethernet device (e*); Wi-Fi is
        # wl*. Prefer the e* iface on the Unitree internal net (192.168.123.x),
        # else the first UP e* with an IPv4.
        iface = a.iface
        if iface == "auto":
            _, det, _ = _run(
                cli,
                # 1) e* iface on the Unitree internal net, else 2) first UP e*
                # with an IPv4, else 3) first e* that is simply UP (no IPv4 yet).
                "i=$(ip -o -4 addr show 2>/dev/null | "
                "awk '$2 ~ /^e/ && $4 ~ /^192[.]168[.]123[.]/ {print $2; exit}'); "
                "[ -z \"$i\" ] && i=$(ip -o -4 addr show up 2>/dev/null | "
                "awk '$2 ~ /^e/ {print $2; exit}'); "
                "[ -z \"$i\" ] && i=$(ip -br link 2>/dev/null | "
                "awk '$1 ~ /^e/ && $2 == \"UP\" {print $1; exit}'); "
                "echo \"$i\"",
                timeout=10,
            )
            iface = det.strip() or "eth0"

        # CYCLONEDDS_HOME (their from-source build): explicit arg > auto-detected
        # install > ~/cyclonedds/install. It isn't in a non-interactively-sourced
        # rc, so set it explicitly at launch. Shared with the agent's systemd unit
        # (cmd_provision) so both load the same DDS runtime.
        cdds_home = _detect_cyclonedds_home(cli, a.cyclonedds_home)

        # CycloneDDS writes its trace to /tmp/cdds.LOG. An earlier (mistaken) root
        # launch left that file root-owned, and /tmp is sticky — so the user's
        # bridge can neither overwrite nor delete it ("cannot open for writing").
        # Clear it (sudo, due to the sticky bit) so a fresh, user-owned one is made.
        _run(cli, "sudo -S -p '' rm -rf /tmp/cdds.LOG 2>/dev/null || true",
             sudo_pw=pw, timeout=10)

        # Run the bridge AS THE SSH USER (the way it's run by hand) via a login +
        # interactive shell so conda/env load; set CYCLONEDDS_HOME + the resolved
        # interface explicitly. `exec` so pgrep/pkill see the python directly.
        pyexe = a.bridge_python or "python"
        # Per-robot PC-side UDP offset (from the command center): the bridge sends
        # lowstate/hand to pc_ip:(9501+off)/(9505+off) so multiple robots don't
        # collide on this PC. Default 0 keeps the single-robot behavior.
        port_offset = os.environ.get("SCL_PORT_OFFSET", "0")
        # PYTHONUNBUFFERED + `-u`: the bridge writes to a file (not a TTY) so its
        # stdout is block-buffered — without this its "[bridge] …" / "lowstate ->
        # PC" lines never reach the log in time and the readiness check times out
        # even when streaming is fine.
        inner = (
            f"export PYTHONUNBUFFERED=1; export CYCLONEDDS_HOME={cdds_home}; "
            f"export SCL_PORT_OFFSET={port_offset}; "
            f"export LD_LIBRARY_PATH={cdds_home}/lib:${{LD_LIBRARY_PATH:-}}; "
            f"cd {a.bridge_dir} && exec {pyexe} -u dds_bridge_nx.py "
            f"--pc_ip {pc_ip} --iface {iface} --eef {a.eef}"
        )
        launch = (
            f"setsid nohup bash -lic '{inner}' "
            f"</dev/null >/tmp/scl-bridge.log 2>&1 & echo LAUNCHED"
        )
        _run(cli, launch, timeout=25)
        # Wait until the bridge is actually FORWARDING lowstate to this PC. It
        # inits LocoClient/AudioClient (each up to ~10s) BEFORE subscribing to
        # rt/lowstate, and only logs "lowstate -> PC" once data flows — that is
        # the true readiness signal (a live process alone isn't enough, which is
        # why motion_play's 5s lowstate wait was timing out).
        deadline = time.time() + 35.0
        log = ""
        flowing = False
        while time.time() < deadline:
            time.sleep(1.0)
            _, ps, _ = _run(cli, "pgrep -f '[d]ds_bridge_nx.py' || true", timeout=10)
            _, log, _ = _run(cli, "tail -n 30 /tmp/scl-bridge.log 2>/dev/null || true", timeout=10)
            if not ps.strip():
                _, ifaces, _ = _run(cli, "ip -br addr 2>/dev/null || ip addr", timeout=10)
                err(f"bridge crashed on startup. tried --iface={iface}, "
                    f"CYCLONEDDS_HOME={cdds_home}.\n"
                    f"interfaces on robot:\n{ifaces.strip()[-600:]}\n"
                    f"bridge log:\n{log.strip()[-500:] or '(empty)'}")
            if "lowstate -> PC" in log:
                flowing = True
                break
        if not flowing:
            _, ifaces, _ = _run(cli, "ip -br addr 2>/dev/null || ip addr", timeout=10)
            err("bridge started but no lowstate is reaching this PC within 35s — "
                f"check the robot is powered/active and --iface ({iface}) is the "
                "NX→MCU interface (pick one from the list below).\n"
                f"interfaces on robot:\n{ifaces.strip()[-500:]}\n"
                f"bridge log:\n{log.strip()[-500:] or '(empty)'}")
        out({"ok": True, "pc_ip": pc_ip, "iface": iface, "log": log.strip()[-300:]})
    finally:
        cli.close()


def cmd_bridge_stop(a):
    """Stop the on-robot dds_bridge after playback (best-effort)."""
    pw = os.environ.get("SCL_SSH_PASSWORD", "")
    try:
        cli = _connect(a.host, a.user, pw)
    except Exception as e:
        err(f"SSH failed: {e}")
    try:
        # The bridge now runs as root, so stopping it needs sudo.
        _run(cli, "sudo -S -p '' pkill -f '[d]ds_bridge_nx.py' 2>/dev/null || true",
             sudo_pw=pw, timeout=10)
        out({"ok": True})
    finally:
        cli.close()


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="action", required=True)
    for name in ("reachable", "ssh-check", "scan", "connect", "host-ssid", "host-psk"):
        sp = sub.add_parser(name)
        sp.add_argument("--host", default="")
        sp.add_argument("--user", default="")
        sp.add_argument("--ssid", default="")
        sp.add_argument("--port", type=int, default=22)
        sp.add_argument("--timeout", type=float, default=5.0)
    prov = sub.add_parser("provision")
    prov.add_argument("--host", default="")
    prov.add_argument("--user", default="")
    prov.add_argument("--agent-port", type=int, default=8472)
    for name in ("bridge-start", "bridge-stop"):
        bp = sub.add_parser(name)
        bp.add_argument("--host", default="")
        bp.add_argument("--user", default="")
        bp.add_argument("--iface", default="auto")
        bp.add_argument("--eef", default="inspire")
        bp.add_argument("--bridge-dir", dest="bridge_dir", default="~/dds_bridge")
        bp.add_argument("--bridge-python", dest="bridge_python", default="")
        bp.add_argument("--cyclonedds-home", dest="cyclonedds_home", default="")
    a = p.parse_args()
    handlers = {
        "reachable": cmd_reachable,
        "ssh-check": cmd_ssh_check,
        "scan": cmd_scan,
        "connect": cmd_connect,
        "host-ssid": cmd_host_ssid,
        "host-psk": cmd_host_psk,
        "provision": cmd_provision,
        "bridge-start": cmd_bridge_start,
        "bridge-stop": cmd_bridge_stop,
    }
    try:
        handlers[a.action](a)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        err(e)


if __name__ == "__main__":
    main()
