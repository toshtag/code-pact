/**
 * Provenance marker for dynamic generated skill files.
 *
 * Dynamic skill files (e.g. `.claude/skills/adapter-doctor.md`) live in a
 * shared namespace with hand-authored user skills. To distinguish files WE
 * generated from user-authored ones, every generated skill starts with an
 * HTML comment provenance marker:
 *
 *   <!-- code-pact:generated skill="name" command="cmd" -->
 *
 * This module provides functions to:
 * - Check if a file's first line is a code-pact provenance marker.
 * - Extract the provenance metadata (skill name, command) from the marker.
 * - Compare provenance against expected values to determine if a file is
 *   stale (our marker but outdated content) or foreign (no marker / user-authored).
 *
 * The provenance check reads ONLY the first line — it never reads the full
 * file content, so a user-authored file's content is never inspected beyond
 * the first line (which is either our marker or it isn't).
 */

const PROVENANCE_PREFIX = "<!-- code-pact:generated";
const PROVENANCE_REGEX =
  /^<!-- code-pact:generated skill="([^"]*)" command="([^"]*)" -->$/;

export type ProvenanceInfo = {
  skill: string;
  command: string;
};

export type ProvenanceStatus =
  | { kind: "ours"; info: ProvenanceInfo }
  | { kind: "foreign" }
  | { kind: "empty" };

/**
 * Check the first line of a file for a code-pact provenance marker.
 * Returns:
 * - `ours` if the first line is a valid code-pact provenance marker.
 * - `foreign` if the first line exists but is NOT our marker.
 * - `empty` if the file content is empty or whitespace-only.
 */
export function checkProvenance(firstLine: string): ProvenanceStatus {
  const trimmed = firstLine.trim();
  if (trimmed === "") return { kind: "empty" };
  if (!trimmed.startsWith(PROVENANCE_PREFIX)) return { kind: "foreign" };
  const match = PROVENANCE_REGEX.exec(trimmed);
  if (!match) return { kind: "foreign" };
  return {
    kind: "ours",
    info: { skill: match[1]!, command: match[2]! },
  };
}

/**
 * Compare provenance info against expected values.
 * Returns true if the provenance marker matches the expected skill name
 * and command string.
 */
export function provenanceMatches(
  info: ProvenanceInfo,
  expectedSkill: string,
  expectedCommand: string,
): boolean {
  return info.skill === expectedSkill && info.command === expectedCommand;
}

/**
 * Extract provenance info from the first line of generated content.
 * Returns null if the content does not start with a provenance marker.
 */
export function extractProvenanceFromContent(
  content: string,
): ProvenanceInfo | null {
  const firstLine = content.split("\n")[0] ?? "";
  const status = checkProvenance(firstLine);
  if (status.kind === "ours") return status.info;
  return null;
}

/**
 * Check if the provenance info from an existing file matches the provenance
 * in the desired (newly generated) content. This compares only the marker
 * metadata (skill name + command), not the full file content.
 */
export function provenanceContentMatches(
  existingInfo: ProvenanceInfo,
  desiredContent: string,
): boolean {
  const desiredInfo = extractProvenanceFromContent(desiredContent);
  if (desiredInfo === null) return false;
  return (
    existingInfo.skill === desiredInfo.skill &&
    existingInfo.command === desiredInfo.command
  );
}

/**
 * Build the provenance marker line for a generated skill.
 */
export function buildProvenanceMarker(
  skillName: string,
  command: string,
): string {
  return `<!-- code-pact:generated skill="${skillName}" command="${command.replace(/"/g, "&quot;")}" -->`;
}
