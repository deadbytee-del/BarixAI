# Self-edit mode

`BarixTerm.bat self` (or `barixterm self`) lets Barix work on **its own repository** unattended for up to 24 hours (`--hours N`, max 168).

```
BarixTerm.bat self --hours 24                  # type "start" to confirm
BarixTerm.bat self --goal "speed up retrieval"  # focus the run on one goal
BarixTerm.bat self --resume                     # continue a stopped run
```

Needs Git, and ideally a local model server (Ollama / llama.cpp): the built-in CPU model is slow. Set `GITHUB_TOKEN` (or `gh auth login`) to let it push its branch and keep a draft PR; without a token it only commits locally. If the launcher is not in a repo checkout, it clones Barix to `~/.barix/self-edit/BarixAI`.

## Loop

1. Run the test suite. Pick a task: your `--goal`, else fix failing tests, else a TODO/FIXME, else a rotating improvement area.
2. The agent edits the working copy (read/edit/run-tests tools only; it cannot commit or push).
3. Fences are applied to the diff: protected files are reverted, deleting tests is refused, the diff must stay small (≤ 20 files, ≤ 800 lines).
4. The full test suite runs again. Pass → the supervisor commits. Fail → hard rollback, and the reason is fed into later prompts.
5. Every few commits it pushes `barix/self-edit-<timestamp>` and keeps **one draft PR** up to date. Failures back off exponentially (up to 30 min) so a bad streak never burns CPU.

## Safety guarantees (enforced in `apps/term/src/self-edit.js`, which is itself protected)

- Never works on or pushes to `main`/`master`; never merges; PRs are always drafts; no force-push.
- Cannot change: `self-edit.js`, the command policy, `.github/`, `.gitignore`, `package-lock.json`, launchers, `LICENSE`, `scripts/publish-site.mjs`, secrets/keys. Such edits are reverted and counted.
- Commands run through the normal BarixTerm command policy; unfamiliar commands are denied (no one is there to approve them).
- Stop with Ctrl-C or by creating `.barix/self/STOP`. State is in `.barix/self/state.json`, the event log in `log.jsonl`, the summary in `REPORT.md`.

## Honest limits

A passing test suite is the only quality gate, so the changes are only as good as the tests and the model: review the draft PR before merging. Barix with a small model will often fail cycles and roll back; that is the design working. The logic is tested against a real git repository with a scripted agent; a full 24-hour run with a real model has not been run.
