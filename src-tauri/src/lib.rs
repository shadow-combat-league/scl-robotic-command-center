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
) -> Result<String, String> {
    let agent_port = agent_port.unwrap_or(8472);
    tauri::async_runtime::spawn_blocking(move || {
        run_onboard_blocking(
            &app, &action, &host, &user, &ssid, &ssh_password, &wifi_password, agent_port,
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
        .arg("--loop")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
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

    match rx.recv_timeout(Duration::from_secs(45)) {
        Ok(Ok(url)) => Ok(url),
        Ok(Err(e)) => {
            kill_existing(&state);
            Err(e)
        }
        Err(_) => {
            kill_existing(&state);
            Err("timed out starting the preview viewer".into())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(PreviewState::default())
        .manage(PlaybackState::default())
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
            local_ipv4
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
