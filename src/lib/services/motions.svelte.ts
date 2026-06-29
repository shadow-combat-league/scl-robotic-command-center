/**
 * Motion & policy library.
 *
 * - Motions: LAFAN1 `.csv` datasets, previewed in Meshcat.
 * - Policies: `.onnx` files (target robot chosen at import), previewed in Isaac Lab.
 *
 * Imported files are COPIED into the app's data dir (library/{motions,policies})
 * via Tauri so they're owned by the app, and the copy is DELETED when the user
 * removes the entry. The library (metadata + stored path) is persisted to
 * localStorage so it survives restarts.
 *
 * MOCK-FIRST seam: in the browser (no Tauri) there's no app data dir, so imports
 * stay in-memory; the 3D/sim previews fall back to placeholder URLs.
 */

import type { RobotType } from "./types";
import { robot } from "./robot.svelte";
import {
  isTauri,
  startMotionPreview,
  stopMotionPreview,
  controlMotionPreview,
  saveLibraryFile,
  deleteLibraryFile,
} from "./tauri";

export interface ImportedMotion {
  id: string;
  name: string;
  frames: number;
  fps: number;
  durationSec: number;
  columns: number; // degrees of freedom in the dataset
  importedAt: number;
  /** Path of the app-owned copy in the data dir (Tauri). */
  path?: string;
}

export interface ImportedPolicy {
  id: string;
  name: string;
  robot: RobotType; // chosen explicitly at import
  sizeKb: number;
  importedAt: number;
  /** Path of the app-owned copy in the data dir (Tauri). */
  path?: string;
}

export type PreviewState = "idle" | "loading" | "ready" | "error";
export type PreviewKind = "motion" | "policy";

/** A live "play motion on robots" session (popup with the Meshcat view + controls). */
export interface PlaySession {
  id: string;
  motionId: string;
  motionName: string;
  robotIds: string[];
  state: PreviewState;
  url: string;
  paused: boolean;
}

const LAFAN_FPS = 30;
const LIB_KEY = "scl-ccc.library";
const MESHCAT_URL = "http://127.0.0.1:7000/static/";
const ISAAC_URL = "http://127.0.0.1:8211/streaming/webrtc-client";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}
function extOf(name: string, fallback: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i) : fallback;
}

/** Lightweight LAFAN1 CSV parse — frame/column counts, or null if not motion data. */
function parseLafan(text: string): { frames: number; columns: number } | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const firstCells = lines[0].split(",");
  const firstIsNumeric = firstCells.every((c) => c !== "" && !Number.isNaN(Number(c)));
  const dataLines = firstIsNumeric ? lines : lines.slice(1);
  if (dataLines.length === 0) return null;
  const columns = dataLines[0].split(",").length;
  if (columns < 2) return null;
  return { frames: dataLines.length, columns };
}

class Library {
  motions = $state<ImportedMotion[]>([]);
  policies = $state<ImportedPolicy[]>([]);
  importError = $state("");

  // --- preview (motion → Meshcat, policy → Isaac Lab) ---
  previewKind = $state<PreviewKind | null>(null);
  previewId = $state<string | null>(null);
  previewState = $state<PreviewState>("idle");
  previewUrl = $state("");

  // motion-only playback
  previewRobot = $state<RobotType>("unitree-g1");
  playing = $state(false);
  frame = $state(0);
  speed = $state(1);

  // live "play on robots" session
  playSession = $state<PlaySession | null>(null);

  #loaded = false;

