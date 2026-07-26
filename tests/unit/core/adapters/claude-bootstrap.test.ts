import { describe, expect, it } from "vitest";
import { generateClaudeDesiredFiles } from "../../../../src/core/adapters/claude.ts";
import { claudeAdapterDescriptor } from "../../../../src/core/adapters/claude.ts";
import { DEFAULT_AGENT_PROFILES } from "../../../../src/core/agents.ts";
import { DEFAULT_MODEL_PROFILES } from "../../../../src/core/models/catalog.ts";
import { CLAUDE_MODEL_VERSIONS } from "../../../../src/core/models/catalog.ts";
import {
  BOOTSTRAP_CONTEXT_BUDGET_BYTES,
  BOOTSTRAP_CONTRACT_FROM_ADAPTER_SCHEMA_VERSION,
  BOOTSTRAP_EXCLUDED_FAILURE_CATALOG_KEYWORDS,
  BOOTSTRAP_EXCLUDED_LIFECYCLE_SURFACES,
  BOOTSTRAP_EXCLUDED_MODEL_GUIDANCE_ANCHORS,
  BOOTSTRAP_GOTCHA_SECTION_HEADING,
  BOOTSTRAP_MAX_GOTCHAS,
  BOOTSTRAP_REQUIRED_ANCHORS,
} from "../../../../src/core/adapters/conformance-spec.ts";
import type { Locale } from "../../../../src/i18n/index.ts";

const LOCALES: Locale[] = ["en-US", "ja-JP"];

// The manifest pins the instruction file's hash under `ownership: managed`, so a
// hand edit fails `file_checksum_match` and `adapter upgrade` refuses the file as
// `managed_modified`. A bootstrap that asks the reader to edit it therefore
// invites the one action its own contract rejects. Locale-specific because the
// invitation is prose, not an English-locked anchor.
const EDIT_INVITATION: Record<Locale, RegExp> = {
  "en-US": /\b(edit|replace|customi[sz]e|fill in|update) (the|these|this)\b/i,
  "ja-JP": /(編集し|置き換え|書き換え|記入し)/,
};

async function renderInstruction(
  locale: Locale,
  modelVersion?: string,
): Promise<string> {
  const files = await generateClaudeDesiredFiles({
    // A path that cannot exist: verification-command skill discovery degrades to
    // "no command skills", which keeps the instruction file the only subject.
    cwd: "/nonexistent-code-pact-bootstrap-test",
    profile: DEFAULT_AGENT_PROFILES["claude-code"],
    modelProfiles: DEFAULT_MODEL_PROFILES,
    locale,
    ...(modelVersion === undefined ? {} : { modelVersion }),
  });
  const instruction = files.find(f => f.role === "instruction");
  if (instruction === undefined) throw new Error("no instruction file rendered");
  return instruction.content;
}

describe("claude-code bootstrap instruction file", () => {
  it("declares the adapter schema version that selects the bootstrap contract", () => {
    expect(claudeAdapterDescriptor.adapterSchemaVersion).toBe(
      BOOTSTRAP_CONTRACT_FROM_ADAPTER_SCHEMA_VERSION,
    );
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      it("stays within the bootstrap context budget", async () => {
        const md = await renderInstruction(locale);
        // A Code Pact regression budget, not a published model limit: the point
        // is that a bootstrap growing back into a manual is caught here.
        expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(
          BOOTSTRAP_CONTEXT_BUDGET_BYTES,
        );
      });

      it("presents the entrypoint and the progressive-disclosure fields", async () => {
        const md = await renderInstruction(locale);
        for (const anchor of BOOTSTRAP_REQUIRED_ANCHORS) {
          expect(md).toContain(anchor);
        }
      });

      it("enumerates no lifecycle verbs beyond the entrypoint", async () => {
        const md = await renderInstruction(locale);
        for (const surface of BOOTSTRAP_EXCLUDED_LIFECYCLE_SURFACES) {
          expect(md).not.toContain(surface);
        }
      });

      it("carries no failure catalog", async () => {
        const md = await renderInstruction(locale);
        for (const keyword of BOOTSTRAP_EXCLUDED_FAILURE_CATALOG_KEYWORDS) {
          expect(md).not.toContain(keyword);
        }
      });

      it("carries no model selection guidance", async () => {
        const md = await renderInstruction(locale);
        for (const anchor of BOOTSTRAP_EXCLUDED_MODEL_GUIDANCE_ANCHORS) {
          expect(md).not.toContain(anchor);
        }
      });

      it("bounds the repository-gotcha section", async () => {
        const md = await renderInstruction(locale);
        expect(md).toContain(BOOTSTRAP_GOTCHA_SECTION_HEADING);
        const after = md.slice(
          md.indexOf(BOOTSTRAP_GOTCHA_SECTION_HEADING) +
            BOOTSTRAP_GOTCHA_SECTION_HEADING.length,
        );
        const bullets = after
          .split("\n")
          .filter(line => /^- \S/.test(line)).length;
        expect(bullets).toBeGreaterThan(0);
        expect(bullets).toBeLessThanOrEqual(BOOTSTRAP_MAX_GOTCHAS);
      });

      it("names the envelope reference rather than restating it", async () => {
        const md = await renderInstruction(locale);
        expect(md).toContain("docs/cli-contract.md");
      });

      it("asks the reader for no edit the manifest hash would reject", async () => {
        const md = await renderInstruction(locale);
        expect(md).not.toMatch(EDIT_INVITATION[locale]);
      });

      it("points repository conventions at the sources it does not own", async () => {
        const md = await renderInstruction(locale);
        expect(md).toContain("design/rules/");
      });
    });
  }

  it("renders identical bytes for every supported model version", async () => {
    const baseline = await renderInstruction("en-US");
    for (const version of CLAUDE_MODEL_VERSIONS) {
      expect(await renderInstruction("en-US", version)).toBe(baseline);
    }
    // Including a value the catalog does not know: an unknown pin must not
    // reintroduce a model-specific block either.
    expect(await renderInstruction("en-US", "opus-99.9")).toBe(baseline);
  });

  it("still generates the three built-in skills", async () => {
    const files = await generateClaudeDesiredFiles({
      cwd: "/nonexistent-code-pact-bootstrap-test",
      profile: DEFAULT_AGENT_PROFILES["claude-code"],
      modelProfiles: DEFAULT_MODEL_PROFILES,
      locale: "en-US",
    });
    expect(files.filter(f => f.role === "skill").map(f => f.path)).toEqual([
      ".claude/skills/context.md",
      ".claude/skills/verify.md",
      ".claude/skills/progress.md",
    ]);
  });
});
