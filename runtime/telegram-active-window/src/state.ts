import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ActiveState } from "./gate.js";

// Persist the active window so a gateway restart does not put the bot back to sleep.
export const DEFAULT_STATE_FILE = join(
  homedir(),
  ".openclaw",
  "plugin-state",
  "telegram-active-window.json"
);

function isActiveState(value: any): value is ActiveState {
  return (
    typeof value?.activatorId === "string" &&
    typeof value?.lastRelevantAt === "number" &&
    Number.isFinite(value.lastRelevantAt)
  );
}

export function loadState(file: string = DEFAULT_STATE_FILE): Map<string, ActiveState> {
  const map = new Map<string, ActiveState>();

  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(data ?? {})) {
      if (isActiveState(value)) map.set(key, value);
    }
  } catch {
    // Missing or corrupt file: start asleep.
  }

  return map;
}

export function saveState(map: Map<string, ActiveState>, file: string = DEFAULT_STATE_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
  renameSync(tmp, file);
}
