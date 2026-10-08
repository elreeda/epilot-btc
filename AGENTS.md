# Agent guide

Portable entry point for coding agents working on this repo.

## Skills

Agent Skills live in [`.agents/skills/`](.agents/skills/) (standard layout discovered by Cursor, Codex, and similar tools). Claude Code also resolves the same skills via relative symlinks under [`.claude/skills/`](.claude/skills/).

| Skill | Purpose |
| --- | --- |
| [`settlement-fairness`](.agents/skills/settlement-fairness/SKILL.md) | Server-owned prices, feed/reconnect, round lifecycle; no client-trusted resolve |
| [`btc-guess-change`](.agents/skills/btc-guess-change/SKILL.md) | Safe API/domain/UI/test touch points and verify-before-done |
| [`verify-btc-guess`](.agents/skills/verify-btc-guess/SKILL.md) | Unit/integration/e2e commands and evidence |

Frontmatter is limited to standard `name` + `description`.

## Verify gate

Before claiming a change is done:

```sh
pnpm verify
```

See [`scripts/verify.sh`](scripts/verify.sh) and the `verify-btc-guess` skill. Optional: `pnpm verify -- --integration --e2e`.

## Humans

Setup and deployment: [README](README.md). Product, architecture, and change guidance for humans and agents: [project guide](docs/PROJECT_GUIDE.md).
