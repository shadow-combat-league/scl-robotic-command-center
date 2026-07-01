// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::Emitter;
use tauri::Manager;

/// Live on-disk bundle on the dev machine. `tauri dev` serves a Resource copy
/// that can be STALE (not re-synced on rebuild), so prefer this when it exists.
/// Absent on end-user machines → falls back to the packaged Resource bundle.
const DEV_RES: &str = "/home/victor/SCL/scl-robotic-command-center/src-tauri/resources";

/// Holds the currently-running motion-preview backend process (if any).
#[derive(Default)]
struct PreviewState(Mutex<Option<Child>>);

fn kill_existing(state: &PreviewState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            // Graceful SIGTERM first (POSITIVE pid → only this process) so the
            // python can shut down its meshcat server; then force-kill this exact
            // child as a fallback. Never signal a process group.
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .arg(child.id().to_string())
                    .status();
                std::thread::sleep(Duration::from_millis(250));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn gmr_robot_key(robot: &str) -> &'static str {
    match robot {
        "engineai-t800" => "engineai_pm01",
        _ => "unitree_g1",
    }
}

fn p2s(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Resolved interpreter + script + (optional) bundled GMR source.
struct PreviewPaths {
    python: String,
    script: String,
    gmr_root: Option<String>,
}

/// Resolve the python interpreter + scripts. Dev prefers the live on-disk bundle
/// (DEV_RES); packaged uses the Resource bundle; otherwise a dev/system fallback.
fn resolve_paths(app: &tauri::AppHandle) -> PreviewPaths {
    if std::path::Path::new(DEV_RES).join("pyenv/bin/python").exists() {
        return PreviewPaths {
            python: format!("{DEV_RES}/pyenv/bin/python"),
            script: format!("{DEV_RES}/meshcat_preview/meshcat_motion_preview.py"),
            gmr_root: Some(format!("{DEV_RES}/GMR")),
        };
    }
    let res = |rel: &str| {
        app.path()
            .resolve(rel, BaseDirectory::Resource)
            .ok()
            .filter(|p| p.exists())
    };
    if let Some(python) = res("resources/pyenv/bin/python") {
        return PreviewPaths {
            python: p2s(python),
            script: res("resources/meshcat_preview/meshcat_motion_preview.py")
                .map(p2s)
                .unwrap_or_default(),
            gmr_root: res("resources/GMR").map(p2s),
        };
    }
    PreviewPaths {
        python: std::env::var("SCL_PREVIEW_PYTHON")
            .unwrap_or_else(|_| "/home/victor/miniconda3/envs/unitree-rl/bin/python".into()),
        script: std::env::var("SCL_PREVIEW_SCRIPT").unwrap_or_else(|_| {
            "/home/victor/SCL/scl-robotic-command-center/tools/meshcat_preview/meshcat_motion_preview.py".into()
        }),
        gmr_root: std::env::var("SCL_GMR_ROOT").ok(),
    }
}

/// (python interpreter, scripts-root dir). Bundled env if present, else the
/// repo's `tools/` as a dev fallback.
fn python_env(app: &tauri::AppHandle) -> (String, String) {
    if std::path::Path::new(DEV_RES).join("pyenv/bin/python").exists() {
        return (format!("{DEV_RES}/pyenv/bin/python"), DEV_RES.to_string());
    }
    if let Some(py) = app
        .path()
        .resolve("resources/pyenv/bin/python", BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
    {
        let root = app
            .path()
            .resolve("resources", BaseDirectory::Resource)
            .map(p2s)
            .unwrap_or_default();
        return (p2s(py), root);
    }
    (
        std::env::var("SCL_PREVIEW_PYTHON")
            .unwrap_or_else(|_| "/home/victor/miniconda3/envs/unitree-rl/bin/python".into()),
        "/home/victor/SCL/scl-robotic-command-center/tools".to_string(),
    )
}

/// Blocking implementation of an onboarding action. Runs on a worker thread
/// (see `run_onboard`) so the long SSH/nmcli work never blocks the UI thread.
fn run_onboard_blocking(
    app: &tauri::AppHandle,
    action: &str,
    host: &str,
    user: &str,
    ssid: &str,
    ssh_password: &str,
    wifi_password: &str,
    agent_port: u16,
    port_offset: u16,
) -> Result<String, String> {
    let (python, root) = python_env(app);
    // Resolve onboard.py by first-existing candidate — the bundled root may lag
    // behind the live source on a dev machine.
    let script = [
        format!("{root}/robot_onboard/onboard.py"),
        format!("{DEV_RES}/robot_onboard/onboard.py"),
        "/home/victor/SCL/scl-robotic-command-center/tools/robot_onboard/onboard.py".to_string(),
    ]
    .into_iter()
    .find(|p| std::path::Path::new(p).exists())
    .ok_or("onboard.py not found in bundle or tools/")?;
    let mut cmd = Command::new(&python);
    cmd.arg(&script).arg(action);
    if !host.is_empty() {
        cmd.arg("--host").arg(host);
    }
    if !user.is_empty() {
        cmd.arg("--user").arg(user);
    }
    if !ssid.is_empty() {
        cmd.arg("--ssid").arg(ssid);
    }
    // Provisioning ships the bundled telemetry agent's source to the robot via
    // an env var (read by onboard.py's `provision` subcommand).
    if action == "provision" {
        cmd.arg("--agent-port").arg(agent_port.to_string());
        let agent = [
            format!("{root}/robot_agent/agent.py"),
            format!("{DEV_RES}/robot_agent/agent.py"),
            "/home/victor/SCL/scl-robotic-command-center/tools/robot_agent/agent.py".to_string(),
        ]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or("agent.py not found in bundle or tools/")?;
        let content = std::fs::read_to_string(&agent)
            .map_err(|e| format!("could not read agent.py ('{agent}'): {e}"))?;
        cmd.env("SCL_ROBOT_AGENT_CONTENT", content);
    }
    cmd.env("SCL_SSH_PASSWORD", ssh_password)
        .env("SCL_WIFI_PASSWORD", wifi_password)
        // Per-robot PC-side UDP offset for bridge-start (the on-robot bridge sends
        // lowstate to this PC's offset port, matching the teleop's bind offset).
        .env("SCL_PORT_OFFSET", port_offset.to_string())
        .stdin(Stdio::null())
        .stderr(Stdio::piped());
    let output = cmd
        .output()
        .map_err(|e| format!("onboard backend failed to start ('{python}'): {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "onboard backend produced no output".into()
        } else {
            format!("onboard backend error: {stderr}")
        });
    }
    Ok(stdout)
}

/// Run an onboarding action (reachable / ssh-check / scan / connect / host-ssid)
/// against the robot via the bundled python; returns the backend's JSON line.
/// Secrets are passed via env (not argv) so they don't show in process lists.
///
/// `async` + `spawn_blocking` so the SSH/nmcli round-trip (up to ~70s) runs OFF
/// the main thread — otherwise it freezes the webview and the UI's loading state
/// never paints.
#[tauri::command]
async fn run_onboard(
    app: tauri::AppHandle,
    action: String,
    host: String,
    user: String,
    ssid: String,
    ssh_password: String,
    wifi_password: String,
    agent_port: Option<u16>,
    port_offset: Option<u16>,
) -> Result<String, String> {
    let agent_port = agent_port.unwrap_or(8472);
    let port_offset = port_offset.unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || {
        run_onboard_blocking(
            &app, &action, &host, &user, &ssid, &ssh_password, &wifi_password, agent_port,
            port_offset,
        )
    })
    .await
    .map_err(|e| format!("onboard task failed: {e}"))?
}

