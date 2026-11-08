import { describe, expect, it } from "vitest";
import { type Install, moduleCandidates, parseInstalls } from "../src/index.js";

/** Each install as `manager: name@spec ...`, skipped arguments in brackets. */
function summary(command: string, env: Record<string, string> = {}): string[] {
  return parseInstalls(command, env).map((install: Install) => {
    const packages = install.packages.map((p) => (p.spec ? `${p.name}@${p.spec}` : p.name));
    const skipped = install.skipped.map((s) => `[${s.arg}]`);
    return `${install.manager}: ${[...packages, ...skipped].join(" ")}`;
  });
}

describe("parseInstalls: npm, pnpm, yarn and bun", () => {
  it.each([
    ["npm install left-pad", ["npm: left-pad"]],
    ["npm i -D vitest@^4 @types/node@20.19.43", ["npm: vitest@^4 @types/node@20.19.43"]],
    ["npm isntall left-pad", ["npm: left-pad"]],
    ["npm add --save-exact zod@latest", ["npm: zod@latest"]],
    ["npm -w web i react", ["npm: react"]],
    ["npm --prefix web install react", ["npm: react"]],
    ["npm i lp@npm:left-pad@1.3.0", ["npm: left-pad@1.3.0"]],
    ["pnpm add zod -w", ["pnpm: zod"]],
    ["pnpm --filter web add zod", ["pnpm: zod"]],
    ["pnpm -C packages/api add hono", ["pnpm: hono"]],
    ["yarn add lodash", ["yarn: lodash"]],
    ["yarn workspace web add lodash", ["yarn: lodash"]],
    ["yarn global add serve", ["yarn: serve"]],
    ["bun add elysia", ["bun: elysia"]],
    ["bun i -d @biomejs/biome", ["bun: @biomejs/biome"]],
  ])("reads %s", (command, expected) => {
    expect(summary(command)).toEqual(expected);
  });

  it("checks only the package a run command runs, not its arguments", () => {
    expect(summary("npx -y create-next-app@latest my-app --ts")).toEqual([
      "npx: create-next-app@latest",
    ]);
    expect(summary("npx eslint --fix .")).toEqual(["npx: eslint"]);
    expect(summary("npm exec -- prettier --write .")).toEqual(["npm: prettier"]);
    expect(summary("pnpm dlx shadcn@latest init")).toEqual(["pnpm: shadcn@latest"]);
    expect(summary("pnpx degit user/repo app")).toEqual(["pnpx: degit"]);
    expect(summary("bunx cowsay hi")).toEqual(["bunx: cowsay"]);
    expect(summary("bun x cowsay hi")).toEqual(["bun: cowsay"]);
    expect(summary("yarn dlx cowsay hi")).toEqual(["yarn: cowsay"]);
  });

  it("checks --package instead of the command it names", () => {
    expect(summary("npx -p typescript tsc --init")).toEqual(["npx: typescript"]);
    expect(summary("npx --package=@angular/cli ng new app")).toEqual(["npx: @angular/cli"]);
  });

  it("maps initializers to their create- package", () => {
    expect(summary("npm create vite@latest my-app -- --template react")).toEqual([
      "npm: create-vite@latest",
    ]);
    expect(summary("npm init react-app my-app")).toEqual(["npm: create-react-app"]);
    expect(summary("npm init @acme/tool")).toEqual(["npm: @acme/create-tool"]);
    expect(summary("pnpm create astro")).toEqual(["pnpm: create-astro"]);
    expect(summary("yarn create next-app")).toEqual(["yarn: create-next-app"]);
    expect(summary("npm init -y")).toEqual([]);
  });

  it("skips git, GitHub, URL, folder, tarball and workspace specs and says why", () => {
    const [install] = parseInstalls(
      "npm i github:acme/tool user/repo git+https://git.example.com/x.git https://cdn.example.com/x.tgz ./local file:../y x.tgz workspace:* $PKG",
    );
    expect(install?.packages).toEqual([]);
    expect(install?.skipped).toEqual([
      {
        arg: "github:acme/tool",
        reason: "installs from a git repository, not the registry",
        host: "github.com",
      },
      {
        arg: "user/repo",
        reason: "installs from GitHub (user/repo), not the registry",
        host: "github.com",
      },
      {
        arg: "git+https://git.example.com/x.git",
        reason: "installs from a git repository, not the registry",
        host: "git.example.com",
      },
      {
        arg: "https://cdn.example.com/x.tgz",
        reason: "installs a tarball from a URL",
        host: "cdn.example.com",
      },
      { arg: "./local", reason: "installs a local folder, tarball or workspace package" },
      { arg: "file:../y", reason: "installs a local folder, tarball or workspace package" },
      { arg: "x.tgz", reason: "installs a local folder, tarball or workspace package" },
      { arg: "workspace:*", reason: "installs a local folder, tarball or workspace package" },
      {
        arg: "$PKG",
        reason:
          "a shell variable or command substitution, so the package is not known before the command runs",
      },
    ]);
  });

  it("ignores commands that install nothing new", () => {
    for (const command of [
      "npm ci",
      "npm install",
      "pnpm install",
      "npm run build",
      "yarn",
      "npm test",
    ]) {
      expect(summary(command)).toEqual([]);
    }
  });

  it("collects --registry, scoped registries and registry variables", () => {
    const [install] = parseInstalls(
      "npm_config_registry=https://env.example.com npm i x --registry https://r.example.com --@acme:registry=https://acme.example.com",
    );
    expect(install?.registries).toEqual([
      "https://r.example.com",
      "https://acme.example.com",
      "https://env.example.com",
    ]);
  });
});

