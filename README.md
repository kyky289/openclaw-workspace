# OpenClaw Research Workspace

A modular OpenClaw workspace for AI-assisted research, thesis tracking, monitoring, and structured knowledge management.

## What's Included

- Modular Research Brain
- Thesis Monitoring
- Research templates
- Persistent thesis files
- OpenClaw agent configuration
- Git-based version control

## Repository Structure

- `AGENTS.md` — agent behavior and routing instructions
- `memory/` — research and thesis knowledge
- `stable-skills/research-brain/` — research workflow skill
- `stable-skills/thesis-monitoring/` — thesis monitoring skill

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
