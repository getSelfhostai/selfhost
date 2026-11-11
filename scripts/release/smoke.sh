#!/bin/sh
# Installs a packed selfhostai tarball the ways people install it, each in a clean folder with an
# empty HOME, and runs it: `npx selfhostai` (npm exec of the package), a project install, and
# `npm install -g`. Needs only Node and npm; dependencies come from the npm registry.
#
# Usage: sh scripts/release/smoke.sh <selfhostai-x.y.z.tgz> [expected version]
set -eu

[ $# -ge 1 ] || {
  echo "usage: $0 <tarball> [expected version]" >&2
  exit 2
}
tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
expected="${2:-}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Nothing from the machine running the check: an empty HOME, its own npm cache and config, and
# no agent config folders pointed at elsewhere.
export HOME="$work/home"
export npm_config_cache="$work/npm-cache"
export npm_config_userconfig="$work/npmrc"
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
unset CLAUDE_CONFIG_DIR CODEX_HOME XDG_CONFIG_HOME XDG_DATA_HOME SELFHOST_HOME 2>/dev/null || true
mkdir -p "$HOME"
: >"$npm_config_userconfig"

say() { echo "smoke: $*"; }
fail() {
  echo "smoke: $*" >&2
  exit 1
}

check_version() {
  got="$("$@" --version)"
  say "$* --version: $got"
  [ -z "$expected" ] || [ "$got" = "$expected" ] || fail "expected $expected, got $got"
}

check_doctor() {
  out="$work/doctor.json"
  "$@" doctor --json >"$out" || fail "$* doctor --json exited $?: $(cat "$out")"
  # shellcheck disable=SC2016 # JavaScript, not shell
  node -e '
    const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (typeof report !== "object" || report === null) throw new Error("doctor printed no object");
    if (process.argv[2] && report.version !== process.argv[2]) {
      throw new Error(`doctor reports version ${report.version}`);
    }
    console.log(`smoke: doctor --json: ${report.schema}, version ${report.version}`);
  ' "$out" "$expected" || fail "$* doctor --json: $(cat "$out")"
}

say "node $(node --version), npm $(npm --version)"

# npx selfhostai: npm exec installs the package into its cache and runs the bin named after it.
mkdir "$work/npx" && cd "$work/npx"
check_version npm exec --yes --package="$tarball" -- selfhostai
check_doctor npm exec --yes --package="$tarball" -- selfhostai

# A project install, then npx from the project.
mkdir "$work/project" && cd "$work/project"
npm init -y >/dev/null
npm install --no-save "$tarball" >/dev/null
# Nothing in the published package.json may point at the workspace: on npm, @selfhost/* names
# and workspace: or catalog: specs would resolve to whatever the public registry holds.
node -e '
  const pkg = require(process.argv[1]);
  const fields = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
  const bad = fields.flatMap((field) =>
    Object.entries(pkg[field] ?? {})
      .filter(([name, spec]) => name.startsWith("@selfhost/") || /^(workspace|catalog|link|file):/.test(spec))
      .map(([name, spec]) => field + " " + name + "@" + spec),
  );
  if (bad.length > 0) throw new Error("workspace dependencies in package.json: " + bad.join(", "));
  console.log("smoke: package.json has " + Object.keys(pkg.dependencies ?? {}).length + " npm dependencies, none from the workspace");
' "$work/project/node_modules/selfhostai/package.json" || fail "the published package.json names workspace packages"
check_version npx --no-install selfhostai
check_doctor npx --no-install selfhost

# npm install -g, into a prefix of its own.
npm install -g --prefix "$work/global" "$tarball" >/dev/null
check_version "$work/global/bin/selfhostai"
check_version "$work/global/bin/selfhost"
check_doctor "$work/global/bin/selfhost"
"$work/global/bin/selfhost" policy --help >/dev/null
# The embedded ledger: PGlite loads its wasm and data files from the installed package.
"$work/global/bin/selfhost" spend --data-dir "$work/ledger" --since 2026-01-01 --json >"$work/spend.json"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$work/spend.json" ||
  fail "selfhost spend --json did not print JSON"
say "spend --json on an empty embedded ledger: ok"

say "ok"