describe("parseInstalls: pip, uv, poetry and pipx", () => {
  it.each([
    ["pip install requests", ["pip: requests"]],
    ["pip3 install --user 'requests[socks]>=2.31,<3'", ["pip3: requests@>=2.31,<3"]],
    ["pip3.12 install Flask==3.0.0", ["pip3.12: flask@==3.0.0"]],
    ["python -m pip install -U pip setuptools", ["python: pip setuptools"]],
    ["python3 -I -m pip install python_dateutil", ["python3: python-dateutil"]],
    ["uv pip install ruff", ["uv: ruff"]],
    ["uv add httpx 'pydantic>=2'", ["uv: httpx pydantic@>=2"]],
    ["uv add --dev pytest", ["uv: pytest"]],
    ["uv tool install ruff", ["uv: ruff"]],
    ["uvx ruff@0.6.0 check .", ["uvx: ruff@==0.6.0"]],
    ["uvx --from 'black==24.1' black .", ["uvx: black@==24.1"]],
    ["uv tool run --with rich pycowsay hi", ["uv: rich pycowsay"]],
    ["uv run --with rich python script.py", ["uv: rich"]],
    [
      "poetry add pendulum@^2.0.5 requests@latest httpx==0.27.0",
      ["poetry: pendulum@^2.0.5 requests httpx@==0.27.0"],
    ],
    ["poetry add --group dev pytest", ["poetry: pytest"]],
    ["pipx install black", ["pipx: black"]],
    ["pipx run cowsay hi", ["pipx: cowsay"]],
    ["pipx run --spec black==24.1 black .", ["pipx: black@==24.1"]],
    ["pipx inject myenv requests", ["pipx: requests"]],
  ])("reads %s", (command, expected) => {
    expect(summary(command)).toEqual(expected);
  });

  it("skips requirement files, editable installs, URLs, VCS and local files and says why", () => {
    const [install] = parseInstalls(
      "pip install -r requirements.txt -e . git+https://github.com/acme/x.git ./dist/x-1.0-py3-none-any.whl 'x @ https://files.example.com/x.whl'",
    );
    expect(install?.packages).toEqual([]);
    expect(install?.skipped.map((s) => [s.arg, s.reason, s.host])).toEqual([
      ["requirements.txt", "lists packages in a file, which the guard does not read", undefined],
      [".", "is an editable install of a local folder or repository", undefined],
      [
        "git+https://github.com/acme/x.git",
        "installs from a version control repository, not the index",
        "github.com",
      ],
      ["./dist/x-1.0-py3-none-any.whl", "installs a local file or folder", undefined],
      [
        "x @ https://files.example.com/x.whl",
        "is a direct reference to a URL or file",
        "files.example.com",
      ],
    ]);
  });

  it("collects index options, uv's name=url form and index variables", () => {
    const [install] = parseInstalls(
      "PIP_EXTRA_INDEX_URL='https://a.example.com https://b.example.com' pip install x -i https://pypi.example.com/simple --extra-index-url=https://extra.example.com",
    );
    expect(install?.registries).toEqual([
      "https://pypi.example.com/simple",
      "https://extra.example.com",
      "https://a.example.com",
      "https://b.example.com",
    ]);
    const [uv] = parseInstalls("uv add torch --index pytorch=https://download.pytorch.org/whl/cpu");
    expect(uv?.registries).toEqual(["https://download.pytorch.org/whl/cpu"]);
    const [poetry] = parseInstalls("poetry add internal-lib --source acme");
    expect(poetry?.registries).toEqual(["acme"]);
  });
});

