#!/usr/bin/env node
// Fast static tripwire for the path-CONTAINMENT class of security bug that the
// adversarial review kept finding: a filesystem read/write of a project path
// built with a LEXICAL `join(...)` instead of `resolveWithinProject(...)`. A
// lexical join follows `..` and symlinks out of the project, so a hostile repo
// (or a symlinked control-plane file) can make the read leak an out-of-project
// file into agent-facing output, or make the write escape the project.
//
// This is NOT a proof — it is a cheap, local, edit-time nudge (wired as a
// PostToolUse hook) so the class is caught at authoring time WITHOUT bloating
// CI. It deliberately favors a few false positives over a miss; silence a line
// that is genuinely safe (e.g. a path with no attacker influence) with a
// trailing `// fs-safe: <reason>` marker, which doubles as the migration log.
//
// Usage: node scripts/check-fs-containment.mjs <file.ts> [<file.ts> ...]
// Exit: 0 = clean (or nothing to check); 1 = findings printed to stdout.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// fs functions whose FIRST argument is the path we care about.
const FS_FNS =
  "readFile|writeFile|appendFile|mkdir|readdir|rmdir|rm|unlink|rename|copyFile|cp|open|truncate|stat|lstat|opendir|watch";
// `fsfn( [await] join(` — a lexically-joined path handed straight to an fs call.
// `\s*` spans newlines so a MULTILINE `readFile(\n join(...),\n "utf8")` is caught
// too (a single-line regex missed exactly that — e.g. the old resolve-task read).
// NOTE: a path stashed in a variable first (`const d = join(...); readFile(d)`)
// is still NOT caught — that needs dataflow (the AST-lint / projectFs follow-up).
const SMELL = new RegExp(`\\b(${FS_FNS})\\s*\\(\\s*(?:await\\s+)?join\\s*\\(`, "g");

// Only the path-handling layers take attacker-controlled project paths. The
// neutral path-safety module itself is exempt (it IS the safe primitive).
function inScope(file) {
  if (!/\.ts$/.test(file)) return false;
  if (/[/\\]path-safety\.ts$/.test(file)) return false;
  if (/[/\\]tests?[/\\]/.test(file) || /\.test\.ts$/.test(file)) return false;
  return /(^|[/\\])src[/\\](commands|core|cli)[/\\]/.test(file);
}

function checkFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const findings = [];
  const lines = text.split("\n");
  for (const m of text.matchAll(SMELL)) {
    // Line number of the fs-call (the match start).
    const lineNo = text.slice(0, m.index).split("\n").length;
    const line = lines[lineNo - 1] ?? "";
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue; // comment
    if (line.includes("resolveWithinProject")) continue; // already contained
    if (/\/\/\s*fs-safe:/.test(line)) continue; // explicitly justified on the fs-call line
    findings.push({ line: lineNo, text: line.trim() });
  }
  return findings;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && full.endsWith(".ts")) out.push(full);
  }
  return out;
}

// With explicit file args (the hook's mode) check just those; with no args
// (`pnpm check:fs-containment`) sweep the whole path-handling surface as a
// migration report. This is NOT wired into the gate — the existing codebase has
// a known baseline of lexical reads (some are the open follow-up to contain
// .code-pact/project.yaml / model-profiles); it is a discoverable report + the
// engine behind the local edit-time hook.
const argv = process.argv.slice(2);
const files = (argv.length > 0 ? argv : walk("src", [])).filter(inScope);
let total = 0;
for (const file of files) {
  const findings = checkFile(file);
  for (const f of findings) {
    total++;
    console.log(`${file}:${f.line}: lexical join into an fs call — use resolveWithinProject(cwd, relPath)`);
    console.log(`    ${f.text}`);
  }
}
if (total > 0) {
  console.log(
    `\nfs-containment: ${total} finding(s). A project path read/written here is NOT contained:`,
  );
  console.log(
    "  resolve it first — `const abs = await resolveWithinProject(cwd, relPath)` — so a `..`/symlink",
  );
  console.log(
    "  cannot escape the project. If the path is genuinely attacker-free, append `// fs-safe: <reason>`.",
  );
  process.exit(1);
}
process.exit(0);
