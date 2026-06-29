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

/** Spawn the Meshcat preview backend; resolves to the viewer URL to embed.
 *  `startPaused` renders the first frame but waits for "resume" before playing. */
export function startMotionPreview(
  motionPath: string,
  robot: string,
  startPaused = false,
): Promise<string> {
  return invoke<string>("start_motion_preview", { motionPath, robot, startPaused });
}

export function stopMotionPreview(): Promise<void> {
  return invoke("stop_motion_preview");
}

/** Send a control line ("pause" | "resume") to the running preview backend. */
export function controlMotionPreview(command: "pause" | "resume"): Promise<void> {
  return invoke("control_motion_preview", { command });
}
