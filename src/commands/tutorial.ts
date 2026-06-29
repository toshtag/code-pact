import { mkdtemp, rm } from "../core/project-fs/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocaleCode } from "../core/schemas/locale.ts";
import { messages as messageCatalog } from "../i18n/index.ts";
import { runInitCore } from "./init.ts";
import { runTaskPrepare } from "./task-prepare.ts";
import { runTaskStart } from "./task-progress.ts";
import { runTaskComplete } from "./task-complete.ts";
import { runTaskFinalize } from "./task-finalize.ts";

/**
 * `code-pact tutorial` walks the per-task loop end to end against a
 * throwaway sandbox so a first-time user can watch the real commands run
 * — and the real output — without writing anything to their own project.
 *
 * Everything happens in a freshly-`mkdtemp`'d directory that is deleted in
 * a `finally` block. Because it drives the same service-layer functions
 * the CLI uses (`runInitCore`, `runTaskPrepare`, …) the narrated output
 * cannot drift from real behaviour: there are no canned example strings.
 */

export type TutorialStep = {
  /** The literal command being demonstrated, e.g. "task prepare TUTORIAL-T1". */
  command: string;
  /** One-line plain-language description of what the step does. */
  explanation: string;
  /** Salient outcome of running the step. */
  result: string;
};

export type TutorialResult = {
  /** Absolute path of the sandbox that was used. */
  sandbox: string;
  /** Whether the sandbox was left on disk (`--keep`). */
  kept: boolean;
  steps: TutorialStep[];
};

export type TutorialOptions = {
  locale: LocaleCode;
  /** Output sink for human narration. Defaults to process.stdout. */
  write?: (s: string) => void;
  /** When true, suppress prose; the caller emits the JSON envelope. */
  json?: boolean;
  /** When true, do not delete the sandbox (debugging). Default false. */
  keep?: boolean;
  /** Override the sandbox parent directory (tests). Defaults to os.tmpdir(). */
  sandboxParent?: string;
};

const AGENT = "claude-code";
const T1 = "TUTORIAL-T1";
const T2 = "TUTORIAL-T2";
// A verification command that always exits 0, on both POSIX sh and Windows
// cmd (verify runs it through `spawn(..., { shell: true })`). The sandbox
// has no test suite, so the real verify command is irrelevant here.
const SANDBOX_VERIFY = "exit 0";

export async function runTutorial(opts: TutorialOptions): Promise<TutorialResult> {
  const t = messageCatalog[opts.locale].tutorial;
  const out = opts.write ?? ((s: string) => process.stdout.write(s));
  const human = opts.json !== true;
  const steps: TutorialStep[] = [];

  const emit = (step: TutorialStep): void => {
    steps.push(step);
    if (human) {
      out(`\n▶ code-pact ${step.command}\n  ${step.explanation}\n  → ${step.result}\n`);
    }
  };

  const sandbox = await mkdtemp(join(opts.sandboxParent ?? tmpdir(), "code-pact-tutorial-"));
  let kept = false;

  try {
    if (human) out(`${t.header}\n${t.sandboxNote(sandbox)}\n`);

    // 1. init (with the sample TUTORIAL phase) — the starting point.
    const initResult = await runInitCore({
      cwd: sandbox,
      locale: opts.locale,
      agents: [AGENT],
      force: false,
      json: true,
      createSamplePhase: true,
      verifyCommand: SANDBOX_VERIFY,
    });
    emit({
      command: "init --sample-phase",
      explanation: t.step.init,
      result: t.result.init(initResult.created.length),
    });

    // 2. prepare T1 — the single per-task entry point.
    const prepareT1 = await runTaskPrepare({ cwd: sandbox, taskId: T1, agent: AGENT });
    emit({
      command: `task prepare ${T1}`,
      explanation: t.step.prepareT1,
      result: t.result.prepare(prepareT1.current_state, prepareT1.next_action.type),
    });

    // 3. start T1.
    await runTaskStart({ cwd: sandbox, taskId: T1, agent: AGENT });
    emit({
      command: `task start ${T1}`,
      explanation: t.step.start,
      result: t.result.started,
    });

    // 4. prepare T2 while T1 is unfinished — demonstrates the dependency gate.
    const prepareT2Blocked = await runTaskPrepare({ cwd: sandbox, taskId: T2, agent: AGENT });
    emit({
      command: `task prepare ${T2}`,
      explanation: t.step.prepareT2Blocked,
      result: t.result.blocked(prepareT2Blocked.blocked_by.join(", ") || T1),
    });

    // 5. complete T1 — runs verify, records a `done` event on pass.
    const complete = await runTaskComplete({ cwd: sandbox, taskId: T1, agent: AGENT });
    const checkCount = complete.kind === "done" ? complete.verify.checks.length : 0;
    emit({
      command: `task complete ${T1}`,
      explanation: t.step.complete,
      result: t.result.completed(checkCount),
    });

    // 6. finalize T1 — reconcile the design state.
    await runTaskFinalize({ cwd: sandbox, taskId: T1, write: true });
    emit({
      command: `task finalize ${T1} --write`,
      explanation: t.step.finalize,
      result: t.result.finalized,
    });

    // 7. prepare T2 again — now unblocked.
    const prepareT2Ready = await runTaskPrepare({ cwd: sandbox, taskId: T2, agent: AGENT });
    emit({
      command: `task prepare ${T2}`,
      explanation: t.step.prepareT2Ready,
      result: t.result.prepare(prepareT2Ready.current_state, prepareT2Ready.next_action.type),
    });

    if (opts.keep === true) {
      kept = true;
      if (human) out(`\n✔ ${t.keptNote(sandbox)}\n  ${t.realNextSteps}\n`);
    } else if (human) {
      out(`\n✔ ${t.done}\n  ${t.realNextSteps}\n`);
    }

    return { sandbox, kept, steps };
  } finally {
    if (opts.keep !== true) {
      await rm(sandbox, { recursive: true, force: true });
    }
  }
}
