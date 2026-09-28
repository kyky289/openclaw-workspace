import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, ACTIVE_MS, isTargetTelegramGroup } from "../dist/gate.js";
import { loadState, saveState } from "../dist/state.js";

const OWNER = "100000001";
const COLLABORATOR = "100000002";
const NOW = 2_000_000;

const active = {
  activatorId: OWNER,
  lastRelevantAt: NOW - 1000,
};

function action(event, state = active, now = NOW) {
  return decide(event, state, now);
}

test("sleeping blocks normal message", () => {
  assert.equal(
    decide({ senderId: OWNER, content: "你好" }, undefined, NOW).action,
    "BLOCK_SLEEPING"
  );
});

test("@bot wakes from sleep", () => {
  const r = decide({
    senderId: OWNER,
    content: "@research_fixture_bot 测试图片"
  }, undefined, NOW);

  assert.equal(r.action, "WAKE");
  assert.equal(r.nextState?.activatorId, OWNER);
});

test("reply to bot wakes from sleep", () => {
  assert.equal(
    decide({
      senderId: OWNER,
      content: "继续",
      replyToSender: "research_fixture_bot",
      replyToId: "123"
    }, undefined, NOW).action,
    "WAKE"
  );
});

test("real Telegram envelope with empty body is treated as media/empty content", () => {
  const r = action({
    senderId: OWNER,
    content:
      "[Telegram Fixture Group id:-1000000000001 +3s Mon 2026-09-21 10:38:43 GMT+8] Fixture Owner (100000001):"
  });

  assert.equal(r.content, "");
  assert.equal(r.action, "ALLOW_ACTIVE");
});

test("real Telegram envelope is stripped before acknowledgement check", () => {
  const r = action({
    senderId: OWNER,
    content:
      "[Telegram Fixture Group id:-1000000000001 +3s Mon 2026-09-21 10:38:43 GMT+8] Fixture Owner (100000001): 嗯"
  });

  assert.equal(r.content, "嗯");
  assert.equal(r.action, "BLOCK_ACK");
});

test("owner continuation while active is allowed", () => {
  assert.equal(
    action({
      senderId: OWNER,
      content: "能分析这张图片吗"
    }).action,
    "ALLOW_ACTIVE"
  );
});

test("owner pure image/empty content while active is allowed", () => {
  assert.equal(
    action({ senderId: OWNER, content: "" }).action,
    "ALLOW_ACTIVE"
  );
});

test("human-to-human reply is blocked", () => {
  assert.equal(
    action({
      senderId: OWNER,
      content: "对",
      replyToSender: "fixture_collaborator",
      replyToId: "456"
    }).action,
    "BLOCK_HUMAN_REPLY"
  );
});

test("Collaborator normal request while active is allowed", () => {
  assert.equal(
    action({
      senderId: COLLABORATOR,
      content: "帮我分析一下NVDA"
    }).action,
    "ALLOW_OTHER"
  );
});

test("Collaborator media while active is allowed", () => {
  assert.equal(
    action({
      senderId: COLLABORATOR,
      content: ""
    }).action,
    "ALLOW_OTHER"
  );
});

test("Collaborator does not extend owner's active window", () => {
  const r = action({
    senderId: COLLABORATOR,
    content: "帮我看看这个"
  });

  assert.equal(r.action, "ALLOW_OTHER");
  assert.equal(r.nextState?.lastRelevantAt, active.lastRelevantAt);
});

test("owner valid continuation extends active window", () => {
  const r = action({
    senderId: OWNER,
    content: "继续分析"
  });

  assert.equal(r.action, "ALLOW_ACTIVE");
  assert.equal(r.nextState?.lastRelevantAt, NOW);
});

test("expired window returns to sleep", () => {
  assert.equal(
    decide(
      { senderId: OWNER, content: "继续" },
      {
        activatorId: OWNER,
        lastRelevantAt: NOW - ACTIVE_MS - 1
      },
      NOW
    ).action,
    "BLOCK_SLEEPING"
  );
});

test("@ someone else while active is blocked", () => {
  assert.equal(
    action({ senderId: OWNER, content: "@fixture_collaborator 叔你看这个" }).action,
    "BLOCK_OTHER_MENTION"
  );
});

