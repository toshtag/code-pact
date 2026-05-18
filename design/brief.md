# Project Brief

## What we're building

code-pact is a CLI tool that structures software projects for AI agent execution.
It stores phases and tasks in version-controlled YAML files so that coding agents
(Claude Code, Codex, Cursor, Gemini CLI) receive precisely the right context — no more,
no less — and can record task completion in a machine-readable way.

## Who it's for

Teams and solo developers who use AI coding agents as primary implementors, not just
assistants. The intended user runs `code-pact task context <id>` in an agent session
instead of pasting requirements by hand every time.

## What makes it different

code-pact sits *below* the AI — it is not an orchestrator or API wrapper.
It is a convention for storing *what to build* and *how to verify it* inside the repo,
readable by any agent and auditable by any human.
The core schema is vendor-neutral; adapter files (CLAUDE.md, AGENTS.md, etc.)
are generated per-agent and opt-in.

---

*This file was created with `code-pact plan brief`. Update it as the project evolves.*
