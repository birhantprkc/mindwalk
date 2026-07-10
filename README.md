# mindwalk

mindwalk renders Claude Code and Codex tool-calling sessions on top of a deterministic 3D code city. The first version is a local Go binary with a Vite/React/Three.js UI.

## What works in v1

- `mindwalk serve`: scans `~/.claude/projects` and `~/.codex/sessions`, serves the local UI, and opens a browser. Pass `--no-open` for headless verification.
- `mindwalk open <session.jsonl>`: opens a specific Claude Code or Codex session; it also accepts `--no-open`.
- `mindwalk build <repo> [-o citymap.json]`: builds a deterministic repository citymap.
- `mindwalk trace <session.jsonl> [-o trace.json]`: parses a Claude Code or Codex JSONL session into normalized events.
- Web UI: session list, 3D city, final touch-state coloring, timeline playback, recent transition edges, stats, and file visit history.

## Local development

```sh
make setup
make test
make serve
```

The Go server serves `web/dist` from the working tree when it exists, then falls back to a tiny embedded placeholder. Run `make web` before `mindwalk serve` during development.

## Current limits

- Claude Code and Codex main-chain sessions are supported first; Claude sidechain expansion is still future work.
- The city layout is deterministic slice treemap v1, not the full squarified treemap described in the design note.
- Session/repo commit alignment currently uses the live worktree and records the current commit; `git ls-tree` at the session commit is not implemented yet.
- Cache is in-memory for trace/citymap requests. Persistent `~/.cache/mindwalk` storage remains a v1 follow-up.
