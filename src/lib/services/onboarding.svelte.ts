/**
 * Onboarding wizard — reactive state machine for setting up a robot.
 *
 * Flow: profile → ethernet scan → ssh auth → wi-fi → done.
 * All network/SSH operations are SIMULATED (mock-first). Replace the bodies of
 * scanEthernet / authenticateSsh / scanWifi / connectWifi with Tauri `invoke`
 * calls into a Rust bridge later; the wizard UI won't change.
 */

import { robot } from "./robot.svelte";
import { robotTypeSpec } from "./robotTypes";
import type { RobotProfile, RobotType, WifiNetwork } from "./types";

export type WizardStepId = "profile" | "ethernet" | "ssh" | "wifi" | "done";

export const WIZARD_STEPS: { id: WizardStepId; label: string; hint: string }[] = [
  { id: "profile", label: "Profile", hint: "Name & robot type" },
  { id: "ethernet", label: "Ethernet", hint: "Find robot on the wire" },
  { id: "ssh", label: "Authenticate", hint: "SSH into the robot" },
  { id: "wifi", label: "Network", hint: "Join a Wi-Fi network" },
  { id: "done", label: "Done", hint: "Saved & ready" },
];

/** Async-op phase used by the network/SSH steps. */
export type Phase = "idle" | "working" | "ok" | "error";

export type WifiMode = "computer" | "scan";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MOCK_WIFI: WifiNetwork[] = [
  { ssid: "SCL-LAB-5G", signal: 92, secured: true },
  { ssid: "ARENA-NET", signal: 71, secured: true },
  { ssid: "SCL-Guest", signal: 58, secured: false },
  { ssid: "Robotics_2.4", signal: 39, secured: true },
];

