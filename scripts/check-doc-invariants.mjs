#!/usr/bin/env node
// Semantic doc invariants (companion to check-doc-links.ts).
//
// check-doc-links catches broken links. This catches a different class:
// links/text that are still *valid* but semantically stale or unsafe — the
// kind of drift that re-appears every time a feature is added. Each rule
// below encodes a lesson from a past regression so CI can stop it recurring.
//
// Rules are intentionally narrow and prose-scoped (code fences and <details>
// blocks are stripped before scanning) to avoid false positives on legitimate
// examples.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { closesClaimProblem, readLivePhaseFiles } from "./closes-claim.mjs";

/** Resolve an archived phase snapshot for `phaseId` from the BUNDLE store — the
 *  compacted form (`state compact-archive` folds the loose `archive/phases/<id>.json`
 *  into `archive/bundles/phase_snapshot-<hash>.json` and deletes the loose file). The
 *  same loose∪bundle resolution the runtime readers use, so this CI check survives a
 *  compacted repo. Returns the parsed snapshot, `"PARSE_ERROR"` (a member is present
 *  but its bytes are unparseable), or `null` (no bundle member for the id). */
function resolveSnapshotFromBundle(repoRoot, phaseId) {
  const dir = resolve(repoRoot, ".code-pact/state/archive/bundles");
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.startsWith("phase_snapshot-") && n.endsWith(".json"));
  } catch {
    return null; // no bundles dir → no compacted snapshot
  }
  for (const name of names) {
    let bundle;
    try {
      bundle = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue; // a corrupt bundle file is the bundle reader's concern, not this CI check's
    }
    const member = (bundle.members ?? []).find((m) => m.id === phaseId);
    if (!member) continue;
    try {
      return JSON.parse(member.bytes);
    } catch {
      return "PARSE_ERROR";
    }
  }
  return null;
}

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
//    ("closes P43", "(closes P41)"), that phase must actually be `done`. This caught
//    itself TWICE (P43 and P41 both shipped with the phase/task status left `planned`
//    while the CHANGELOG said "closes" — found only in post-merge review). The check
//    derives the obligation from the CHANGELOG's own claim, so a future "closes PNN"
//    can no longer ship with a stale phase status; CI fails before review.
//    design-docs-ephemeral: a phase may be ARCHIVED (its live YAML deleted, runtime
//    truth in a `.code-pact/state/archive/phases/<id>.json` snapshot). A "closes Pxx"
//    claim is still satisfied by a terminal archive snapshot (`phase_status: done`),
//    so resolve a missing live phase from its snapshot before failing — the same
//    archived-tolerance every phase-existence reader applies, so archiving a phase
//    named by a "closes" claim does not break this gate.
{
  const changelog = read("CHANGELOG.md");
  const claimed = new Set(
    [...changelog.matchAll(/closes\s+(P\d+)\b/gi)].map((m) => m[1].toUpperCase()),
  );
  if (claimed.size > 0) {
    const phaseDir = "design/phases";
    // Tolerates an ABSENT design/phases (all phases archived → git drops the empty dir);
    // every `closes` claim then resolves from its archive snapshot below. Pinned in
    // tests/unit/scripts/check-doc-invariants.test.ts.
    const files = readLivePhaseFiles(repoRoot, phaseDir);
    // Map phase id -> its YAML file (id read from the file, not the name).
    const byId = new Map();
    for (const f of files) {
      const body = read(`${phaseDir}/${f}`);
      const idMatch = body.match(/^id:\s*(P\d+)\b/m);
      if (idMatch) byId.set(idMatch[1].toUpperCase(), { file: f, body });
    }
    for (const phaseId of claimed) {
      const entry = byId.get(phaseId);
      // When no live YAML resolves the id, read the archive snapshot: `null` = no
      // snapshot file, `"PARSE_ERROR"` = a file is present but unparseable (distinct
      // diagnostics; the verdict — incl. the snapshot phase_id identity check — lives
      // in the pure `closesClaimProblem`).
      let snapshot = null;
      if (!entry) {
        try {
          const raw = read(`.code-pact/state/archive/phases/${phaseId}.json`);
          try {
            snapshot = JSON.parse(raw);
          } catch {
            snapshot = "PARSE_ERROR";
          }
        } catch {
          // No LOOSE snapshot — resolve from the BUNDLE store (the compacted form). A
          // compacted repo has the snapshot only as a bundle member; loose-wins, so the
          // bundle is consulted only when the loose file is absent.
          snapshot = resolveSnapshotFromBundle(repoRoot, phaseId);
        }
      }
      const problem = closesClaimProblem(phaseId, entry, snapshot);
      if (problem) fail(problem.rel, problem.msg);
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
    /State file write guarantees[\s\S]*?\(context pack[\s\S]*?goes through `atomicWriteText`/.test(
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

// 12. `check:docs` ↔ docs-maintenance.md "Checks" section, both directions. The
//     aggregate `check:docs` chains a set of `check:*` sub-commands; the guide's
//     Checks section documents one bullet per sub-command. The two sets must be
//     equal, so adding a sub-check (it must be documented) or removing one (its
//     bullet must go) can't leave the guide stale. Derived from package.json, so
//     the rule can't go stale relative to the script. `check:docs` itself is the
//     aggregate and is excluded from both sides.
{
  const GUIDE = "docs/maintainers/docs-maintenance.md";
  const sectionBody = (text, heading) => {
    const h = text.match(new RegExp(`^##\\s+${heading}\\s*$`, "m"));
    if (!h) return "";
    const rest = text.slice(h.index + h[0].length);
    const next = rest.search(/\n##\s+/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  const checksIn = (s) =>
    new Set(
      [...s.matchAll(/\bcheck:[A-Za-z0-9:_-]+\b/g)]
        .map((m) => m[0])
        .filter((name) => name !== "check:docs"),
    );
  const expected = checksIn(JSON.parse(read("package.json")).scripts?.["check:docs"] ?? "");
  const documented = checksIn(sectionBody(read(GUIDE), "Checks"));
  for (const sub of expected) {
    if (!documented.has(sub)) {
      fail(GUIDE, `\`check:docs\` runs \`${sub}\` but the "Checks" section never names it — add a bullet for it`);
    }
  }
  for (const sub of documented) {
    if (!expected.has(sub)) {
      fail(GUIDE, `the "Checks" section documents \`${sub}\` but \`check:docs\` does not run it — drop the bullet or add it to the check:docs script`);
    }
  }
}

// 13. Locale-safe structural projection conformance is a public JSON contract.
//     Keep the adapter-conformance CLI docs synchronized with the check id,
//     release gate, and details shape that agents/users consume.
{
  const CLI_CONTRACT = "docs/cli-contract.md";
  const body = read(CLI_CONTRACT);
  for (const anchor of [
    "structural_projection_guidance_present",
    "STRUCTURAL_PROJECTION_GUIDANCE_FROM_VERSION",
    "matched_variant",
  ]) {
    if (!body.includes(anchor)) {
      fail(CLI_CONTRACT, `adapter conformance docs must mention \`${anchor}\``);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-doc-invariants: ${problems.length} issue(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("check-doc-invariants: OK — all semantic doc invariants hold.");
