import { buildContextPack, writeContextPack } from "../core/pack/index.ts";

export type PackOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  agentName: string;
  /** Override output root; defaults to cwd/.context/<agentName> */
  outputDir?: string;
};

export type PackResult = {
  outputPath: string;
  charCount: number;
  includedRules: string[];
  includedDecisions: string[];
};

export async function runPack(opts: PackOptions): Promise<PackResult> {
  const pack = await buildContextPack({
    cwd: opts.cwd,
    phaseId: opts.phaseId,
    taskId: opts.taskId,
    agentName: opts.agentName,
  });
  const { outputPath } = await writeContextPack(pack, {
    cwd: opts.cwd,
    agentName: opts.agentName,
    outputDir: opts.outputDir,
  });
  return {
    outputPath,
    charCount: pack.charCount,
    includedRules: pack.includedRules,
    includedDecisions: pack.includedDecisions,
  };
}
