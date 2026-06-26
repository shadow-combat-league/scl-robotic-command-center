import type { RobotProfile } from "./types";

/**
 * Local database for robot profiles.
 *
 * MOCK-FIRST: persisted to `localStorage` so it works in both the browser dev
 * server and the Tauri webview today. Swap the read/write bodies for
 * `tauri-plugin-sql` (SQLite) or `tauri-plugin-store` later — the `db` surface
 * stays the same.
 */

const KEY = "scl-ccc.profiles";

function read(): RobotProfile[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RobotProfile[]) : [];
  } catch {
    return [];
  }
}

function write(profiles: RobotProfile[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(profiles));
}

export const db = {
  loadProfiles(): RobotProfile[] {
    return read();
  },

  /** Insert or replace a profile by id; returns the full updated list. */
  upsertProfile(profile: RobotProfile): RobotProfile[] {
    const all = read();
    const i = all.findIndex((p) => p.id === profile.id);
    if (i >= 0) all[i] = profile;
    else all.push(profile);
    write(all);
    return all;
  },

  /** Patch fields on an existing profile; returns the full updated list. */
  updateProfile(id: string, patch: Partial<RobotProfile>): RobotProfile[] {
    const all = read().map((p) => (p.id === id ? { ...p, ...patch } : p));
    write(all);
    return all;
  },

  deleteProfile(id: string): RobotProfile[] {
    const all = read().filter((p) => p.id !== id);
    write(all);
    return all;
  },
};
