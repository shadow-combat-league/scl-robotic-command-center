/**
 * Motion & policy library.
 *
 * - Motions: LAFAN1 `.csv` datasets. Parsed for real (frames/columns/duration),
 *   previewed in Meshcat retargeted onto a chosen robot model.
 * - Policies: `.onnx` files. The user picks the target robot (G1 / T800) at
 *   import time; the rollout is previewed in an embedded Isaac Lab stream.
 *
 * MOCK-FIRST: parsing is real; the 3D/sim previews simulate spinning up the
 * backend (Meshcat server / Isaac Lab headless + WebRTC) and point an iframe at
 * its web URL. The real version is a Tauri Rust command that launches the
 * backend and returns the URL — this surface doesn't change.
 */

import type { RobotType } from "./types";
import { isTauri, startMotionPreview, stopMotionPreview } from "./tauri";

export interface ImportedMotion {
  id: string;
  name: string;
  frames: number;
  fps: number;
  durationSec: number;
  columns: number; // degrees of freedom in the dataset
  importedAt: number;
  /** Absolute path on disk (set when imported via the native dialog in Tauri). */
  path?: string;
}

export interface ImportedPolicy {
  id: string;
  name: string;
  robot: RobotType; // chosen explicitly at import
  sizeKb: number;
  importedAt: number;
}

export type PreviewState = "idle" | "loading" | "ready" | "error";
export type PreviewKind = "motion" | "policy";

const LAFAN_FPS = 30;
// Default Meshcat web URL served by tools/meshcat_preview/meshcat_motion_preview.py.
// The packaged app will instead read the URL the spawned backend prints.
const MESHCAT_URL = "http://127.0.0.1:7000/static/";
const ISAAC_URL = "http://127.0.0.1:8211/streaming/webrtc-client";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    await this.openMotionPreview(motion.id);
  }

  /** Import a motion by absolute path (native dialog, Tauri) and preview it. */
  async importMotionFromPath(path: string): Promise<void> {
    this.importError = "";
    const name = path.split(/[/\\]/).pop() || path;
    const motion: ImportedMotion = {
      id: `m-${Date.now().toString(36)}`,
      name,
      path,
      frames: 0, // unknown without parsing; the backend owns playback
      fps: LAFAN_FPS,
      durationSec: 0,
      columns: 0,
      importedAt: Date.now(),
    };
    this.motions = [motion, ...this.motions];
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
      // Real backend: auto-spawn the Meshcat preview and embed its URL.
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

    // Mock (browser / no path): show the placeholder transport against MESHCAT_URL.
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

  removeMotion(id: string): void {
    this.motions = this.motions.filter((m) => m.id !== id);
    if (this.previewKind === "motion" && this.previewId === id) this.closePreview();
  }
  removePolicy(id: string): void {
    this.policies = this.policies.filter((p) => p.id !== id);
    if (this.previewKind === "policy" && this.previewId === id) this.closePreview();
  }
}

export const library = new Library();
