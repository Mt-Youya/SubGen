Before generating the commit message, perform these checks in order:

## 1. Verify local build (macOS only — Windows/Linux verified via CI)
Run `pnpm build:next` inside `packages/desktop` to confirm Next.js + TypeScript compiles with no errors. If it fails, stop and fix first.

## 2. Check last CI run covers all three platforms
Run `gh run list --workflow=build-desktop.yml --limit=5` to find the most recent completed run.
Then run `gh run view <run-id> --json jobs -q '.jobs[] | "\(.name): \(.conclusion)"'` to check each job.
- If the latest run has jobs for `linux-x64`, `macos`, and `windows-x64` all with conclusion `success` — proceed.
- If any job failed or the run is too old (before current changes) — warn the user and ask whether to proceed anyway. Do NOT block the commit silently.
- If no run exists yet — note it and proceed.

## 3. Verify GitHub Actions workflow sanity
Read `.github/workflows/build-desktop.yml` and confirm:
- macOS: dylib copy uses `brew --cellar` / `brew --prefix`, not `otool` rpath or version wildcards
- Windows: dll copy uses `*.dll` wildcard, not hardcoded filenames
- Linux: whisper.cpp clone uses a pinned release tag, not bare `--depth=1` on HEAD
- All three platforms install dependencies before the `Build desktop` step

If any issue is found, fix it before proceeding.

## 4. Generate commit message
Run `git diff --stat HEAD` and `git diff HEAD | grep "^[+-]" | grep -v "^---\|^+++"` to understand what changed.

Generate a short English commit message following these rules:
- Format: `<type>: <short description>`
- Types: feat / fix / chore / refactor / ci / docs
- Max 72 characters
- No period at the end
- Focus on WHY or WHAT changed, not HOW

Print ONLY the commit message, nothing else. Do not commit.

## 5. Suggest next release tags
Run `git ls-remote --tags origin` to list all remote tags.

For each prefix, find the highest existing version and increment the patch number:
- `desktop-v*` → e.g. latest is `desktop-v0.1.9` → suggest `desktop-v0.1.10`
- `extractor-v*` → e.g. latest is `extractor-v0.2.1` → suggest `extractor-v0.2.2`

If no tag exists for a prefix yet, suggest `desktop-v0.1.0` / `extractor-v0.1.0`.

Print the suggestions in this format:
```
Next tags (when ready to release):
  desktop:   git tag desktop-v0.1.10 && git push origin desktop-v0.1.10
  extractor: git tag extractor-v0.2.2 && git push origin extractor-v0.2.2
```
