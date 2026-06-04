import type { Phase } from "../../schemas/phase.ts";
import type { Task } from "../../schemas/task.ts";
import type { ProgressEvent } from "../../schemas/progress-event.ts";
import type { TaskCurrentState } from "../../progress/task-state.ts";

export type PackContext = {
  phase: Phase;
  task: Task;
  agentName: string;
  rules: RuleDoc[];
  decisions: DecisionDoc[];
  /** design/constitution.md content — included when context_size:large or ambiguity:high */
  constitution?: string | null;
  /** Recent done events in this phase — included when ambiguity:high */
  doneEvents?: ProgressEvent[];
  // P10 — Task Readiness Schema declared-section data. Each field is
  // optional; when absent the corresponding pack section is omitted
  // entirely so output stays byte-identical to v1.0.2 for tasks that
  // declare none of the new fields.
  dependsOn?: DependsOnEntry[];
  readMatches?: ReadGlobMatches[];
  writeGlobs?: string[];
  declaredDecisions?: DecisionDoc[];
  acceptanceRefs?: string[];
};

export type RuleDoc = {
  filename: string;
  tags: string[];
  applies_to: string[];
  body: string;
};

export type DecisionDoc = {
  filename: string;
  body: string;
};

export type DependsOnEntry = {
  id: string;
  /**
   * Derived state from progress.yaml. `"unknown"` is reserved for ids
   * that fail to resolve at all — this should not occur because the
   * lint surface (`TASK_DEPENDS_ON_UNRESOLVED`) catches missing ids
   * before pack time, but the type tolerates the case so the renderer
   * never throws.
   */
  current: TaskCurrentState | "unknown";
};

export type ReadGlobMatches = {
  glob: string;
  matches: string[];
};

/**
 * Internal intermediate representation produced by `renderSections`.
 *
 * Each entry corresponds to one logical section of the context pack.
 * `lines` is the array of strings that will be joined by `"\n"` when
 * the pack is rendered to disk. `name` is a stable identifier used by
 * the explain machinery to attach reason codes to each section.
 *
 * The sum of `Buffer.byteLength(lines.join("\n"), "utf8")` over every
 * section, plus `(sections.length - 1)` (the inter-section newlines
 * introduced by the final `join`), equals the byte length of the
 * rendered content. The `format_overhead` section in the explain
 * output captures the inter-section newline byte count so consumers
 * see a clean `sum(sections[].bytes) === total_bytes` invariant.
 */
export type RenderedSection = {
  /** Stable identifier — see SECTION_NAMES for the closed set. */
  name: string;
  /** Optional extra detail (e.g. glob match count, decision filename). */
  details?: Record<string, unknown>;
  /** Lines that will be joined by `"\n"`. */
  lines: string[];
};

/**
 * Build the structured sections that compose the rendered context
 * pack. The renderer is byte-identical to v1.0.2 — joining the
 * concatenation of every section's lines with `"\n"` produces exactly
 * the same string `renderMarkdown` returned in v1.10.
 */
