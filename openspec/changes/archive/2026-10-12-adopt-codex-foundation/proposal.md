# Adopt the codex-lb foundation

## Why

The user requires the original codex-lb stack, build system and functional foundation, rather than a smaller TypeScript gateway. The current independent implementation does not preserve the upstream control plane. The user also requires the Dither Kit visual language.

## What Changes

- Import the pinned upstream source, tests, specifications and build tooling with its MIT notice.
- Replace the Node/Fastify runtime with the original Python/FastAPI/SQLAlchemy runtime and React frontend, managed by uv and Bun.
- Preserve upstream management capabilities and existing Gemini native protocol behavior while introducing Gemini-specific credentials and transports.
- Apply Dither Kit to the retained operator workflows without removing their forms, permissions or data.
- Inventory provider-specific exclusions before removing code. Treat approximately 500,000 lines as a scale preference, not a reason to delete necessary tests.

## Impact

This replaces the runtime and package layout. Legacy data must not be opened as the upstream database. No production data migration, deployment or account calls are authorized by this change.