describe("parseInstalls: cargo", () => {
  it.each([
    ["cargo add serde", ["cargo: serde"]],
    ["cargo add serde serde_json@1.0 --features derive", ["cargo: serde serde_json@1.0"]],
    ["cargo add -F full tokio", ["cargo: tokio"]],
    ["cargo install ripgrep", ["cargo: ripgrep"]],
    ["cargo install ripgrep --version 14.1.0", ["cargo: ripgrep@=14.1.0"]],
    ["cargo install ripgrep@14.1.0", ["cargo: ripgrep@=14.1.0"]],
    ["cargo install ripgrep --version '~14.1'", ["cargo: ripgrep@~14.1"]],
    ["cargo +nightly install cargo-expand", ["cargo: cargo-expand"]],
  ])("reads %s", (command, expected) => {
    expect(summary(command)).toEqual(expected);
  });

  it("skips crates from git or a path, and keeps the git host", () => {
    expect(
      parseInstalls("cargo install --git https://github.com/acme/tool tool")[0]?.skipped,
    ).toEqual([
      { arg: "tool", reason: "installs from a git repository, not crates.io", host: "github.com" },
    ]);
    expect(parseInstalls("cargo install --path .")[0]?.skipped).toEqual([
      { arg: ".", reason: "installs a local path" },
    ]);
  });

  it("collects --registry and --index", () => {
    expect(parseInstalls("cargo add x --registry acme")[0]?.registries).toEqual(["acme"]);
    expect(
      parseInstalls("cargo install x --index sparse+https://crates.example.com/")[0]?.registries,
    ).toEqual(["sparse+https://crates.example.com/"]);
  });
});

