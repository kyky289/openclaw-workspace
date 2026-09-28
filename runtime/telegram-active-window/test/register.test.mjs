import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGate } from "../dist/register.js";
import { ACTIVE_MS, TARGET_GROUP_ID } from "../dist/gate.js";
import { loadState } from "../dist/state.js";

const OWNER = "100000001";
const COLLABORATOR = "100000002";
const NOW = 2_000_000;
const group = { isGroup: true, channel: "telegram", sessionKey: `agent:group-tim:telegram:group:${TARGET_GROUP_ID}` };

function harness(options = {}) {
  let handler;
  const messages = [];
  const errors = [];
  const stateFile = join(mkdtempSync(join(tmpdir(), "taw-hook-")), "state.json");
  registerGate({
    on(name, callback) {
      assert.equal(name, "before_dispatch");
      assert.equal(handler, undefined, "registers exactly one handler");
      handler = callback;
    },
    logger: { info: (message) => messages.push(message), error: (message) => errors.push(message) },
  }, { stateFile, now: () => NOW, ...options });
  return { dispatch: handler, messages, errors, stateFile };
}

test("registered hook blocks sleeping target and ignores all non-target messages", () => {
  let saves = 0;
  const h = harness({ save() { saves++; } });
  assert.deepEqual(h.dispatch({ ...group, senderId: OWNER, content: "hello" }, {}), { handled: true });
  assert.equal(h.dispatch({ ...group, sessionKey: `agent:main:telegram:group:${TARGET_GROUP_ID}0`, content: "@research_fixture_bot" }, {}), undefined);
  assert.equal(h.dispatch({ ...group, channel: "nottelegram", content: "@research_fixture_bot" }, {}), undefined);
  assert.equal(h.dispatch({ ...group, isGroup: false, content: "@research_fixture_bot" }, {}), undefined);
  assert.equal(saves, 0);
  assert.equal(h.messages.length, 1);
});

test("hook wakes using context reply fields and persists state that survives registration", () => {
  const h = harness();
  assert.equal(h.dispatch({ isGroup: true, body: "private example text" }, {
    channelId: "telegram", conversationId: TARGET_GROUP_ID, senderId: OWNER,
    replyToSender: "C (you)", replyToIdFull: "telegram:123",
  }), undefined);
  assert.deepEqual(loadState(h.stateFile).get(TARGET_GROUP_ID), { activatorId: OWNER, lastRelevantAt: NOW });
  assert.equal(h.messages.some((message) => message.includes("private example text")), false);

  const restarted = harness({ stateFile: h.stateFile, now: () => NOW + 1000 });
  assert.equal(restarted.dispatch({ ...group, senderId: OWNER, content: "继续" }, {}), undefined);
  assert.deepEqual(loadState(h.stateFile).get(TARGET_GROUP_ID), { activatorId: OWNER, lastRelevantAt: NOW + 1000 });
});

test("hook preserves shared window and other-member acknowledgement behavior without writes", () => {
  let currentTime = NOW;
  let saves = 0;
  const h = harness({ now: () => currentTime, save() { saves++; } });
  h.dispatch({ ...group, senderId: OWNER, content: "@research_fixture_bot" }, {});
  currentTime += 1000;
  assert.equal(h.dispatch({ ...group, senderId: COLLABORATOR, content: "ok" }, {}), undefined);
  assert.deepEqual(h.dispatch({ ...group, senderId: OWNER, content: "ok" }, {}), { handled: true });
  assert.equal(saves, 1);
  currentTime = NOW + ACTIVE_MS + 1;
  assert.deepEqual(h.dispatch({ ...group, senderId: COLLABORATOR, content: "继续" }, {}), { handled: true });
  assert.equal(saves, 2, "expiry persists the state removal");
});

test("hook persists expiry removal and stays asleep after registration", () => {
  let currentTime = NOW;
  const h = harness({ now: () => currentTime });
  h.dispatch({ ...group, senderId: OWNER, content: "@research_fixture_bot" }, {});
  currentTime += ACTIVE_MS + 1;
  assert.deepEqual(h.dispatch({ ...group, senderId: OWNER, content: "继续" }, {}), { handled: true });
  assert.equal(readFileSync(h.stateFile, "utf8"), "{}");
  const restarted = harness({ stateFile: h.stateFile, now: () => currentTime });
  assert.deepEqual(restarted.dispatch({ ...group, senderId: OWNER, content: "继续" }, {}), { handled: true });
});

test("state save failure is logged while in-memory gate behavior is retained", () => {
  const h = harness({ save() { throw new Error("test write failure"); } });
  assert.equal(h.dispatch({ ...group, senderId: OWNER, content: "@research_fixture_bot" }, {}), undefined);
  assert.match(h.errors[0], /state save failed/);
  assert.deepEqual(h.dispatch({ ...group, senderId: OWNER, content: "@anotherperson" }, {}), { handled: true });
});

test("unexpected dispatch failure retains explicit fail-open policy", () => {
  const h = harness({ now() { throw new Error("test clock failure"); } });
  assert.equal(h.dispatch({ ...group, senderId: OWNER, content: "hello" }, {}), undefined);
  assert.match(h.errors[0], /ERROR fail-open/);
});

test("event reply metadata takes precedence over context fallback", () => {
  const h = harness();
  h.dispatch({ ...group, senderId: OWNER, content: "@research_fixture_bot" }, {});
  assert.deepEqual(h.dispatch({ ...group, senderId: OWNER, content: "继续", replyToSender: "Collaborator", replyToId: "8" }, {
    replyToSender: "C (you)", replyToId: "9",
  }), { handled: true });
});

test("forum topic messages share the existing per-group active window", () => {
  const h = harness();
  h.dispatch({ ...group, sessionKey: `${group.sessionKey}:topic:1`, senderId: OWNER, content: "@research_fixture_bot" }, {});
  assert.equal(h.dispatch({ ...group, sessionKey: `${group.sessionKey}:topic:2`, senderId: COLLABORATOR, content: "继续" }, {}), undefined);
  assert.match(h.messages.at(-1), /ALLOW_OTHER/);
});
