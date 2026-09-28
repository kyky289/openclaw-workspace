export const TARGET_GROUP_ID = "-1000000000001";
export const BOT_USERNAME = "@research_fixture_bot";
export const ACTIVE_MS = 30 * 60 * 1000;
export function isTargetTelegramGroup(event, ctx) {
    const channel = String(event?.channel ?? ctx?.channelId ?? "").trim().toLowerCase();
    if (event?.isGroup !== true || channel !== "telegram")
        return false;
    const session = String(event?.sessionKey ?? ctx?.sessionKey ?? "").trim();
    const conversation = String(event?.conversationId ?? ctx?.conversationId ?? "").trim();
    // Match complete identifiers, including an optional numeric forum topic.
    // An opaque/non-route session key may coexist with a usable conversation id.
    const sessionId = session.match(/^(?:agent:[^:]+:)?(?:telegram:)?group:(-?\d+)(?::topic:\d+)?$/i)?.[1];
    const conversationId = conversation.match(/^(?:telegram:)?(?:group:)?(-?\d+)(?::topic:\d+)?$/i)?.[1];
    const ids = [sessionId, conversationId].filter((id) => id !== undefined);
    return ids.length > 0 && ids.every((id) => id === TARGET_GROUP_ID);
}
function telegramMentions(content) {
    // Ignore embedded email/user tokens, and never truncate an overlong handle.
    // Chinese text and punctuation may directly precede a real @mention.
    return content.match(/(?<![a-z0-9_@.+-])@[a-z0-9_]{5,32}(?![a-z0-9_])/gi) ?? [];
}
// True when the message @-mentions some other Telegram handle (not the bot).
export function mentionsSomeoneElse(content) {
    const bot = BOT_USERNAME.toLowerCase();
    const handles = telegramMentions(content);
    return handles.some((h) => h.toLowerCase() !== bot);
}
export function stripTelegramEnvelope(value) {
    const raw = String(value ?? "").trim();
    return raw
        .replace(/^\[Telegram [^\]]*\]\s*[^\n:]*\(\d+\):\s*/, "")
        .trim();
}
export function hasBotMention(content) {
    return telegramMentions(content).some((handle) => handle.toLowerCase() === BOT_USERNAME.toLowerCase());
}
export function isReplyToBot(event) {
    if (!hasReplyReference(event))
        return false;
    const sender = String(event.replyToSender ?? "").toLowerCase().trim();
    // OpenClaw labels replies to the bot's own messages as "<display name> (you)",
    // e.g. "C (you)" (observed 2026-09-21).
    // These are compatibility labels, not verified Telegram user ids. Do not use
    // this conversational gate for authorization or private-data isolation.
    return (/^.+\s\(you\)$/.test(sender) ||
        sender === BOT_USERNAME ||
        sender === BOT_USERNAME.slice(1) ||
        sender === "telegram active window");
}
function hasReplyReference(event) {
    return Boolean(event.replyToId || event.replyToIdFull);
}
export function decide(event, state, now) {
    const content = stripTelegramEnvelope(event.content ?? event.body ?? "");
    const senderId = String(event.senderId ?? "unknown");
    const repliedToBot = isReplyToBot(event);
    if (hasBotMention(content) || repliedToBot) {
        return {
            action: "WAKE",
            content,
            nextState: {
                activatorId: senderId,
                lastRelevantAt: now,
            },
        };
    }
    if (!state || !Number.isFinite(state.lastRelevantAt) || now - state.lastRelevantAt > ACTIVE_MS) {
        return {
            action: "BLOCK_SLEEPING",
            content,
        };
    }
    const repliedToSomeone = hasReplyReference(event);
    if (repliedToSomeone && !repliedToBot) {
        return {
            action: "BLOCK_HUMAN_REPLY",
            content,
            nextState: state,
        };
    }
    if (mentionsSomeoneElse(content)) {
        return {
            action: "BLOCK_OTHER_MENTION",
            content,
            nextState: state,
        };
    }
    const isAck = /^(ok|okay|好的?|嗯+|哦+|哈+|哈哈+|收到|行|👍|🙏)$/i.test(content);
    if (senderId === state.activatorId) {
        if (isAck) {
            return {
                action: "BLOCK_ACK",
                content,
                nextState: state,
            };
        }
        return {
            action: "ALLOW_ACTIVE",
            content,
            nextState: {
                ...state,
                lastRelevantAt: now,
            },
        };
    }
    // Other people such as Collaborator are allowed during an active window,
    // but they do NOT extend the activator's 30-minute window.
    return {
        action: "ALLOW_OTHER",
        content,
        nextState: state,
    };
}
