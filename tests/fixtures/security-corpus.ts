// P38-T1 — shared security corpus.
//
// One source of unsafe values, exercised at EVERY plan/agent write entrypoint
// and schema boundary by tests/unit/security/write-entrypoint-coverage.test.ts.
// The 1.26.0 review found the same traversal/injection class re-discovered one
// site at a time (PlanId added to read schemas but missed on phase import /
// createPhase / task add / recommend / pack / agent-profile paths). Keeping the
// bad-value set in one place means a new entrypoint is wired against the same
// corpus instead of re-inventing its own (incomplete) list.
//
// Conventional values that MUST still be accepted live alongside, so the
// coverage test also proves the constraints are not over-broad.

/**
 * Identifiers that must be rejected by the {@link PlanId} charset
 * (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) and by every id field built on it
 * (`Task.id`, `Phase.id`, roadmap `PhaseRef.id`, agent names, import ids).
 *
 * Covers: empty, `.`/`..`, traversal, slashes, whitespace, shell
 * metacharacters, leading non-alphanumerics (option-like `--json` / `-P1`,
 * hidden `.x`, `_x`), and backslash.
 */
export const BAD_PLAN_IDS: readonly string[] = [
  "",
  ".",
  "..",
  "../evil",
  "P1/T1",
  "P1 T1",
  "P1\tT1",
  "P1\nT2",
  "P1;echo owned",
  "P1|x",
  "P1&x",
  "P1$x",
  "P1`x`",
  "--json",
  "--help",
  "-P1",
  "-",
  ".hidden",
  "_leading",
  "a\\b",
];

/** Conventional identifiers that MUST parse (guards against over-broad rules). */
export const GOOD_PLAN_IDS: readonly string[] = [
  "P1",
  "P1-T1",
  "P34-ci-branch-drift",
  "P36-adr-quality-advisory",
  "TUTORIAL-1",
  "claude-code",
  "a.b_c-1",
  "1",
];

/**
 * Paths that must be rejected by {@link RelativePosixPath} and by every
 * project-relative path field built on it (`AgentProfile.instruction_filename`
 * / `context_dir` / `skill_dir` / `hook_dir`, `AgentRef.profile`).
 *
 * Covers: empty, `.`/`..`, traversal, absolute (POSIX + Windows drive), `~`,
 * empty segments, and backslash.
 */
export const BAD_RELATIVE_PATHS: readonly string[] = [
  "",
  ".",
  "..",
  "../outside",
  "/tmp/x",
  "/",
  "a/../b",
  "a//b",
  "C:\\tmp",
  "~/.ssh",
  "a\\b",
];

/** Conventional project-relative paths that MUST parse. */
export const GOOD_RELATIVE_PATHS: readonly string[] = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".context/claude-code",
  ".claude/skills",
  ".claude/hooks",
  "docs/code-pact/agent-instructions.md",
  ".cursor/rules/code-pact.mdc",
  "agent-profiles/claude-code.yaml",
];
