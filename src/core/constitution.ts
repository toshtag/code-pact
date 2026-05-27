import type { LocaleCode } from "./schemas/locale.ts";
import { messages as messageCatalog } from "../i18n/index.ts";

// ---------------------------------------------------------------------------
// Constitution template — single source of truth
//
// `init` writes a placeholder constitution; `doctor` warns while it is still
// the unedited placeholder; `plan constitution` may overwrite that placeholder
// without --force. All three must agree on what "the generated placeholder"
// is, so the template and its detection live here rather than being
// re-derived (and drifting) in each command.
// ---------------------------------------------------------------------------

/**
 * The exact constitution `init` generates for a project. `plan constitution`
 * compares against this (normalized) to decide whether an existing file is the
 * pristine placeholder it may replace, or a user edit it must protect.
 */
export function renderInitConstitution(projectName: string, locale: LocaleCode): string {
  const t = messageCatalog[locale].templates.constitution;
  return [
    `# ${projectName} — Constitution`,
    "",
    t.description,
    "",
    `## ${t.corePrinciplesHeader}`,
    "",
    ...t.principles.map((p) => `- ${p}`),
    "",
    `> ${t.editHint}`,
  ].join("\n");
}

/**
 * The editHint line from every locale's constitution template. A constitution
 * still containing one is (heuristically) unedited — used by `doctor`'s
 * CONSTITUTION_PLACEHOLDER warning. Derived from the catalog so a new locale
 * cannot silently fall out of the marker set.
 */
export const CONSTITUTION_PLACEHOLDER_MARKERS: readonly string[] = Object.values(
  messageCatalog,
).map((m) => m.templates.constitution.editHint);

function normalizeConstitution(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/**
 * True iff `content` is the pristine `init`-generated placeholder for this
 * project (byte-identical after whitespace normalization). Marker presence
 * alone is intentionally NOT enough: a user who edited the body but left the
 * edit-hint line must be treated as having a real constitution, so
 * `plan constitution` will not silently overwrite their work without --force.
 */
export function isPristineInitConstitution(
  content: string,
  projectName: string,
  locale: LocaleCode,
): boolean {
  return (
    normalizeConstitution(content) ===
    normalizeConstitution(renderInitConstitution(projectName, locale))
  );
}
