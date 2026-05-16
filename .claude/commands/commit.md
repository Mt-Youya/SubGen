Run `git diff --stat HEAD` and `git diff HEAD | grep "^[+-]" | grep -v "^---\|^+++"` to understand what changed.

Generate a short English commit message following these rules:
- Format: `<type>: <short description>`
- Types: feat / fix / chore / refactor / ci / docs
- Max 72 characters
- No period at the end
- Focus on WHY or WHAT changed, not HOW

Print ONLY the commit message, nothing else. Do not commit.
