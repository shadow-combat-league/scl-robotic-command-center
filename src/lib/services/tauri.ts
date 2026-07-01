/**
 * Thin wrapper around Tauri APIs used by the preview pipeline.
 *
 * Everything here is guarded by `isTauri()` so the app still runs in the browser
 * (`pnpm dev`), where these calls are unavailable and the UI falls back to mock.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

/** Start the on-robot dds_bridge_nx.py (on-demand, before motion playback).
 *  Returns the laptop IP the bridge was told to stream lowstate to. */
export async function robotBridgeStart(
  host: string,
  user: string,
  sshPassword: string,
): Promise<{ ok: boolean; pcIp: string }> {
  const d = await runOnboard("bridge-start", { host, user, sshPassword });
  return { ok: d.ok === true, pcIp: (d.pc_ip as string) ?? "" };
}

/** Stop the on-robot dds_bridge_nx.py after playback (best-effort). */
export async function robotBridgeStop(
  host: string,
  user: string,
  sshPassword: string,
): Promise<void> {
  await runOnboard("bridge-stop", { host, user, sshPassword });
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
  loop = false,
): Promise<string> {
  return invoke<string>("start_motion_preview", {
    motionPath,
    robot,
    startPaused,
    loopPreview: loop,
  });
}

export function stopMotionPreview(): Promise<void> {
  return invoke("stop_motion_preview");
}

/** Send a control line to the preview viewer: pause/resume or loop on/off. */
export function controlMotionPreview(
  command: "pause" | "resume" | "loop on" | "loop off",
): Promise<void> {
  return invoke("control_motion_preview", { command });
}

// ---- on-robot motion playback (per-robot) --------------------------------

/** Spawn motion playback for a robot; resolves once the backend is ready (or throws). */
export function startMotionPlayback(
  id: string,
  motionPath: string,
  robotIp: string,
  loop = false,
): Promise<void> {
  return invoke("start_motion_playback", { id, motionPath, robotIp, loopMotion: loop });
}

/** Drive a robot's playback: start | play | pause | reset | stop | "loop on" | "speed 1.5". */
export function controlMotionPlayback(id: string, command: string): Promise<void> {
  return invoke("control_motion_playback", { id, command });
}

/** Stop a robot's playback (returns it to FSM 801). */
export function stopMotionPlayback(id: string): Promise<void> {
  return invoke("stop_motion_playback", { id });
}

// ---- live teleoperation (WBC whole_body_teleop_record_2.py) ----------------

/** Start the live teleop pipeline for a robot — reads the paired headset via
 *  xrobotoolkit_sdk, retargets, and streams to the robot over the UDP bridge.
 *  Resolves to the Meshcat web URL the script actually bound to (dynamic port). */
export function startTeleopScript(id: string, robotIp: string, eef: string): Promise<string> {
  return invoke("start_teleop", { id, robotIp, eef });
}

/** Stop a robot's teleop pipeline (SIGINT → the script returns it to FSM 801). */
export function stopTeleopScript(id: string): Promise<void> {
  return invoke("stop_teleop", { id });
}

/** Ensure this robot's XRoboToolkit PC-Service instance is running: `tcpPort`
 *  = the Pico control port (a headset's pcPort), `grpcPort` = the teleop SDK. */
export function startXroboService(tcpPort: number, grpcPort: number): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("start_xrobo_service", { tcpPort, grpcPort });
}

/** Stop the XRoboToolkit PC-Service instance on a control port. */
export function stopXroboService(tcpPort: number): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("stop_xrobo_service", { tcpPort });
}

/** One line of live status from a robot's playback backend. */
export interface PlaybackEvent {
  id: string;
  /** STATUS | EVENT | ERROR | PLAYBACK_READY | EXIT */
  kind: string;
  /** remainder of the line; STATUS carries a JSON blob */
  data: string;
}

/** Subscribe to live playback events from all robots. Returns an unlisten fn
 *  (a no-op in the browser, where there is no backend). */
export async function onPlaybackEvent(
  cb: (e: PlaybackEvent) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<PlaybackEvent>("playback-event", (ev) => cb(ev.payload));
}

// ---- teleop headset discovery (XRoboToolkit) -----------------------------
//
// PROTOCOL CONTRACT (the headset, running XRoboToolkit, must implement this):
//   Discovery:  GET  http://<headset-ip>:<PORT>/xrobo/info
//               -> { "service":"xrobotoolkit", "id":"<stable-unique>",
//                    "name":"<display>", "model":"<headset model>",
//                    "battery":<0-100|null>, "status":"idle|paired|streaming",
//                    "pcIp":"<currently paired pc ip, or empty>" }
//   Pairing:    POST http://<headset-ip>:<PORT>/xrobo/pair
//               body { "pcIp":"<this computer's ip>" }  -> 200 { "ok": true }
//               (the headset stores pcIp and auto-connects for teleop)
// The computer finds headsets by probing /xrobo/info across the Wi-Fi /24.

/** Shape returned by a headset's /xrobo/info endpoint. */
export interface HeadsetInfo {
  service?: string;
  id: string;
  name?: string;
  model?: string;
  battery?: number | null;
  status?: string;
  pcIp?: string;
  pcPort?: number; // which robot's PC-Service instance this headset is paired to
}

/** This computer's IPv4 on the active network (for the scan base + pairing). */
export function localIpv4(): Promise<string> {
  if (!isTauri()) return Promise.resolve("");
  return invoke<string>("local_ipv4");
}

/**
 * Probe one address for an XRoboToolkit headset. Resolves to its info, or null
 * if nothing answers / it isn't a headset (kept fast — this runs ~254×/scan).
 */
export async function headsetInfo(
  ip: string,
  port: number,
  timeoutMs = 500,
): Promise<HeadsetInfo | null> {
  if (!isTauri()) return null;
  try {
    const res = await tauriFetch(`http://${ip}:${port}/xrobo/info`, {
      method: "GET",
      connectTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as HeadsetInfo;
    if (j && (j.service === "xrobotoolkit" || j.id)) return { ...j, id: j.id ?? ip };
    return null;
  } catch {
    return null; // closed port / timeout / non-JSON — not a headset
  }
}

/**
 * Hand a headset this computer's IP + the PC-Service port to dial, so it
 * auto-connects for teleop. `pcPort` appoints which robot (one service instance
 * per robot, e.g. 63901, 63902, …); omit/0 → the Pico defaults to 63901.
 * An empty `pcIp` unpairs.
 */
export async function pairHeadset(
  ip: string,
  port: number,
  pcIp: string,
  pcPort?: number,
): Promise<void> {
  if (!isTauri()) return;
  const body: { pcIp: string; pcPort?: number } = { pcIp };
  if (pcPort && pcPort > 0) body.pcPort = pcPort;
  const res = await tauriFetch(`http://${ip}:${port}/xrobo/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    connectTimeout: 3000,
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* non-JSON */
    }
    throw new Error(msg);
  }
}
