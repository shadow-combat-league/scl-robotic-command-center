/**
 * Thin wrapper around Tauri APIs used by the preview pipeline.
 *
 * Everything here is guarded by `isTauri()` so the app still runs in the browser
 * (`pnpm dev`), where these calls are unavailable and the UI falls back to mock.
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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

/** Spawn the Meshcat preview backend; resolves to the viewer URL to embed. */
export function startMotionPreview(motionPath: string, robot: string): Promise<string> {
  return invoke<string>("start_motion_preview", { motionPath, robot });
}

export function stopMotionPreview(): Promise<void> {
  return invoke("stop_motion_preview");
}
