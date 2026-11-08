#!/bin/sh
# Pull requests merged since the last tag, one per line.
set -eu
last=$(git describe --tags --abbrev=0)
git log --merges --format='%s' "$last"..HEAD
