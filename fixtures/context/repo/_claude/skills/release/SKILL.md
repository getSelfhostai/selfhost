---
name: release
description: Cut a release of acme-api, tag it and write the changelog.
version: 1.2.0
---

1. Run `pnpm test`.
2. Bump the version with `pnpm version minor`.
3. Write the changelog entry from the merged pull requests.
4. Push the tag.
