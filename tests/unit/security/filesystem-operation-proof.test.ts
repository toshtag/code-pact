import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAdapterConformance } from "../../../src/commands/adapter-conformance.ts";
import { runAdapterDoctor } from "../../../src/commands/adapter-doctor.ts";
import { atomicWriteText } from "../../../src/io/atomic-text.ts";

type FsOperation = {
  operation: string;
  path: string;
  destination?: string;
};

// Spy on ALL filesystem operations that could leak content or mutate state.
// This includes FileHandle methods (returned by open()) that bypass the
// top-level fs/promises spies.
const spies = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  access: vi.fn(),
  cp: vi.fn(),
  copyFile: vi.fn(),
  // FileHandle method spies
  fhRead: vi.fn(),
  fhReadFile: vi.fn(),
  fhWrite: vi.fn(),
  fhWriteFile: vi.fn(),
  fhClose: vi.fn(),
  fhTruncate: vi.fn(),
  fhSync: vi.fn(),
  fhDatasync: vi.fn(),
  fhAppendFile: vi.fn(),
  fhChmod: vi.fn(),
  fhChown: vi.fn(),
  fhUtimes: vi.fn(),
  operations: [] as FsOperation[],
}));

vi.mock("node:fs/promises", async importActual => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      spies.operations.push({ operation: "readFile", path: String(args[0]) });
      spies.readFile(String(args[0]));
      return actual.readFile(...args);
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      spies.operations.push({ operation: "stat", path: String(args[0]) });
      spies.stat(String(args[0]));
      return actual.stat(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      spies.operations.push({ operation: "lstat", path: String(args[0]) });
      spies.lstat(String(args[0]));
      return actual.lstat(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      spies.operations.push({ operation: "unlink", path: String(args[0]) });
      spies.unlink(String(args[0]));
      return actual.unlink(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      spies.operations.push({ operation: "writeFile", path: String(args[0]) });
      spies.writeFile(String(args[0]));
      return actual.writeFile(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      spies.operations.push({ operation: "readdir", path: String(args[0]) });
      spies.readdir(String(args[0]));
      return actual.readdir(...args);
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      spies.operations.push({ operation: "mkdir", path: String(args[0]) });
      spies.mkdir(String(args[0]));
      return actual.mkdir(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      spies.operations.push({ operation: "open", path: String(args[0]) });
      spies.open(String(args[0]));
      const fh = await actual.open(...args);
      // Wrap FileHandle methods to track reads/writes via open().
      return new Proxy(fh, {
        get(target, prop, receiver) {
          const val = Reflect.get(target, prop, receiver);
          if (typeof val !== "function") return val;
          const fhSpyMap: Record<string, ((path: string) => void) | undefined> =
            {
              read: spies.fhRead,
              readFile: spies.fhReadFile,
              write: spies.fhWrite,
              writeFile: spies.fhWriteFile,
              close: spies.fhClose,
              truncate: spies.fhTruncate,
              sync: spies.fhSync,
              datasync: spies.fhDatasync,
              appendFile: spies.fhAppendFile,
              chmod: spies.fhChmod,
              chown: spies.fhChown,
              utimes: spies.fhUtimes,
            };
          const spy = fhSpyMap[String(prop)];
          if (spy) {
            return (...fhArgs: unknown[]) => {
              spies.operations.push({
                operation: `FileHandle.${String(prop)}`,
                path: String(args[0]),
              });
              spy(String(args[0]));
              return val.apply(target, fhArgs);
            };
          }
          return val.bind(target);
        },
      });
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      spies.operations.push({
        operation: "rename_from",
        path: String(args[0]),
        destination: String(args[1]),
      });
      spies.operations.push({
        operation: "rename_to",
        path: String(args[1]),
        destination: String(args[0]),
      });
      spies.rename(String(args[0]));
      spies.rename(String(args[1]));
      return actual.rename(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      spies.operations.push({ operation: "rm", path: String(args[0]) });
      spies.rm(String(args[0]));
      return actual.rm(...args);
    },
    access: async (...args: Parameters<typeof actual.access>) => {
      spies.operations.push({ operation: "access", path: String(args[0]) });
      spies.access(String(args[0]));
      return actual.access(...args);
    },
    cp: async (...args: Parameters<typeof actual.cp>) => {
      spies.operations.push({
        operation: "copy_from",
        path: String(args[0]),
        destination: String(args[1]),
      });
      spies.operations.push({
        operation: "copy_to",
        path: String(args[1]),
        destination: String(args[0]),
      });
      spies.cp(String(args[0]));
      spies.cp(String(args[1]));
      return actual.cp(...args);
    },
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      spies.operations.push({
        operation: "copy_from",
        path: String(args[0]),
        destination: String(args[1]),
      });
      spies.operations.push({
        operation: "copy_to",
        path: String(args[1]),
        destination: String(args[0]),
      });
      spies.copyFile(String(args[0]));
      spies.copyFile(String(args[1]));
      return actual.copyFile(...args);
    },
  };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-fs-proof-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function targetOps(target: string): {
  read: string[];
  stat: string[];
  lstat: string[];
  unlink: string[];
  write: string[];
  readdir: string[];
  mkdir: string[];
  open: string[];
  rename: string[];
  rm: string[];
  access: string[];
  cp: string[];
  copyFile: string[];
} {
  return {
    read: spies.readFile.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
    stat: spies.stat.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
    lstat: spies.lstat.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
    unlink: spies.unlink.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
    write: spies.writeFile.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
    readdir: spies.readdir.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
    mkdir: spies.mkdir.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
    open: spies.open.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
    rename: spies.rename.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
    rm: spies.rm.mock.calls.map(([p]) => String(p)).filter(p => p === target),
    access: spies.access.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
    cp: spies.cp.mock.calls.map(([p]) => String(p)).filter(p => p === target),
    copyFile: spies.copyFile.mock.calls
      .map(([p]) => String(p))
      .filter(p => p === target),
  };
}

function resetSpies() {
  spies.readFile.mockClear();
  spies.stat.mockClear();
  spies.lstat.mockClear();
  spies.unlink.mockClear();
  spies.writeFile.mockClear();
  spies.readdir.mockClear();
  spies.mkdir.mockClear();
  spies.open.mockClear();
  spies.rename.mockClear();
  spies.rm.mockClear();
  spies.access.mockClear();
  spies.cp.mockClear();
  spies.copyFile.mockClear();
  spies.fhRead.mockClear();
  spies.fhReadFile.mockClear();
  spies.fhWrite.mockClear();
  spies.fhWriteFile.mockClear();
  spies.fhClose.mockClear();
  spies.fhTruncate.mockClear();
  spies.fhSync.mockClear();
  spies.fhDatasync.mockClear();
  spies.fhAppendFile.mockClear();
  spies.fhChmod.mockClear();
  spies.fhChown.mockClear();
  spies.fhUtimes.mockClear();
  spies.operations.length = 0;
}

const VALID_CONTRACT_BODY = `# Some Adapter

> Managed file.

## How to work on a task

Some workflow text.

## Agent contract

The canonical workflow.

### When to invoke code-pact

Per task:

\`\`\`sh
code-pact task prepare <task-id> --agent claude-code --json
code-pact task start    <task-id> --agent claude-code
code-pact task context <task-id> --agent claude-code
code-pact task complete <task-id> --agent claude-code
code-pact task finalize <task-id> --write --json
code-pact verify --phase <p> --task <task-id>
code-pact validate --json
\`\`\`

Activation rules:

- Run \`task finalize --write\` only after \`task complete\`.
- If \`next_action.type\` is \`wait_for_dependencies\`, do not implement.
- On \`CONTEXT_OVER_BUDGET\`, report rather than widen.

### What to verify first

- run verify
- check the audit
- Read \`data.recommendation\`; let \`lifecycleMode\` pick the loop. When the runtime cannot switch model, report the limitation.
- \`record_only\` is a lighter loop, not lighter verification — run verification, then \`task record-done\`.

### How to handle failures

- **blocked dependency** — wait or resume.
- **verification failure** — fix and re-run.
- **adapter drift** — re-upgrade.
- **missing context pack** — task prepare rebuilds it.
`;

async function setupAdapterWithForgedFiles(
  dir: string,
  files: Array<{
    path: string;
    content: string;
    role: "instruction" | "skill" | "hook" | "rule";
    sha256: string;
  }>,
): Promise<void> {
  await mkdir(join(dir, ".code-pact", "adapters"), { recursive: true });
  // Always write a valid CLAUDE.md so conformance has an instruction file.
  await writeFile(join(dir, "CLAUDE.md"), VALID_CONTRACT_BODY, "utf8");
  for (const f of files) {
    const target = join(dir, f.path);
    const parent = join(target, "..");
    await mkdir(parent, { recursive: true });
    await writeFile(target, f.content, "utf8");
  }
  const yamlLines = [
    `schema_version: 1`,
    `agent_name: claude-code`,
    `generator_version: 1.11.0`,
    `adapter_schema_version: 1`,
    `generated_at: "2026-05-22T00:00:00+00:00"`,
    `profile_fingerprint:`,
    `  instruction_filename: CLAUDE.md`,
    `  context_dir: .context/claude-code`,
    `files:`,
    `  - path: CLAUDE.md`,
    `    sha256: "${require("node:crypto").createHash("sha256").update(VALID_CONTRACT_BODY.replace(/\r\n/g, "\n"), "utf8").digest("hex")}"`,
    `    managed: true`,
    `    role: instruction`,
  ];
  for (const f of files) {
    yamlLines.push(
      `  - path: ${f.path}`,
      `    sha256: "${f.sha256}"`,
      `    managed: true`,
      `    role: ${f.role}`,
    );
  }
  yamlLines.push("");
  await writeFile(
    join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
    yamlLines.join("\n"),
    "utf8",
  );
}

describe("filesystem operation proof — conformance", () => {
  it("records atomicWriteText temp writes and rename direction separately", async () => {
    const target = join(dir, "atomic.txt");

    resetSpies();
    await atomicWriteText(target, "hello");

    const tempOpen = spies.operations.find(
      op =>
        op.operation === "open" &&
        op.path.startsWith(`${target}.tmp-`) &&
        op.path !== target,
    );
    expect(tempOpen).toBeDefined();
    expect(
      spies.operations.some(
        op =>
          op.operation === "FileHandle.writeFile" &&
          op.path.startsWith(`${target}.tmp-`),
      ),
    ).toBe(true);
    expect(spies.operations).toContainEqual(
      expect.objectContaining({
        operation: "rename_to",
        path: target,
      }),
    );
    expect(
      spies.operations.some(
        op =>
          op.operation === "rename_from" &&
          op.path.startsWith(`${target}.tmp-`) &&
          op.destination === target,
      ),
    ).toBe(true);
  });

  it("never reads/stats an unowned .env file listed in a forged manifest", async () => {
    const envPath = join(dir, ".env");
    const envContent = "API_TOKEN=secret\n";
    await setupAdapterWithForgedFiles(dir, [
      {
        path: ".env",
        content: envContent,
        role: "instruction",
        sha256: "0".repeat(64),
      },
    ]);

    resetSpies();
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    expect(result.compliant).toBe(false);

    const ops = targetOps(envPath);
    expect(ops.read).toEqual([]);
    expect(ops.stat).toEqual([]);
    expect(ops.lstat).toEqual([]);
    expect(ops.unlink).toEqual([]);
    expect(ops.write).toEqual([]);
    expect(ops.readdir).toEqual([]);
    expect(ops.mkdir).toEqual([]);
    expect(ops.open).toEqual([]);
    expect(ops.rename).toEqual([]);
    expect(ops.rm).toEqual([]);
    expect(ops.access).toEqual([]);
    expect(ops.cp).toEqual([]);
    expect(ops.copyFile).toEqual([]);
  });

  it("never reads/stats a role-swapped owned path (CLAUDE.md with role: skill)", async () => {
    // CLAUDE.md exists but the manifest declares role: skill — conformance
    // should find no instruction entry and fail early without reading CLAUDE.md
    // for heading inspection.
    await mkdir(join(dir, ".code-pact", "adapters"), { recursive: true });
    await writeFile(join(dir, "CLAUDE.md"), VALID_CONTRACT_BODY, "utf8");
    const crypto = require("node:crypto");
    const hash = crypto
      .createHash("sha256")
      .update(VALID_CONTRACT_BODY.replace(/\r\n/g, "\n"), "utf8")
      .digest("hex");
    const yaml = [
      `schema_version: 1`,
      `agent_name: claude-code`,
      `generator_version: 1.11.0`,
      `adapter_schema_version: 1`,
      `generated_at: "2026-05-22T00:00:00+00:00"`,
      `profile_fingerprint:`,
      `  instruction_filename: CLAUDE.md`,
      `  context_dir: .context/claude-code`,
      `files:`,
      `  - path: CLAUDE.md`,
      `    sha256: "${hash}"`,
      `    managed: true`,
      `    role: skill`,
      ``,
    ].join("\n");
    await writeFile(
      join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
      yaml,
      "utf8",
    );

    resetSpies();
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    expect(result.compliant).toBe(false);

    const ops = targetOps(join(dir, "CLAUDE.md"));
    // CLAUDE.md should NOT be read for heading/contract inspection.
    expect(ops.read).toEqual([]);
    // No writes or deletes.
    expect(ops.write).toEqual([]);
    expect(ops.unlink).toEqual([]);
    expect(ops.readdir).toEqual([]);
    expect(ops.mkdir).toEqual([]);
    expect(ops.open).toEqual([]);
    expect(ops.rename).toEqual([]);
    expect(ops.rm).toEqual([]);
    expect(ops.access).toEqual([]);
  });

  it("never reads/stats a symlinked owned path (CLAUDE.md → real-claude.md)", async () => {
    const realTarget = join(dir, "real-claude.md");
    const symlinkPath = join(dir, "CLAUDE.md");
    const content = "# private target\n";
    await writeFile(realTarget, content, "utf8");
    await symlink("real-claude.md", symlinkPath);
    await mkdir(join(dir, ".code-pact", "adapters"), { recursive: true });
    const crypto = require("node:crypto");
    const hash = crypto
      .createHash("sha256")
      .update(content.replace(/\r\n/g, "\n"), "utf8")
      .digest("hex");
    const yaml = [
      `schema_version: 1`,
      `agent_name: claude-code`,
      `generator_version: 1.11.0`,
      `adapter_schema_version: 1`,
      `generated_at: "2026-05-22T00:00:00+00:00"`,
      `profile_fingerprint:`,
      `  instruction_filename: CLAUDE.md`,
      `  context_dir: .context/claude-code`,
      `files:`,
      `  - path: CLAUDE.md`,
      `    sha256: "${hash}"`,
      `    managed: true`,
      `    role: instruction`,
      ``,
    ].join("\n");
    await writeFile(
      join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
      yaml,
      "utf8",
    );

    resetSpies();
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    expect(result.compliant).toBe(false);

    // Neither the symlink nor its target should be read.
    const symlinkOps = targetOps(symlinkPath);
    const targetOps2 = targetOps(realTarget);
    expect(symlinkOps.read).toEqual([]);
    expect(targetOps2.read).toEqual([]);
    expect(symlinkOps.write).toEqual([]);
    expect(symlinkOps.unlink).toEqual([]);
    expect(symlinkOps.readdir).toEqual([]);
    expect(symlinkOps.mkdir).toEqual([]);
    expect(symlinkOps.open).toEqual([]);
    expect(symlinkOps.rename).toEqual([]);
    expect(symlinkOps.rm).toEqual([]);
    expect(symlinkOps.access).toEqual([]);
    expect(targetOps2.readdir).toEqual([]);
    expect(targetOps2.mkdir).toEqual([]);
    expect(targetOps2.open).toEqual([]);
    expect(targetOps2.rename).toEqual([]);
    expect(targetOps2.rm).toEqual([]);
    expect(targetOps2.access).toEqual([]);
  });

  it("never reads/stats a protected-namespace path in a forged manifest", async () => {
    const protectedPath = join(dir, ".code-pact", "project.yaml");
    const protectedContent = "schema_version: 1\nagent_name: claude-code\n";
    await setupAdapterWithForgedFiles(dir, [
      {
        path: ".code-pact/project.yaml",
        content: protectedContent,
        role: "instruction",
        sha256: "0".repeat(64),
      },
    ]);

    resetSpies();
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    expect(result.compliant).toBe(false);

    const ops = targetOps(protectedPath);
    expect(ops.read).toEqual([]);
    expect(ops.stat).toEqual([]);
    expect(ops.lstat).toEqual([]);
    expect(ops.unlink).toEqual([]);
    expect(ops.write).toEqual([]);
    expect(ops.readdir).toEqual([]);
    expect(ops.mkdir).toEqual([]);
    expect(ops.open).toEqual([]);
    expect(ops.rename).toEqual([]);
    expect(ops.rm).toEqual([]);
    expect(ops.access).toEqual([]);
    expect(ops.cp).toEqual([]);
    expect(ops.copyFile).toEqual([]);
  });
});

describe("filesystem operation proof — doctor", () => {
  it("never reads/stats an unowned .env file during doctor", async () => {
    const envPath = join(dir, ".env");
    const envContent = "API_TOKEN=secret\n";
    await setupAdapterWithForgedFiles(dir, [
      {
        path: ".env",
        content: envContent,
        role: "instruction",
        sha256: "0".repeat(64),
      },
    ]);

    resetSpies();
    await runAdapterDoctor({
      cwd: dir,
      agentName: "claude-code",
      locale: "en-US",
    });

    const ops = targetOps(envPath);
    expect(ops.read).toEqual([]);
    expect(ops.stat).toEqual([]);
    expect(ops.lstat).toEqual([]);
    expect(ops.unlink).toEqual([]);
    expect(ops.write).toEqual([]);
    expect(ops.readdir).toEqual([]);
    expect(ops.mkdir).toEqual([]);
    expect(ops.open).toEqual([]);
    expect(ops.rename).toEqual([]);
    expect(ops.rm).toEqual([]);
    expect(ops.access).toEqual([]);
    expect(ops.cp).toEqual([]);
    expect(ops.copyFile).toEqual([]);
  });

  it("never reads a dynamic skill in the shared namespace during doctor", async () => {
    const skillPath = join(dir, ".claude", "skills", "deploy.md");
    const skillContent = "# hand-authored deploy notes\n";
    await setupAdapterWithForgedFiles(dir, [
      {
        path: ".claude/skills/deploy.md",
        content: skillContent,
        role: "skill",
        sha256: "f".repeat(64),
      },
    ]);

    resetSpies();
    await runAdapterDoctor({
      cwd: dir,
      agentName: "claude-code",
      locale: "en-US",
    });

    const ops = targetOps(skillPath);
    expect(ops.read).toEqual([]);
    expect(ops.unlink).toEqual([]);
    expect(ops.write).toEqual([]);
    expect(ops.readdir).toEqual([]);
    expect(ops.mkdir).toEqual([]);
    expect(ops.open).toEqual([]);
    expect(ops.rename).toEqual([]);
    expect(ops.rm).toEqual([]);
    expect(ops.access).toEqual([]);
  });

  it("FileHandle methods are tracked — no fhRead/fhWrite on unowned paths", async () => {
    const envPath = join(dir, ".env");
    const envContent = "API_TOKEN=secret\n";
    await setupAdapterWithForgedFiles(dir, [
      {
        path: ".env",
        content: envContent,
        role: "instruction",
        sha256: "0".repeat(64),
      },
    ]);

    resetSpies();
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    expect(result.compliant).toBe(false);

    // No FileHandle methods should be called on the .env path.
    expect(spies.fhRead.mock.calls.map(c => c[0])).not.toContain(envPath);
    expect(spies.fhReadFile.mock.calls.map(c => c[0])).not.toContain(envPath);
    expect(spies.fhWrite.mock.calls.map(c => c[0])).not.toContain(envPath);
    expect(spies.fhWriteFile.mock.calls.map(c => c[0])).not.toContain(envPath);
    expect(spies.fhAppendFile.mock.calls.map(c => c[0])).not.toContain(envPath);
    expect(spies.fhTruncate.mock.calls.map(c => c[0])).not.toContain(envPath);
  });
});