export function renderSections(ctx: PackContext): RenderedSection[] {
  const sections: RenderedSection[] = [];

  // 1. Header
  sections.push({
    name: "header",
    lines: [
      `# Context Pack — ${ctx.phase.id} / ${ctx.task.id}`,
      ``,
      `**Agent:** ${ctx.agentName}  `,
      `**Phase:** ${ctx.phase.id} — ${ctx.phase.name}  `,
      `**Task:** ${ctx.task.id}`,
      ``,
    ],
  });

  // 2. Constitution (context_size: large | ambiguity: high)
  if (ctx.constitution) {
    sections.push({
      name: "constitution",
      lines: [`## Project Constitution`, ``, ctx.constitution.trim(), ``],
    });
  }

  // 3. Applicable rules
  if (ctx.rules.length > 0) {
    const lines: string[] = [`## Rules`];
    for (const rule of ctx.rules) {
      lines.push(``, `### ${rule.filename}`, ``, rule.body.trim());
    }
    lines.push(``);
    sections.push({
      name: "rules",
      details: { rule_count: ctx.rules.length },
      lines,
    });
  }

  // 4. Phase contract
  const phaseContractLines: string[] = [
    `## Phase Contract`,
    ``,
    `**Objective:** ${ctx.phase.objective.trim()}`,
    ``,
    `**Definition of Done:**`,
    ...ctx.phase.definition_of_done.map((d) => `- ${d}`),
    ``,
  ];

  if (ctx.phase.non_goals && ctx.phase.non_goals.length > 0) {
    phaseContractLines.push(
      `**Non-Goals:**`,
      ...ctx.phase.non_goals.map((g) => `- ${g}`),
      ``,
    );
  }
  sections.push({ name: "phase_contract", lines: phaseContractLines });

  // 5. Task definition
  const taskDefinitionLines: string[] = [
    `## Task Definition`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| ID | ${ctx.task.id} |`,
    `| Type | ${ctx.task.type} |`,
    `| Ambiguity | ${ctx.task.ambiguity} |`,
    `| Risk | ${ctx.task.risk} |`,
    `| Context size | ${ctx.task.context_size} |`,
    `| Write surface | ${ctx.task.write_surface} |`,
    `| Verification | ${ctx.task.verification_strength} |`,
    `| Expected duration | ${ctx.task.expected_duration} |`,
    `| Status | ${ctx.task.status} |`,
    ``,
  ];

  if (ctx.task.description) {
    taskDefinitionLines.push(`**Description:** ${ctx.task.description}`, ``);
  }
  sections.push({ name: "task_definition", lines: taskDefinitionLines });

  // 6a. Depends on — task-declared dependencies, P10. Each id is shown
  // with its current derived state from progress.yaml.
  if (ctx.dependsOn && ctx.dependsOn.length > 0) {
    const lines: string[] = [`## Depends on`, ``];
    for (const dep of ctx.dependsOn) {
      lines.push(`- **${dep.id}** — ${dep.current}`);
    }
    lines.push(``);
    sections.push({
      name: "depends_on",
      details: { count: ctx.dependsOn.length },
      lines,
    });
  }

  // 6b. Declared read surface — P10. Each glob is shown with the set of
  // currently-matched files under it; file contents are not inlined in
  // P10 (declaration-only). An empty matches list is rendered as a
  // visible "no matches" line so the agent sees the lint warning's
  // counterpart in pack form.
  if (ctx.readMatches && ctx.readMatches.length > 0) {
    const lines: string[] = [`## Declared read surface`, ``];
    let totalMatches = 0;
    for (const entry of ctx.readMatches) {
      lines.push(`- \`${entry.glob}\``);
      if (entry.matches.length === 0) {
        lines.push(`  - _(no current matches on disk)_`);
      } else {
        for (const m of entry.matches) {
          lines.push(`  - \`${m}\``);
        }
      }
      totalMatches += entry.matches.length;
    }
    lines.push(``);
    sections.push({
      name: "reads",
      details: {
        glob_count: ctx.readMatches.length,
        match_count: totalMatches,
      },
      lines,
    });
  }

  // 6c. Declared write surface — P10. Globs only; existence is by
  // definition future-tense for writes, so no fs lookup is done.
  if (ctx.writeGlobs && ctx.writeGlobs.length > 0) {
    const lines: string[] = [`## Declared write surface`, ``];
    for (const g of ctx.writeGlobs) {
      lines.push(`- \`${g}\``);
    }
    lines.push(``);
    sections.push({
      name: "writes",
      details: { glob_count: ctx.writeGlobs.length },
      lines,
    });
  }

  // 6d. Declared decisions — P10. Full content of files referenced by
  // task.decision_refs, inserted under each filename. Surfaced
  // regardless of context_size. The existing context_size:large
  // allDecisions path (rendered in section 6e) is filtered to avoid
  // re-printing files already shown here.
  if (ctx.declaredDecisions && ctx.declaredDecisions.length > 0) {
    const lines: string[] = [`## Declared decisions`];
    for (const dec of ctx.declaredDecisions) {
      lines.push(``, `### ${dec.filename}`, ``, dec.body.trim());
    }
    lines.push(``);
    sections.push({
      name: "declared_decisions",
      details: {
        count: ctx.declaredDecisions.length,
        filenames: ctx.declaredDecisions.map((d) => d.filename),
      },
      lines,
    });
  }

  // 6e. Acceptance references — P10. Path list only in P10; no content
  // excerpt and no semantic validation (deferred to P11 reconcile).
  if (ctx.acceptanceRefs && ctx.acceptanceRefs.length > 0) {
    const lines: string[] = [`## Acceptance references`, ``];
    for (const p of ctx.acceptanceRefs) {
      lines.push(`- \`${p}\``);
    }
    lines.push(``);
    sections.push({
      name: "acceptance_refs",
      details: { count: ctx.acceptanceRefs.length },
      lines,
    });
  }

  // 6. Related decisions — existing v1.0 path (task-id filename match
  // and the context_size:large allDecisions case). Deduped against
  // declared decisions so content is not printed twice when a file is
  // both referenced and matched.
  const declaredNames = new Set(
    (ctx.declaredDecisions ?? []).map((d) => d.filename),
  );
  const relatedDecisions = ctx.decisions.filter(
    (d) => !declaredNames.has(d.filename),
  );
  if (relatedDecisions.length > 0) {
    const lines: string[] = [`## Related Decisions`];
    for (const dec of relatedDecisions) {
      lines.push(``, `### ${dec.filename}`, ``, dec.body.trim());
    }
    lines.push(``);
    sections.push({
      name: "related_decisions",
      details: { count: relatedDecisions.length },
      lines,
    });
  }

  // 7. Completed tasks in this phase (ambiguity: high)
  if (ctx.doneEvents && ctx.doneEvents.length > 0) {
    const lines: string[] = [`## Completed Tasks in This Phase`, ``];
    for (const ev of ctx.doneEvents) {
      const agent = ev.agent ? ` by ${ev.agent}` : "";
      const evidence =
        ev.evidence && ev.evidence.length > 0
          ? `\n  Evidence: ${ev.evidence.join(", ")}`
          : "";
      lines.push(`- **${ev.task_id}** — done at ${ev.at}${agent}${evidence}`);
    }
    lines.push(``);
    sections.push({
      name: "completed_tasks",
      details: { count: ctx.doneEvents.length },
      lines,
    });
  }

  // 8. Verification commands
  sections.push({
    name: "verification_commands",
    lines: [
      `## Verification Commands`,
      ``,
      ...ctx.phase.verification.commands.map((c) => `\`\`\`\n${c}\n\`\`\``),
      ``,
    ],
  });

  // 9. Progress recording hint — command-guided. The ledger is a set of
  // per-event files under .code-pact/state/events/; agents record via the CLI,
  // never by hand-editing the ledger.
  sections.push({
    name: "progress_event_schema",
    lines: [
      `## Recording progress`,
      ``,
      `Do NOT hand-write the ledger. When this task is complete, record it with:`,
      ``,
      `\`\`\`sh`,
      `code-pact task complete ${ctx.task.id} --agent <agent>`,
      `\`\`\``,
      ``,
      `If the work was completed outside the loop, record it with evidence instead:`,
      ``,
      `\`\`\`sh`,
      `code-pact task record-done ${ctx.task.id} --evidence "<verification command or artifact>"`,
      `\`\`\``,
      ``,
      `Either writes one merge-safe event file under \`.code-pact/state/events/\`.`,
      ``,
    ],
  });

  return sections;
}

