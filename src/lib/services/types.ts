/**
 * Domain types for the SCL Robotic Command Center.
 *
 * Transport-agnostic on purpose: the UI is built against these shapes with a
 * mock implementation today (see `robot.svelte.ts`, `onboarding.svelte.ts`,
 * `db.ts`). The same shapes can later be fed by a Tauri Rust bridge (real SSH /
 * network scan), the scl-backend API, or a direct robot connection — without
 * touching the components.
 */

/** Supported robot types. */
export type RobotType = "unitree-g1" | "engineai-t800";

export type RobotPlatform = "humanoid" | "quadruped" | "arm" | "custom";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "online"
  | "error";

/** Static description + sensible defaults for a robot type. */
export interface RobotTypeSpec {
  id: RobotType;
  name: string; // "Unitree G1"
  vendor: string; // "Unitree"
  platform: RobotPlatform;
  /** Default wired (ethernet) IP the robot ships with. */
  defaultEthernetIp: string;
  /** Default SSH user for the robot's onboard computer. */
  defaultSshUser: string;
  /** Optional caveat shown next to editable defaults that aren't confirmed. */
  note?: string;
  /** Temporarily unavailable — shown as "Coming soon" and not selectable. */
  comingSoon?: boolean;
}

/** A robot the operator has created a profile for. */
export interface RobotProfile {
  id: string;
  name: string;
  type: RobotType;
  /** Wired discovery address used during onboarding. */
  ethernetIp: string;
  /** Current/active address — becomes the Wi-Fi IP after onboarding. */
  ip: string;
  sshUser: string;
  /** SSH password, stored to allow hassle-free reconnect / re-Wi-Fi (operator's choice). */
  sshPassword?: string;
  /** Wi-Fi network the robot was joined to, if any. */
  wifiSsid: string | null;
  /** Port the on-robot telemetry agent listens on (deployed during onboarding). */
  apiPort?: number;
  createdAt: number;
}

/** Live(ish) robot telemetry. */
export interface Telemetry {
  battery: number; // 0–100 %
  temperature: number; // °C
  cpuLoad: number; // 0–100 %
  /** Used memory %, from the on-robot agent (OS metric). */
  memory?: number;
  uptimeSec: number;
  jointsOk: boolean;
  estop: boolean;
  /** Robot's hostname, reported by the agent. */
  hostname?: string;
  /**
   * Whether robot-specific fields (battery/temperature/jointsOk/estop) are live
   * from the Unitree DDS. False when only OS metrics are available — the UI then
   * renders those fields as "—".
   */
  robotStateAvailable?: boolean;
}

/** A Wi-Fi network discovered by the robot's radio. */
export interface WifiNetwork {
  ssid: string;
  signal: number; // 0–100 %
  secured: boolean;
}

/** State of a robot's teleoperation script + Meshcat viewer. */
export type TeleopState = "stopped" | "starting" | "running" | "error";

export type StepStatus = "pending" | "active" | "done" | "error";

export type Severity = "info" | "success" | "warn" | "error";

/** An entry for the activity / event feed. */
export interface ActivityEvent {
  id: string;
  agoSec: number;
  severity: Severity;
  message: string;
}
