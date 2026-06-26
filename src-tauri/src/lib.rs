// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::Manager;

/// Holds the currently-running motion-preview backend process (if any).
#[derive(Default)]
struct PreviewState(Mutex<Option<Child>>);

fn kill_existing(state: &PreviewState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
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

/// Prefer the self-contained Python env bundled in app resources; fall back to a
/// dev interpreter (env var / the unitree-rl conda env) when it isn't present.
fn resolve_paths(app: &tauri::AppHandle) -> PreviewPaths {
    let res = |rel: &str| {
        app.path()
            .resolve(rel, BaseDirectory::Resource)
            .ok()
            .filter(|p| p.exists())
    };

    if let Some(python) = res("resources/pyenv/bin/python") {
        // Packaged: fully embedded, nothing required on the user's machine.
        return PreviewPaths {
            python: p2s(python),
            script: res("resources/meshcat_preview/meshcat_motion_preview.py")
                .map(p2s)
                .unwrap_or_default(),
            gmr_root: res("resources/GMR").map(p2s),
        };
    }

    // `tauri dev` doesn't expose bundled resources via BaseDirectory::Resource,
    // so use the built bundle on disk directly when it's present.
    const DEV_RES: &str =
        "/home/victor/SCL/scl-robotic-command-center/src-tauri/resources";
    let dev_python = std::path::Path::new(DEV_RES).join("pyenv/bin/python");
    if dev_python.exists() {
        return PreviewPaths {
            python: p2s(dev_python),
            script: format!("{DEV_RES}/meshcat_preview/meshcat_motion_preview.py"),
            gmr_root: Some(format!("{DEV_RES}/GMR")),
        };
    }

    // Last resort: a Python you have installed.
    PreviewPaths {
        python: std::env::var("SCL_PREVIEW_PYTHON")
            .unwrap_or_else(|_| "/home/victor/miniconda3/envs/unitree-rl/bin/python".into()),
        script: std::env::var("SCL_PREVIEW_SCRIPT").unwrap_or_else(|_| {
            "/home/victor/SCL/scl-robotic-command-center/tools/meshcat_preview/meshcat_motion_preview.py".into()
        }),
        gmr_root: std::env::var("SCL_GMR_ROOT").ok(),
    }
}

/// Spawn the Meshcat motion-preview backend, wait for `MESHCAT_URL=...`, return it.
#[tauri::command]
fn start_motion_preview(
    app: tauri::AppHandle,
    state: tauri::State<PreviewState>,
    motion_path: String,
    robot: String,
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
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PreviewState::default())
        .invoke_handler(tauri::generate_handler![
            start_motion_preview,
            stop_motion_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