/**
 * Section elision PRIORITY for `--budget-bytes` (P24).
 *
 * When `buildContextPack` is invoked with `budgetBytes`, sections are
 * dropped from the rendered output in this order until the total byte
 * count falls at or below the budget. Sections NOT listed here are
 * unelidable — they are either always-included or carry task-declared
 * intent the user explicitly opted into.
 *
 * This constant is the priority ORDER only. Elision ELIGIBILITY is
 * conditional (P28, enforced in `applyBudgetElision`): `related_decisions`
 * is elidable only when it is the `context_size: large` "all decisions"
 * expansion, and `rules` only when it is the `write_surface: high` "all
 * rules" expansion. The applies_to-matched / task-id-matched subsets that
 * appear outside those expansions are never elided.
 *
 * Locked by `design/decisions/context-budget-rfc.md`. New entries or
 * eligibility changes require an RFC amendment.
 */
export const ELISION_ORDER: ReadonlyArray<string> = [
  "completed_tasks",
  "related_decisions",
  "constitution",
  "rules",
  "reads",
];

/**
 * Render the context pack to a single Markdown string.
 *
 * Byte-identical contract: for any input that produced a given output
 * in v1.10, this function MUST produce the same bytes in v1.11. The
 * contract is locked by
 * `tests/integration/pack-byte-identical.test.ts`.
 */
export function renderMarkdown(ctx: PackContext): string {
  const sections = renderSections(ctx);
  return sections.flatMap((s) => s.lines).join("\n");
}
