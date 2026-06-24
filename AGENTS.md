# Project Agent Instructions

Use relevant Codex Skills from `.codex/skills/` when they match the task.

Default behavior:
- Prefer small, reviewable diffs.
- Preserve existing architecture and naming conventions.
- Do not add dependencies unless clearly necessary.
- Do not create new files unless they are required.
- Avoid unrelated refactors and cleanup.
- Inspect existing code before editing.
- Explain changed files after work.
- Include practical verification steps when possible.

When working:
1. Identify the likely files to touch.
2. Make the smallest safe change.
3. Preserve current project style.
4. Summarize what changed, why, and how to verify.
