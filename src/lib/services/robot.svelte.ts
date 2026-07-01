/**
 * Robot service — reactive source of truth for the robot roster and the live
 * link to each robot.
 *
 * MULTI-ROBOT: connection state, telemetry and posture are keyed PER ROBOT id,
 * so any number of robots can be connected and commanded at the same time
 * (operationally usually two, but not capped). Onboarding is still one robot at
 * a time (see onboarding.svelte.ts).
 *
 * Profiles persist via `db`. Connection/telemetry are simulated (mock-first) —
 * swap those method bodies for a real transport later.
 */

import { db } from "./db";
import { robotTypeSpec } from "./robotTypes";
import {
  isTauri,
  robotReachable,
  fetchTelemetry,
  robotCommand,
  startMotionPlayback,
  controlMotionPlayback,
  stopMotionPlayback,
  robotBridgeStart,
  robotBridgeStop,
  startTeleopScript,
  stopTeleopScript,
  controlTeleopScript,
  startXroboService,
} from "./tauri";
import type {
  ActivityEvent,
  ConnectionState,
  RobotProfile,
  TeleopState,
  Telemetry,
} from "./types";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ZERO_TELEMETRY: Telemetry = {
  battery: 0,
  temperature: 0,
  cpuLoad: 0,
  uptimeSec: 0,
  jointsOk: true,
  estop: false,
};

function seedTelemetry(id: string): Telemetry {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return {
    battery: 70 + (h % 28),
    temperature: 37 + (h % 9),
    cpuLoad: 12 + (h % 18),
    uptimeSec: 0,
    jointsOk: true,
    estop: false,
  };
}

/**
 * Merge a raw telemetry snapshot from the on-robot agent into the existing
 * Telemetry. OS metrics (cpu/memory/uptime) always apply; robot-specific fields
 * (battery/temperature/jointsOk) only when the agent reports them live via DDS,
 * otherwise they read as "unavailable". `estop` stays a command-side concept
 * (the agent's value is best-effort) so the E-Stop / All-Stop buttons keep working.
 */
function mergeTelemetry(prev: Telemetry, raw: Record<string, unknown>): Telemetry {
  const robotAvail = raw.robotStateAvailable === true;
  const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);
  return {
    battery: robotAvail ? num(raw.battery, prev.battery) : 0,
    temperature: robotAvail ? num(raw.temperature, prev.temperature) : 0,
    cpuLoad: num(raw.cpuLoad, prev.cpuLoad),
    memory: typeof raw.memory === "number" ? raw.memory : prev.memory,
    uptimeSec: num(raw.uptimeSec, prev.uptimeSec),
    jointsOk: robotAvail ? raw.jointsOk === true : prev.jointsOk,
    estop: prev.estop,
    hostname: typeof raw.hostname === "string" ? raw.hostname : prev.hostname,
    robotStateAvailable: robotAvail,
  };
}

class RobotService {
  robots = $state<RobotProfile[]>([]);

  /** Per-robot live state, keyed by profile id. */
  connections = $state<Record<string, ConnectionState>>({});
  telemetry = $state<Record<string, Telemetry>>({});
  postures = $state<Record<string, string>>({});
  /** Teleoperation script state + the Meshcat viewer URL it publishes to. */
  teleop = $state<Record<string, TeleopState>>({});
  teleopPaused = $state<Record<string, boolean>>({}); // desktop paused this robot's tracking
  meshcatUrls = $state<Record<string, string>>({});
  /** Result of the most recent mode command per robot (for inline UI feedback). */
  cmdState = $state<
    Record<string, { action: string; phase: "sending" | "ok" | "error"; msg: string }>
  >({});

  activity = $state<ActivityEvent[]>([]);

  #loaded = false;
  #ticking = false;
  /** Consecutive telemetry-fetch failures per robot id (drives offline detection). */
  #misses: Record<string, number> = {};

