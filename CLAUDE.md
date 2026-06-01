# CLAUDE.md — Porto Tools

Project context and rules for Claude Code working on this repository.
This file is committed to git and read by Claude Code automatically at the
start of every session. Update it when project conventions change.

## Project overview

Porto Tools is a privacy-first, agent-native file converter. The
architecture is unusual: the conversion engine runs **entirely in the
user's browser** via WebAssembly. No files ever leave the user's device.
This is the central product promise and constrains many technical
decisions throughout the codebase.

Three surfaces share the same engine:
- **Website** (porto.tools) — public consumer-facing tool, ad-supported
- **MCP server** — exposes the engine for AI agents via Model Context Protocol
- **n8n community node** — exposes the engine for n8n workflow automation users

## Stack (high level)

- **Hosting:** Cloudflare (Pages + Workers + R2)
- **Frontend framework:** Next.js + Tailwind CSS
- **Engine:** WebAssembly, lazy-loaded per conversion type
- **CI/CD:** GitHub Actions (deploys to Cloudflare, publishes to npm)
- **Analytics:** Cloudflare Web Analytics + Google Search Console (no GA4)
- **Consent management:** Klaro

## Security rules (non-negotiable)

1. **Never commit secrets to the repository.** This includes `.env` files,
   API tokens, private keys, deploy credentials, or anything that grants
   authorization. Verify `.gitignore` covers `.env*` before any commits.

2. **No secrets in frontend code.** Anything in the browser-side bundle is
   publicly inspectable via View Source. The conversion engine, UI code,
   and conversion logic are fine to be public. API tokens, deploy keys,
   and database credentials are NOT.

3. **All deploy/publish credentials live as GitHub Actions secrets.**
   Cloudflare deploy tokens, npm publish tokens, etc. are accessed only by
   CI workflows via `${{ secrets.NAME }}` syntax.

4. **Public identifiers are fine in public code.** AdSense Publisher ID,
   analytics tracking IDs, etc. identify accounts but do not grant access.

5. **If unsure whether something is a secret, treat it as one.** Ask the
   user before committing anything that looks credential-shaped.

## Code quality expectations

- Simple, readable architecture over clever abstractions.
- Comments explain **why**, not **what** the code does.
- Tests alongside features. Do not ship untested code paths.
- Keep `README.md` and `ARCHITECTURE.md` updated as structure evolves.
- Major decisions get a short note in `docs/decisions/` explaining why X
   over Y. One markdown file per decision, dated.

## Commit conventions

- Use Conventional Commits format: `feat:`, `fix:`, `docs:`, `chore:`,
   `refactor:`, `test:`, `perf:`, `style:`.
- Small, focused commits — one logical change per commit.
- The commit body explains the change in plain language if the title is
   not self-explanatory.

## PR workflow

- Even for solo work, create PRs for feature work instead of pushing
   directly to `main`. PRs serve as review checkpoints.
- PR descriptions briefly explain what changed and why.
- Self-review the diff before merging.

## What to avoid

- Over-engineering. Build the simplest thing that solves the problem.
- Hidden complexity. If code does something non-obvious, comment it.
- Skipping tests "for now."
- Hardcoding values that should be configurable.
- Adding dependencies casually. Each dependency is a maintenance liability
   and a potential security surface.

## Reference documents (kept private, not committed)

These live locally on the project owner's machine and in the `website`
private repo. Ask for context from them when needed:

- `PRD.md` — full product requirements
- `CONVERSIONS-V1.md` — locked v1 conversion shortlist (27 conversions, 15 rows)
- `PRD-GAPS.md` — known gaps to address before/during build
- `PROGRESS.md` — live project status

## Repository-specific notes

(This section will be expanded per-repo when actual work begins on each.)
