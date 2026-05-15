import type { Phase } from "../../schemas/phase.ts";
import type { Task } from "../../schemas/task.ts";

export type PackContext = {
  phase: Phase;
  task: Task;
  agentName: string;
  rules: RuleDoc[];
  decisions: DecisionDoc[];
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

  // 2. Applicable rules
  if (ctx.rules.length > 0) {
    sections.push(`## Rules`);
    for (const rule of ctx.rules) {
      sections.push(``, `### ${rule.filename}`, ``, rule.body.trim());
    }
    sections.push(``);
  }

  // 3. Phase contract
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

  // 4. Task definition
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

  // 5. Related decisions
  if (ctx.decisions.length > 0) {
    sections.push(`## Related Decisions`);
    for (const dec of ctx.decisions) {
      sections.push(``, `### ${dec.filename}`, ``, dec.body.trim());
    }
    sections.push(``);
  }

  // 6. Verification commands
  sections.push(
    `## Verification Commands`,
    ``,
    ...ctx.phase.verification.commands.map((c) => `\`\`\`\n${c}\n\`\`\``),
    ``,
  );

  // 7. Progress event schema hint
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
