# MCP listener lifetime regression

An OpenClaw 2026.9.4 loopback MCP listener can inherit the temporary
`AsyncWorkScope` and gateway root admission of the first native CLI turn that
starts it. The listener is process owned; its triggering turn is not. After that
turn drains, later HTTP tool calls can enter the closed scope. Plugin callbacks
with a cancellation signal fail in `runWithTrackedCancellation` before the
plugin body runs, reporting `Async work scope is closed`. Rebuilding the tool
cache does not repair the inherited asynchronous context.

The bounded compatibility patch adds `runOutsideAsyncWorkScope` and calls it,
together with the existing `runOutsideGatewayRootWorkAdmission`, only around
creation of the process-owned MCP server. Existing scopes still reject work
after closure. Per-request authentication, grant revocation, plugin registry
authority, cancellation signals, and server close behavior remain in their
existing paths. The patch neither retries a failed tool write nor grants new
permissions.

The patch generator checks the exact reviewed source hashes and unique anchors.
It refuses unknown versions or already-patched input. Do not apply it blindly
after an OpenClaw upgrade. Production deployment requires a separately reviewed
backup and rollback procedure; the generator itself only returns candidate
source and hashes, with no file writes or service operations.

The opt-in regression uses `OPENCLAW_ASYNC_WORK_SOURCE_DIR` for a directory
containing the reviewed unmodified runtime modules, or `OPENCLAW_RUNTIME_ROOT`
for an unpatched installation with those exact source hashes. After deployment,
use the retained pre-patch snapshot: the test intentionally needs both the old
failure and the generated fix, and rejects already-patched source. Run:

```bash
OPENCLAW_ASYNC_WORK_SOURCE_DIR=/path/to/pre-patch-dist node test/runtime-async-work.test.mjs
```

It exercises actual extracted lifecycle functions using
synthetic asynchronous resources. It does not start another gateway, create
production grants, call a model, send Telegram messages, or use production
research records. Real collaborator inbound acceptance remains a separate check.