/// Spawn the Meshcat motion-preview backend, wait for `MESHCAT_URL=...`, return it.
#[tauri::command]
fn start_motion_preview(
    app: tauri::AppHandle,
    state: tauri::State<PreviewState>,
    motion_path: String,
    robot: String,
    start_paused: bool,
    loop_preview: bool,
) -> Result<String, String> {
    kill_existing(&state);

    let robot_key = gmr_robot_key(&robot);
    let paths = resolve_paths(&app);

    let mut cmd = Command::new(&paths.python);
    cmd.arg(&paths.script)
        .arg("--motion")
        .arg(&motion_path)
        .arg("--robot")
        .arg(robot_key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Looping is toggleable live over stdin; --loop only sets the INITIAL state.
    if loop_preview {
        cmd.arg("--loop");
    }
    if start_paused {
        cmd.arg("--start-paused");
    }
    if let Some(gmr) = &paths.gmr_root {
        cmd.env("SCL_GMR_ROOT", gmr);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start preview backend ('{}'): {e}", paths.python))?;
    let stdout = child.stdout.take().ok_or("no stdout from preview backend")?;

    // Collect the backend's stderr so a real failure (missing dep, bad path, a
    // python traceback) surfaces in the UI instead of a generic timeout. Still
    // echo each line so it also shows in the `tauri dev` terminal.
    let errbuf = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    if let Some(stderr) = child.stderr.take() {
        let errbuf = errbuf.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                eprintln!("[meshcat-preview] {line}");
                if let Ok(mut b) = errbuf.lock() {
                    b.push(line);
                }
            }
        });
    }

    // Read stdout on a thread: report the first MESHCAT_URL line, then keep
    // draining so the child never blocks on a full pipe.
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if !sent {
                if let Some(pos) = line.find("MESHCAT_URL=") {
                    let url = line[pos + "MESHCAT_URL=".len()..].trim().to_string();
                    let _ = tx.send(Ok(url));
                    sent = true;
                }
            }
        }
        if !sent {
            let _ = tx.send(Err("preview backend exited before printing MESHCAT_URL".into()));
        }
    });

    *state.0.lock().unwrap() = Some(child);

    // Last few stderr lines, to append to any error message.
    let tail = || -> String {
        errbuf
            .lock()
            .ok()
            .map(|b| b[b.len().saturating_sub(4)..].join(" | "))
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_default()
    };
    match rx.recv_timeout(Duration::from_secs(45)) {
        Ok(Ok(url)) => Ok(url),
        Ok(Err(e)) => {
            kill_existing(&state);
            let t = tail();
            Err(if t.is_empty() { e } else { format!("{e} — {t}") })
        }
        Err(_) => {
            kill_existing(&state);
            let t = tail();
            let base = "timed out starting the preview viewer";
            Err(if t.is_empty() { base.into() } else { format!("{base} — {t}") })
        }
    }
}

