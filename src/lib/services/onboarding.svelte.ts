/**
 * Onboarding wizard — reactive state machine for setting up a robot.
 *
 * Flow: profile → ethernet → ssh → wi-fi → done.
 * In the desktop app these steps run for REAL against the robot (TCP reachability,
 * SSH auth, nmcli Wi-Fi scan/connect, read the new IP) via the Tauri `run_onboard`
 * backend. In the browser (`pnpm dev`) there's no robot, so they're simulated.
 *
 * `resumeReonboard(profile)` re-runs the flow for an existing robot (e.g. its
 * saved Wi-Fi IP stopped responding) starting at the Ethernet step.
 */

import { robot } from "./robot.svelte";
import { robotTypeSpec } from "./robotTypes";
import type { RobotProfile, RobotType, WifiNetwork } from "./types";
import {
  isTauri,
  robotReachable,
  robotSshCheck,
  robotWifiScan,
  robotWifiConnect,
  hostWifiSsid,
  hostWifiPsk,
  robotProvisionAgent,
} from "./tauri";

export type WizardStepId = "profile" | "ethernet" | "ssh" | "wifi" | "provision" | "done";

export const WIZARD_STEPS: { id: WizardStepId; label: string; hint: string }[] = [
  { id: "profile", label: "Profile", hint: "Name & robot type" },
  { id: "ethernet", label: "Ethernet", hint: "Find robot on the wire" },
  { id: "ssh", label: "Authenticate", hint: "SSH into the robot" },
  { id: "wifi", label: "Network", hint: "Join a Wi-Fi network" },
  { id: "provision", label: "Deploy", hint: "Install telemetry agent" },
  { id: "done", label: "Done", hint: "Saved & ready" },
];

/** Async-op phase used by the network/SSH steps. */
export type Phase = "idle" | "working" | "ok" | "error";

export type WifiMode = "computer" | "scan";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

const MOCK_WIFI: WifiNetwork[] = [
  { ssid: "SCL-LAB-5G", signal: 92, secured: true },
  { ssid: "ARENA-NET", signal: 71, secured: true },
  { ssid: "SCL-Guest", signal: 58, secured: false },
  { ssid: "Robotics_2.4", signal: 39, secured: true },
];

function mockWifiIp(ssid: string): string {
  let h = 0;
  for (const c of ssid) h = (h * 31 + c.charCodeAt(0)) & 0xff;
  return `192.168.1.${40 + (h % 180)}`;
}

class OnboardingFlow {
  step = $state<WizardStepId>("profile");

  /** Set when re-onboarding an existing robot (updates it instead of creating). */
  reonboardId = $state<string | null>(null);

  // --- step 1: profile ---
  name = $state("");
  type = $state<RobotType | null>(null);

  // --- step 2: ethernet ---
  ethernetIp = $state("");
  ethPhase = $state<Phase>("idle");
  ethMsg = $state("");

  // --- step 3: ssh ---
  sshUser = $state("");
  sshPassword = $state("");
  sshPhase = $state<Phase>("idle");
  sshMsg = $state("");

  // --- step 4: wi-fi ---
  wifiMode = $state<WifiMode | null>(null);
  computerSsid = $state(""); // the network this computer is on
  hostSsidPhase = $state<Phase>("idle"); // detecting this computer's Wi-Fi
  wifiList = $state<WifiNetwork[]>([]);
  wifiScanPhase = $state<Phase>("idle");
  selectedSsid = $state<string | null>(null);
  wifiPassword = $state("");
  wifiPhase = $state<Phase>("idle");
  wifiMsg = $state("");
  newIp = $state("");

  // --- step 5: provision (deploy the on-robot telemetry agent) ---
  provisionPhase = $state<Phase>("idle");
  provisionMsg = $state("");
  agentPort = $state(8472);

  /** SSID that will actually be joined given the current mode/selection. */
  get targetSsid(): string | null {
    return this.wifiMode === "computer" ? this.computerSsid : this.selectedSsid;
  }

  get selectedNetwork(): WifiNetwork | null {
    return this.wifiList.find((w) => w.ssid === this.selectedSsid) ?? null;
  }

