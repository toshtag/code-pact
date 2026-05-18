import type { Phase } from "../../schemas/phase.ts";
import type { Task } from "../../schemas/task.ts";
import type { ProgressEvent } from "../../schemas/progress-event.ts";

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

  // 6. Related decisions
  if (ctx.decisions.length > 0) {
    sections.push(`## Related Decisions`);
    for (const dec of ctx.decisions) {
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
