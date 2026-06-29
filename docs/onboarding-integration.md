# Real onboarding integration — plan

Replace the mock onboarding (`onboarding.svelte.ts`) with real robot ops.
Grounded in the team's actual method: **NetworkManager `nmcli` over SSH** on the
robot (see `GR00T-WholeBodyControl/gear_sonic_deploy/scripts/setup_wifi.sh`).

## Flow (per wizard step)
1. **Ethernet reachable** — TCP-connect to the wired IP `:22` (G1 default `192.168.123.164`). No raw ICMP needed.
2. **SSH auth** — open an SSH session as `unitree@<wiredIP>` with the SSH password.
3. **Wi-Fi scan (robot's radio)** — over SSH: `sudo nmcli device wifi rescan` then `nmcli -t -f SSID,SIGNAL,SECURITY device wifi list`.
4. **Wi-Fi connect** — over SSH: `nmcli device wifi connect "<SSID>" password "<pw>"` (via `sudo -S`, feeding the SSH password to sudo). Falls back to a manual `nmcli connection add … wifi-sec.psk` profile, matching setup_wifi.sh.
5. **Get + save IP** — over SSH read the wlan IPv4 (`nmcli -t -f IP4.ADDRESS device show <wlan>`), strip `/xx`, persist to the profile as the new `ip`.
6. **Reconnect / re-Wi-Fi** — if the saved (Wi-Fi) IP is unreachable, the console/home shows **Reconnect** → re-opens onboarding at the **Ethernet** step (using the stored wired IP + creds) so the user can redo Wi-Fi without re-entering everything.

## Architecture
- **SSH via the embedded Python + `paramiko`** (reuses the bundled `pyenv`; battle-tested, no Rust SSH/C-build deps). A small `tools/robot_onboard/onboard.py` exposes subcommands (`reachable`, `scan`, `connect`) that print JSON.
- **Rust command** `run_onboard(action, host, user, …)` spawns the bundled python, passing secrets via **env vars** (not argv/ps), captures stdout JSON, returns it. Reuses the existing python-resolution + safe-kill code.
- **`tauri.ts`** wrappers: `robotReachable`, `robotSshCheck`, `robotWifiScan`, `robotWifiConnect`.
- `onboarding.svelte.ts`: swap mock bodies for these; keep the same wizard UI.
- `build_bundle.sh`: add `paramiko`.

## Decisions
- **SSH password storage** — needed for hassle-free reconnect/re-Wi-Fi. Options: OS keychain (secure) / localStorage in the profile (simple) / prompt each time. ← confirm.
- `sudo` is run as `sudo -S` fed the SSH password (works whether sudo is passwordless or not).
- Host-key policy: trust-on-first-use (LAN-only).

## Out of scope (for now)
- EngineAI T800 (coming soon).
- Changing the robot back to a *static* wired IP.
