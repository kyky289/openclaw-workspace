---
name: "thesis-monitoring"
description: "Monitor/track/watch a research thesis; change frequency or criteria, pause, resume, stop, list, check now. Two-stage scan + re-evaluation."
---

# Thesis Monitoring

The user manages monitoring in natural language over Telegram. Carry out requests with the `automations` tool; never ask the user to configure backend jobs for ordinary monitoring changes.

## State model

`<slug>` is the part of the thesis filename after `thesis-` (e.g. `nvda`, `us-crypto-regulation`). All three parts of a monitor use the same slug:

- **Thesis:** `memory/thesis-<slug>.md` (workspace-relative). Holds only the thesis and its dated, never-overwritten updates. Never write monitor runtime state here (no last-check, seen evidence, criteria, jobId, or pending notification).
- **Automation:** named `thesis-monitor:<slug>`. Source of truth for schedule and on/off (`enabled`). Its prompt contains: an instruction to read the `thesis-monitoring` skill first and follow it, the slug, and the trigger-type marker `Trigger: scheduled run`.
- **State file:** `state/thesis-monitors/<slug>.md` (workspace-relative). The only place for monitor runtime state: criteria, last check, seen evidence, pending notification, jobId. Format in `templates/monitor-state.md` (relative to this skill's directory).

Never use automation scratch for monitor state, neither on the monitor job nor on the heartbeat job. Ordinary agentTurn runs do not receive scratch; only heartbeat runs read the heartbeat job's own scratch. The heartbeat scratch belongs to heartbeat only; never read monitor state from it or write monitor state into it.

## Operations (verified `automations` tool actions)

- **List:** `action: "list"`, `includeDisabled: true` (without it, paused monitors are hidden). Keep names starting `thesis-monitor:`; report thesis, schedule, enabled.
- **Inspect one:** `action: "get"`, `jobId`.
- **Start:** Step 1, using `action: "add"`.
- **Change frequency:** `action: "update"`, `jobId`, `job: { schedule: {...} }`. Mirror the new schedule in the state file.
- **Change criteria:** edit `Criteria` in the state file. No automation change needed.
- **Pause:** `action: "update"`, `jobId`, `job: { enabled: false }`. Set state `Status: paused`.
- **Resume:** `action: "update"`, `jobId`, `job: { enabled: true }`. Set state `Status: active`.
- **Stop:** `action: "remove"`, `jobId`. Confirm first if the target is ambiguous. Set state `Status: stopped (YYYY-MM-DD)`; keep the file and the thesis.
- **Check now / re-evaluate:** run Steps 2-3 directly in the chat as a user-initiated check. Always reply normally, even with no material change: report UNCHANGED with the evidence checked; never `NO_REPLY`, and quiet hours do not apply. Do not use `action: "run"`: that run carries the scheduled-run marker and would stay silent.

The tool's inventory is scoped to the caller. If a monitor listed in `state/thesis-monitors/` is not returned by `list` or `get`, tell the user it was created from another session and must be managed from the Control UI Automations page.

## Step 1 — Start monitoring

1. Check `memory/thesis-*.md` for an existing thesis.
2. If none exists and the topic warrants one, first load the `research-brain` skill to research and create it.
3. Read the thesis `Monitor next` and `Invalidation conditions`.
4. Decide what evidence actually needs monitoring. Keep it focused on evidence capable of changing the thesis, not general news volume.
5. List automations (`includeDisabled: true`) and check `state/thesis-monitors/<slug>.md`. If a monitor exists, update it instead of adding a duplicate.
6. Create `state/thesis-monitors/<slug>.md` from `templates/monitor-state.md` with the criteria from step 4.
7. `action: "add"` with:
   - `name: "thesis-monitor:<slug>"`;
   - `schedule`: `kind: "cron"` with `tz: "Asia/Hong_Kong"`, or `kind: "every"`, frequency per Resource Discipline;
   - `sessionTarget: "current"` so results land in this chat;
   - `payload: { kind: "agentTurn", message: "Trigger: scheduled run. First read the thesis-monitoring skill and follow it: run Steps 2-3 for slug <slug>. Reply NO_REPLY unless the Notification Standard is met." }`.
8. Write the returned `jobId` into the state file.
9. Confirm to the user in one short message: what is watched and how often.

Done when: exactly one monitor job exists for the thesis, its prompt points to this skill, and the state file holds its `jobId`.

## Step 2 — Evidence scan

Used by scheduled runs (prompt says `Trigger: scheduled run`) and by user-initiated check now. Scheduled runs are unattended: never ask questions or wait for input.

1. Read `state/thesis-monitors/<slug>.md`. If `Pending notification` is set and quiet hours are over, deliver it and clear it.
2. Search for genuinely new information since `Last check`, targeted at `Criteria` (derived from `Monitor next` and `Invalidation conditions`).
3. Drop items already in `Seen evidence`.
4. Do not rewrite the thesis for routine or irrelevant news.
5. Update `Last check` (HKT) and add new items to `Seen evidence` (keep the most recent 30).
6. If nothing is material: a scheduled run replies exactly `NO_REPLY`; a user-initiated check replies UNCHANGED with what was checked.

Escalate to Step 3 only when new evidence could materially affect the current thesis, a key assumption, confidence, contrary evidence, an invalidation condition, or an important monitoring priority.

Done when: the state file is updated, and the run either ends per step 6 or proceeds to Step 3 with the specific evidence named.

## Step 3 — Thesis re-evaluation

1. Read the existing thesis.
2. Inspect and verify the new evidence; prefer primary sources.
3. Cross-check material claims.
4. Apply the Thesis Update Protocol in Step 5 of the `research-brain` skill, including its reporting priority order.
5. Append a dated update only when warranted.
6. Scheduled run: notify the user with the important change and reasoning only if the Notification Standard is met; otherwise `NO_REPLY`. User-initiated check: always reply with the status, including UNCHANGED.

Done when: the thesis is appended or left untouched, and the reply follows step 6.

## Notification standard

Applies to scheduled runs only; a user-initiated check always gets a reply. Never notify merely because a scheduled check ran. Notify when:

- the thesis is materially strengthened or weakened;
- an invalidation condition is approached or triggered;
- a key assumption changes;
- important contrary evidence appears;
- confidence materially changes;
- a genuinely decision-relevant development occurs.

Otherwise stay quiet with `NO_REPLY`. A scheduled run never reports UNCHANGED; UNCHANGED is reported only for user-initiated re-evaluation.

Quiet hours are 23:00-08:00 HKT. A triggered invalidation condition counts as urgent and is sent immediately. Any other notification found in quiet hours is saved to `Pending notification` and sent by the first run after 08:00.

## Resource discipline

- Do not run full research on every scheduled check. Use lightweight discovery first; escalate only when evidence warrants it.
- Set frequency by how quickly the monitored evidence can realistically change. Avoid unnecessarily frequent checks.
