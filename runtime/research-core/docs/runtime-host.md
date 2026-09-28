# Research runtime host and local CLI

This release adds a callable host facade and a local maintenance entry point.
It does not start a daemon, connect to a model or broker, enable Telegram delivery,
or change the running gateway. The model-facing OpenClaw bridge is a separate,
default-disabled candidate plugin. Its current native-CLI compatibility findings
must be resolved before claiming that this host is reachable from live chats.

## Host API

`createResearchHost({directory,agentId,environment,actorId,mode:'agent'})` opens
the journal, research, queue and workflow stores in one fixed trusted scope.
`execute(command,request)` synchronously delegates to a bounded operation;
`close()` closes the owned handles. `mode`, scope and actor are host constructor
options, never fields accepted from a model request.

Agent mode exposes exactly `task-submit`, `task-get`, `task-list`, `task-propose`.
These retain source bytes/text and candidate analysis. They do not verify their
own evidence, certify an actual model, resolve a forecast, change a strategy,
or authorize an order. See workflow.md for input schemas and recovery states.
References supplied for thesis/skill/strategy are claimed context until a
trusted host verifies them against the actual artifacts; names alone are not
proof those versions exist.

`mode:'operator-test'` is a local synthetic acceptance path available only in
`environment:'test'`. It additionally exposes evidence-get/verify/freeze,
task-commit/reconcile, review-create, prediction-resolve, review-receipt and
journal-get/list/statistics. Commit/freeze requires `provider:'fixture'` rather
than accepting a selected real model name as an authenticated receipt. Early
resolution authority is enabled only in this synthetic operator fixture.
Reconciliation also rejects an existing non-fixture commit intent. Reviews and
resolutions require fixture provenance on both the target and frozen evidence;
the operator cannot use recovery to bypass that restriction.

This test operator is not human identity verification. The CLI trusts the OS
caller; a model with unrestricted shell access under the same UID could run it
or read owned databases. The API does not establish a strong boundary against
that OS identity. Real owner approvals and trading controls must be implemented
in an independently protected host; this facade provides neither.

## CLI

```sh
node research-core/src/runtime-cli.mjs task-list \
  --state /absolute/new-private-state --agent main --environment test <<'JSON'
{"limit":20,"offset":0}
JSON
```

Request JSON is bounded to 256 KiB; scope comes from command-line options.
The four model-facing task operations return at most 400 KiB, leaving room for
the bridge envelope. Oversized accumulated task views return `projection:'summary'`
without changing stored evidence or turning a successful write into an error.
Retrieve a full item with `task-get` using `{taskId,detail,itemId}`: `detail` is
`proposal`, `evidence` or `source`; source items use their `evidenceId`.
`{taskId,detail:'publication'}` retrieves the publication without an itemId.
A shortened list page includes `returned` and `nextOffset`. Local operator
results can be larger; they are not exported by model tools. All responses
contain private research records, so direct them only to authorized local
recipients. Errors use fixed codes rather than
echoing raw input or diagnostics. Unknown fields do not grant extra authority.
The CLI starts no listener and never reads production credentials.

Run the complete synthetic acceptance scenario with:

```sh
npm run demo:runtime
```

It retains a source, makes a pending forecast proposal, confirms an attempted
unverified commit is blocked, verifies synthetic evidence, records the forecast,
records later evidence, settles the defined outcome and appends a retrospective.
Every stage reopens its handles, preserving history and original probability.
The CLI test repeats the scenario through separate Node processes, including
idempotent retries. One settled forecast still reports insufficient calibration
samples; a correct forecast does not establish profitability. No external
model call, Telegram message, security trade or strategy update occurs.

The outcome-evidence submission remains a research candidate if no independent
decision is proposed for it; it is not automatically marked as a completed
investment task merely because its evidence supported someone else's review.

## Production gap

The current OpenClaw Claude loopback path must supply authenticated private
conversation and sender fields before the strict bridge may expose tools.
Requested `activeModel` and runtime-selected provider/model metadata are not an
actual provider receipt. Neither a configuration patch nor passing these local
tests proves native end-to-end access, billing verification or investment
readiness. Do not bypass missing context by relaxing the owner/private checks.
