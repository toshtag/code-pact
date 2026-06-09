#!/usr/bin/env node
// CHANGELOG rolling-archive (decision-lifecycle RFC § Long-term record-of-truth model).
//
// `CHANGELOG.md` is the one authored "what changed" record, but it grows without
// bound. The bloat control is a rolling archive: keep the CURRENT major in-repo,
// MOVE older majors (verbatim, not summarized) to
// `docs/maintainers/history/CHANGELOG-<major>.md`, and leave a pointer behind.
// Unlike `decision compress`, this is non-lossy and deterministic — it moves whole
// `## [version]` sections by their major, so git diff / rollback are trivial and
// no rationale is ever dropped.
//
//   node scripts/changelog-archive.mjs            # dry-run: report what would move
//   node scripts/changelog-archive.mjs --write    # apply the move
//   node scripts/changelog-archive.mjs --check     # CI: fail if an older major is still in CHANGELOG.md
//
// The current major is read from package.json. Reference-style `[#NN]` link
// definitions trail their version section, so moving a whole section keeps a ref
// WITH ITS DEFINITION WHEN ONE EXISTS — the move neither creates nor repairs a
// ref that was already undefined in the source CHANGELOG.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ARCHIVE_DIR = "docs/maintainers/history";
const POINTER_HEADING = "## Older versions";

/** Major number of a leading `X.Y.Z` version string, or null. */
export function majorOf(version) {
  const m = /^(\d+)\.\d+\.\d+/.exec(String(version));
  return m ? Number(m[1]) : null;
}

/**
 * Split a CHANGELOG into its preamble and top-level `## ` blocks. A block runs
 * from a `## ` heading to just before the next `## ` heading (or EOF), so it
 * carries the section's entries AND its trailing reference-link definitions /
 * separators. `version` / `major` are null for non-version blocks (`[Unreleased]`,
 * the `## Older versions` pointer). Pure (no I/O).
 */
export function parseChangelog(text) {
  const lines = text.split(/\r?\n/);
  const headingIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) headingIdx.push(i);
  }
  const preamble = headingIdx.length === 0 ? text : lines.slice(0, headingIdx[0]).join("\n");
  const blocks = [];
  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h];
    const end = h + 1 < headingIdx.length ? headingIdx[h + 1] : lines.length;
    const heading = lines[start];
    const vm = /^##\s*\[(\d+\.\d+\.\d+[^\]]*)\]/.exec(heading);
    const version = vm ? vm[1] : null;
    blocks.push({
      heading,
      version,
      major: version ? majorOf(version) : null,
      text: lines.slice(start, end).join("\n"),
    });
  }
  return { preamble, blocks };
}

/**
 * Partition blocks into those kept in CHANGELOG.md (the current major + version-less
 * blocks like Unreleased / the pointer) and those archived (an older major), grouped
 * by major. Order is preserved within each group.
 */
export function partitionByMajor(blocks, currentMajor) {
  const kept = [];
  const archivedByMajor = new Map();
  for (const b of blocks) {
    if (b.major !== null && b.major < currentMajor) {
      if (!archivedByMajor.has(b.major)) archivedByMajor.set(b.major, []);
      archivedByMajor.get(b.major).push(b);
    } else {
      kept.push(b);
    }
  }
  return { kept, archivedByMajor };
}

/** The archive-file body for one major's moved blocks. */
export function renderArchiveFile(major, blocks) {
  const header =
    `# Changelog — archived (v${major}.x)\n\n` +
    `Older releases moved out of the main [CHANGELOG.md](../../../CHANGELOG.md) by ` +
    `\`scripts/changelog-archive.mjs\` (rolling archive). Verbatim, not summarized; ` +
    `the full history is also in git.\n`;
  return `${header}\n${blocks.map((b) => b.text.trimEnd()).join("\n\n")}\n`;
}

/** The pointer block left in CHANGELOG.md for the archived majors (descending). */
export function renderPointer(majors) {
  const bullets = [...new Set(majors)]
    .sort((a, b) => b - a)
    .map((m) => `- v${m}.x — [${ARCHIVE_DIR}/CHANGELOG-${m}.md](${ARCHIVE_DIR}/CHANGELOG-${m}.md)`)
    .join("\n");
  return `${POINTER_HEADING}\n\nReleases before the current major are archived (moved verbatim, not deleted):\n\n${bullets}\n`;
}

/** Majors already listed in an existing `## Older versions` pointer block (from its CHANGELOG-<n>.md links). */
export function majorsFromPointer(pointerText) {
  const out = [];
  for (const m of pointerText.matchAll(/CHANGELOG-(\d+)\.md/g)) out.push(Number(m[1]));
  return out;
}

/**
 * Rebuild CHANGELOG.md content from the preamble + kept blocks + the pointer.
 * The pointer is regenerated over the UNION of majors it already listed and the
 * ones archived this run — so a later major rollover (e.g. v2 archiving v1.x)
 * never drops the discovery link to an earlier archive (CHANGELOG-0.md).
 */
