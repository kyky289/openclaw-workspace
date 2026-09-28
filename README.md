# OpenClaw Research Workspace

A modular OpenClaw workspace for AI-assisted research, thesis tracking, monitoring, and structured knowledge management.

## What's Included

- Modular Research Brain
- Thesis Monitoring
- Research templates
- Persistent thesis files
- OpenClaw agent configuration
- Git-based version control

## 2026-09-28 development code and review

Today's research runtime, execution receipts, model routing/budget foundations,
media interfaces and tests are in [`runtime/`](runtime/README.md).
The existing skills and thesis history remain in their original locations.

For a first review, use Linux or WSL and Node.js 24 or later:

```sh
cd runtime
npm test
npm run check
npm run demo:runtime
```

These commands use synthetic local data. They require no model, Telegram or
broker credentials and do not start an OpenClaw gateway. The core has no npm
dependencies, so `npm install` is unnecessary for this offline review path.

See the [Chinese quick start and architecture](runtime/README.md) for what is
implemented, what is still incomplete, optional SDK tests, and review priorities.
The repository is not a turnkey autonomous trading product: market feeds,
broker execution and the full investment risk/account reconciliation loop
remain unfinished.

Operational backups, personal memory, runtime databases, deployment receipts
and machine-specific deployment scripts are not part of this code update.
Example identity values are placeholders; configure your own environment only
when you intentionally test an integration.

## Repository Structure

- `AGENTS.md` — agent behavior and routing instructions
- `memory/` — research and thesis knowledge
- `stable-skills/research-brain/` — research workflow skill
- `stable-skills/thesis-monitoring/` — thesis monitoring skill
- `runtime/research-core/` — evidence, workflow, journal, review, routing and budget libraries
- `runtime/openclaw-research-bridge/` — scoped OpenClaw research tools and execution receipts
- `runtime/telegram-active-window/` — candidate message gate, with synthetic identity fixtures
- `runtime/ops/` — offline test entry, local bundle build and generic audit/plan helpers

## Requirements

This repository contains the workspace layer, not the OpenClaw runtime itself.

You need your own:

- OpenClaw installation
- LLM/API access
- API credentials
- Server or local environment

Private credentials and runtime state are intentionally excluded from this repository.

## Security

Do not commit API keys, tokens, credentials, `.env` files, private memory, or runtime state.

Each user should configure their own credentials locally.

## Status

Research Brain and Thesis Monitoring modularization completed and tested.