  reset(): void {
    this.step = "profile";
    this.reonboardId = null;
    this.name = "";
    this.type = null;
    this.ethernetIp = "";
    this.ethPhase = "idle";
    this.ethMsg = "";
    this.sshUser = "";
    this.sshPassword = "";
    this.sshPhase = "idle";
    this.sshMsg = "";
    this.wifiMode = null;
    this.computerSsid = "";
    this.hostSsidPhase = "idle";
    this.wifiList = [];
    this.wifiScanPhase = "idle";
    this.selectedSsid = null;
    this.wifiPassword = "";
    this.wifiPhase = "idle";
    this.wifiMsg = "";
    this.newIp = "";
    this.provisionPhase = "idle";
    this.provisionMsg = "";
    this.agentPort = 8472;
  }

  /** Re-run onboarding for an existing robot, starting at the Ethernet step. */
  resumeReonboard(p: RobotProfile): void {
    this.reset();
    this.reonboardId = p.id;
    this.name = p.name;
    this.type = p.type;
    this.ethernetIp = p.ethernetIp || robotTypeSpec(p.type).defaultEthernetIp;
    this.sshUser = p.sshUser || robotTypeSpec(p.type).defaultSshUser;
    this.sshPassword = p.sshPassword ?? "";
    this.agentPort = p.apiPort ?? 8472;
    this.step = "ethernet";
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

  /** Step 2 — is the robot reachable at its wired IP? */
  async scanEthernet(): Promise<void> {
    this.ethPhase = "working";
    this.ethMsg = "";
    if (!this.ethernetIp.trim()) {
      this.ethPhase = "error";
      this.ethMsg = "Enter the robot's wired IP address.";
      return;
    }
    if (isTauri()) {
      try {
        const ok = await robotReachable(this.ethernetIp);
        if (ok) {
          this.ethPhase = "ok";
          this.ethMsg = `Robot reachable at ${this.ethernetIp}`;
        } else {
          this.ethPhase = "error";
          this.ethMsg = `No response from ${this.ethernetIp}. Check the Ethernet cable and that the robot is powered on.`;
        }
      } catch (e) {
        this.ethPhase = "error";
        this.ethMsg = reason(e);
      }
      return;
    }
    await wait(1300);
    this.ethPhase = "ok";
    this.ethMsg = `Robot reachable at ${this.ethernetIp} (mock)`;
  }

  /** Step 3 — SSH into the robot. */
  async authenticateSsh(): Promise<void> {
    this.sshPhase = "working";
    this.sshMsg = "";
    if (!this.sshPassword) {
      this.sshPhase = "error";
      this.sshMsg = "Enter the SSH password for the robot.";
      return;
    }
    if (isTauri()) {
      try {
        const hostname = await robotSshCheck(this.ethernetIp, this.sshUser, this.sshPassword);
        this.sshPhase = "ok";
        this.sshMsg = `Authenticated as ${this.sshUser}@${this.ethernetIp}${hostname ? ` (${hostname})` : ""}`;
      } catch (e) {
        this.sshPhase = "error";
        this.sshMsg = reason(e);
      }
      return;
    }
    await wait(1100);
    this.sshPhase = "ok";
    this.sshMsg = `Authenticated as ${this.sshUser}@${this.ethernetIp} (mock)`;
  }

  /** Return to the "how should the robot join Wi-Fi?" choice. */
  backToWifiChoice(): void {
    this.wifiMode = null;
    this.selectedSsid = null;
    this.hostSsidPhase = "idle";
    this.wifiList = [];
    this.wifiScanPhase = "idle";
    this.wifiPassword = "";
    this.wifiPhase = "idle";
    this.wifiMsg = "";
    this.newIp = "";
  }

  chooseWifiMode(mode: WifiMode): void {
    this.wifiMode = mode;
    this.wifiPassword = "";
    this.wifiPhase = "idle";
    this.wifiMsg = "";
    this.newIp = "";
    this.hostSsidPhase = "idle";

    if (mode === "scan") {
      this.selectedSsid = null;
      return;
    }

    // "Use this computer's network" — detect the SSID this machine is on.
    this.computerSsid = "";
    this.selectedSsid = null;
    this.hostSsidPhase = "working";
    const apply = (ssid: string) => {
      if (this.wifiMode !== "computer") return; // user changed their mind
      if (ssid) {
        this.computerSsid = ssid;
        this.selectedSsid = ssid;
        this.hostSsidPhase = "ok";
        // Prefill the Wi-Fi password from this laptop's saved network, so the
        // operator doesn't retype it when the robot joins the same network.
        if (isTauri()) {
          hostWifiPsk(ssid)
            .then((psk) => {
              if (this.wifiMode === "computer" && psk && !this.wifiPassword) {
                this.wifiPassword = psk;
              }
            })
            .catch(() => {});
        }
      } else {
        this.hostSsidPhase = "error";
        this.wifiMsg =
          "Couldn't detect this computer's Wi-Fi network — it may be on Ethernet. Use “Scan robot's networks” instead.";
      }
    };
    if (isTauri()) {
      hostWifiSsid()
        .then(apply)
        .catch((e) => {
          if (this.wifiMode !== "computer") return;
          this.hostSsidPhase = "error";
          this.wifiMsg = reason(e);
        });
    } else {
      wait(900).then(() => apply("SCL-LAB-5G"));
    }
  }

  /** Step 4 (scan mode) — ask the robot to list nearby networks. */
  async scanWifi(): Promise<void> {
    this.wifiScanPhase = "working";
    this.wifiMsg = "";
    this.wifiList = [];
    if (isTauri()) {
      try {
        const nets = await robotWifiScan(this.ethernetIp, this.sshUser, this.sshPassword);
        this.wifiList = nets.map((n) => ({ ssid: n.ssid, signal: n.signal, secured: n.secured }));
        this.wifiScanPhase = "ok";
      } catch (e) {
        this.wifiScanPhase = "error";
        this.wifiMsg = reason(e);
      }
      return;
    }
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

  /** Step 4 — tell the robot to join the target network, then read its new IP. */
  async connectWifi(): Promise<void> {
    const ssid = this.targetSsid;
    this.wifiPhase = "working";
    this.wifiMsg = "";
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
    if (isTauri()) {
      try {
        this.newIp = await robotWifiConnect(
          this.ethernetIp,
          this.sshUser,
          this.sshPassword,
          ssid,
          this.wifiPassword,
        );
        this.wifiPhase = "ok";
        this.wifiMsg = `Robot joined “${ssid}”`;
      } catch (e) {
        this.wifiPhase = "error";
        this.wifiMsg = reason(e);
      }
      return;
    }
    await wait(1700);
    this.newIp = mockWifiIp(ssid);
    this.wifiPhase = "ok";
    this.wifiMsg = `Robot joined “${ssid}” (mock)`;
  }

  /** Wi-Fi joined — advance to the Deploy step and kick off provisioning. */
  goToProvision(): void {
    if (this.wifiPhase !== "ok") return;
    this.step = "provision";
    this.provisionAgent();
  }

  /** Deploy the telemetry agent to the robot, then persist the profile. */
  async provisionAgent(): Promise<void> {
    if (!this.type) return;
    this.provisionPhase = "working";
    this.provisionMsg = "";
    if (isTauri()) {
      try {
        const res = await robotProvisionAgent(
          this.newIp,
          this.sshUser,
          this.sshPassword,
          this.agentPort,
        );
        if (!res.ok) throw new Error("the agent service did not confirm it was running");
        this.provisionPhase = "ok";
        this.provisionMsg = res.ddsAvailable
          ? "Telemetry agent installed — robot sensors are live."
          : "Telemetry agent installed (system metrics). Robot sensors appear once the Unitree SDK is detected on the robot.";
        this.#persist();
      } catch (e) {
        this.provisionPhase = "error";
        this.provisionMsg = reason(e);
      }
      return;
    }
    await wait(1300);
    this.provisionPhase = "ok";
    this.provisionMsg = "Telemetry agent installed (mock).";
    this.#persist();
  }

  /** Save the robot without deploying the agent now (telemetry shows "—" until later). */
  skipProvision(): void {
    this.provisionPhase = "idle";
    this.#persist();
    this.step = "done";
  }

  /** Move on to the final summary after a successful deploy. */
  finish(): void {
    this.step = "done";
  }

  /** Create the new profile (or update the re-onboarded one) in the roster. */
  #persist(): void {
    if (!this.type) return;
    if (this.reonboardId) {
      robot.updateConnection(this.reonboardId, {
        ip: this.newIp,
        wifiSsid: this.targetSsid,
        apiPort: this.agentPort,
      });
    } else {
      const profile: RobotProfile = {
        id: `${this.type}-${Date.now().toString(36)}`,
        name: this.name.trim(),
        type: this.type,
        ethernetIp: this.ethernetIp,
        ip: this.newIp,
        sshUser: this.sshUser,
        sshPassword: this.sshPassword || undefined,
        wifiSsid: this.targetSsid,
        apiPort: this.agentPort,
        createdAt: Date.now(),
      };
      robot.upsert(profile);
    }
  }
}

export const onboarding = new OnboardingFlow();
