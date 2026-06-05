// Shared, authoritative check for "is the shared control plane git-ignored?"
// (collaboration-safe-state RFC A1 follow-up). Used by both `doctor`
// (CONTROL_PLANE_GITIGNORED) and `init` (the blanket-ignore advisory) so the two
// surfaces apply the IDENTICAL judgement and can never drift on the probe set or
// the git semantics.
//
// We ask git, not the .gitignore text: `git check-ignore --no-index` matches
// against the ignore RULES only (what a NEW, untracked file would hit), so a
// force-added file under a blanket ignore does not mask the problem, and a
// negation re-include (`!…`) is honoured exactly as git would — including git's
// rule that a negation under an excluded parent directory is ineffective.
//
// CRUCIAL: we probe a representative *file path* inside each shared area, not the
// directory. A file-scoped rule like `/.code-pact/state/events/*.yaml` ignores
// every NEW event file while leaving the `events/` directory itself un-ignored —
// probing the directory would miss it and stay silently broken (the exact Gap1
// failure). And the "control plane" is more than the ledger: `project.yaml`,
// agent/model profiles, and baselines are all shared, must-commit state — a
// config that re-includes only the ledger but still ignores the rest leaves a
// teammate's clean checkout without project config, which is just as broken.

import { runGit } from "./audit/index.ts";

/**
 * Probes for the shared, must-be-committed control plane (collaboration state).
 * Each `path` is a repo-relative pathspec handed to `git check-ignore`; for the
 * directory-shaped areas it is a representative *file* (the path a NEW file would
 * take), so a file-scoped ignore rule is caught. `label` is the human-facing area
 * name reported back to the user. The probe files do not need to exist —
 * `--no-index` matches on rules alone. Mirrors the shared-vs-local table in
 * `docs/cli-contract.md` § State file write guarantees.
 */
export const SHARED_CONTROL_PLANE_PROBES: ReadonlyArray<{
  path: string;
  label: string;
}> = [
  { path: ".code-pact/project.yaml", label: ".code-pact/project.yaml" },
  {
    path: ".code-pact/agent-profiles/codepact-probe.yaml",
    label: ".code-pact/agent-profiles/",
  },
  {
    path: ".code-pact/model-profiles/codepact-probe.yaml",
    label: ".code-pact/model-profiles/",
  },
  {
    path: ".code-pact/state/baselines/codepact-probe.json",
    label: ".code-pact/state/baselines/",
  },
  {
    // A representative NEW event-file name (the writer uses `<at-compact>-<id>.yaml`).
    path: ".code-pact/state/events/19700101T000000Z-codepact-probe.yaml",
    label: ".code-pact/state/events/ (the progress ledger)",
  },
];

/** True when `cwd` is inside a git work tree (and the `git` binary is available). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await runGit(cwd, ["rev-parse", "--git-dir"])).ok;
}

/**
 * The human-facing labels of the shared control-plane areas that git reports
 * git-ignored — one `git check-ignore --no-index` over every probe. Empty when
 * none are ignored OR git is unavailable / `cwd` is not a repo (a conservative
 * skip; pair with {@link isGitRepo} to distinguish "nothing ignored" from "git
 * could not answer").
 */
export async function gitIgnoredControlPlaneAreas(cwd: string): Promise<string[]> {
  const r = await runGit(cwd, [
    "check-ignore",
    "--no-index",
    ...SHARED_CONTROL_PLANE_PROBES.map((p) => p.path),
  ]);
  // ok:true → exit 0 → at least one probe is ignored; stdout lists the matched
  // pathspecs (verbatim, one per line). ok:false → exit 1 (none ignored) / 128
  // (not a repo) / spawn failure → nothing to report.
  if (!r.ok) return [];
  const ignored = new Set(
    r.stdout.split(/\s+/).map((s) => s.trim()).filter((s) => s.length > 0),
  );
  return SHARED_CONTROL_PLANE_PROBES.filter((p) => ignored.has(p.path)).map(
    (p) => p.label,
  );
}
