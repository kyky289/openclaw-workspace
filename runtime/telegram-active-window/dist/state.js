import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// Persist the active window so a gateway restart does not put the bot back to sleep.
export const DEFAULT_STATE_FILE = join(homedir(), ".openclaw", "plugin-state", "telegram-active-window.json");
function isActiveState(value) {
    return (typeof value?.activatorId === "string" &&
        typeof value?.lastRelevantAt === "number" &&
        Number.isFinite(value.lastRelevantAt));
}
export function loadState(file = DEFAULT_STATE_FILE) {
    const map = new Map();
    try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        for (const [key, value] of Object.entries(data ?? {})) {
            if (isActiveState(value))
                map.set(key, value);
        }
    }
    catch {
        // Missing or corrupt file: start asleep.
    }
    return map;
}
export function saveState(map, file = DEFAULT_STATE_FILE) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
    renameSync(tmp, file);
}
