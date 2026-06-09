#!/usr/bin/env node
// Release-notes extractor (decision-lifecycle RFC § Long-term record-of-truth model).
//
// The GitHub Release body is "generated from CHANGELOG.md, never authored twice"
// (docs/maintainers/releasing.md step 9). This pulls the `## [<version>]` section
// out of CHANGELOG.md verbatim so the release notes are exactly the authored
// changelog entry — no hand-copying, no drift.
//
//   node scripts/release-notes.mjs 1.32.0   # prints the [1.32.0] section to stdout
//
// Exits non-zero if the version section is not found. The `## Integrity` block
// (published-tarball shasum) is still added by hand after publish, per SECURITY.md.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

/**
 * Return the body of the `## [<version>]` section — everything after its heading
 * line up to (but not including) the next `## ` heading or EOF — trimmed. Returns
 * null when the version has no section. Pure (no I/O), for testability.
 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  // Match `## [<version>]` exactly (escape regex metachars in the version).
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^##\\s*\\[${esc}\\]`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function main(argv) {
  const version = argv[0];
  if (!version) {
    process.stderr.write("usage: node scripts/release-notes.mjs <version>\n");
    return 2;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const notes = extractReleaseNotes(changelog, version);
  if (notes === null || notes === "") {
    process.stderr.write(`release-notes: no \"## [${version}]\" section in CHANGELOG.md\n`);
    return 1;
  }
  process.stdout.write(`${notes}\n`);
  return 0;
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