function mockSerial(type: RobotType): string {
  const code = type === "unitree-g1" ? "G1" : "T800";
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${code}-${n}-${String.fromCharCode(65 + Math.floor(Math.random() * 26))}X`;
}

function mockWifiIp(ssid: string): string {
  let h = 0;
  for (const c of ssid) h = (h * 31 + c.charCodeAt(0)) & 0xff;
  return `192.168.1.${40 + (h % 180)}`;
}

class OnboardingFlow {
  step = $state<WizardStepId>("profile");

  // --- step 1: profile ---
  name = $state("");
  type = $state<RobotType | null>(null);

  // --- step 2: ethernet ---
  ethernetIp = $state("");
  ethPhase = $state<Phase>("idle");
  ethMsg = $state("");
  foundSerial = $state("");

  // --- step 3: ssh ---
  sshUser = $state("");
  sshPassword = $state("");
  sshPhase = $state<Phase>("idle");
  sshMsg = $state("");

  // --- step 4: wi-fi ---
  wifiMode = $state<WifiMode | null>(null);
  computerSsid = $state("SCL-LAB-5G"); // mock: the network this computer is on
  wifiList = $state<WifiNetwork[]>([]);
  wifiScanPhase = $state<Phase>("idle");
  selectedSsid = $state<string | null>(null);
  wifiPassword = $state("");
  wifiPhase = $state<Phase>("idle");
  wifiMsg = $state("");
  newIp = $state("");

  /** SSID that will actually be joined given the current mode/selection. */
  get targetSsid(): string | null {
    return this.wifiMode === "computer" ? this.computerSsid : this.selectedSsid;
  }

  get selectedNetwork(): WifiNetwork | null {
    return this.wifiList.find((w) => w.ssid === this.selectedSsid) ?? null;
  }

  reset(): void {
    this.step = "profile";
    this.name = "";
    this.type = null;
    this.ethernetIp = "";
    this.ethPhase = "idle";
    this.ethMsg = "";
    this.foundSerial = "";
    this.sshUser = "";
    this.sshPassword = "";
    this.sshPhase = "idle";
    this.sshMsg = "";
    this.wifiMode = null;
    this.wifiList = [];
    this.wifiScanPhase = "idle";
    this.selectedSsid = null;
    this.wifiPassword = "";
    this.wifiPhase = "idle";
    this.wifiMsg = "";
    this.newIp = "";
  }

  chooseType(type: RobotType): void {
    const spec = robotTypeSpec(type);
    if (spec.comingSoon) return; // not yet selectable
    this.type = type;
    this.ethernetIp = spec.defaultEthernetIp;
    this.sshUser = spec.defaultSshUser;
  }

  /** Step 1 → validate name + type, then advance. Nothing is persisted yet. */
  confirmProfile(): void {
    if (!this.type || !this.name.trim()) return;
    this.step = "ethernet";
  }

  /** Step 2 — simulated ethernet discovery at the configured IP. */
  async scanEthernet(): Promise<void> {
    this.ethPhase = "working";
    this.ethMsg = "";
    await wait(1300);
    if (!this.ethernetIp.trim()) {
      this.ethPhase = "error";
      this.ethMsg = "Enter the robot's wired IP address.";
      return;
    }
    this.foundSerial = mockSerial(this.type ?? "unitree-g1");
    this.ethPhase = "ok";
    this.ethMsg = `Found ${robotTypeSpec(this.type ?? "unitree-g1").name} · ${this.foundSerial}`;
  }

  /** Step 3 — simulated SSH authentication. */
  async authenticateSsh(): Promise<void> {
    this.sshPhase = "working";
    this.sshMsg = "";
    await wait(1100);
    if (!this.sshPassword) {
      this.sshPhase = "error";
      this.sshMsg = "Enter the SSH password for the robot.";
      return;
    }
    this.sshPhase = "ok";
    this.sshMsg = `Authenticated as ${this.sshUser}@${this.ethernetIp}`;
  }

  /** Return to the "how should the robot join Wi-Fi?" choice. */
  backToWifiChoice(): void {
    this.wifiMode = null;
    this.selectedSsid = null;
    this.wifiPassword = "";
    this.wifiPhase = "idle";
    this.wifiMsg = "";
    this.newIp = "";
  }

  chooseWifiMode(mode: WifiMode): void {
    this.wifiMode = mode;
    this.selectedSsid = mode === "computer" ? this.computerSsid : null;
    this.wifiPassword = "";
    this.wifiPhase = "idle";
    this.wifiMsg = "";
    this.newIp = "";
  }

  /** Step 4 (scan mode) — ask the robot to list nearby networks. */
  async scanWifi(): Promise<void> {
    this.wifiScanPhase = "working";
    this.wifiList = [];
    await wait(1500);
    this.wifiList = MOCK_WIFI;
    this.wifiScanPhase = "ok";
  }

  selectWifi(ssid: string): void {
    this.selectedSsid = ssid;
    this.wifiPassword = "";
    this.wifiPhase = "idle";
    this.wifiMsg = "";
  }

  /** Step 4 — tell the robot to join the target network. */
  async connectWifi(): Promise<void> {
    const ssid = this.targetSsid;
    this.wifiPhase = "working";
    this.wifiMsg = "";
    await wait(1700);
    if (!ssid) {
      this.wifiPhase = "error";
      this.wifiMsg = "Choose a network first.";
      return;
    }
    const secured =
      this.wifiMode === "computer" ? true : (this.selectedNetwork?.secured ?? true);
    if (secured && !this.wifiPassword) {
      this.wifiPhase = "error";
      this.wifiMsg = `“${ssid}” is secured — enter its password.`;
      return;
    }
    this.newIp = mockWifiIp(ssid);
    this.wifiPhase = "ok";
    this.wifiMsg = `Robot joined “${ssid}”`;
  }

  /** Create the fully-onboarded profile in the local DB and finish. */
  finish(): void {
    if (!this.type || this.wifiPhase !== "ok") return;
    const profile: RobotProfile = {
      id: `${this.type}-${Date.now().toString(36)}`,
      name: this.name.trim(),
      type: this.type,
      ethernetIp: this.ethernetIp,
      ip: this.newIp,
      sshUser: this.sshUser,
      wifiSsid: this.targetSsid,
      createdAt: Date.now(),
    };
    robot.upsert(profile);
    this.step = "done";
  }
}

export const onboarding = new OnboardingFlow();
