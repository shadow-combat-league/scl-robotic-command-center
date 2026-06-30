/**
 * Teleop headset discovery + pairing (XRoboToolkit).
 *
 * MOCK-FIRST: in the browser (`pnpm dev`) `discover()`/`pair()` simulate; in the
 * desktop app they probe the real Wi-Fi via the Tauri HTTP transport (see the
 * PROTOCOL CONTRACT in services/tauri.ts). State is reactive + persisted so
 * known headsets survive reloads; a scan refreshes their online status.
 *
 * Discovery: probe every host on this computer's Wi-Fi /24 for an XRoboToolkit
 * `/xrobo/info` endpoint. Pairing: POST this computer's IP to the headset so it
 * connects back automatically — no input needed on the headset side.
 */
import { isTauri, localIpv4, headsetInfo, pairHeadset, type HeadsetInfo } from "./tauri";

export type HeadsetStatus =
  | "discovered" // seen on the network, not paired to this PC
  | "pairing"
  | "paired" // told to connect to this PC
  | "streaming" // actively teleoperating
  | "offline" // known but not seen on the last scan
  | "error";

export interface Headset {
  id: string;
  name: string;
  model: string;
  ip: string;
  port: number;
  battery: number | null;
  status: HeadsetStatus;
  pairedPcIp: string;
  online: boolean;
  lastSeen: number;
  error?: string;
}

