import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { VerifyResult } from "../src/commands/verify.ts";
import { projectVerifyForPublicJson } from "../src/commands/verify.ts";
import {
  projectVerifyForAgent,
  stringifyBoundedAgentEnvelope,
} from "../src/core/evidence/failure-capsule.ts";

type Measurement = {
  name: string;
  raw_result_bytes: number;
  full_json_bytes: number;
  agent_json_bytes: number;
  reduction_ratio: number;
  evidence_bytes: number;
};

const OUT_PATH = join("docs", "maintainers", "measurements", "agent-detail-evidence.json");

function commandFailure(command: string, stdout: string, stderr: string): VerifyResult {
  return {
    ok: false,
    checks: [
      {
        name: "commands",
        ok: false,
        reason: `"${command}" exited with code 1`,
        command,
        stdout,
        stderr,
        exitCode: 1,
        timedOut: false,
        aborted: false,
        elapsedMs: 123,
        commands: [
          {
            command,
            ok: false,
            exitCode: 1,
            timedOut: false,
            aborted: false,
            elapsedMs: 123,
            stdout,
            stderr,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        ],
      },
    ],
  };
}

function cases(): Array<{ name: string; result: VerifyResult }> {
  const jsonWorst = `${"\0".repeat(512)}${"\\\"".repeat(512)}${"\b\f\n\r\t".repeat(512)}`;
  return [
    {
      name: "vitest_failure",
      result: commandFailure(
        "bun vitest run tests/unit/example.test.ts",
        "stdout | failing test\nexpected true to be false\n".repeat(256),
        "FAIL tests/unit/example.test.ts > rejects invalid state\nAssertionError: expected true to be false\n".repeat(256),
      ),
    },
    {
      name: "typescript_error",
      result: commandFailure(
        "pnpm typecheck",
        "",
        "src/index.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\n".repeat(256),
      ),
    },
    {
      name: "eslint_error",
      result: commandFailure(
        "pnpm lint",
        "",
        "src/index.ts\n  4:10  error  'unused' is defined but never used  no-unused-vars\n".repeat(256),
      ),
    },
    {
      name: "build_failure",
      result: commandFailure(
        "pnpm build",
        "",
        "ERROR Build failed with 1 error:\nsrc/cli.ts:10:8: Could not resolve './missing'\n".repeat(256),
      ),
    },
    {
      name: "large_stdout",
      result: commandFailure("node scripts/noisy-stdout.mjs", "stdout line\n".repeat(4096), "failed\n"),
    },
    {
      name: "large_stderr",
      result: commandFailure("node scripts/noisy-stderr.mjs", "", "stderr line\n".repeat(4096)),
    },
    {
      name: "json_escape_worst_case",
      result: commandFailure("node scripts/json-worst.mjs", jsonWorst.repeat(8), jsonWorst.repeat(8)),
    },
    {
      name: "mixed_utf8",
      result: commandFailure(
        "pnpm test:unicode",
        "日本語のstdout\nemoji-like text stays UTF-8 safe\n".repeat(256),
        "型エラー: 値 '𠮷' を処理できません\n".repeat(256),
      ),
    },
  ];
}

async function evidenceBytes(cwd: string): Promise<number> {
  const evidenceDir = join(cwd, ".code-pact", "cache", "evidence");
  let names: string[];
  try {
    names = await readdir(evidenceDir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    total += Buffer.byteLength(await readFile(join(evidenceDir, name), "utf8"), "utf8");
  }
  return total;
}

async function measure(name: string, result: VerifyResult): Promise<Measurement> {
  const cwd = await mkdtemp(join(tmpdir(), "code-pact-agent-detail-measure-"));
  try {
    await mkdir(join(cwd, ".code-pact"), { recursive: true });
    const raw = JSON.stringify(result);
    const full = `${JSON.stringify({
      ok: false,
      error: { code: "VERIFICATION_FAILED", message: "Verification failed" },
      data: { checks: projectVerifyForPublicJson(result).checks },
    })}\n`;
    const agent = stringifyBoundedAgentEnvelope({
      ok: false,
      error: { code: "VERIFICATION_FAILED", message: "Verification failed" },
      data: await projectVerifyForAgent(cwd, result),
    });
    const fullBytes = Buffer.byteLength(full, "utf8");
    const agentBytes = Buffer.byteLength(agent, "utf8");
    return {
      name,
      raw_result_bytes: Buffer.byteLength(raw, "utf8"),
      full_json_bytes: fullBytes,
      agent_json_bytes: agentBytes,
      reduction_ratio: Number((agentBytes / fullBytes).toFixed(4)),
      evidence_bytes: await evidenceBytes(cwd),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function buildAgentDetailMeasurements(): Promise<{
  schema_version: 1;
  generated_by: string;
  measurements: Measurement[];
}> {
  return {
    schema_version: 1,
    generated_by: "scripts/measure-agent-detail.ts",
    measurements: await Promise.all(cases().map(({ name, result }) => measure(name, result))),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = `${JSON.stringify(await buildAgentDetailMeasurements(), null, 2)}\n`;
  if (process.argv.includes("--write")) {
    await mkdir(join("docs", "maintainers", "measurements"), { recursive: true });
    await writeFile(OUT_PATH, output, "utf8");
  } else {
    process.stdout.write(output);
  }
}
