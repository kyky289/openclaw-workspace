import { decide, isTargetTelegramGroup, TARGET_GROUP_ID, } from "./gate.js";
import { loadState, saveState } from "./state.js";
// Separate SDK-free wiring lets tests invoke the same registered handler as
// production without loading the gateway, a Telegram client, or private state.
export function registerGate(api, options = {}) {
    const activeGroups = (options.load ?? loadState)(options.stateFile);
    const persist = options.save ?? saveState;
    const now = options.now ?? Date.now;
    api.on("before_dispatch", (event, ctx) => {
        try {
            if (!isTargetTelegramGroup(event, ctx))
                return;
            const key = TARGET_GROUP_ID;
            const senderId = String(event.senderId ?? ctx.senderId ?? "unknown");
            const gateEvent = {
                content: event.content,
                body: event.body,
                senderId,
                replyToSender: event.replyToSender ?? ctx.replyToSender,
                replyToId: event.replyToId ?? ctx.replyToId,
                replyToIdFull: event.replyToIdFull ?? ctx.replyToIdFull,
            };
            const previous = activeGroups.get(key);
            const result = decide(gateEvent, previous, now());
            if (result.nextState) {
                activeGroups.set(key, result.nextState);
            }
            else if (result.action === "BLOCK_SLEEPING") {
                activeGroups.delete(key);
            }
            if (activeGroups.get(key) !== previous) {
                try {
                    persist(activeGroups, options.stateFile);
                }
                catch (error) {
                    api.logger.error(`[telegram-active-window] state save failed: ${String(error)}`);
                }
            }
            // Metadata only: message bodies and media contents are never logged.
            const replyInfo = gateEvent.replyToId || gateEvent.replyToIdFull
                ? ` replyToSender=${JSON.stringify(String(gateEvent.replyToSender ?? ""))}`
                : "";
            api.logger.info(`[telegram-active-window] ${result.action} sender=${senderId}${replyInfo}`);
            switch (result.action) {
                case "BLOCK_SLEEPING":
                case "BLOCK_HUMAN_REPLY":
                case "BLOCK_ACK":
                case "BLOCK_OTHER_MENTION":
                    return { handled: true };
                case "WAKE":
                case "ALLOW_ACTIVE":
                case "ALLOW_OTHER":
                    return;
            }
        }
        catch (error) {
            // Preserve the existing fail-open policy: this gate is not a security
            // boundary. A gate bug must not silently lose an important message.
            api.logger.error(`[telegram-active-window] ERROR fail-open: ${String(error)}`);
            return;
        }
    });
}