#[tauri::command]
fn stop_motion_preview(state: tauri::State<PreviewState>) -> Result<(), String> {
    kill_existing(&state);
    Ok(())
}

/// Send a control line (e.g. "pause" / "resume") to the running preview backend.
#[tauri::command]
fn control_motion_preview(
    state: tauri::State<PreviewState>,
    command: String,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "preview state poisoned")?;
    let child = guard.as_mut().ok_or("no running preview")?;
    let stdin = child.stdin.as_mut().ok_or("preview stdin unavailable")?;
    writeln!(stdin, "{command}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedFile {
    path: String,
    size_kb: u64,
}

fn library_dir(app: &tauri::AppHandle, subdir: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("library")
        .join(subdir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Copy an imported file into the app's data dir (library/<subdir>/<dest_name>).
#[tauri::command]
fn save_library_file(
    app: tauri::AppHandle,
    src_path: String,
    subdir: String,
    dest_name: String,
) -> Result<SavedFile, String> {
    let dest = library_dir(&app, &subdir)?.join(&dest_name);
    std::fs::copy(&src_path, &dest).map_err(|e| format!("copy failed: {e}"))?;
    let size_kb = std::fs::metadata(&dest).map(|m| m.len().div_ceil(1024)).unwrap_or(0);
    Ok(SavedFile {
        path: dest.to_string_lossy().into_owned(),
        size_kb,
    })
}

/// Delete a previously-saved library file (must live under the app data dir).
#[tauri::command]
fn delete_library_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let lib_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("library");
    let p = std::path::PathBuf::from(&path);
    if !p.starts_with(&lib_root) {
        return Err("refusing to delete a path outside the app library dir".into());
    }
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// On-robot motion playback: stream a G1 qpos CSV through the bundled 3.10 env +
// SecureMotionInferencer to dds_bridge_nx.py on the robot. One process per robot
// id, controlled over the child's stdin (start/play/pause/reset/stop/quit).
// ---------------------------------------------------------------------------
struct PlaybackProc {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct PlaybackState(Mutex<HashMap<String, PlaybackProc>>);

/// A line from a robot's playback backend, forwarded to the frontend.
/// `kind` is the first token (STATUS | EVENT | ERROR | PLAYBACK_READY | EXIT),
/// `data` the remainder (STATUS carries a JSON blob).
#[derive(Clone, serde::Serialize)]
struct PlaybackEvent {
    id: String,
    kind: String,
    data: String,
}

/// (python, motion_play.py, bundle dir) for the 3.10 playback env.
fn resolve_playback(app: &tauri::AppHandle) -> Result<(String, String, String), String> {
    if std::path::Path::new(DEV_RES).join("pyenv310/bin/python").exists() {
        return Ok((
            format!("{DEV_RES}/pyenv310/bin/python"),
            format!("{DEV_RES}/motion_play/motion_play.py"),
            format!("{DEV_RES}/motion_play"),
        ));
    }
    let res = |rel: &str| {
        app.path()
            .resolve(rel, BaseDirectory::Resource)
            .ok()
            .filter(|p| p.exists())
            .map(p2s)
    };
    match (
        res("resources/pyenv310/bin/python"),
        res("resources/motion_play/motion_play.py"),
        res("resources/motion_play"),
    ) {
        (Some(py), Some(script), Some(bundle)) => Ok((py, script, bundle)),
        _ => Err("motion playback env not bundled (run tools/motion_play/build_playback_env.sh)".into()),
    }
}

fn kill_playback(state: &PlaybackState, id: &str) {
    if let Some(mut proc) = state.0.lock().ok().and_then(|mut g| g.remove(id)) {
        // Ask it to quit (restores FSM 801), then SIGTERM (the python handler
        // also restores FSM 801), then force-kill as a fallback.
        let _ = writeln!(proc.stdin, "quit");
        let _ = proc.stdin.flush();
        drop(proc.stdin);
        #[cfg(unix)]
        {
            let _ = Command::new("kill").arg(proc.child.id().to_string()).status();
            std::thread::sleep(Duration::from_millis(300));
        }
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
}

/// Spawn motion playback for a robot; resolves once the backend prints
/// `PLAYBACK_READY` (inferencer up + bridge connected) or reports an error.
#[tauri::command]
fn start_motion_playback(
    app: tauri::AppHandle,
    state: tauri::State<PlaybackState>,
    id: String,
    motion_path: String,
    robot_ip: String,
    loop_motion: bool,
) -> Result<(), String> {
    kill_playback(&state, &id);
    let (python, script, bundle) = resolve_playback(&app)?;

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("--motion")
        .arg(&motion_path)
        .arg("--robot_ip")
        .arg(&robot_ip)
        .arg("--bundle")
        .arg(&bundle)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if loop_motion {
        cmd.arg("--loop");
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start playback backend ('{python}'): {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout from playback backend")?;
    let stdin = child.stdin.take().ok_or("no stdin for playback backend")?;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let app_ev = app.clone();
    let id_ev = id.clone();
    std::thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if !sent {
                if line.starts_with("PLAYBACK_READY") {
                    let _ = tx.send(Ok(()));
                    sent = true;
                } else if let Some(rest) = line.strip_prefix("ERROR ") {
                    let _ = tx.send(Err(rest.trim().to_string()));
                    sent = true;
                }
            }
            // Forward every line to the UI so the popup can show live streaming
            // status, frame cursor, loop/speed, ramp events and errors.
            let (kind, data) = match line.split_once(' ') {
                Some((k, r)) => (k.to_string(), r.to_string()),
                None => (line, String::new()),
            };
            let _ = app_ev.emit(
                "playback-event",
                PlaybackEvent { id: id_ev.clone(), kind, data },
            );
        }
        if !sent {
            let _ = tx.send(Err("playback backend exited before it was ready".into()));
        }
        let _ = app_ev.emit(
            "playback-event",
            PlaybackEvent { id: id_ev.clone(), kind: "EXIT".into(), data: String::new() },
        );
    });

    match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(())) => {
            state.0.lock().unwrap().insert(id, PlaybackProc { child, stdin });
            Ok(())
        }
        Ok(Err(e)) => {
            let _ = child.kill();
            Err(e)
        }
        Err(_) => {
            let _ = child.kill();
            Err("timed out starting motion playback".into())
        }
    }
}

/// Send a control line to a robot's playback (start/play/pause/reset/stop/loop/speed).
#[tauri::command]
fn control_motion_playback(
    state: tauri::State<PlaybackState>,
    id: String,
    command: String,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "playback state poisoned")?;
    let proc = guard.get_mut(&id).ok_or("no running playback for that robot")?;
    writeln!(proc.stdin, "{command}").map_err(|e| e.to_string())?;
    proc.stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn stop_motion_playback(state: tauri::State<PlaybackState>, id: String) -> Result<(), String> {
    kill_playback(&state, &id);
    Ok(())
}

/// This computer's IPv4 on the active (Wi-Fi) network — the source address the
/// OS would use to reach the LAN. No packet is sent (UDP connect just selects
/// the route's local address). Used to derive the /24 to scan for headsets and
/// to hand the headset our IP when pairing.
#[tauri::command]
fn local_ipv4() -> String {
    use std::net::UdpSocket;
    UdpSocket::bind("0.0.0.0:0")
        .ok()
        .and_then(|s| {
            s.connect("8.8.8.8:80").ok()?;
            s.local_addr().ok()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_default()
}

// ---- multi-robot XRoboToolkit PC-Service instances -------------------------
// One RoboticsServiceProcess per robot, all on this PC's single IP, told apart
// by port: TcpBindPort = the Pico control port (a headset's pcPort), listenPort
// = the gRPC the teleop SDK dials. Runs the INSTALLED service (the .deb at
// /opt/apps/roboticsservice, or SCL_XROBO_DIR) with NO rebuild: each instance
// runs a copy of the binary from its own dir (so applicationDirPath → its own
// setting.ini for TcpBindPort) with a private XDG_DATA_HOME (so the built-in
// single-instance lockfile doesn't collide). Validated end-to-end in step (a).
#[derive(Default)]
struct XroboState(Mutex<HashMap<u16, Child>>);

fn xrobo_install_dir() -> String {
    std::env::var("SCL_XROBO_DIR").unwrap_or_else(|_| "/opt/apps/roboticsservice".to_string())
}

/// Ensure an XRoboToolkit PC-Service is up for a robot: `tcp_port` (Pico control)
/// + `grpc_port` (teleop SDK). Idempotent — a no-op if that instance is alive.
#[tauri::command]
fn start_xrobo_service(
    app: tauri::AppHandle,
    state: tauri::State<XroboState>,
    tcp_port: u16,
    grpc_port: u16,
) -> Result<(), String> {
    {
        let mut g = state.0.lock().map_err(|_| "xrobo state poisoned")?;
        if let Some(child) = g.get_mut(&tcp_port) {
            match child.try_wait() {
                Ok(None) => return Ok(()), // still running
                _ => {
                    g.remove(&tcp_port);
                } // died — fall through to relaunch
            }
        }
    }

    let src = xrobo_install_dir();
    let bin = format!("{src}/RoboticsServiceProcess");
    if !std::path::Path::new(&bin).exists() {
        return Err(format!(
            "XRoboToolkit service not installed at {src} (set SCL_XROBO_DIR)"
        ));
    }

    // Per-instance dir: own binary copy + own setting.ini + own XDG_DATA_HOME.
    let inst = app
        .path()
        .resolve(format!("xrobo/inst-{tcp_port}"), BaseDirectory::AppLocalData)
        .map(p2s)
        .unwrap_or_else(|_| format!("/tmp/scl-xrobo/inst-{tcp_port}"));
    let xdg = format!("{inst}/xdg");
    std::fs::create_dir_all(&xdg).map_err(|e| format!("mkdir {inst}: {e}"))?;
    std::fs::copy(&bin, format!("{inst}/RoboticsServiceProcess"))
        .map_err(|e| format!("copy service binary: {e}"))?;

    // Build the instance setting.ini from the install's: insert listenPort under
    // [Service] and append a [TCP] section (matches the validated step-(a) recipe).
    let base_ini = std::fs::read_to_string(format!("{src}/setting.ini")).unwrap_or_default();
    let bcast = 29888u32 + (tcp_port as u32).saturating_sub(63901); // distinct per instance
    let mut ini = if base_ini.contains("[Service]") {
        base_ini.replacen("[Service]", &format!("[Service]\nlistenPort={grpc_port}"), 1)
    } else {
        format!("{base_ini}\n[Service]\nlistenPort={grpc_port}\n")
    };
    ini.push_str(&format!(
        "\n[TCP]\nTcpBindPort={tcp_port}\nBroadCastSendPort={bcast}\n"
    ));
    std::fs::write(format!("{inst}/setting.ini"), ini)
        .map_err(|e| format!("write setting.ini: {e}"))?;

    let ld = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
    let mut cmd = Command::new(format!("{inst}/RoboticsServiceProcess"));
    cmd.current_dir(&inst)
        .env("XDG_DATA_HOME", &xdg)
        .env("QT_QPA_PLATFORM", "offscreen")
        .env("LD_LIBRARY_PATH", format!("{src}:{src}/lib:{src}/SDK/x64:{ld}"))
        .env("QT_PLUGIN_PATH", format!("{src}/plugins/"))
        .env("QT_QML_PATH", format!("{src}/qml/"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not launch XRoboToolkit service: {e}"))?;

    // Catch an immediate exit (bad port, missing lib) instead of reporting success.
    std::thread::sleep(Duration::from_millis(1500));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(format!(
            "XRoboToolkit service (port {tcp_port}) exited on startup ({status}) — check {inst}"
        ));
    }
    state.0.lock().unwrap().insert(tcp_port, child);
    Ok(())
}

#[tauri::command]
fn stop_xrobo_service(state: tauri::State<XroboState>, tcp_port: u16) -> Result<(), String> {
    if let Ok(mut g) = state.0.lock() {
        if let Some(mut child) = g.remove(&tcp_port) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

// ---- live teleoperation (whole_body_teleop_record_2.py, WBC env) ----------
#[derive(Default)]
struct TeleopState(Mutex<HashMap<String, Child>>);

/// (python, wbc_dir, pythonpath) for the teleop pipeline. Prefers the bundled,
/// self-contained env (conda-packed wbc_pico + the WBC project under
/// resources/teleop, built by tools/teleop/build_teleop_env.sh) so no machine
/// setup is needed — the three editable deps are added via PYTHONPATH. Falls
/// back to a wbc_pico env on the machine for dev (override via SCL_TELEOP_*).
fn resolve_teleop(app: &tauri::AppHandle) -> Result<(String, String, String), String> {
    let mut bases: Vec<String> = vec![format!("{DEV_RES}/teleop")];
    if let Ok(p) = app.path().resolve("resources/teleop", BaseDirectory::Resource) {
        bases.push(p2s(p));
    }
    for base in bases {
        let py = format!("{base}/env/bin/python");
        let wbc = format!("{base}/wbc");
        if std::path::Path::new(&py).exists()
            && std::path::Path::new(&wbc)
                .join("whole_body_teleop_record_2.py")
                .exists()
        {
            let pp = format!(
                "{wbc}/third_party/GMR:{wbc}/third_party/unitree_sdk2_python:\
                 {wbc}/eef/inspire/inspire_hand_ws/inspire_hand_sdk"
            );
            return Ok((py, wbc, pp));
        }
    }
    // Dev fallback: a wbc_pico env + WBC project on the machine. Its own editable
    // installs resolve the deps, so no PYTHONPATH is needed.
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = std::env::var("SCL_TELEOP_DIR")
        .unwrap_or_else(|_| format!("{home}/SCL/WBC_Pico_Record"));
    let py = std::env::var("SCL_TELEOP_PYTHON")
        .unwrap_or_else(|_| format!("{home}/miniconda3/envs/wbc_pico/bin/python"));
    if !std::path::Path::new(&py).exists() {
        return Err(format!(
            "teleop env not bundled and no python at {py} — run tools/teleop/build_teleop_env.sh (or set SCL_TELEOP_PYTHON)"
        ));
    }
    if !std::path::Path::new(&dir)
        .join("whole_body_teleop_record_2.py")
        .exists()
    {
        return Err(format!(
            "whole_body_teleop_record_2.py not found in {dir} (set SCL_TELEOP_DIR)"
        ));
    }
    Ok((py, dir, String::new()))
}

fn kill_teleop(state: &TeleopState, id: &str) {
    if let Some(mut child) = state.0.lock().ok().and_then(|mut g| g.remove(id)) {
        // SIGINT first so the script's KeyboardInterrupt path runs shutdown()
        // (returns the robot to FSM 801), then force-kill as a fallback.
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .arg("-INT")
                .arg(child.id().to_string())
                .status();
            std::thread::sleep(Duration::from_secs(3));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Read a teleop child stream: echo each line to the console and report the
/// first Meshcat web URL it prints. The script lets meshcat pick a free port
/// (7000, then 7001, 7002, … if taken), so the port is NOT fixed — we must use
/// whatever it printed rather than assume 7000.
fn spawn_teleop_reader<R: std::io::Read + Send + 'static>(stream: R, tx: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stream).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if !sent {
                if let Some(i) = line.find("http://") {
                    let url = line[i..].split_whitespace().next().unwrap_or("");
                    if url.contains("/static") {
                        let _ = tx.send(url.to_string());
                        sent = true;
                    }
                }
            }
            eprintln!("[teleop] {line}");
        }
    });
}

/// Start live teleop for a robot: the WBC script reads the paired headset via
/// xrobotoolkit_sdk, retargets, and streams to the robot over the UDP bridge.
/// Returns the Meshcat web URL the script actually bound to.
#[tauri::command]
fn start_teleop(
    app: tauri::AppHandle,
    state: tauri::State<TeleopState>,
    id: String,
    robot_ip: String,
    eef: String,
    port_offset: u16,
    grpc_port: u16,
) -> Result<String, String> {
    kill_teleop(&state, &id);
    // Sweep only an ORPHAN holding THIS robot's lowstate port (9501+offset) — e.g.
    // left over from a `tauri dev` relaunch/crash. Targeted (not a global pkill)
    // so concurrent teleops for OTHER robots are untouched.
    #[cfg(unix)]
    {
        let lowstate_port = 9501u16 + port_offset;
        let _ = Command::new("fuser")
            .arg("-k")
            .arg(format!("{lowstate_port}/udp"))
            .status();
        std::thread::sleep(Duration::from_millis(400));
    }
    let (py, dir, pythonpath) = resolve_teleop(&app)?;
    let script = format!("{dir}/whole_body_teleop_record_2.py");
    // Per-instance working dir so each teleop's PXREASetting.ini (its gRPC port,
    // written by the script from SCL_GRPC_PORT) is isolated. The script also
    // loads some assets by CWD-relative path (e.g. assets/g1/*.urdf), so mirror
    // the WBC project into this cwd via symlinks — those paths resolve back to the
    // real files, while PXREASetting.ini stays a real per-instance file here.
    let cwd = app
        .path()
        .resolve(format!("teleop-cwd/{id}"), BaseDirectory::AppLocalData)
        .map(p2s)
        .unwrap_or_else(|_| format!("/tmp/scl-teleop-cwd/{id}"));
    std::fs::create_dir_all(&cwd).map_err(|e| format!("mkdir teleop cwd: {e}"))?;
    #[cfg(unix)]
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name();
            if name == *"PXREASetting.ini" {
                continue; // must be a real per-instance file, not a shared symlink
            }
            let link = std::path::Path::new(&cwd).join(&name);
            if std::fs::symlink_metadata(&link).is_err() {
                let _ = std::os::unix::fs::symlink(e.path(), &link);
            }
        }
    }
    let mut cmd = Command::new(&py);
    cmd.arg(&script)
        .arg("--eef")
        .arg(&eef)
        .arg("--robot_ip")
        .arg(&robot_ip)
        .current_dir(&cwd)
        .env("SCL_PORT_OFFSET", port_offset.to_string())
        .env("SCL_GRPC_PORT", grpc_port.to_string())
        .stdin(Stdio::piped()) // kept open so the desktop can pause/resume/stop
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Bundled env: make the three source-only editable deps importable.
    if !pythonpath.is_empty() {
        cmd.env("PYTHONPATH", &pythonpath);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start teleop ('{py}'): {e}"))?;

    let (tx, rx) = mpsc::channel::<String>();
    if let Some(out) = child.stdout.take() {
        spawn_teleop_reader(out, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        spawn_teleop_reader(err, tx.clone());
    }
    drop(tx);

    // Wait for the Meshcat URL — the script inits GMR + the secure inferencer +
    // the viewer first, which is slow. Disconnect/timeout => it never came up.
    match rx.recv_timeout(Duration::from_secs(45)) {
        Ok(url) => {
            state.0.lock().unwrap().insert(id, child);
            Ok(url)
        }
        Err(_) => {
            let msg = match child.try_wait() {
                Ok(Some(status)) => format!(
                    "teleop exited before Meshcat came up ({status}) — check the WBC env and that a headset is streaming"
                ),
                _ => "teleop started but no Meshcat URL appeared within 45s".to_string(),
            };
            let _ = child.kill();
            let _ = child.wait();
            Err(msg)
        }
    }
}

#[tauri::command]
fn stop_teleop(state: tauri::State<TeleopState>, id: String) -> Result<(), String> {
    kill_teleop(&state, &id);
    Ok(())
}

/// Live control of a running teleop over its stdin: "pause" / "resume" (freeze or
/// resume the robot's motion tracking) or "stop". Lets the desktop operator take
/// control instead of the Pico having sole authority once connected.
#[tauri::command]
fn control_teleop(
    state: tauri::State<TeleopState>,
    id: String,
    command: String,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "teleop state poisoned")?;
    let child = guard
        .get_mut(&id)
        .ok_or("no running teleop for this robot")?;
    let stdin = child.stdin.as_mut().ok_or("teleop stdin unavailable")?;
    writeln!(stdin, "{command}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(PreviewState::default())
        .manage(PlaybackState::default())
        .manage(TeleopState::default())
        .manage(XroboState::default())
        .invoke_handler(tauri::generate_handler![
            start_motion_preview,
            stop_motion_preview,
            control_motion_preview,
            run_onboard,
            save_library_file,
            delete_library_file,
            start_motion_playback,
            control_motion_playback,
            stop_motion_playback,
            local_ipv4,
            start_xrobo_service,
            stop_xrobo_service,
            start_teleop,
            stop_teleop,
            control_teleop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