test("@ bot together with someone else still wakes", () => {
  assert.equal(
    action({ senderId: OWNER, content: "@fixture_collaborator @research_fixture_bot 你俩看看" }).action,
    "WAKE"
  );
});

test("email-like text is not treated as a mention of someone else", () => {
  assert.equal(
    action({ senderId: OWNER, content: "发到 a@b.com 吧" }).action,
    "ALLOW_ACTIVE"
  );
});

test("target group matching", () => {
  const group = { isGroup: true, channel: "telegram", sessionKey: "agent:main:telegram:group:-1000000000001" };
  assert.equal(isTargetTelegramGroup(group, {}), true);
  assert.equal(isTargetTelegramGroup({ ...group, isGroup: false }, {}), false);
  assert.equal(isTargetTelegramGroup({ ...group, sessionKey: "agent:main:telegram:group:-100" }, {}), false);
  assert.equal(isTargetTelegramGroup({ ...group, channel: "discord" }, {}), false);
  assert.equal(
    isTargetTelegramGroup({ isGroup: true }, { channelId: "telegram", conversationId: "-1000000000001" }),
    true
  );
});

test("state survives save/load round trip", () => {
  const file = join(mkdtempSync(join(tmpdir(), "taw-")), "state.json");
  const map = new Map([["-1000000000001", { activatorId: OWNER, lastRelevantAt: NOW }]]);
  saveState(map, file);
  assert.deepEqual(loadState(file).get("-1000000000001"), { activatorId: OWNER, lastRelevantAt: NOW });
});

test("missing or corrupt state file starts asleep", () => {
  const dir = mkdtempSync(join(tmpdir(), "taw-"));
  assert.equal(loadState(join(dir, "nope.json")).size, 0);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  assert.equal(loadState(bad).size, 0);
});

test("real reply to bot (replyToSender \"C (you)\") wakes instead of human-reply block", () => {
  // Observed live 2026-09-21: reply to the bot's message arrived as "C (you)".
  const r = action({ senderId: OWNER, content: "hi", replyToSender: "C (you)", replyToId: "468" });
  assert.equal(r.action, "WAKE");
  assert.equal(
    decide({ senderId: OWNER, content: "hi", replyToSender: "C (you)", replyToId: "468" }, undefined, NOW).action,
    "WAKE"
  );
});

test("reply to a human whose name merely contains 'you' is still a human reply", () => {
  assert.equal(
    action({ senderId: OWNER, content: "对", replyToSender: "young", replyToId: "9" }).action,
    "BLOCK_HUMAN_REPLY"
  );
});

test("bot mention matches the complete handle and ignores email local parts", () => {
  for (const content of [
    "@research_fixture_bot_extra",
    "@research_fixture_bot9",
    "alice@research_fixture_bot.com",
    "alice+alerts@research_fixture_bot.com",
    "@prefix_research_fixture_bot",
  ]) {
    assert.equal(decide({ senderId: OWNER, content }, undefined, NOW).action, "BLOCK_SLEEPING", content);
  }
  for (const content of ["@RESEARCH_FIXTURE_BOT", "请@research_fixture_bot 分析", "(@research_fixture_bot)", "@research_fixture_bot，继续"]) {
    assert.equal(decide({ senderId: OWNER, content }, undefined, NOW).action, "WAKE", content);
  }
});

test("email domains containing valid-length Telegram handles do not suppress a continuation", () => {
  for (const content of ["alice@example.com", "first.last@example.com", "alice+alerts@companyname.org"]) {
    assert.equal(action({ senderId: OWNER, content }).action, "ALLOW_ACTIVE", content);
  }
  assert.equal(action({ senderId: OWNER, content: "alice@example.com，请@other_fixture_member 看" }).action, "BLOCK_OTHER_MENTION");
});

test("overlong usernames are not truncated into valid mentions", () => {
  assert.equal(action({ senderId: OWNER, content: `@${"a".repeat(33)}` }).action, "ALLOW_ACTIVE");
  assert.equal(action({ senderId: OWNER, content: `@${"a".repeat(32)}` }).action, "BLOCK_OTHER_MENTION");
});

test("another member's acknowledgement remains allowed without extending the window", () => {
  const r = action({ senderId: COLLABORATOR, content: "ok" });
  assert.equal(r.action, "ALLOW_OTHER");
  assert.deepEqual(r.nextState, active);
});

