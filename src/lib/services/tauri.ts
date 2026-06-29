/**
 * Thin wrapper around Tauri APIs used by the preview pipeline.
 *
 * Everything here is guarded by `isTauri()` so the app still runs in the browser
 * (`pnpm dev`), where these calls are unavailable and the UI falls back to mock.
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Native file picker → absolute path (or null if cancelled). */
export async function pickMotionFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Motion (LAFAN1)", extensions: ["bvh", "csv"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Native file picker for an .onnx policy → absolute path (or null). */
export async function pickPolicyFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Policy (ONNX)", extensions: ["onnx"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Copy an imported file into the app's data dir; returns the stored path + size. */
export function saveLibraryFile(
  srcPath: string,
  subdir: string,
  destName: string,
): Promise<{ path: string; sizeKb: number }> {
  return invoke("save_library_file", { srcPath, subdir, destName });
}

/** Delete a previously-saved library file from the app's data dir. */
export function deleteLibraryFile(path: string): Promise<void> {
  return invoke("delete_library_file", { path });
}

// ---- onboarding (real robot ops over SSH/nmcli) --------------------------

interface OnboardArgs {
  host?: string;
  user?: string;
  ssid?: string;
  sshPassword?: string;
  wifiPassword?: string;
  agentPort?: number;
}

async function runOnboard(action: string, args: OnboardArgs): Promise<Record<string, unknown>> {
  const raw = await invoke<string>("run_onboard", {
    action,
    host: args.host ?? "",
    user: args.user ?? "",
    ssid: args.ssid ?? "",
    sshPassword: args.sshPassword ?? "",
    wifiPassword: args.wifiPassword ?? "",
    agentPort: args.agentPort,
  });
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (typeof data.error === "string") throw new Error(data.error);
  return data;
}

/** TCP-reachability of the robot's wired/saved IP (port 22). */
export async function robotReachable(host: string): Promise<boolean> {
  const d = await runOnboard("reachable", { host });
  return d.reachable === true;
}

/** Authenticate over SSH; throws with the reason on failure. */
export async function robotSshCheck(host: string, user: string, sshPassword: string): Promise<string> {
  const d = await runOnboard("ssh-check", { host, user, sshPassword });
  return (d.hostname as string) ?? "";
}

export interface ScannedWifi {
  ssid: string;
  signal: number;
  secured: boolean;
}

/** Networks the robot's radio can see (nmcli scan over SSH). */
export async function robotWifiScan(host: string, user: string, sshPassword: string): Promise<ScannedWifi[]> {
  const d = await runOnboard("scan", { host, user, sshPassword });
  return (d.networks as ScannedWifi[]) ?? [];
}

/** Join the robot to a Wi-Fi network; resolves to its new Wi-Fi IPv4. */
export async function robotWifiConnect(
  host: string,
  user: string,
  sshPassword: string,
  ssid: string,
  wifiPassword: string,
): Promise<string> {
  const d = await runOnboard("connect", { host, user, sshPassword, ssid, wifiPassword });
  return d.ip as string;
}

/** This computer's current Wi-Fi SSID (for the "use computer's network" option). */
export async function hostWifiSsid(): Promise<string> {
  const d = await runOnboard("host-ssid", {});
  return (d.ssid as string) ?? "";
}

/** The saved password for an SSID from THIS laptop's NetworkManager (best-effort;
 *  "" if it can't be read). Lets us prefill the robot's Wi-Fi password. */
export async function hostWifiPsk(ssid: string): Promise<string> {
  const d = await runOnboard("host-psk", { ssid });
  return (d.psk as string) ?? "";
}

/** Deploy the telemetry agent to the robot + register it as a systemd service. */
export async function robotProvisionAgent(
  host: string,
  user: string,
  sshPassword: string,
  port: number,
): Promise<{ ok: boolean; port: number; python: string; ddsAvailable: boolean }> {
  const d = await runOnboard("provision", { host, user, sshPassword, agentPort: port });
  return {
    ok: d.ok === true,
    port: (d.port as number) ?? port,
    python: (d.python as string) ?? "",
    ddsAvailable: d.ddsAvailable === true,
  };
}

/**
 * Fetch a telemetry snapshot from the on-robot agent. Routed through the Tauri
 * HTTP plugin (Rust-side) so it isn't subject to webview CORS / mixed-content
 * rules in a packaged build. Throws on non-200 or timeout.
 */
export async function fetchTelemetry(ip: string, port: number): Promise<Record<string, unknown>> {
  const res = await tauriFetch(`http://${ip}:${port}/telemetry`, {
    method: "GET",
    connectTimeout: 2500,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`telemetry agent returned HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Send a high-level mode command to the robot's agent (damp / sit / stand / run),
 * which the agent issues via the Unitree LocoClient. Throws with the agent's
 * reason on failure (allow a longer timeout — the FSM transition can take a moment).
 */
export async function robotCommand(ip: string, port: number, action: string): Promise<void> {
  const res = await tauriFetch(`http://${ip}:${port}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
    connectTimeout: 2500,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
}

/** Spawn the Meshcat preview backend; resolves to the viewer URL to embed.
 *  `startPaused` renders the first frame but waits for "resume" before playing. */
export function startMotionPreview(
  motionPath: string,
  robot: string,
  startPaused = false,
): Promise<string> {
  return invoke<string>("start_motion_preview", { motionPath, robot, startPaused });
}

export function stopMotionPreview(): Promise<void> {
  return invoke("stop_motion_preview");
}

/** Send a control line ("pause" | "resume") to the running preview backend. */
export function controlMotionPreview(command: "pause" | "resume"): Promise<void> {
  return invoke("control_motion_preview", { command });
}