const KEY = "scl-ccc.headsets";
const DISCOVERY_PORT = 8090; // XRoboToolkit discovery port (configurable later)
const SCAN_TIMEOUT_MS = 600; // per-host probe budget
const SCAN_BATCH = 40; // concurrent probes in flight

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Headsets {
  headsets = $state<Headset[]>([]);
  scanning = $state(false);
  scanProgress = $state<{ done: number; total: number }>({ done: 0, total: 0 });
  pcIp = $state("");
  error = $state("");
  lastScan = $state(0);
  port = DISCOVERY_PORT;

  constructor() {
    this.#loadPersisted();
  }

  get onlineCount(): number {
    return this.headsets.filter((h) => h.online).length;
  }
  get pairedCount(): number {
    return this.headsets.filter((h) => h.status === "paired" || h.status === "streaming").length;
  }

  /** Resolve this computer's Wi-Fi IP (shown in the UI; used for pairing). */
  async refreshPcIp(): Promise<void> {
    if (!isTauri()) {
      this.pcIp = this.pcIp || "192.168.1.50"; // mock for browser dev
      return;
    }
    this.pcIp = (await localIpv4()) || this.pcIp;
  }

  /** Scan the Wi-Fi subnet for XRoboToolkit headsets and refresh their status. */
  async discover(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.error = "";
    try {
      if (!isTauri()) {
        await this.#mockDiscover();
        return;
      }
      this.pcIp = await localIpv4();
      const octets = this.pcIp.split(".");
      if (octets.length !== 4 || !octets[0]) {
        this.error = "couldn't determine this computer's Wi-Fi IP";
        return;
      }
      const base = octets.slice(0, 3).join(".");
      const ips = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
      this.scanProgress = { done: 0, total: ips.length };
      const seen = new Set<string>();
      for (let i = 0; i < ips.length; i += SCAN_BATCH) {
        const batch = ips.slice(i, i + SCAN_BATCH);
        const results = await Promise.all(
          batch.map(async (ip) => {
            const info = await headsetInfo(ip, this.port, SCAN_TIMEOUT_MS);
            return info ? { ...info, ip } : null;
          }),
        );
        this.scanProgress = { done: Math.min(i + SCAN_BATCH, ips.length), total: ips.length };
        for (const r of results) {
          if (r) {
            this.#merge(r);
            seen.add(r.id);
          }
        }
      }
      // Known headsets we didn't see this scan → offline (keep paired flag).
      for (const h of this.headsets) {
        if (!seen.has(h.id)) {
          h.online = false;
          if (h.status !== "paired") h.status = "offline";
        }
      }
      this.lastScan = Date.now();
      this.#persist();
    } finally {
      this.scanning = false;
    }
  }

  /** Hand the headset this computer's IP so it auto-connects for teleop. */
  async pair(id: string): Promise<void> {
    const h = this.headsets.find((x) => x.id === id);
    if (!h) return;
    h.status = "pairing";
    h.error = undefined;
    try {
      if (!this.pcIp) this.pcIp = await localIpv4();
      if (isTauri()) await pairHeadset(h.ip, h.port, this.pcIp);
      else await wait(500);
      h.status = "paired";
      h.pairedPcIp = this.pcIp;
      this.#persist();
    } catch (e) {
      h.status = "error";
      h.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Tell the headset to stop connecting back to this PC. */
  async unpair(id: string): Promise<void> {
    const h = this.headsets.find((x) => x.id === id);
    if (!h) return;
    try {
      if (isTauri()) await pairHeadset(h.ip, h.port, ""); // empty pcIp = disconnect
    } catch {
      /* best-effort */
    }
    h.status = h.online ? "discovered" : "offline";
    h.pairedPcIp = "";
    this.#persist();
  }

  /** Drop a headset from the known list. */
  forget(id: string): void {
    this.headsets = this.headsets.filter((h) => h.id !== id);
    this.#persist();
  }

  #merge(info: HeadsetInfo & { ip: string }): void {
    const pairedPcIp = info.pcIp ?? "";
    const status: HeadsetStatus =
      info.status === "streaming"
        ? "streaming"
        : pairedPcIp && pairedPcIp === this.pcIp
          ? "paired"
          : "discovered";
    const existing = this.headsets.find((h) => h.id === info.id);
    if (existing) {
      existing.ip = info.ip;
      existing.name = info.name ?? existing.name;
      existing.model = info.model ?? existing.model;
      existing.battery = info.battery ?? null;
      existing.pairedPcIp = pairedPcIp;
      existing.online = true;
      existing.status = existing.status === "pairing" ? "pairing" : status;
      existing.lastSeen = Date.now();
      existing.error = undefined;
    } else {
      this.headsets.push({
        id: info.id,
        ip: info.ip,
        port: this.port,
        name: info.name || `Headset ${this.headsets.length + 1}`,
        model: info.model || "XR headset",
        battery: info.battery ?? null,
        pairedPcIp,
        online: true,
        status,
        lastSeen: Date.now(),
      });
    }
  }

  async #mockDiscover(): Promise<void> {
    this.pcIp = "192.168.1.50";
    this.scanProgress = { done: 0, total: 254 };
    await wait(1100);
    this.scanProgress = { done: 254, total: 254 };
    for (const m of [
      { id: "pico4-demo-01", ip: "192.168.1.21", name: "Headset 1", model: "PICO 4", battery: 82, status: "idle", pcIp: "" },
      { id: "quest3-demo-02", ip: "192.168.1.37", name: "Headset 2", model: "Quest 3", battery: 64, status: "idle", pcIp: "" },
    ]) {
      this.#merge(m);
    }
    this.lastScan = Date.now();
  }

  #loadPersisted(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(KEY);
      const saved = raw ? (JSON.parse(raw) as Array<Partial<Headset>>) : [];
      this.headsets = saved
        .filter((s) => s.id)
        .map((s) => ({
          id: s.id as string,
          ip: s.ip ?? "",
          port: s.port ?? this.port,
          name: s.name ?? "Headset",
          model: s.model ?? "XR headset",
          battery: null,
          pairedPcIp: s.pairedPcIp ?? "",
          online: false,
          status: (s.pairedPcIp ? "paired" : "offline") as HeadsetStatus,
          lastSeen: 0,
        }));
    } catch {
      /* corrupt store — start empty */
    }
  }

  #persist(): void {
    if (typeof localStorage === "undefined") return;
    const subset = this.headsets.map((h) => ({
      id: h.id,
      name: h.name,
      model: h.model,
      ip: h.ip,
      port: h.port,
      pairedPcIp: h.pairedPcIp,
    }));
    localStorage.setItem(KEY, JSON.stringify(subset));
  }
}

export const headsets = new Headsets();
