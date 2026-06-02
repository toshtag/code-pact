#!/usr/bin/env node
// Semantic doc invariants (companion to check-doc-links.mjs).
//
// check-doc-links catches broken links. This catches a different class:
// links/text that are still *valid* but semantically stale or unsafe — the
// kind of drift that re-appears every time a feature is added. Each rule
// below encodes a lesson from a past regression so CI can stop it recurring.
// It also guards one non-doc evidence invariant: the committed measurements
// snapshot must match the package version (so releases can't ship stale
// measurements, as v1.18.0 nearly did).
//
// Rules are intentionally narrow and prose-scoped (code fences and <details>
// blocks are stripped before scanning) to avoid false positives on legitimate
// examples.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

const problems = [];
const fail = (rel, msg) => problems.push(`${rel}: ${msg}`);

// Strip fenced code blocks, <details> blocks, and inline code so rules scan
// only the visible beginner-facing prose.
function prose(text) {
  return text
    .replace(/<details>[\s\S]*?<\/details>/gi, "")
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

// 1. The README quick tour must be runnable from a fresh install. A plain
//    `init` creates an empty roadmap, so `P1-T1` does not exist — the tour
//    must use `code-pact tutorial` and/or the sample `TUTORIAL-` tasks.
{
  const readme = read("README.md");
  if (!readme.includes("code-pact tutorial")) {
    fail("README.md", "quick tour must use `code-pact tutorial` (runs against a throwaway sandbox)");
  }
  if (readme.includes("P1-T1")) {
    fail("README.md", "`P1-T1` does not exist after a fresh `init` — use `TUTORIAL-T1` or `code-pact tutorial` in examples");
  }
}

// 2. dogfood.md is a maintainer *quick* guide — keep it lean. Deep material
//    belongs in maintainers/operations.md.
{
  const lines = read("docs/dogfood.md").split("\n").length;
  const CAP = 180;
  if (lines > CAP) {
    fail("docs/dogfood.md", `is ${lines} lines (cap ${CAP}). Move detail to maintainers/operations.md`);
  }
}

// 4. The canonical per-task loop now lives in per-task-loop.md. The runbook
//    concept doc must not claim (present tense) that the sequence lives in
//    dogfood.
{
  const runbook = read("docs/concepts/runbook.md");
  if (/lives in [^.\n]*dogfood/i.test(runbook)) {
    fail("docs/concepts/runbook.md", 'must not say the loop "lives in dogfood" (present tense) — per-task-loop.md is the canonical source');
  }
}

// 5. getting-started must teach `task finalize` as preview → apply
//    (dry-run is the default), matching per-task-loop.md.
for (const rel of ["docs/getting-started.md"]) {
  const body = read(rel);
  const hasPreview = body.includes("task finalize TUTORIAL-T1 --json");
  const hasApply = body.includes("task finalize TUTORIAL-T1 --write --json");
  if (!hasPreview || !hasApply) {
    fail(rel, "the TUTORIAL sample must show `task finalize TUTORIAL-T1 --json` (preview) then `--write --json` (apply)");
  }
}

// 6. Beginner-facing getting-started prose must not carry version/RFC noise
//    (feature-shipped-in tags and phase/RFC citations). Such detail belongs in
//    <details>, upgrading.md, or maintainers/operations.md. Scans prose only.
const NOISE = [
  { re: /\bPre-v\d/, label: "Pre-vX.Y version-history note" },
  { re: /\bP\d+-T\d+\b/, label: "phase-task RFC reference (e.g. P13-T3)" },
  { re: /\(v\d+\.\d+\+/, label: "feature-version tag (e.g. (v1.4+)" },
  { re: /\bP1[0-9]\b(?!-)/, label: "bare phase/RFC reference (e.g. P17)" },
];
for (const rel of ["docs/getting-started.md"]) {
  const text = prose(read(rel));
  for (const { re, label } of NOISE) {
    const m = text.match(re);
    if (m) {
      fail(rel, `beginner prose contains ${label}: "${m[0]}" — move to <details>, upgrading.md, or operations.md`);
    }
  }
}

// 7. The committed measurements snapshot must reflect the current release —
//    its `code_pact_cli_version` must equal package.json's version. This
//    catches "released without re-running the harness" (the v1.18.0 class,
//    which shipped a v1.17.1 snapshot). Run `pnpm harness --corpus . --write`.
{
  const pkgVersion = JSON.parse(read("package.json")).version;
  const summaryVersion = JSON.parse(read("docs/maintainers/measurements/summary.json")).code_pact_cli_version;
  if (pkgVersion !== summaryVersion) {
    fail(
      "docs/maintainers/measurements/summary.json",
      `code_pact_cli_version "${summaryVersion}" != package.json "${pkgVersion}" — run \`pnpm harness --corpus . --write\` to refresh the snapshot`,
    );
  }
}

// 8. Contract↔code invariant for the JSON error envelope (the P39 class).
//    If src/ emits `error.cause_code` (an ADDITIVE error field beyond
//    code/message), then docs/cli-contract.md's "JSON output shape" section
//    MUST tell consumers the error object can carry additive fields — otherwise
//    a reader of that section alone concludes `error` is only {code, message}
//    and writes a brittle parser. This caught itself: the shape section
//    documented only {code, message} for several releases after cause_code
//    shipped. The check derives the obligation from code (does src emit
//    cause_code?), so it can't go stale relative to the implementation.
{
  const emitsCauseCode = /\bcause_code\s*:/.test(read("src/cli/commands/task.ts"));
  if (emitsCauseCode) {
    const contract = read("docs/cli-contract.md");
    // Locate the "## JSON output shape" section body (up to the next "## ").
    const m = contract.match(/##\s+JSON output shape\b([\s\S]*?)(?=\n##\s)/);
    const section = m ? m[1] : "";
    if (!/error\.cause_code/.test(section) || !/additive/i.test(section)) {
      fail(
        "docs/cli-contract.md",
        'src emits `error.cause_code` but the "JSON output shape" section does not describe additive `error` fields (must mention `error.cause_code` and that `error` carries additive fields) — a reader of that section alone would assume `error` is only {code, message}',
      );
    }
  }
}

// 9. Control-plane↔CHANGELOG consistency. If CHANGELOG.md claims a phase is done
//    ("closes P43", "(closes P41)"), that phase's YAML must actually be
//    `status: done`. This caught itself TWICE (P43 and P41 both shipped with the
//    phase/task status left `planned` while the CHANGELOG said "closes" — found
//    only in post-merge review). The check derives the obligation from the
//    CHANGELOG's own claim, so a future "closes PNN" can no longer ship with a
//    stale phase status; CI fails before review.
{
  const changelog = read("CHANGELOG.md");
  const claimed = new Set(
    [...changelog.matchAll(/closes\s+(P\d+)\b/gi)].map((m) => m[1].toUpperCase()),
  );
  if (claimed.size > 0) {
    const phaseDir = "design/phases";
    const files = readdirSync(resolve(repoRoot, phaseDir)).filter((f) =>
      f.endsWith(".yaml"),
    );
    // Map phase id -> its YAML file (id read from the file, not the name).
    const byId = new Map();
    for (const f of files) {
      const body = read(`${phaseDir}/${f}`);
      const idMatch = body.match(/^id:\s*(P\d+)\b/m);
      if (idMatch) byId.set(idMatch[1].toUpperCase(), { file: f, body });
    }
    for (const phaseId of claimed) {
      const entry = byId.get(phaseId);
      if (!entry) {
        fail(
          "CHANGELOG.md",
          `claims "closes ${phaseId}" but no design/phases/*.yaml has \`id: ${phaseId}\``,
        );
        continue;
      }
      const statusMatch = entry.body.match(/^status:\s*(\S+)/m);
      const status = statusMatch ? statusMatch[1] : "(none)";
      if (status !== "done") {
        fail(
          `${phaseDir}/${entry.file}`,
          `CHANGELOG.md says "closes ${phaseId}" but the phase status is "${status}", not "done" — flip the phase (and its tasks) to done, or drop the "closes" claim`,
        );
      }
    }
  }
}

// 10. Control-plane completion consistency. A roadmap-registered phase whose
//     tasks are ALL `done` must itself be `done` (or an explicit non-completing
//     status: cancelled / deferred). This catches the recurrence rule #9 could
//     NOT — a final task merges, every task is done, but the phase status is
//     left `planned` and nobody wrote a "closes PNN" claim to trip rule #9. It
//     happened on P43, P41, and P40. The obligation is derived from the tasks'
//     own states, so a shipped-but-not-flipped phase fails CI before review.
{
  const NON_COMPLETING = new Set(["done", "cancelled", "deferred"]);
  let roadmap;
  try {
    roadmap = parseYaml(read("design/roadmap.yaml"));
  } catch {
    roadmap = null;
  }
  const phaseRefs = Array.isArray(roadmap?.phases) ? roadmap.phases : [];
  for (const ref of phaseRefs) {
    if (typeof ref?.path !== "string") continue;
    let phase;
    try {
      phase = parseYaml(read(ref.path));
    } catch {
      continue; // unparseable phase YAML is validate's job, not ours
    }
    const tasks = Array.isArray(phase?.tasks) ? phase.tasks : [];
    if (tasks.length === 0) continue; // no tasks → nothing to conclude
    const allTasksDone = tasks.every((t) => t?.status === "done");
    const phaseStatus = typeof phase?.status === "string" ? phase.status : "(none)";
    if (allTasksDone && !NON_COMPLETING.has(phaseStatus)) {
      fail(
        ref.path,
        `every task is "done" but the phase status is "${phaseStatus}" — flip the phase to "done" (a shipped phase whose control-plane was left stale; or set an explicit cancelled/deferred status)`,
      );
    }
  }
}

// 11. Context-pack writer accuracy (the P45 class). Two narrow invariants
//     keep the docs/code story straight about WHO writes the context pack:
//     `task context` builds and returns it (read-only); `task prepare` and the
//     low-level `pack` are the writers. Both rules are scoped to one slice each
//     so they cannot false-positive on legitimate `task prepare` prose.
{
  // 11a. positioning.md must not describe `task context` as writing the pack
  //      file. Scan ONLY the `task context` bullet (from its bold label to the
  //      next top-level bullet) so the adjacent `task prepare` bullet — which
  //      legitimately says it writes `.context/<agent>/<task-id>.md` — is not
  //      caught.
  const positioning = read("docs/positioning.md");
  const bulletMatch = positioning.match(
    /-\s+\*\*`code-pact task context`\*\*([\s\S]*?)(?=\n-\s+\*\*`)/,
  );
  const bullet = bulletMatch ? bulletMatch[1] : "";
  if (/\bwrites?\b[\s\S]*?\.context\//i.test(bullet) || /\bwrites? it to\b/i.test(bullet)) {
    fail(
      "docs/positioning.md",
      "the `task context` bullet describes it as writing the pack file — `task context` is a read-only diagnostic; `task prepare` / `pack` are the writers (say it builds and returns/prints the pack)",
    );
  }

  // 11b. Contract↔code invariant. When cli-contract.md's "State file write
  //      guarantees" section lists the context pack as a written file AND
  //      asserts every such write goes through `atomicWriteText`, the
  //      implementation `writeContextPack()` MUST actually use atomicWriteText
  //      (not raw `writeFile`). This was false before v1.29.1 — the contract
  //      claimed atomic, the code used a raw write. The obligation is derived
  //      from the doc's own claim, so it cannot go stale relative to the prose.
  //      Anchored on the `(context pack` row LABEL, not a specific path string,
  //      so it survives the canonical `<agent-profile>.context_dir/...` form
  //      (and would not silently go dormant if the default-path parenthetical
  //      is ever dropped).
  const contract = read("docs/cli-contract.md");
  const guaranteesContextPackAtomic =
    /State file write guarantees[\s\S]*?\(context pack[\s\S]*?Every write listed above goes through `atomicWriteText`/.test(
      contract,
    );
  if (guaranteesContextPackAtomic) {
    const packSrc = read("src/core/pack/index.ts");
    const fnMatch = packSrc.match(
      /export async function writeContextPack[\s\S]*?\n\}/,
    );
    const fnBody = fnMatch ? fnMatch[0] : "";
    if (!/atomicWriteText\s*\(/.test(fnBody) || /\bwriteFile\s*\(/.test(fnBody)) {
      fail(
        "src/core/pack/index.ts",
        "cli-contract.md guarantees context-pack writes go through `atomicWriteText`, but `writeContextPack()` does not use it (or still calls raw `writeFile`) — align the implementation with the published atomic-write contract",
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`check-doc-invariants: ${problems.length} issue(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("check-doc-invariants: OK — all semantic doc invariants hold.");
