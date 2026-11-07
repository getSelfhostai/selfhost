#!/usr/bin/env node
// Scans fixture files and exits 1 if any contain secret-shaped strings, emails
// outside example.com (agent and GitHub service addresses aside), home paths other
// than /home/dev, or macOS user paths.
// Also fails on JSON or JSONL files that do not parse.
//
// Usage: node scripts/scrub-check.mjs [dir]   (default: fixtures/, skipping fixtures/redaction/)

import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKIP_TOP_LEVEL = new Set(["redaction"]);
const ALLOWED_EMAIL_DOMAIN = "example.com";

export const SECRET_RULES = [
  ["anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai key", /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g],
  ["openai key", /T3BlbkFJ/g],
  ["openai key", /\bsk-[A-Za-z0-9]{32,}\b/g],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ["github token", /\bgithub_pat_[A-Za-z0-9_]{30,}/g],
  ["aws access key id", /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z2-7]{16}\b/g],
  ["aws secret key", /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{30,}/gi],
  ["slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["stripe key", /\b[rs]k_live_[A-Za-z0-9]{16,}/g],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g],
  [
    "credential assignment",
    /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=.]{12,}/gi,
  ],
  ["credentials in url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'\\]+:[^\s/@"'\\]+@/gi],
];

const PATH_RULES = [
  ["home path other than /home/dev", /\/home\/(?!dev(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+/g],
  ["macOS user path", /\/Users\/[^/\s"'\\]+/g],
  ["macOS user path (encoded project dir)", /-Users-[A-Za-z0-9]/g],
  ["macOS temp path", /\/(?:private\/)?var\/folders\//g],
  ["Windows user path", /\b[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[^\\/\s"']+/gi],
];

const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;

// Service addresses that agents and GitHub write into commits (fixtures/github). They belong to
// no person, so they may appear in fixtures.
const SERVICE_EMAILS = new Set([
  "noreply@anthropic.com",
  "noreply@openai.com",
  "noreply@github.com",
  "cursoragent@cursor.com",
  "amp@ampcode.com",
  "aider@aider.chat",
]);
const AGENT_NOREPLY = /^\d+\+(?:copilot|claude|codex)@users\.noreply\.github\.com$/i;

function isServiceEmail(email) {
  const value = email.toLowerCase();
  return SERVICE_EMAILS.has(value) || AGENT_NOREPLY.test(value);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localIdentityRules() {
  // Catch the current machine's username and hostname. Skipped in CI, where
  // generic account names would match ordinary words.
  if (process.env.CI) return [];
  const rules = [];
  const common = new Set(["dev", "root", "runner", "node", "user", "admin", "ubuntu"]);
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {}
  if (user && user.length >= 3 && !common.has(user.toLowerCase())) {
    rules.push([
      "local username",
      new RegExp(`(?<![A-Za-z0-9])${escapeRegex(user)}(?![A-Za-z0-9])`, "gi"),
    ]);
  }
  const host = os.hostname().split(".")[0];
  if (host && host.length >= 4 && host.toLowerCase() !== "localhost") {
    rules.push(["local hostname", new RegExp(escapeRegex(host), "gi")]);
  }
  return rules;
}

function redactMatch(s) {
  return s.length <= 8 ? `${s.slice(0, 2)}***` : `${s.slice(0, 6)}***(${s.length} chars)`;
}

let defaultRules;

function getDefaultRules() {
  defaultRules ??= [...SECRET_RULES, ...PATH_RULES, ...localIdentityRules()];
  return defaultRules;
}

export function findInText(text, rules = getDefaultRules()) {
  const hits = [];
  for (const [name, re] of rules) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.push({ rule: name, index: m.index, match: m[0] });
  }
  EMAIL.lastIndex = 0;
  for (const m of text.matchAll(EMAIL)) {
    if (m[1].toLowerCase() !== ALLOWED_EMAIL_DOMAIN && !isServiceEmail(m[0]))
      hits.push({ rule: "email outside example.com", index: m.index, match: m[0] });
  }
  return hits;
}

export function looksSensitive(text) {
  return findInText(text).length > 0;
}

function lineCol(text, index) {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  return [line, index - before.lastIndexOf("\n")];
}

function walk(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === root && SKIP_TOP_LEVEL.has(entry.name)) continue;
      walk(full, root, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export function scanDir(dir) {
  const root = resolve(dir);
  const findings = [];
  const files = walk(root, root, []);
  const identity = localIdentityRules();
  for (const file of files) {
    const rel = relative(root, file);
    for (const hit of findInText(rel, [...PATH_RULES, ...identity])) {
      findings.push(`${rel}: file path: ${hit.rule}: ${redactMatch(hit.match)}`);
    }
    const buf = readFileSync(file);
    if (buf.includes(0)) continue;
    const text = buf.toString("utf8");
    for (const hit of findInText(text, [...SECRET_RULES, ...PATH_RULES, ...identity])) {
      const [line, col] = lineCol(text, hit.index);
      findings.push(`${rel}:${line}:${col}: ${hit.rule}: ${redactMatch(hit.match)}`);
    }
    if (file.endsWith(".json")) {
      try {
        JSON.parse(text);
      } catch (e) {
        findings.push(`${rel}: invalid JSON: ${e.message}`);
      }
    } else if (file.endsWith(".jsonl")) {
      text.split("\n").forEach((l, i) => {
        if (!l.trim()) return;
        try {
          JSON.parse(l);
        } catch (e) {
          findings.push(`${rel}:${i + 1}: invalid JSONL line: ${e.message}`);
        }
      });
    }
  }
  return { files: files.length, findings };
}

function main() {
  const dir = resolve(process.argv[2] ?? join(REPO_ROOT, "fixtures"));
  const { files, findings } = scanDir(dir);
  if (findings.length) {
    console.error(`scrub-check: ${findings.length} finding(s) under ${dir}`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`scrub-check: ${files} file(s) clean under ${relative(process.cwd(), dir) || "."}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