  /** Restore the persisted library (call once on mount). */
  load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(LIB_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { motions?: ImportedMotion[]; policies?: ImportedPolicy[] };
      this.motions = data.motions ?? [];
      this.policies = data.policies ?? [];
    } catch {
      /* ignore corrupt store */
    }
  }

  #persist(): void {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      LIB_KEY,
      JSON.stringify({ motions: this.motions, policies: this.policies }),
    );
  }

  get previewMotion(): ImportedMotion | null {
    return this.previewKind === "motion"
      ? this.motions.find((m) => m.id === this.previewId) ?? null
      : null;
  }
  get previewPolicy(): ImportedPolicy | null {
    return this.previewKind === "policy"
      ? this.policies.find((p) => p.id === this.previewId) ?? null
      : null;
  }

  // ---------------- motions ----------------
  /** Browser fallback: read + validate a File, keep in memory (no app-data copy). */
  async importMotionFromFile(file: File): Promise<void> {
    this.importError = "";
    let text: string;
    try {
      text = await file.text();
    } catch {
      this.importError = `Couldn't read “${file.name}”.`;
      return;
    }
    const parsed = parseLafan(text);
    if (!parsed) {
      this.importError = `“${file.name}” doesn't look like a LAFAN1 CSV (expected rows of comma-separated numbers).`;
      return;
    }
    const motion: ImportedMotion = {
      id: `m-${Date.now().toString(36)}`,
      name: file.name,
      frames: parsed.frames,
      fps: LAFAN_FPS,
      durationSec: parsed.frames / LAFAN_FPS,
      columns: parsed.columns,
      importedAt: Date.now(),
    };
    this.motions = [motion, ...this.motions];
    this.#persist();
    await this.openMotionPreview(motion.id);
  }

  /** Tauri: copy the picked motion into the app data dir, persist, then preview. */
  async importMotionFromPath(srcPath: string): Promise<void> {
    this.importError = "";
    const name = baseName(srcPath);
    const id = `m-${Date.now().toString(36)}`;
    let storedPath: string;
    try {
      const saved = await saveLibraryFile(srcPath, "motions", `${id}${extOf(name, ".csv")}`);
      storedPath = saved.path;
    } catch (e) {
      this.importError = `Couldn't save “${name}” into the app: ${e}`;
      return;
    }
    const motion: ImportedMotion = {
      id,
      name,
      path: storedPath,
      frames: 0, // backend owns playback; metadata not parsed from path
      fps: LAFAN_FPS,
      durationSec: 0,
      columns: 0,
      importedAt: Date.now(),
    };
    this.motions = [motion, ...this.motions];
    this.#persist();
    await this.openMotionPreview(motion.id);
  }

  async openMotionPreview(id: string, robot?: RobotType): Promise<void> {
    this.previewKind = "motion";
    this.previewId = id;
    if (robot) this.previewRobot = robot;
    this.frame = 0;
    this.playing = false;
    this.previewState = "loading";

    const motion = this.motions.find((m) => m.id === id);
    if (motion?.path && isTauri()) {
      try {
        const url = await startMotionPreview(motion.path, this.previewRobot);
        if (this.previewId !== id) return;
        this.previewUrl = url;
        this.previewState = "ready";
      } catch (e) {
        if (this.previewId !== id) return;
        this.previewState = "error";
        this.importError = `Preview backend failed: ${e}`;
      }
      return;
    }

    // Mock (browser / no stored file): placeholder transport against MESHCAT_URL.
    await wait(1200);
    if (this.previewId !== id) return;
    this.previewUrl = MESHCAT_URL;
    this.previewState = "ready";
    this.playing = true;
  }

  setModel(robot: RobotType): void {
    if (robot === this.previewRobot) return;
    if (this.previewKind === "motion" && this.previewId) this.openMotionPreview(this.previewId, robot);
    else this.previewRobot = robot;
  }

  // ---------------- policies ----------------
  /** Browser fallback: validate an .onnx File, keep in memory (no app-data copy). */
  importPolicy(file: File, robot: RobotType): void {
    this.importError = "";
    if (!file.name.toLowerCase().endsWith(".onnx")) {
      this.importError = `“${file.name}” isn't an .onnx policy file.`;
      return;
    }
    const policy: ImportedPolicy = {
      id: `p-${Date.now().toString(36)}`,
      name: file.name,
      robot,
      sizeKb: Math.max(1, Math.round(file.size / 1024)),
      importedAt: Date.now(),
    };
    this.policies = [policy, ...this.policies];
    this.#persist();
    this.openPolicyPreview(policy.id);
  }

  /** Tauri: copy the picked .onnx into the app data dir, persist, then preview. */
  async importPolicyFromPath(srcPath: string, robot: RobotType): Promise<void> {
    this.importError = "";
    const name = baseName(srcPath);
    if (!name.toLowerCase().endsWith(".onnx")) {
      this.importError = `“${name}” isn't an .onnx policy file.`;
      return;
    }
    const id = `p-${Date.now().toString(36)}`;
    let stored: { path: string; sizeKb: number };
    try {
      stored = await saveLibraryFile(srcPath, "policies", `${id}.onnx`);
    } catch (e) {
      this.importError = `Couldn't save “${name}” into the app: ${e}`;
      return;
    }
    const policy: ImportedPolicy = {
      id,
      name,
      robot,
      sizeKb: stored.sizeKb,
      importedAt: Date.now(),
      path: stored.path,
    };
    this.policies = [policy, ...this.policies];
    this.#persist();
    this.openPolicyPreview(policy.id);
  }

  async openPolicyPreview(id: string): Promise<void> {
    this.previewKind = "policy";
    this.previewId = id;
    this.previewState = "loading";
    // MOCK: launch Isaac Lab headless with this policy + robot, start WebRTC stream.
    await wait(1600);
    if (this.previewId !== id) return;
    this.previewUrl = ISAAC_URL;
    this.previewState = "ready";
  }

  // ---------------- shared preview ----------------
  closePreview(): void {
    const wasMotion = this.previewKind === "motion";
    this.previewKind = null;
    this.previewId = null;
    this.previewUrl = "";
    this.previewState = "idle";
    this.playing = false;
    this.frame = 0;
    if (wasMotion && isTauri()) stopMotionPreview().catch(() => {});
  }
  togglePlay(): void {
    if (this.previewState === "ready" && this.previewKind === "motion") this.playing = !this.playing;
  }
  seek(frame: number): void {
    this.frame = Math.max(0, Math.min(frame, (this.previewMotion?.frames ?? 1) - 1));
  }
  setSpeed(speed: number): void {
    this.speed = speed;
  }
  tick(): void {
    const m = this.previewMotion;
    if (!m || !this.playing) return;
    const step = Math.max(1, Math.round(m.fps * 0.1 * this.speed));
    let f = this.frame + step;
    if (f >= m.frames) f = 0;
    this.frame = f;
  }

  // ---------------- live playback session ----------------
  /** Trigger on-robot playback and open the live Meshcat popup. */
  async startPlaySession(motion: ImportedMotion, robotIds: string[]): Promise<void> {
    robot.playMotionOn(robotIds, motion.name);
    const id = `play-${Date.now().toString(36)}`;
    this.playSession = {
      id,
      motionId: motion.id,
      motionName: motion.name,
      robotIds: [...robotIds],
      state: "loading",
      url: "",
      paused: true, // armed — starts paused; the popup's Play button resumes it
    };
    const targetType =
      robot.robots.find((r) => r.id === robotIds[0])?.type ?? this.previewRobot;
    let url = MESHCAT_URL;
    let ok = true;
    if (motion.path && isTauri()) {
      try {
        url = await startMotionPreview(motion.path, targetType, true); // start paused
      } catch {
        ok = false;
      }
    } else {
      await wait(1200);
    }
    if (this.playSession?.id !== id) return; // stopped or superseded
    if (ok) {
      this.playSession.url = url;
      this.playSession.state = "ready";
    } else {
      this.playSession.state = "error";
    }
  }

  stopPlaySession(): void {
    const s = this.playSession;
    if (!s) return;
    this.playSession = null;
    robot.stopMotionOn(s.robotIds, s.motionName);
    if (isTauri()) stopMotionPreview().catch(() => {});
  }

  togglePauseSession(): void {
    if (!this.playSession) return;
    this.playSession.paused = !this.playSession.paused;
    if (isTauri()) {
      controlMotionPreview(this.playSession.paused ? "pause" : "resume").catch(() => {});
    }
  }

  async removeMotion(id: string): Promise<void> {
    const m = this.motions.find((x) => x.id === id);
    this.motions = this.motions.filter((x) => x.id !== id);
    if (this.previewKind === "motion" && this.previewId === id) this.closePreview();
    if (m?.path && isTauri()) await deleteLibraryFile(m.path).catch(() => {});
    this.#persist();
  }
  async removePolicy(id: string): Promise<void> {
    const p = this.policies.find((x) => x.id === id);
    this.policies = this.policies.filter((x) => x.id !== id);
    if (this.previewKind === "policy" && this.previewId === id) this.closePreview();
    if (p?.path && isTauri()) await deleteLibraryFile(p.path).catch(() => {});
    this.#persist();
  }
}

export const library = new Library();