test("group and channel identifiers cannot match through a substring", () => {
  const group = { isGroup: true, channel: "telegram", sessionKey: "agent:main:telegram:group:-1000000000001" };
  for (const channel of ["nottelegram", "telegram-proxy", "discord:telegram"]) {
    assert.equal(isTargetTelegramGroup({ ...group, channel }, {}), false, channel);
  }
  for (const sessionKey of [
    "agent:main:telegram:group:-10000000000010",
    "agent:main:telegram:group:-1000000000001-extra",
    "agent:main:telegram:group:-1000000000001:topic:abc",
    "agent:main:telegram:direct:-1000000000001",
    "agent:main:discord:group:-1000000000001",
    "agent:main:telegram:group:-1:topic:5491176253",
  ]) {
    assert.equal(isTargetTelegramGroup({ ...group, sessionKey }, {}), false, sessionKey);
  }
  for (const conversationId of ["-10000000000010", "prefix-1000000000001", "-1000000000001:topic:bad", "-1000000000001:topic:1:extra"]) {
    assert.equal(isTargetTelegramGroup({ isGroup: true, channel: "telegram" }, { conversationId }), false, conversationId);
  }
});

test("group session and conversation forms accept numeric topic ids", () => {
  for (const sessionKey of [
    "agent:group-tim:telegram:group:-1000000000001:topic:42",
    "telegram:group:-1000000000001",
    "group:-1000000000001:topic:1",
  ]) {
    assert.equal(isTargetTelegramGroup({ isGroup: true, channel: "telegram", sessionKey }, {}), true, sessionKey);
  }
  for (const conversationId of ["-1000000000001", "-1000000000001:topic:42", "group:-1000000000001", "telegram:group:-1000000000001:topic:42"]) {
    assert.equal(isTargetTelegramGroup({ isGroup: true, conversationId }, { channelId: "telegram" }), true, conversationId);
  }
});

test("conflicting parsed group identifiers do not apply the target gate", () => {
  assert.equal(isTargetTelegramGroup({ isGroup: true, channel: "telegram", sessionKey: "agent:main:telegram:group:-1" }, { conversationId: "-1000000000001" }), false);
  assert.equal(isTargetTelegramGroup({ isGroup: true, channel: "telegram", sessionKey: "agent:main:telegram:group:-1000000000001" }, { conversationId: "-1" }), false);
});

test("reply compatibility labels must be exact or runtime '(you)' labels with a reply reference", () => {
  for (const replyToSender of ["my research_fixture_bot friend", "research_fixture_bot_extra", "Telegram Active Window fan", "(you)"]) {
    assert.equal(action({ senderId: OWNER, content: "继续", replyToSender, replyToId: "9" }).action, "BLOCK_HUMAN_REPLY", replyToSender);
  }
  assert.equal(decide({ senderId: OWNER, content: "继续", replyToSender: "C (you)" }, undefined, NOW).action, "BLOCK_SLEEPING");
  assert.equal(decide({ senderId: OWNER, content: "继续", replyToSender: "@research_fixture_bot", replyToIdFull: "telegram:9" }, undefined, NOW).action, "WAKE");
});

test("full reply id is honored when short reply id is empty", () => {
  assert.equal(action({ senderId: OWNER, content: "继续", replyToSender: "Collaborator", replyToId: "", replyToIdFull: "telegram:9" }).action, "BLOCK_HUMAN_REPLY");
});

test("non-finite persisted timestamps cannot keep a window open", () => {
  const file = join(mkdtempSync(join(tmpdir(), "taw-")), "state.json");
  // JSON parses an exponent overflow to Infinity even though the file is valid JSON.
  writeFileSync(file, '{"-1000000000001":{"activatorId":"owner","lastRelevantAt":1e999},"valid":{"activatorId":"owner","lastRelevantAt":1000}}');
  assert.equal(loadState(file).has("-1000000000001"), false);
  assert.equal(loadState(file).size, 1);
  for (const lastRelevantAt of [Infinity, -Infinity, NaN]) {
    assert.equal(action({ senderId: OWNER, content: "继续" }, { ...active, lastRelevantAt }).action, "BLOCK_SLEEPING");
  }
});