  load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    this.robots = db.loadProfiles();
    for (const r of this.robots) this.#initRuntime(r.id);
  }

  #initRuntime(id: string): void {
    if (!(id in this.connections)) this.connections[id] = "disconnected";
    if (!(id in this.telemetry)) this.telemetry[id] = seedTelemetry(id);
    if (!(id in this.postures)) this.postures[id] = "idle";
    if (!(id in this.teleop)) this.teleop[id] = "stopped";
  }

  // --- lookups ---
  modelName(p: RobotProfile): string {
    return robotTypeSpec(p.type).name;
  }
  connectionOf(id: string): ConnectionState {
    return this.connections[id] ?? "disconnected";
  }
  telemetryOf(id: string): Telemetry {
    return this.telemetry[id] ?? ZERO_TELEMETRY;
  }
  postureOf(id: string): string {
    return this.postures[id] ?? "idle";
  }
  /** True when the robot is in Running Mode (FSM 801) — the required starting
   *  point for teleop and motion playback. Both ramp out of the operating stand,
   *  so starting from any other mode makes the robot drop or jump. */
  isInRunningMode(id: string): boolean {
    return this.postureOf(id) === "run";
  }

  // --- Per-robot XRoboToolkit service ports (one PC-Service instance per robot,
  // all on this PC's single IP). A robot's stable slot = its index among all
  // robots ordered by id; slot k → Pico control port 63901+k, gRPC 60061+k.
  #serviceSlot(id: string): number {
    const i = this.robots.map((r) => r.id).sort().indexOf(id);
    return i < 0 ? 0 : i;
  }
  /** XRoboToolkit control port a Pico dials to reach THIS robot's instance (pcPort). */
  servicePortOf(id: string): number {
    return 63901 + this.#serviceSlot(id);
  }
  /** XRoboToolkit gRPC port this robot's teleop script connects to. */
  grpcPortOf(id: string): number {
    return 60061 + this.#serviceSlot(id);
  }
  /** Stable 0-based slot — also the PC-side UDP port offset for teleop/bridge. */
  serviceSlotOf(id: string): number {
    return this.#serviceSlot(id);
  }
  commandStateOf(id: string) {
    return this.cmdState[id];
  }
  isOnline(id: string): boolean {
    return this.connectionOf(id) === "online";
  }

  // --- derived fleet state ---
  get hasRobots(): boolean {
    return this.robots.length > 0;
  }
  get onlineRobots(): RobotProfile[] {
    return this.robots.filter((r) => this.isOnline(r.id));
  }
  get onlineCount(): number {
    return this.onlineRobots.length;
  }
  get anyOnline(): boolean {
    return this.onlineCount > 0;
  }
  get anyConnectable(): boolean {
    return this.robots.some((r) => this.connectionOf(r.id) === "disconnected");
  }
  /** True when every online robot is E-stopped (and at least one is online). */
  get allEstopped(): boolean {
    const on = this.onlineRobots;
    return on.length > 0 && on.every((r) => this.telemetryOf(r.id).estop);
  }

  // --- profile mutations ---
  upsert(profile: RobotProfile): void {
    const isNew = !this.robots.some((r) => r.id === profile.id);
    this.robots = db.upsertProfile(profile);
    this.#initRuntime(profile.id);
    if (isNew) {
      this.#log("success", `${profile.name} onboarded — reachable at ${profile.ip}`);
    }
  }
  /** Persist a robot's new Wi-Fi IP/SSID (+ agent port) after a re-onboard. */
  updateConnection(
    id: string,
    patch: { ip: string; wifiSsid: string | null; apiPort?: number },
  ): void {
    this.robots = db.updateProfile(id, patch);
    this.#initRuntime(id);
    const name = this.robots.find((r) => r.id === id)?.name ?? "robot";
    this.#log("success", `${name} reconnected — reachable at ${patch.ip}`);
  }
  remove(id: string): void {
    this.robots = db.deleteProfile(id);
    delete this.connections[id];
    delete this.telemetry[id];
    delete this.postures[id];
    delete this.teleop[id];
    delete this.meshcatUrls[id];
  }

  // --- per-robot link control ---
  async connect(id: string): Promise<void> {
    const r = this.robots.find((x) => x.id === id);
    if (!r || this.connectionOf(id) === "online") return;
    this.connections[id] = "connecting";
    // In the app, verify the saved IP actually responds; in the browser, mock it.
    if (isTauri()) {
      const ok = await robotReachable(r.ip).catch(() => false);
      if (!ok) {
        this.connections[id] = "error";
        this.#log("error", `${r.name} unreachable at ${r.ip} — re-onboard to fix Wi-Fi`);
        return;
      }
    } else {
      await wait(900);
    }
    this.connections[id] = "online";
    this.telemetry[id] = seedTelemetry(id);
    this.postures[id] = "idle";
    this.#misses[id] = 0;
    if (isTauri()) {
      const ok = await this.#refreshTelemetry(id);
      if (!ok) {
        this.#log("warn", `${r.name}: telemetry agent not responding — re-onboard to redeploy`);
      }
    }
    this.#log("success", `Connected to ${r.name}`);
  }

  /** Pull a fresh telemetry snapshot from the robot's agent into state. */
  async #refreshTelemetry(id: string): Promise<boolean> {
    const r = this.robots.find((x) => x.id === id);
    if (!r) return false;
    try {
      const raw = await fetchTelemetry(r.ip, r.apiPort ?? 8472);
      this.telemetry[id] = mergeTelemetry(this.telemetryOf(id), raw);
      return true;
    } catch {
      return false;
    }
  }

  /** One real-telemetry poll for a robot; flips it to "error" after 3 misses. */
  async #tickRobot(r: RobotProfile): Promise<void> {
    if (this.connectionOf(r.id) !== "online") return;
    if (await this.#refreshTelemetry(r.id)) {
      this.#misses[r.id] = 0;
      return;
    }
    this.#misses[r.id] = (this.#misses[r.id] ?? 0) + 1;
    if (this.#misses[r.id] >= 3) {
      this.connections[r.id] = "error";
      this.#misses[r.id] = 0;
      this.#log("error", `${r.name}: telemetry agent unreachable — re-onboard to redeploy`);
    }
  }

  disconnect(id: string): void {
    if (this.connectionOf(id) === "disconnected") return;
    this.connections[id] = "disconnected";
    const name = this.robots.find((r) => r.id === id)?.name ?? "robot";
    this.#log("info", `Disconnected ${name}`);
  }

  toggleEstop(id: string): void {
    const t = this.telemetry[id];
    if (!t) return;
    t.estop = !t.estop;
    if (t.estop) this.postures[id] = "damp";
    const name = this.robots.find((r) => r.id === id)?.name ?? "robot";
    this.#log(t.estop ? "error" : "info", `${name}: E-stop ${t.estop ? "engaged" : "released"}`);
  }

  /**
   * Command a high-level mode (damp / sit / stand / run). In the desktop app this
   * is sent to the robot's agent (→ Unitree LocoClient FSM); in the browser it's
   * a mock that just updates the local highlight + activity feed.
   */
  async setPosture(id: string, posture: string): Promise<void> {
    if (!this.isOnline(id)) return;
    if (this.telemetryOf(id).estop) return; // can't command while E-stopped
    this.postures[id] = posture;
    const r = this.robots.find((x) => x.id === id);
    const name = r?.name ?? "robot";
    if (isTauri() && r) {
      this.cmdState[id] = { action: posture, phase: "sending", msg: "" };
      try {
        await robotCommand(r.ip, r.apiPort ?? 8472, posture);
        this.cmdState[id] = { action: posture, phase: "ok", msg: "" };
        this.#log("info", `${name}: ${posture} command sent`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.cmdState[id] = { action: posture, phase: "error", msg };
        this.#log("error", `${name}: ${posture} failed — ${msg}`);
      }
      return;
    }
    this.cmdState[id] = {
      action: posture,
      phase: "ok",
      msg: "simulated — open the desktop app to command the robot",
    };
    this.#log("info", `${name}: ${posture}`);
  }

  /**
   * Stream a motion onto the given (online) robots via the on-robot playback
   * pipeline (real in the desktop app; logged-only in the browser). Per robot:
   * spawn playback → ramp into frame 0 → play.
   */
  async playMotionOn(
    ids: string[],
    motionName: string,
    motionPath?: string,
  ): Promise<Record<string, { ok: boolean; error?: string }>> {
    const results: Record<string, { ok: boolean; error?: string }> = {};
    for (const id of ids) {
      const r = this.robots.find((x) => x.id === id);
      if (!r || !this.isOnline(id)) {
        results[id] = { ok: false, error: "robot offline" };
        continue;
      }
      // Safety gate: playback ramps out of the operating stand, so the robot
      // must already be in Running Mode (the UI blocks this too).
      if (!this.isInRunningMode(id)) {
        results[id] = { ok: false, error: "robot must be in Running Mode" };
        continue;
      }
      if (isTauri() && motionPath) {
        this.cmdState[id] = { action: "play motion", phase: "sending", msg: motionName };
        try {
          // The dds_bridge must be running on the robot before the PC connects.
          await robotBridgeStart(r.ip, r.sshUser, r.sshPassword ?? "");
          await startMotionPlayback(id, motionPath, r.ip, false);
          await controlMotionPlayback(id, "start"); // ramp into frame 0, then hold (armed)
          this.cmdState[id] = { action: "play motion", phase: "ok", msg: `armed: ${motionName}` };
          this.#log("success", `${r.name}: motion “${motionName}” armed (press Play)`);
          results[id] = { ok: true };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.cmdState[id] = { action: "play motion", phase: "error", msg };
          this.#log("error", `${r.name}: motion playback failed — ${msg}`);
          results[id] = { ok: false, error: msg };
        }
      } else {
        this.#log("success", `${r.name}: playing motion “${motionName}”`);
        results[id] = { ok: true };
      }
    }
    return results;
  }

  /** Stop motion playback on the given robots (returns them to FSM 801) + bridge. */
  async stopMotionOn(ids: string[], motionName: string): Promise<void> {
    for (const id of ids) {
      const r = this.robots.find((x) => x.id === id);
      const name = r?.name ?? "robot";
      if (isTauri()) {
        // Graceful stop: tell playback to stop streaming and switch the robot
        // back to FSM 801 FIRST, then wait for the on-robot SetFsmId(801) to
        // COMPLETE (the bridge's loco call blocks up to ~3s) before tearing
        // anything down. Killing motion_play / the bridge mid-switch leaves the
        // robot half-transitioned out of teleop (504), and in that state the
        // agent's mode controls (Damp/Sit/Stand/Run) are all rejected.
        try {
          await controlMotionPlayback(id, "stop");
          await new Promise((res) => setTimeout(res, 3500));
        } catch {
          /* best-effort */
        }
        try {
          await stopMotionPlayback(id);
          if (r) await robotBridgeStop(r.ip, r.sshUser, r.sshPassword ?? "");
        } catch {
          /* best-effort */
        }
      }
      this.#log("info", `${name}: stopped motion “${motionName}”`);
    }
  }

  /** Pause/resume motion playback on the given robots. */
  async setMotionPaused(ids: string[], paused: boolean): Promise<void> {
    if (!isTauri()) return;
    for (const id of ids) {
      try {
        await controlMotionPlayback(id, paused ? "pause" : "play");
      } catch {
        /* best-effort */
      }
    }
  }

  /** Toggle looping on the given robots' playback. */
  async setMotionLoop(ids: string[], loop: boolean): Promise<void> {
    if (!isTauri()) return;
    for (const id of ids) {
      try {
        await controlMotionPlayback(id, loop ? "loop on" : "loop off");
      } catch {
        /* best-effort */
      }
    }
  }

  // --- teleoperation (per robot) ---
  teleopStateOf(id: string): TeleopState {
    return this.teleop[id] ?? "stopped";
  }
  meshcatUrlOf(id: string): string {
    return this.meshcatUrls[id] ?? "";
  }
  teleopPausedOf(id: string): boolean {
    return this.teleopPaused[id] ?? false;
  }
  /** Desktop authority: pause (freeze the robot) or resume its live tracking
   *  without tearing down the teleop pipeline. No-op unless teleop is running. */
  async setTeleopPaused(id: string, paused: boolean): Promise<void> {
    if (this.teleopStateOf(id) !== "running") return;
    this.teleopPaused[id] = paused;
    const name = this.robots.find((r) => r.id === id)?.name ?? "robot";
    if (isTauri()) {
      try {
        await controlTeleopScript(id, paused ? "pause" : "resume");
        this.#log("info", `${name}: teleop ${paused ? "paused" : "resumed"}`);
      } catch (e) {
        this.teleopPaused[id] = !paused; // revert optimistic flip
        this.#log("error", `${name}: ${paused ? "pause" : "resume"} failed — ${e}`);
      }
    } else {
      this.#log("info", `${name}: teleop ${paused ? "paused" : "resumed"} (simulated)`);
    }
  }
  isTeleoperating(id: string): boolean {
    return this.teleopStateOf(id) === "running";
  }
  get teleopRunningCount(): number {
    return this.robots.filter((r) => this.isTeleoperating(r.id)).length;
  }
  get anyTeleopStartable(): boolean {
    return this.robots.some((r) => this.teleopStateOf(r.id) === "stopped");
  }
  get anyTeleopActive(): boolean {
    return this.robots.some((r) => this.teleopStateOf(r.id) !== "stopped");
  }

  /**
   * Default Meshcat web URL for a robot. The real teleop integration (Tauri
   * Rust spawning the teleop script) should report the actual web_url the
   * meshcat-server printed; until then we assign one port per robot from 7000.
   */
  #meshcatUrl(id: string): string {
    const idx = Math.max(0, this.robots.findIndex((r) => r.id === id));
    return `http://127.0.0.1:${7000 + idx}/static/`;
  }

  /**
   * Launch the teleoperation pipeline for a robot. In the desktop app this
   * starts the on-robot dds_bridge, then spawns whole_body_teleop_record_2.py
   * (WBC env) which reads the paired headset via xrobotoolkit_sdk and streams to
   * the robot; the Meshcat view appears once it's up. Browser stays mock.
   */
  async startTeleop(id: string): Promise<void> {
    const s = this.teleopStateOf(id);
    if (s === "running" || s === "starting") return;
    const r = this.robots.find((x) => x.id === id);
    const name = r?.name ?? "robot";
    // Safety gate: teleop must begin from Running Mode (the UI blocks this too).
    if (!this.isInRunningMode(id)) {
      this.#log("error", `${name}: switch to Running Mode before teleoperation`);
      return;
    }
    this.teleop[id] = "starting";
    this.teleopPaused[id] = false; // fresh teleop starts tracking (not paused)
    this.#log("info", `${name}: launching teleoperation…`);
    if (isTauri() && r) {
      try {
        // Bring up THIS robot's XRoboToolkit service instance (its own ports on
        // this PC's IP) so its paired headset connects to the right one.
        const slot = this.serviceSlotOf(id);
        await startXroboService(this.servicePortOf(id), this.grpcPortOf(id));
        // Bridge streams lowstate to this PC on the robot's offset port (matches
        // the teleop's bind offset below), so concurrent robots don't collide.
        await robotBridgeStart(r.ip, r.sshUser, r.sshPassword ?? "", slot);
        // The script picks a free Meshcat port (7000/7001/7002/…); use the URL
        // it actually bound to rather than assuming a port.
        const url = await startTeleopScript(id, r.ip, "inspire", slot, this.grpcPortOf(id));
        this.meshcatUrls[id] = url;
        this.teleop[id] = "running";
        this.#log("success", `${name}: teleoperation running`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.teleop[id] = "error";
        this.#log("error", `${name}: teleoperation failed — ${msg}`);
      }
    } else {
      await wait(1600);
      this.meshcatUrls[id] = this.#meshcatUrl(id);
      this.teleop[id] = "running";
      this.#log("success", `${name}: teleoperation running`);
    }
  }

  /** Stop teleop for a robot (returns it to FSM 801) + tears down the bridge. */
  async stopTeleop(id: string): Promise<void> {
    if (this.teleopStateOf(id) === "stopped") return;
    const r = this.robots.find((x) => x.id === id);
    const name = r?.name ?? "robot";
    this.teleop[id] = "stopped";
    this.teleopPaused[id] = false;
    delete this.meshcatUrls[id];
    if (isTauri() && r) {
      try {
        await stopTeleopScript(id); // SIGINT → script switches FSM 801 + settles
        await robotBridgeStop(r.ip, r.sshUser, r.sshPassword ?? "");
      } catch {
        /* best-effort */
      }
    }
    this.#log("info", `${name}: teleoperation stopped`);
  }

  async startTeleopAll(): Promise<void> {
    await Promise.all(
      this.robots
        .filter((r) => this.teleopStateOf(r.id) === "stopped")
        .map((r) => this.startTeleop(r.id)),
    );
  }

  stopTeleopAll(): void {
    for (const r of this.robots) {
      if (this.teleopStateOf(r.id) !== "stopped") this.stopTeleop(r.id);
    }
  }

  // --- fleet-wide actions ---
  async connectAll(): Promise<void> {
    await Promise.all(
      this.robots
        .filter((r) => this.connectionOf(r.id) === "disconnected")
        .map((r) => this.connect(r.id)),
    );
  }

  /** Emergency stop on every online robot; also halts any teleoperation. */
  allStop(): void {
    for (const r of this.onlineRobots) {
      const t = this.telemetry[r.id];
      if (t) {
        t.estop = true;
        this.postures[r.id] = "damp";
      }
    }
    for (const r of this.robots) {
      if (this.teleopStateOf(r.id) !== "stopped") {
        this.teleop[r.id] = "stopped";
        delete this.meshcatUrls[r.id];
        if (isTauri()) {
          // An E-stop must actually kill the streaming teleop process + bridge,
          // not just clear the UI (otherwise the robot keeps getting frames).
          stopTeleopScript(r.id).catch(() => {});
          robotBridgeStop(r.ip, r.sshUser, r.sshPassword ?? "").catch(() => {});
        }
      }
    }
    this.#log("error", "ALL-STOP engaged — robots E-stopped, teleoperation halted");
  }

  releaseAll(): void {
    for (const r of this.onlineRobots) {
      const t = this.telemetry[r.id];
      if (t) t.estop = false;
    }
    this.#log("info", "E-stop released on all robots");
  }

  #log(severity: ActivityEvent["severity"], message: string): void {
    this.activity = [
      { id: `e${this.activity.length}-${message.length}`, agoSec: 0, severity, message },
      ...this.activity,
    ].slice(0, 40);
  }

  /**
   * Telemetry tick — call once on app start. In the desktop app this polls each
   * online robot's on-robot agent over HTTP; in the browser it random-walks the
   * mock values so the UI still feels alive.
   */
  startTelemetry(): void {
    if (this.#ticking) return;
    this.#ticking = true;
    if (isTauri()) {
      setInterval(() => {
        for (const r of this.robots) {
          if (this.connectionOf(r.id) === "online") void this.#tickRobot(r);
        }
      }, 3000);
      return;
    }
    setInterval(() => {
      for (const r of this.robots) {
        if (this.connectionOf(r.id) !== "online") continue;
        const t = this.telemetry[r.id];
        if (!t) continue;
        t.uptimeSec += 2;
        t.cpuLoad = clamp(t.cpuLoad + rand(-4, 4), 8, 72);
        t.temperature = clamp(t.temperature + rand(-1, 1), 36, 58);
        if (!t.estop && t.battery > 0) t.battery = clamp(t.battery - 0.05, 0, 100);
      }
    }, 2000);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n * 10) / 10));
}

let seed = 7;
function rand(lo: number, hi: number): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return lo + (seed / 0x7fffffff) * (hi - lo);
}

export const robot = new RobotService();