describe("parseInstalls: go", () => {
  it.each([
    ["go get github.com/spf13/cobra", ["go: github.com/spf13/cobra"]],
    ["go get -u github.com/spf13/cobra@v1.8.0", ["go: github.com/spf13/cobra@v1.8.0"]],
    ["go get github.com/acme/x/...@latest", ["go: github.com/acme/x@latest"]],
    ["go install golang.org/x/tools/gopls@latest", ["go: golang.org/x/tools/gopls@latest"]],
    [
      "go run golang.org/x/tools/cmd/stringer@v0.24.0 -type=Pill",
      ["go: golang.org/x/tools/cmd/stringer@v0.24.0"],
    ],
    ["go install -tags netgo github.com/acme/tool@v1.2.3", ["go: github.com/acme/tool@v1.2.3"]],
  ])("reads %s", (command, expected) => {
    expect(summary(command)).toEqual(expected);
  });

  it("leaves out local packages, the standard library and removals", () => {
    for (const command of [
      "go run main.go",
      "go run ./cmd/server",
      "go get ./...",
      "go install std",
      "go get github.com/acme/x@none",
      "go build ./...",
      "go mod tidy",
    ]) {
      expect(summary(command)).toEqual([]);
    }
  });

  it("notes go install without a version, which builds what go.mod requires", () => {
    expect(summary("go install github.com/acme/tool/cmd/x")).toEqual([
      "go: [github.com/acme/tool/cmd/x]",
    ]);
  });

  it("reads GOPROXY, GOPRIVATE and GONOPROXY", () => {
    const [install] = parseInstalls(
      "GOPROXY=https://goproxy.example.com,direct GOPRIVATE=github.com/acme/* go get github.com/acme/x",
      { GONOPROXY: "gitlab.example.com" },
    );
    expect(install?.registries).toEqual(["https://goproxy.example.com", "direct"]);
    expect(install?.privatePatterns).toEqual(["github.com/acme/*", "gitlab.example.com"]);
  });

  it("lists the module paths a package path can belong to, longest first", () => {
    expect(moduleCandidates("github.com/acme/tool/cmd/x")).toEqual([
      "github.com/acme/tool/cmd/x",
      "github.com/acme/tool/cmd",
      "github.com/acme/tool",
    ]);
    expect(moduleCandidates("gopkg.in/yaml.v3")).toEqual(["gopkg.in/yaml.v3"]);
    expect(moduleCandidates("example.com/a/b")).toEqual(["example.com/a/b", "example.com/a"]);
  });
});

describe("parseInstalls: shell", () => {
  it("reads every command in a chain, a pipeline, lines and subshells", () => {
    expect(
      summary("cd web && npm i react || echo failed; (pip install requests) | tee log"),
    ).toEqual(["npm: react", "pip: requests"]);
    expect(summary("set -e\nnpm i a \\\n  b\ncargo add c")).toEqual(["npm: a b", "cargo: c"]);
  });

  it("drops comments and redirections", () => {
    expect(summary("# setup\nnpm i a # not b\npip install c 2>&1 > out.txt")).toEqual([
      "npm: a",
      "pip: c",
    ]);
  });

  it("reads commands inside bash -c, sh -c and eval", () => {
    expect(summary("bash -lc 'npm i a && pip install b'")).toEqual(["npm: a", "pip: b"]);
    expect(summary('sh -c "cargo add c"')).toEqual(["cargo: c"]);
    expect(summary("eval npm i d")).toEqual(["npm: d"]);
  });

  it("looks through sudo, env, time and corepack, keeping the variables they set", () => {
    expect(summary("sudo -E npm install -g pnpm")).toEqual(["npm: pnpm"]);
    expect(summary("time corepack pnpm add zod")).toEqual(["pnpm: zod"]);
    const [install] = parseInstalls("env GOPROXY=https://p.example.com go get example.com/m");
    expect(install?.registries).toEqual(["https://p.example.com"]);
  });

  it("finds tools by their file name", () => {
    expect(summary("/usr/local/bin/pip3 install x && ./node_modules/.bin/pnpm add y")).toEqual([
      "pip3: x",
      "pnpm: y",
    ]);
  });

  it("keeps the command as written for the trace", () => {
    expect(parseInstalls("cd web && npm --prefix x i react -D")[0]?.command).toBe(
      "npm --prefix x i react -D",
    );
  });

  it("takes registry variables from the environment, with the command's own winning", () => {
    const env = { npm_config_registry: "https://env.example.com" };
    expect(parseInstalls("npm i x", env)[0]?.registries).toEqual(["https://env.example.com"]);
    expect(
      parseInstalls("npm_config_registry=https://cmd.example.com npm i x", env)[0]?.registries,
    ).toEqual(["https://cmd.example.com"]);
  });
});
