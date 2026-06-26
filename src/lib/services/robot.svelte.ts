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

class RobotService {
  robots = $state<RobotProfile[]>([]);

  /** Per-robot live state, keyed by profile id. */
  connections = $state<Record<string, ConnectionState>>({});
  telemetry = $state<Record<string, Telemetry>>({});
  postures = $state<Record<string, string>>({});
  /** Teleoperation script state + the Meshcat viewer URL it publishes to. */
  teleop = $state<Record<string, TeleopState>>({});
  meshcatUrls = $state<Record<string, string>>({});

  activity = $state<ActivityEvent[]>([]);

  #loaded = false;
  #ticking = false;

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
    await wait(900);
    this.connections[id] = "online";
    this.telemetry[id] = seedTelemetry(id);
    this.postures[id] = "idle";
    this.#log("success", `Connected to ${r.name}`);
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

  setPosture(id: string, posture: string): void {
    if (!this.isOnline(id)) return;
    if (this.telemetryOf(id).estop) return; // can't command while E-stopped
    this.postures[id] = posture;
    const name = this.robots.find((r) => r.id === id)?.name ?? "robot";
    this.#log("info", `${name}: ${posture}`);
  }

  // --- teleoperation (per robot) ---
  teleopStateOf(id: string): TeleopState {
    return this.teleop[id] ?? "stopped";
  }
  meshcatUrlOf(id: string): string {
    return this.meshcatUrls[id] ?? "";
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

  /** Launch the teleoperation script; the 3D (Meshcat) view appears once running. */
  async startTeleop(id: string): Promise<void> {
    const s = this.teleopStateOf(id);
    if (s === "running" || s === "starting") return;
    const name = this.robots.find((r) => r.id === id)?.name ?? "robot";
    this.teleop[id] = "starting";
    this.#log("info", `${name}: launching teleoperation script…`);
    await wait(1600);
    this.meshcatUrls[id] = this.#meshcatUrl(id);
    this.teleop[id] = "running";
    this.#log("success", `${name}: teleoperation running`);
  }

  stopTeleop(id: string): void {
    if (this.teleopStateOf(id) === "stopped") return;
    this.teleop[id] = "stopped";
    delete this.meshcatUrls[id];
    const name = this.robots.find((r) => r.id === id)?.name ?? "robot";
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

  /** Simulated telemetry tick — call once on app start; updates all online robots. */
  startTelemetry(): void {
    if (this.#ticking) return;
    this.#ticking = true;
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
