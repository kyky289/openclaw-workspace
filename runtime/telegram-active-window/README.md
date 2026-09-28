# Telegram Active Window

Hook-only OpenClaw plugin (`before_dispatch`) that gates bot replies in one Telegram group.
The gate only applies when `isGroup` is true, the channel is exactly `telegram`, and a parsed
group/session identifier is exactly the configured group id. Supported session forms are
`agent:<agent>:telegram:group:<id>`, `telegram:group:<id>`, and `group:<id>`; conversation ids may
be bare ids or have `group:` / `telegram:` prefixes. An optional `:topic:<numeric-id>` is accepted.
Conflicting parsed group ids do not apply the gate. Unsupported/opaque session ids can fall back
to a supported conversation id. All topics share the existing group-wide window.

`@research_fixture_bot` or a recognized reply to the bot opens or renews a 30-minute window and makes
that sender the activator. Mentions use complete case-insensitive handles: longer names such as
`@research_fixture_bot_extra` do not wake the bot, and embedded email handles such as
`alice@example.com` are ignored. Explicit wake-ups take precedence over the filters below.

During an active window:

- The activator's normal messages, including media-only messages, pass and extend the window.
- The activator's short acknowledgements (`ok`, `收到`, `👍`, etc.) are blocked without extending it.
- Other members' messages, including media-only messages **and acknowledgements**, pass without
  extending the window (`ALLOW_OTHER`).
- Replies to other people and mentions of other handles are blocked for every member.
- After the window expires, ordinary messages are blocked until another explicit wake-up.

Replies require a reply id and a recognized sender label: the exact bot username (with or without
`@`), the exact legacy label `Telegram Active Window`, or OpenClaw's `<display name> (you)` label
(for example, `C (you)`). Substring matches inside other display names are not accepted. The
available hook fields do not provide a verified reply-author bot id; label matching is a
compatibility heuristic and must not be used as identity verification.

State persists in `~/.openclaw/plugin-state/telegram-active-window.json`; missing/corrupt files
start asleep, and entries with non-finite timestamps are ignored. Persistence failure logs an
error and retains in-memory state for the current process. Unexpected dispatch exceptions
**fail open**, preserving the previous behavior. This is a conversation gate, not an authorization,
private-data isolation, or investment-risk boundary; those controls belong outside the plugin.

Decision logic lives in `src/gate.ts`, persistence in `src/state.ts`, SDK-free hook registration in
`src/register.ts`, and the OpenClaw SDK entry in `src/index.ts`.

## Build and offline tests

```sh
npm run build   # tsc only
npm test        # rebuilds via pretest, then runs all test/*.test.mjs
```

Tests import the compiled code and use temporary state files or mocks. They do not contact
Telegram, send messages, start services, or read the live state file. Hook integration tests run
the registered production handler with a mocked API and clock. TypeScript compilation checks
the SDK entry against the installed development dependency; it is not a live gateway validation.

## Deployment

This checkout is an isolated development copy. Do not copy it over a live plugin or restart the
gateway as part of a build/test command. Review the source/artifact diff, verify the gateway and
SDK versions, preserve the existing plugin and state, and obtain approval for the production
switch. Keep a restoration plan before applying a reviewed release.

`openclaw plugins build` / `validate` are not used: they only apply to tool/feature plugins with
static authoring metadata, which this hook plugin does not have.
