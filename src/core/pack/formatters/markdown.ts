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

export function renderMarkdown(ctx: PackContext): string {
  const sections: string[] = [];

  // 1. Header
  sections.push(
    `# Context Pack — ${ctx.phase.id} / ${ctx.task.id}`,
    ``,
    `**Agent:** ${ctx.agentName}  `,
    `**Phase:** ${ctx.phase.id} — ${ctx.phase.name}  `,
    `**Task:** ${ctx.task.id}`,
    ``,
  );

  // 2. Constitution (context_size: large | ambiguity: high)
  if (ctx.constitution) {
    sections.push(`## Project Constitution`, ``, ctx.constitution.trim(), ``);
  }

  // 3. Applicable rules
  if (ctx.rules.length > 0) {
    sections.push(`## Rules`);
    for (const rule of ctx.rules) {
      sections.push(``, `### ${rule.filename}`, ``, rule.body.trim());
    }
    sections.push(``);
  }

  // 4. Phase contract
  sections.push(
    `## Phase Contract`,
    ``,
    `**Objective:** ${ctx.phase.objective.trim()}`,
    ``,
    `**Definition of Done:**`,
    ...ctx.phase.definition_of_done.map((d) => `- ${d}`),
    ``,
  );

  if (ctx.phase.non_goals && ctx.phase.non_goals.length > 0) {
    sections.push(
      `**Non-Goals:**`,
      ...ctx.phase.non_goals.map((g) => `- ${g}`),
      ``,
    );
  }

  // 5. Task definition
  sections.push(
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
  );

  if (ctx.task.description) {
    sections.push(`**Description:** ${ctx.task.description}`, ``);
  }

  // 6a. Depends on — task-declared dependencies, P10. Each id is shown
  // with its current derived state from progress.yaml.
  if (ctx.dependsOn && ctx.dependsOn.length > 0) {
    sections.push(`## Depends on`, ``);
    for (const dep of ctx.dependsOn) {
      sections.push(`- **${dep.id}** — ${dep.current}`);
    }
    sections.push(``);
  }

  // 6b. Declared read surface — P10. Each glob is shown with the set of
  // currently-matched files under it; file contents are not inlined in
  // P10 (declaration-only). An empty matches list is rendered as a
  // visible "no matches" line so the agent sees the lint warning's
  // counterpart in pack form.
  if (ctx.readMatches && ctx.readMatches.length > 0) {
    sections.push(`## Declared read surface`, ``);
    for (const entry of ctx.readMatches) {
      sections.push(`- \`${entry.glob}\``);
      if (entry.matches.length === 0) {
        sections.push(`  - _(no current matches on disk)_`);
      } else {
        for (const m of entry.matches) {
          sections.push(`  - \`${m}\``);
        }
      }
    }
    sections.push(``);
  }

  // 6c. Declared write surface — P10. Globs only; existence is by
  // definition future-tense for writes, so no fs lookup is done.
  if (ctx.writeGlobs && ctx.writeGlobs.length > 0) {
    sections.push(`## Declared write surface`, ``);
    for (const g of ctx.writeGlobs) {
      sections.push(`- \`${g}\``);
    }
    sections.push(``);
  }

  // 6d. Declared decisions — P10. Full content of files referenced by
  // task.decision_refs, inserted under each filename. Surfaced
  // regardless of context_size. The existing context_size:large
  // allDecisions path (rendered in section 6e) is filtered to avoid
  // re-printing files already shown here.
  if (ctx.declaredDecisions && ctx.declaredDecisions.length > 0) {
    sections.push(`## Declared decisions`);
    for (const dec of ctx.declaredDecisions) {
      sections.push(``, `### ${dec.filename}`, ``, dec.body.trim());
    }
    sections.push(``);
  }

  // 6e. Acceptance references — P10. Path list only in P10; no content
  // excerpt and no semantic validation (deferred to P11 reconcile).
  if (ctx.acceptanceRefs && ctx.acceptanceRefs.length > 0) {
    sections.push(`## Acceptance references`, ``);
    for (const p of ctx.acceptanceRefs) {
      sections.push(`- \`${p}\``);
    }
    sections.push(``);
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
    sections.push(`## Related Decisions`);
    for (const dec of relatedDecisions) {
      sections.push(``, `### ${dec.filename}`, ``, dec.body.trim());
    }
    sections.push(``);
  }

  // 7. Completed tasks in this phase (ambiguity: high)
  if (ctx.doneEvents && ctx.doneEvents.length > 0) {
    sections.push(`## Completed Tasks in This Phase`, ``);
    for (const ev of ctx.doneEvents) {
      const agent = ev.agent ? ` by ${ev.agent}` : "";
      const evidence = ev.evidence && ev.evidence.length > 0
        ? `\n  Evidence: ${ev.evidence.join(", ")}`
        : "";
      sections.push(`- **${ev.task_id}** — done at ${ev.at}${agent}${evidence}`);
    }
    sections.push(``);
  }

  // 8. Verification commands
  sections.push(
    `## Verification Commands`,
    ``,
    ...ctx.phase.verification.commands.map((c) => `\`\`\`\n${c}\n\`\`\``),
    ``,
  );

  // 9. Progress event schema hint
  sections.push(
    `## Progress Event`,
    ``,
    `When this task is complete, record an event in \`.code-pact/state/progress.yaml\`:`,
    ``,
    `\`\`\`yaml`,
    `events:`,
    `  - task_id: ${ctx.task.id}`,
    `    status: done`,
    `    at: "<ISO8601 with offset>"`,
    `    actor: agent`,
    `    evidence:`,
    `      - <verification command or artifact>`,
    `\`\`\``,
    ``,
  );

  return sections.join("\n");
}
