// Helpers for check-doc-invariants rule #9 (CHANGELOG "closes Pxx"), extracted so the
// repo-bound script's hard-to-test bits are unit-testable: `readLivePhaseFiles` (the
// directory read, which must tolerate an ABSENT `design/phases/` once every phase is
// archived) and the PURE `closesClaimProblem` verdict.
//
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * List the live `design/phases/*.yaml` files. design-docs-ephemeral end state: once
 * EVERY phase is archived, `design/phases/` is empty and git does not track an empty
 * directory — on a fresh checkout the directory is ABSENT. Treat ENOENT as "no live
 * phases" (`[]`); re-throw anything else (e.g. ENOTDIR) so a real fault is not masked.
 * @param {string} repoRoot
 * @param {string} [phaseDir]
 * @returns {string[]} the `.yaml` basenames (possibly empty)
 */
export function readLivePhaseFiles(repoRoot, phaseDir = "design/phases") {
  try {
    return readdirSync(resolve(repoRoot, phaseDir)).filter((f) => f.endsWith(".yaml"));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

// The verdict for ONE CHANGELOG "closes Pxx" claim — a PURE function, so the snapshot
// identity / status logic is unit-testable without running the whole repo-bound script.
//
// design-docs-ephemeral: a phase named by a "closes" claim may be LIVE (a
// design/phases YAML) or ARCHIVED (its YAML deleted, runtime truth in a
// .code-pact/state/archive/phases/<id>.json snapshot). A snapshot is accepted as the
// claim's durable truth ONLY on a full positive identity check — its internal
// `phase_id` must match the claimed id (never trust the filename alone) AND its
// `phase_status` must be `done`. Anything else fails closed.

/**
 * @param {string} phaseId  the claimed id, uppercased (e.g. "P16")
 * @param {{file:string, body:string}|undefined} liveEntry  the live phase YAML with
 *        that id (id read from the file body), or undefined when none is live
 * @param {object|null|"PARSE_ERROR"} snapshot  the parsed archive snapshot when no
 *        live YAML resolves the id: an object, `null` (no snapshot file), or the
 *        sentinel `"PARSE_ERROR"` (a snapshot file is present but unparseable)
 * @returns {{rel:string, msg:string}|null}  a problem to report, or null when the
 *        claim is satisfied
 */
export function closesClaimProblem(phaseId, liveEntry, snapshot) {
  // --- live phase wins: its status must be done ---
  if (liveEntry) {
    const statusMatch = liveEntry.body.match(/^status:\s*(\S+)/m);
    const status = statusMatch ? statusMatch[1] : "(none)";
    if (status !== "done") {
      return {
        rel: `design/phases/${liveEntry.file}`,
        msg: `CHANGELOG.md says "closes ${phaseId}" but the phase status is "${status}", not "done" — flip the phase (and its tasks) to done, or drop the "closes" claim`,
      };
    }
    return null;
  }

  // --- no live YAML: resolve from the archive snapshot, fail-closed on identity ---
  const snapPath = `.code-pact/state/archive/phases/${phaseId}.json`;
  if (snapshot === "PARSE_ERROR") {
    return { rel: "CHANGELOG.md", msg: `says "closes ${phaseId}" but its archive snapshot ${snapPath} is present yet unparseable` };
  }
  if (snapshot) {
    const snapId = typeof snapshot.phase_id === "string" ? snapshot.phase_id.toUpperCase() : "(none)";
    if (snapId !== phaseId) {
      return { rel: "CHANGELOG.md", msg: `says "closes ${phaseId}" but archive snapshot ${snapPath} has phase_id "${snapshot.phase_id ?? "(none)"}" — filename must not be trusted over the snapshot's own identity` };
    }
    if (snapshot.phase_status !== "done") {
      return { rel: "CHANGELOG.md", msg: `says "closes ${phaseId}" but its archive snapshot's phase_status is "${snapshot.phase_status}", not "done"` };
    }
    return null; // archived + matching phase_id + done → claim satisfied
  }
  return { rel: "CHANGELOG.md", msg: `claims "closes ${phaseId}" but no live design/phases/*.yaml has \`id: ${phaseId}\` and no archive snapshot resolves it` };
}
