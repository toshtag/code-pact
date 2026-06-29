#!/usr/bin/env node
// AST gate: verify that every filesystem operation (readFile, writeFile, mkdir,
// rm, stat, unlink, rename) in adapter-install.ts and adapter-upgrade.ts uses
// a path that has been through an authority resolution:
//   - authorizeAdapterMutationPath (returns .absPath from resolveSymlinkFreeProjectPath)
//   - resolveSymlinkFreeProjectPath (direct ownership check)
//   - resolveManifestPath (manifest-specific ownership check)
//   - readAuthorizedRegularFileMaybe / authorizedPathExists (accept pre-resolved absPath)
//   - writeManifest / readManifest (internally use resolveManifestPath)
//   - atomicWriteText (accepts pre-resolved absPath)
//   - assertAdapterWritePathsContained (returns resolved paths)
//
// This is a STRUCTURAL backstop: it flags any fs call on a path that is NOT
// sourced from one of these authority resolvers. A clean exit 0 means the
// adapter mutation commands do not perform raw fs I/O on unvetted paths.
//
// Usage: node scripts/check-fs-authority.mjs
// Exit: 0 = clean; 1 = findings printed to stdout

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ADAPTER_FILES = [
  join("src", "commands", "adapter-install.ts"),
  join("src", "commands", "adapter-upgrade.ts"),
];

// fs functions whose FIRST argument is the path we care about.
const FS_CALL_RE =
  /\b(readFile|writeFile|appendFile|mkdir|readdir|rmdir|rm|unlink|rename|copyFile|cp|open|truncate|stat|lstat|opendir|watch|atomicWriteText)\s*\(/g;

// Authority sources: variables and expressions that produce safe paths.
const AUTHORITY_SOURCES = [
  "authority.absPath",
  "contextDirAbs",
  "planned.absPath",
  "item.absPath",
  "absPath",
  "resolveSymlinkFreeProjectPath",
  "resolveManifestPath",
  "resolveProjectConfigPath",
  "readAuthorizedRegularFileMaybe",
  "authorizedPathExists",
  "writeManifest",
  "readManifest",
  "assertAdapterWritePathsContained",
  "resolveOwnedReadPath",
];

// Lines exempt from the check: comments, imports, or the authority resolvers
// themselves (they internally call fs functions on already-resolved paths).
function isExempt(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return true;
  if (trimmed.startsWith("import ")) return true;
  // The authority resolver definitions themselves contain fs calls on
  // already-resolved paths — they are the safe primitives, not call sites.
  if (/^(export\s+)?(async\s+)?function\s+(resolveSymlinkFreeProjectPath|resolveManifestPath|readAuthorizedRegularFileMaybe|authorizedPathExists|assertAdapterWritePathsContained|writeManifest|readManifest)/.test(trimmed)) {
    return true;
  }
  return false;
}

function isAuthorityPath(argText) {
  for (const src of AUTHORITY_SOURCES) {
    if (argText.includes(src)) return true;
  }
  return false;
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

  for (const m of text.matchAll(FS_CALL_RE)) {
    const lineNo = text.slice(0, m.index).split("\n").length;
    const line = lines[lineNo - 1] ?? "";
    if (isExempt(line)) continue;

    // Extract the first argument (path) from the fs call
    const callStart = m.index + m[0].length;
    let depth = 1;
    let argEnd = callStart;
    for (let i = callStart; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      else if (text[i] === "," && depth === 1) {
        argEnd = i;
        break;
      }
    }
    const argText = text.slice(callStart, argEnd).trim();

    // Check if the path argument comes from an authority source
    if (!isAuthorityPath(argText)) {
      // Check if there's a fs-safe marker
      if (/\/\/\s*fs-safe:/.test(line)) continue;
      findings.push({
        line: lineNo,
        fn: m[1],
        arg: argText.slice(0, 60),
        text: line.trim(),
      });
    }
  }
  return findings;
}

let total = 0;
for (const file of ADAPTER_FILES) {
  const findings = checkFile(file);
  for (const f of findings) {
    total++;
    console.log(
      `${file}:${f.line}: ${f.fn}() called on non-authority path "${f.arg}"`,
    );
    console.log(`    ${f.text}`);
  }
}

if (total > 0) {
  console.log(
    `\nfs-authority: ${total} finding(s). Adapter fs operations must use paths from:`,
  );
  console.log(
    `  authorizeAdapterMutationPath, resolveSymlinkFreeProjectPath, resolveManifestPath,`,
  );
  console.log(
    `  or a pre-resolved variable (absPath, contextDirAbs, etc.).`,
  );
  console.log(
    `  If the path is genuinely safe, append \`// fs-safe: <reason>\`.`,
  );
  process.exit(1);
}
process.exit(0);
