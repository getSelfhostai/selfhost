---
name: release-notes
description: Drafts release notes from the merged pull requests since the last tag. Use when asked for a changelog or release notes.
version: 1.2.0
license: Apache-2.0
---

# Release notes

1. Run `scripts/collect.sh` to list the pull requests merged since the last tag.
2. Group them by the sections in `references/template.md`.
3. Write one line per change, in the past tense, with the pull request number.