export function renderChangelog(preamble, keptBlocks, archivedMajors) {
  const parts = [preamble.trimEnd()];
  const existingPointer = keptBlocks.find((b) => b.heading.trim() === POINTER_HEADING);
  const priorMajors = existingPointer ? majorsFromPointer(existingPointer.text) : [];
  const kept = keptBlocks.filter((b) => b.heading.trim() !== POINTER_HEADING);
  for (const b of kept) parts.push(b.text.trimEnd());
  const allMajors = [...new Set([...priorMajors, ...archivedMajors])];
  if (allMajors.length > 0) parts.push(renderPointer(allMajors).trimEnd());
  return `${parts.join("\n\n")}\n`;
}

/**
 * Archive targets that already exist with DIFFERENT content — a refuse condition.
 * `readOrNull(path)` returns the current file content or null when absent. An
 * absent target (fresh archive) or a byte-identical one (a partial run being
 * re-applied) is safe; a different existing archive must NOT be overwritten
 * (non-lossy / move-not-delete contract — e.g. a merge that leaked some sections
 * back into CHANGELOG.md must not clobber the full archive with the fragment).
 */
export function archiveConflicts(archive, readOrNull) {
  const conflicts = [];
  for (const a of archive) {
    const existing = readOrNull(a.path);
    if (existing !== null && existing !== a.content) conflicts.push(a.path);
  }
  return conflicts;
}

/** Compute the full plan (pure). `archive` is [{major, path, content}], `changelog` the new CHANGELOG.md. */
export function planArchive(changelogText, currentMajor) {
  const { preamble, blocks } = parseChangelog(changelogText);
  const { kept, archivedByMajor } = partitionByMajor(blocks, currentMajor);
  const archive = [...archivedByMajor.entries()].map(([major, blks]) => ({
    major,
    path: `${ARCHIVE_DIR}/CHANGELOG-${major}.md`,
    content: renderArchiveFile(major, blks),
    versions: blks.map((b) => b.version),
  }));
  const majors = [...archivedByMajor.keys()];
  const newChangelog = majors.length > 0 ? renderChangelog(preamble, kept, majors) : changelogText;
  return { archive, newChangelog, changed: majors.length > 0 };
}

function readCurrentMajor(repoRoot) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const major = majorOf(pkg.version);
  if (major === null) throw new Error(`package.json version "${pkg.version}" is not X.Y.Z`);
  return major;
}

function main(argv) {
  const mode = argv.includes("--write") ? "write" : argv.includes("--check") ? "check" : "dry-run";
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const currentMajor = readCurrentMajor(repoRoot);
  const changelogPath = join(repoRoot, "CHANGELOG.md");
  const plan = planArchive(readFileSync(changelogPath, "utf8"), currentMajor);

  if (!plan.changed) {
    process.stdout.write(`changelog-archive: CHANGELOG.md holds only the current major (v${currentMajor}.x) + Unreleased — nothing to archive.\n`);
    return 0;
  }

  const summary = plan.archive
    .map((a) => `  v${a.major}.x → ${a.path} (${a.versions.length} release${a.versions.length === 1 ? "" : "s"})`)
    .join("\n");

  if (mode === "check") {
    process.stderr.write(
      `changelog-archive: CHANGELOG.md still contains older majors:\n${summary}\n` +
        `Run \`node scripts/changelog-archive.mjs --write\` to move them to ${ARCHIVE_DIR}/.\n`,
    );
    return 1;
  }
  if (mode === "dry-run") {
    process.stdout.write(`changelog-archive (dry-run): would archive\n${summary}\nand leave a pointer in CHANGELOG.md. Re-run with --write to apply.\n`);
    return 0;
  }
  // write. Preflight first: refuse to overwrite an existing archive file whose
  // content differs (would lose history) — write NOTHING in that case. An absent
  // or byte-identical target is safe (fresh create, or re-applying a partial run).
  const conflicts = archiveConflicts(plan.archive, (p) => {
    const abs = join(repoRoot, p);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  });
  if (conflicts.length > 0) {
    process.stderr.write(
      `changelog-archive: refusing to overwrite existing archive file(s) with different content:\n` +
        conflicts.map((p) => `  ${p}`).join("\n") +
        `\nNothing was written. Reconcile by hand (the archive already holds the moved history).\n`,
    );
    return 1;
  }
  // Each major is archived exactly once: once its sections leave CHANGELOG.md a
  // re-run finds nothing to move (changed:false short-circuits above).
  mkdirSync(join(repoRoot, ARCHIVE_DIR), { recursive: true });
  for (const a of plan.archive) {
    writeFileSync(join(repoRoot, a.path), a.content);
  }
  writeFileSync(changelogPath, plan.newChangelog);
  process.stdout.write(`changelog-archive: archived\n${summary}\nand left a pointer in CHANGELOG.md.\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
