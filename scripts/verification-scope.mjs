#!/usr/bin/env node
// Change-aware verification scope classifier.
//
// Used by both local `pnpm verify:local` and the GitHub Actions classify job.
// No external dependencies — only Node.js built-ins and `git`.

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { runBoundedProcess } from "./lib/run-bounded-process.mjs";

const repoRoot = process.cwd();

const REPORTER_PATH = "scripts/vitest-ci-reporter.mjs";
const DEFAULT_HEARTBEAT_MS = 30_000;

const WORKFLOW_PREFIXES = [".github/workflows/"];

const WORKFLOW_TEST_MAP = {
  ".github/workflows/ci.yml": ["tests/unit/workflows/ci-workflow.test.ts"],
  ".github/workflows/publish.yml": [
    "tests/unit/workflows/publish-workflow.test.ts",
  ],
};

const WORKFLOW_COMMON_TESTS = [
  "tests/unit/scripts/check-supply-chain-invariants.test.ts",
];

const RELEASE_SCRIPT_TEST_MAP = {
  "scripts/check-release-tag.mjs": [
    "tests/unit/scripts/check-release-tag.test.ts",
  ],
  "scripts/check-release-version.mjs": [
    "tests/unit/scripts/check-release-version.test.ts",
  ],
  "scripts/check-package-tarball.mjs": [
    "tests/unit/scripts/check-package-tarball.test.ts",
  ],
  "scripts/verify-published-tarball.mjs": [
    "tests/unit/scripts/verify-published-tarball.test.ts",
  ],
  "scripts/check-npm-version-availability.mjs": [
    "tests/unit/scripts/check-npm-version-availability.test.ts",
  ],
  "scripts/verify-published-provenance.mjs": [
    "tests/unit/scripts/verify-published-provenance.test.ts",
  ],
  "scripts/check-required-ci-for-sha.mjs": [
    "tests/unit/scripts/check-required-ci-for-sha.test.ts",
  ],
};

const RELEASE_SCRIPT_COMMON_TESTS = [
  "tests/unit/workflows/publish-workflow.test.ts",
  "tests/unit/scripts/check-supply-chain-invariants.test.ts",
];

const RELEASE_SCRIPT_EXACT = [
  "scripts/check-release-tag.mjs",
  "scripts/check-release-version.mjs",
  "scripts/check-package-tarball.mjs",
  "scripts/verify-published-tarball.mjs",
  "scripts/check-npm-version-availability.mjs",
  "scripts/verify-published-provenance.mjs",
  "scripts/assert-package-metadata.mjs",
  "scripts/release-notes.mjs",
  "scripts/check-required-ci-for-sha.mjs",
];

const SHARED_TEST_INFRA_PREFIXES = [
  "tests/setup.ts",
  "tests/helpers/",
  "tests/fixtures/",
  "tests/__mocks__/",
  "tests/utils/",
];

const KNOWN_PREFIXES = [
  "src/",
  "tests/",
  "scripts/",
  "docs/",
  ".github/",
  "design/",
  ".code-pact/",
];

const KNOWN_ROOT_FILES = [
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".eslintrc",
  ".eslintrc.cjs",
  ".prettierrc",
  ".prettierrc.cjs",
  "LICENSE",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
];

// --- path classification sets ---

const DOCS_ONLY_EXACT = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "LICENSE",
  ".github/pull_request_template.md",
];

const DOCS_ONLY_PREFIXES = ["docs/", ".github/ISSUE_TEMPLATE/"];

const DOCS_GENERATOR_PREFIXES = [
  "src/cli/spec/",
  "src/contracts/",
  "scripts/gen-cli-reference.ts",
  "scripts/gen-doc-blocks.ts",
  "scripts/check-doc-",
  "scripts/check-public-md-links.ts",
  "scripts/check-history-noise.mjs",
  "scripts/changelog-archive.mjs",
];

const TOOLCHAIN_EXACT = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsup.config.ts",
  "vitest.config.ts",
  "vitest.integration.config.ts",
  "vitest.integration.smoke.config.ts",
  "scripts/check-supply-chain-invariants.mjs",
  "scripts/check-toolchain-binaries.mjs",
  "tests/unit/scripts/check-supply-chain-invariants.test.ts",
];

const TOOLCHAIN_PREFIXES = [".github/workflows/"];

const PROCESS_CONTROL_EXACT = [
  "src/lib/timeout.ts",
  "src/commands/verify.ts",
  "src/commands/task-complete.ts",
  "tests/unit/commands/verify-process.test.ts",
  "tests/integration/verify-timeout-abort.test.ts",
  "tests/unit/core/project-fs-authority-resolvers.test.ts",
];

const PROCESS_CONTROL_PREFIXES = ["src/core/process/"];

// --- pure classification helpers ---

function startsWithAny(file, prefixes) {
  return prefixes.some(prefix => file.startsWith(prefix));
}

function isDocsOnly(file) {
  if (DOCS_ONLY_EXACT.includes(file)) return true;
  return DOCS_ONLY_PREFIXES.some(
    prefix => file.startsWith(prefix) || file === prefix.replace(/\/$/, ""),
  );
}

function isDocsGenerator(file) {
  return startsWithAny(file, DOCS_GENERATOR_PREFIXES);
}

function isDocs(file) {
  return isDocsOnly(file) || isDocsGenerator(file);
}

function isToolchain(file) {
  if (TOOLCHAIN_EXACT.includes(file)) return true;
  return startsWithAny(file, TOOLCHAIN_PREFIXES);
}

function isProcessControl(file) {
  if (PROCESS_CONTROL_EXACT.includes(file)) return true;
  return startsWithAny(file, PROCESS_CONTROL_PREFIXES);
}

function isWorkflow(file) {
  return startsWithAny(file, WORKFLOW_PREFIXES);
}

function isMappedWorkflow(file) {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_TEST_MAP, file);
}

function isUnmappedWorkflow(file) {
  return isWorkflow(file) && !isMappedWorkflow(file);
}

function isReleaseScript(file) {
  if (RELEASE_SCRIPT_EXACT.includes(file)) return true;
  return (
    file.startsWith("scripts/check-release-") ||
    file.startsWith("scripts/verify-published-") ||
    file.startsWith("scripts/check-npm-version-")
  );
}

function isMappedReleaseScript(file) {
  return Object.prototype.hasOwnProperty.call(RELEASE_SCRIPT_TEST_MAP, file);
}

function isUnmappedReleaseScript(file) {
  return isReleaseScript(file) && !isMappedReleaseScript(file);
}

function isSharedTestInfra(file) {
  return SHARED_TEST_INFRA_PREFIXES.some(prefix =>
    prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix,
  );
}

function isKnown(file) {
  if (KNOWN_ROOT_FILES.includes(file)) return true;
  return KNOWN_PREFIXES.some(prefix => file.startsWith(prefix));
}

function isUnknown(file) {
  return (
    !isDocsOnly(file) &&
    !isToolchain(file) &&
    !isWorkflow(file) &&
    !isReleaseScript(file) &&
    !isProcessControl(file) &&
    !isSharedTestInfra(file) &&
    !isKnown(file)
  );
}

function isClassifier(file) {
  return (
    file === "scripts/verification-scope.mjs" ||
    file === "scripts/lib/run-bounded-process.mjs" ||
    file === REPORTER_PATH
  );
}

function isHighRisk(file) {
  if (isWorkflow(file)) return false;
  if (isReleaseScript(file)) return false;
  if (isToolchain(file) && !isWorkflow(file)) return true;
  if (isSharedTestInfra(file)) return true;
  if (isClassifier(file)) return true;
  if (isUnknown(file)) return true;
  return false;
}

function isIntegrationTest(file) {
  return file.startsWith("tests/integration/") && file.endsWith(".test.ts");
}

function isUnitTest(file) {
  return file.startsWith("tests/unit/") && file.endsWith(".test.ts");
}

function isGenericCode(file) {
  return (
    !isDocsOnly(file) &&
    !isToolchain(file) &&
    !isProcessControl(file) &&
    !isWorkflow(file) &&
    !isReleaseScript(file)
  );
}

export function classifyChangedFiles(files) {
  const changedFiles = [...new Set(files)];
  const docs = changedFiles.some(isDocs);
  const standard = changedFiles.length > 0 && !changedFiles.every(isDocsOnly);
  const toolchain = changedFiles.some(isToolchain);
  const processControl = changedFiles.some(isProcessControl);
  const generic = changedFiles.some(isGenericCode);
  const workflow = changedFiles.some(isWorkflow);
  const releaseScript = changedFiles.some(isReleaseScript);
  const sharedTestInfra = changedFiles.some(isSharedTestInfra);
  const unknown = changedFiles.some(isUnknown);
  const highRisk = changedFiles.some(isHighRisk);
  const unmappedReleaseScript = changedFiles.some(isUnmappedReleaseScript);
  const unmappedWorkflow = changedFiles.some(isUnmappedWorkflow);

  const reasons = [];
  if (highRisk) reasons.push("high-risk");
  if (processControl) reasons.push("process-control");
  if (toolchain) reasons.push("toolchain");
  if (workflow) reasons.push("workflow");
  if (releaseScript) reasons.push("release");
  if (docs) reasons.push("docs");
  if (sharedTestInfra) reasons.push("shared-test-infra");
  if (unmappedReleaseScript) reasons.push("unmapped-release-script");
  if (unmappedWorkflow) reasons.push("unmapped-workflow");
  if (
    standard &&
    !processControl &&
    !toolchain &&
    !workflow &&
    !releaseScript &&
    !highRisk
  )
    reasons.push("standard");

  const fallbackFull =
    highRisk || unknown || unmappedReleaseScript || unmappedWorkflow;
  const mode = fallbackFull ? "full" : "focused";

  return {
    changedFiles,
    docs,
    standard,
    toolchain,
    processControl,
    generic,
    workflow,
    releaseScript,
    sharedTestInfra,
    unknown,
    highRisk,
    fallbackFull,
    mode,
    reason:
      changedFiles.length === 0
        ? "no tracked changes"
        : reasons.join("+") || "standard",
  };
}

function buildFailSafeScope(files) {
  const known = classifyChangedFiles(files);

  return {
    ...known,
    docs: true,
    standard: true,
    generic: true,
    highRisk: true,
    fallbackFull: true,
    mode: "full",
    reason: "fail-safe",
  };
}

function buildFullScope(files = []) {
  return {
    changedFiles: files,
    docs: false,
    standard: true,
    toolchain: true,
    processControl: true,
    generic: true,
    workflow: true,
    releaseScript: true,
    sharedTestInfra: true,
    unknown: false,
    highRisk: true,
    fallbackFull: true,
    mode: "full",
    reason: "main full gate",
  };
}

function uniqueFiles(files) {
  return [...new Set(files)];
}

function genericFiles(files) {
  return uniqueFiles(files.filter(isGenericCode));
}

function isSubset(left, right) {
  const rightSet = new Set(right);
  return left.every(file => rightSet.has(file));
}

function hasGenericFiles(files) {
  return genericFiles(files).length > 0;
}

function getTestMode(scope, changeSet, mergeBase = null) {
  if (scope.fallbackFull || scope.highRisk || scope.unknown) return "full";
  if (changeSet.indeterminate) return "full";
  if (mergeBase === null) return "full";
  if (hasGenericFiles(changeSet.untrackedFiles ?? [])) return "full";
  return "focused";
}

function makeStep(id, scope, command, timeoutMs, reason) {
  return {
    id,
    scope,
    enabled: true,
    command,
    timeout_ms: timeoutMs,
    reason,
  };
}

function withReporter(args, forceReporter = true) {
  const hasReporter = args.some(a => a.startsWith("--reporter="));
  if (hasReporter) {
    return args.map(a =>
      a === "--reporter=agent" || a.startsWith("--reporter=")
        ? `--reporter=${REPORTER_PATH}`
        : a,
    );
  }
  if (forceReporter && args.includes("run") && args.includes("vitest")) {
    return [...args, `--reporter=${REPORTER_PATH}`];
  }
  return args;
}

function addVitestStep(steps, id, scope, program, args, timeoutMs, reason) {
  const finalArgs = withReporter(args, true);
  const command = [program, ...finalArgs];
  steps.push(makeStep(id, scope, command, timeoutMs, reason));
}

function buildUnitSteps(scope, changeSet, mergeBase) {
  const steps = [];
  if (
    !scope.generic &&
    !scope.standard &&
    !scope.processControl &&
    !scope.workflow &&
    !scope.releaseScript
  )
    return steps;

  const allChanged = uniqueFiles([
    ...(changeSet.baseFiles ?? []),
    ...(changeSet.workingTreeFiles ?? []),
    ...(changeSet.untrackedFiles ?? []),
  ]);
  const directUnitFiles = allChanged.filter(isUnitTest);
  const sourceFiles = allChanged.filter(
    f => isGenericCode(f) && !isUnitTest(f) && !isIntegrationTest(f),
  );
  const targetedUnitFiles = collectTargetedUnitTests(scope, changeSet);

  const processUnitFiles = scope.processControl
    ? uniqueFiles([
        "tests/unit/core/project-fs-authority-resolvers.test.ts",
        "tests/unit/commands/verify-process.test.ts",
        ...directUnitFiles,
      ])
    : [];

  const explicitFiles = uniqueFiles([
    ...directUnitFiles,
    ...targetedUnitFiles,
    ...processUnitFiles,
  ]);

  if (explicitFiles.length > 0) {
    addVitestStep(
      steps,
      "unit-focused",
      "focused",
      "pnpm",
      ["exec", "vitest", "run", ...explicitFiles],
      300_000,
      `focused: ${explicitFiles.length} unit test file(s)`,
    );
  }

  // When source files changed, use --changed to discover affected tests.
  if (sourceFiles.length > 0) {
    if (
      mergeBase === null ||
      changeSet.indeterminate ||
      hasGenericFiles(changeSet.untrackedFiles ?? [])
    ) {
      addVitestStep(
        steps,
        "unit",
        "full",
        "pnpm",
        ["exec", "vitest", "run"],
        480_000,
        "untracked or indeterminate: full unit tests",
      );
    } else {
      const baseGenericFiles = genericFiles(changeSet.baseFiles ?? []);
      const workingGenericFiles = genericFiles(
        changeSet.workingTreeFiles ?? [],
      );
      const hasBaseGenericFiles = baseGenericFiles.length > 0;
      const hasWorkingGenericFiles = workingGenericFiles.length > 0;

      let runBaseChanged = hasBaseGenericFiles;
      let runWorkingChanged = hasWorkingGenericFiles;

      if (hasBaseGenericFiles && hasWorkingGenericFiles) {
        if (isSubset(baseGenericFiles, workingGenericFiles)) {
          runBaseChanged = false;
        } else if (isSubset(workingGenericFiles, baseGenericFiles)) {
          runWorkingChanged = false;
        }
      }

      if (runBaseChanged) {
        addVitestStep(
          steps,
          "unit-base",
          "focused",
          "pnpm",
          [
            "exec",
            "vitest",
            "run",
            "--changed",
            mergeBase,
            "--passWithNoTests",
          ],
          300_000,
          `committed generic changes: ${baseGenericFiles.length} file(s)`,
        );
      }

      if (runWorkingChanged) {
        addVitestStep(
          steps,
          "unit-working",
          "focused",
          "pnpm",
          ["exec", "vitest", "run", "--changed", "--passWithNoTests"],
          300_000,
          `working-tree generic changes: ${workingGenericFiles.length} file(s)`,
        );
      }
    }
  }

  return steps;
}

function buildIntegrationSteps(scope, changeSet) {
  const steps = [];
  if (!scope.standard) return steps;

  const allChanged = uniqueFiles([
    ...(changeSet.baseFiles ?? []),
    ...(changeSet.workingTreeFiles ?? []),
    ...(changeSet.untrackedFiles ?? []),
  ]);
  const directIntegrationFiles = uniqueFiles(
    allChanged.filter(isIntegrationTest),
  );
  const processControlIntegrationFile =
    "tests/integration/verify-timeout-abort.test.ts";
  const processControlFiles = scope.processControl
    ? [processControlIntegrationFile]
    : [];
  const remainingDirect = directIntegrationFiles.filter(
    f => !processControlFiles.includes(f),
  );
  const sourceFiles = allChanged.filter(
    f => isGenericCode(f) && !isUnitTest(f) && !isIntegrationTest(f),
  );
  const hasSource = sourceFiles.length > 0;

  if (scope.processControl) {
    addVitestStep(
      steps,
      "integration-process-control",
      "focused",
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.integration.config.ts",
        processControlIntegrationFile,
      ],
      300_000,
      "process-control: targeted timeout-abort integration test",
    );
  }

  if (remainingDirect.length > 0) {
    addVitestStep(
      steps,
      "integration-direct",
      "focused",
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.integration.config.ts",
        ...remainingDirect,
      ],
      300_000,
      `focused: ${remainingDirect.length} changed integration test file(s)`,
    );
  }

  if (hasSource) {
    addVitestStep(
      steps,
      "integration-smoke",
      "focused",
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.integration.smoke.config.ts",
      ],
      240_000,
      "source changes: integration smoke",
    );
  }

  return steps;
}

function collectTargetedUnitTests(scope, changeSet) {
  const files = new Set();
  const allChanged = uniqueFiles([
    ...(changeSet.baseFiles ?? []),
    ...(changeSet.workingTreeFiles ?? []),
    ...(changeSet.untrackedFiles ?? []),
  ]);

  if (scope.workflow) {
    for (const file of allChanged.filter(isWorkflow)) {
      const mapped = WORKFLOW_TEST_MAP[file];
      if (mapped) {
        for (const t of mapped) files.add(t);
      }
    }
    for (const t of WORKFLOW_COMMON_TESTS) files.add(t);
  }

  if (scope.releaseScript) {
    for (const file of allChanged.filter(isReleaseScript)) {
      const mapped = RELEASE_SCRIPT_TEST_MAP[file];
      if (mapped) {
        for (const t of mapped) files.add(t);
      }
    }
    for (const t of RELEASE_SCRIPT_COMMON_TESTS) files.add(t);
  }

  return [...files];
}

function buildVersionSteps(steps) {
  steps.push(
    makeStep(
      "version-human",
      "release",
      ["node", "dist/cli.js", "--version"],
      60_000,
      "CLI version (human)",
    ),
  );
  steps.push(
    makeStep(
      "version-json",
      "release",
      ["node", "dist/cli.js", "--json", "--version"],
      60_000,
      "CLI version (JSON)",
    ),
  );
}

export function buildVerificationPlan({
  scope,
  changeSet = {},
  mergeBase = null,
  baseSha = null,
  headSha = null,
}) {
  const mode = getTestMode(scope, changeSet, mergeBase);
  const steps = [];

  if (scope.docs) {
    steps.push(
      makeStep("docs", "docs", ["pnpm", "check:docs"], 300_000, "docs"),
    );
  }

  if (mode === "full") {
    steps.push(
      makeStep(
        "supply-chain",
        "toolchain",
        ["pnpm", "check:supply-chain"],
        300_000,
        "toolchain",
      ),
    );
    steps.push(
      makeStep(
        "typecheck",
        "toolchain",
        ["pnpm", "typecheck"],
        300_000,
        "toolchain",
      ),
    );
    addVitestStep(
      steps,
      "unit",
      "full",
      "pnpm",
      ["exec", "vitest", "run"],
      480_000,
      "full fallback: all unit tests",
    );
    steps.push(
      makeStep("build", "toolchain", ["pnpm", "build"], 300_000, "toolchain"),
    );
    addVitestStep(
      steps,
      "integration-full",
      "full",
      "pnpm",
      ["exec", "vitest", "run", "--config", "vitest.integration.config.ts"],
      720_000,
      "full fallback: all integration tests",
    );
    buildVersionSteps(steps);
    return {
      schema_version: "p87-t2/1",
      base_sha: baseSha ?? mergeBase ?? null,
      head_sha: headSha ?? null,
      mode,
      fallback_full: true,
      reason: scope.reason,
      changed_files: scope.changedFiles,
      categories: {
        docs: scope.docs,
        standard: scope.standard,
        toolchain: scope.toolchain,
        process_control: scope.processControl,
        generic: scope.generic,
        workflow: scope.workflow,
        release: scope.releaseScript,
        shared_test_infra: scope.sharedTestInfra,
        unknown: scope.unknown,
        high_risk: scope.highRisk,
      },
      steps,
    };
  }

  const hasStandard =
    scope.standard ||
    scope.toolchain ||
    scope.processControl ||
    scope.workflow ||
    scope.releaseScript ||
    scope.sharedTestInfra;

  if (scope.toolchain) {
    steps.push(
      makeStep(
        "supply-chain",
        "toolchain",
        ["pnpm", "check:supply-chain"],
        300_000,
        "toolchain/workflow",
      ),
    );
  }

  if (hasStandard) {
    steps.push(
      makeStep(
        "typecheck",
        "standard",
        ["pnpm", "typecheck"],
        300_000,
        "standard",
      ),
    );
  }

  const unitSteps = buildUnitSteps(scope, changeSet, mergeBase);
  const integrationSteps = buildIntegrationSteps(scope, changeSet);

  const needsBuild = integrationSteps.length > 0;

  steps.push(...unitSteps);
  if (needsBuild) {
    steps.push(
      makeStep("build", "standard", ["pnpm", "build"], 300_000, "standard"),
    );
  }
  steps.push(...integrationSteps);

  return {
    schema_version: "p87-t2/1",
    base_sha: baseSha ?? mergeBase ?? null,
    head_sha: headSha ?? null,
    mode,
    fallback_full: scope.fallbackFull,
    reason: scope.reason,
    changed_files: scope.changedFiles,
    categories: {
      docs: scope.docs,
      standard: scope.standard,
      toolchain: scope.toolchain,
      process_control: scope.processControl,
      generic: scope.generic,
      workflow: scope.workflow,
      release: scope.releaseScript,
      shared_test_infra: scope.sharedTestInfra,
      unknown: scope.unknown,
      high_risk: scope.highRisk,
    },
    steps,
  };
}

function parseVitestProgress(stdout) {
  const startMatches = stdout.match(/\[vitest:start\]\s+(\S+)/g);
  const totalMatch = /\[vitest:total\]\s+(\d+)/.exec(stdout);
  const doneMatches = stdout.match(/\[vitest:done\]\s+(\S+)/g);
  let currentFile = null;
  if (Array.isArray(startMatches) && startMatches.length > 0) {
    const last = startMatches[startMatches.length - 1];
    const match = /\[vitest:start\]\s+(\S+)/.exec(last);
    currentFile = match ? match[1] : null;
  }
  return {
    currentFile,
    totalFiles: totalMatch ? Number(totalMatch[1]) : null,
    completedFiles: doneMatches ? doneMatches.length : 0,
  };
}

export async function runVerificationPlan(plan, options = {}) {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const commandLabel = cmd => cmd.join(" ");
  const enabledSteps = plan.steps.filter(s => s.enabled);

  let progress = {
    step: null,
    currentFile: null,
    totalFiles: null,
    completedFiles: 0,
    elapsedMs: 0,
  };

  function printHeartbeat(result, step) {
    const elapsed = result.elapsedMs;
    const remaining = step.timeout_ms - elapsed;
    const { currentFile, totalFiles, completedFiles } = parseVitestProgress(
      result.stdout,
    );
    if (currentFile) progress.currentFile = currentFile;
    if (totalFiles !== null) progress.totalFiles = totalFiles;
    progress.completedFiles = completedFiles;
    progress.elapsedMs = elapsed;

    const parts = [
      `[code-pact-ci]`,
      `step=${step.id}`,
      `elapsed=${Math.floor(elapsed / 1000)}s`,
      `remaining=${Math.max(0, Math.floor(remaining / 1000))}s`,
      `timeout=${step.timeout_ms}ms`,
      `pid=${result.pid ?? "-"}`,
    ];
    if (progress.totalFiles !== null) {
      parts.push(`files=${progress.completedFiles}/${progress.totalFiles}`);
    }
    if (progress.currentFile) {
      parts.push(`current=${progress.currentFile}`);
    }
    console.error(parts.join(" "));
  }

  for (const step of enabledSteps) {
    console.error(
      `verify:local: starting step=${step.id} scope=${step.scope} command="${commandLabel(step.command)}"`,
    );
    progress = {
      step: step.id,
      currentFile: null,
      totalFiles: null,
      completedFiles: 0,
      elapsedMs: 0,
    };

    let [program, ...args] = step.command;
    const lastHeartbeat = { at: 0 };

    if (program === "pnpm" && process.env.npm_execpath) {
      args = [process.env.npm_execpath, ...args];
      program = process.execPath;
    }

    const result = await runBoundedProcess({
      command: program,
      args,
      cwd: repoRoot,
      timeoutMs: step.timeout_ms,
      maxOutputBytes: 2 * 1024 * 1024,
      heartbeatIntervalMs: heartbeatMs,
      onProgress: result => {
        const now = Date.now();
        if (now - lastHeartbeat.at >= heartbeatMs) {
          lastHeartbeat.at = now;
          printHeartbeat(result, step);
        }
      },
    });

    if (result.stdout) {
      console.log(result.stdout);
    }
    if (result.stderr) {
      console.error(result.stderr);
    }

    if (!result.ok) {
      console.error(
        `verify:local: step=${step.id} failed after ${result.elapsedMs}ms ` +
          `(exit=${result.exitCode}, signal=${result.signal}, timedOut=${result.timedOut})`,
      );
      return { ok: false, step: step.id, result };
    }

    console.error(
      `verify:local: step=${step.id} passed in ${result.elapsedMs}ms`,
    );
  }

  console.error(`verify:local: ${enabledSteps.length} step(s) passed`);
  return { ok: true, steps: enabledSteps.length };
}

// --- git helpers ---

async function runGit(args, options = {}) {
  const result = await runBoundedProcess({
    command: "git",
    args,
    cwd: options.cwd ?? repoRoot,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
    heartbeatIntervalMs: 0,
  });

  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function resolveMergeBase(baseRef, runGitImpl = runGit) {
  const result = await runGitImpl(["merge-base", baseRef, "HEAD"]);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  if (!sha || /^0+$/.test(sha)) return null;
  return sha;
}

async function gitNameList(args, runGitImpl = runGit) {
  const result = await runGitImpl(args);
  if (result.code !== 0) {
    const command = `git ${args.join(" ")}`;
    const message = result.stderr
      ? `${result.stderr.trim()} (${command} failed)`
      : `${command} failed`;
    throw new Error(message);
  }
  return result.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}

async function mergeBaseDiffNames(baseRef, runGitImpl = runGit) {
  const mergeBase = await resolveMergeBase(baseRef, runGitImpl);
  if (!mergeBase) return { files: [], mergeBase: null };
  const files = await gitNameList(
    ["diff", "--no-renames", "--name-only", `${mergeBase}...HEAD`],
    runGitImpl,
  );
  return { files, mergeBase };
}

export async function collectLocalChangedFiles({ runGitImpl = runGit } = {}) {
  const baseFiles = new Set();
  const unstagedFiles = new Set();
  const stagedFiles = new Set();
  const untrackedFiles = new Set();
  const errors = [];
  let mergeBase = null;
  let baseResolved = false;

  // Try to find a sensible base for branch changes.
  for (const baseRef of ["origin/main", "main"]) {
    try {
      const { files: baseChangedFiles, mergeBase: mb } =
        await mergeBaseDiffNames(baseRef, runGitImpl);
      if (mb) {
        for (const f of baseChangedFiles) baseFiles.add(f);
        mergeBase = mb;
        baseResolved = true;
        break;
      }
    } catch (err) {
      errors.push(err);
      // continue to next base candidate
    }
  }

  // Always add staged, unstaged, and untracked (non-ignored) working-tree changes.
  for (const [target, args] of [
    [unstagedFiles, ["diff", "--no-renames", "--name-only"]],
    [stagedFiles, ["diff", "--no-renames", "--cached", "--name-only"]],
    [untrackedFiles, ["ls-files", "--others", "--exclude-standard"]],
  ]) {
    try {
      const names = await gitNameList(args, runGitImpl);
      for (const f of names) target.add(f);
    } catch (err) {
      errors.push(err);
    }
  }

  const workingTreeFiles = uniqueFiles([
    ...unstagedFiles,
    ...stagedFiles,
    ...untrackedFiles,
  ]);

  return {
    baseFiles: [...baseFiles],
    unstagedFiles: [...unstagedFiles],
    stagedFiles: [...stagedFiles],
    untrackedFiles: [...untrackedFiles],
    workingTreeFiles,
    files: uniqueFiles([...baseFiles, ...workingTreeFiles]),
    mergeBase,
    baseResolved,
    indeterminate: errors.length > 0,
  };
}

async function collectBaseChangedFiles(baseRef) {
  const { files, mergeBase } = await mergeBaseDiffNames(baseRef);
  return { files, mergeBase };
}

// --- command execution ---

async function resolveHeadSha(runGitImpl = runGit) {
  if (
    process.env.GITHUB_SHA &&
    /^[0-9a-f]{40}$/i.test(process.env.GITHUB_SHA)
  ) {
    return process.env.GITHUB_SHA;
  }
  const result = await runGitImpl(["rev-parse", "HEAD"]);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  if (!sha || /^0+$/.test(sha)) return null;
  return sha;
}

async function runLocalVerification(options = {}) {
  let changeSet;
  let failSafe = false;

  try {
    changeSet = await collectLocalChangedFiles();
    if (changeSet.indeterminate || !changeSet.baseResolved) failSafe = true;
  } catch (err) {
    console.error(
      `verify:local: failed to determine changed files: ${err.message}`,
    );
    changeSet = {
      indeterminate: true,
      baseFiles: [],
      workingTreeFiles: [],
      untrackedFiles: [],
      files: [],
      mergeBase: null,
      baseResolved: false,
    };
    failSafe = true;
  }

  if (!failSafe && changeSet.files.length === 0) {
    console.log("verify:local: no tracked changes");
    process.exit(0);
  }

  const scope = failSafe
    ? buildFailSafeScope(changeSet.files)
    : classifyChangedFiles(changeSet.files);

  const headSha = await resolveHeadSha();
  const baseSha = failSafe ? null : changeSet.mergeBase;

  const plan = buildVerificationPlan({
    scope,
    changeSet,
    mergeBase: changeSet.mergeBase,
    baseSha,
    headSha,
  });

  console.log(
    `verify:local: scope=${scope.reason} mode=${plan.mode} steps=${plan.steps.length}`,
  );

  if (options.writePlan) {
    writeFileSync(options.writePlan, JSON.stringify(plan, null, 2) + "\n");
    console.error(`verify:local: wrote plan to ${options.writePlan}`);
  }

  if (plan.steps.length === 0) {
    console.log("verify:local: 0 checks passed");
    process.exit(0);
  }

  const run = await runVerificationPlan(plan, {
    heartbeatMs: options.heartbeatMs,
  });
  if (!run.ok) {
    process.exit(1);
  }

  console.log(
    `verify:local: ${run.steps} check${run.steps === 1 ? "" : "s"} passed`,
  );
}

async function runBaseVerification(baseRef, options = {}) {
  const forceFull = options.forceFull === true;
  let files = [];
  let mergeBase = null;
  let changeSet = {
    baseFiles: [],
    workingTreeFiles: [],
    untrackedFiles: [],
    files: [],
  };
  let failSafe = false;

  try {
    const collected = await collectBaseChangedFiles(baseRef);
    files = collected.files;
    mergeBase = collected.mergeBase;
    if (mergeBase === null) failSafe = true;
    changeSet = {
      baseFiles: files,
      workingTreeFiles: [],
      untrackedFiles: [],
      indeterminate: mergeBase === null,
    };
  } catch (err) {
    console.error(
      `verify: failed to determine changed files for base ${baseRef}: ${err.message}`,
    );
    failSafe = true;
  }

  if (!forceFull && !failSafe && files.length === 0) {
    console.log("verify: no tracked changes");
    process.exit(0);
  }

  const scope = forceFull
    ? buildFullScope(files)
    : failSafe
      ? buildFailSafeScope(files)
      : classifyChangedFiles(files);

  const headSha = await resolveHeadSha();
  const plan = buildVerificationPlan({
    scope,
    changeSet,
    mergeBase,
    baseSha: mergeBase,
    headSha,
  });

  console.log(
    `verify: scope=${scope.reason} mode=${plan.mode} steps=${plan.steps.length}`,
  );

  if (options.writePlan) {
    writeFileSync(options.writePlan, JSON.stringify(plan, null, 2) + "\n");
    console.error(`verify: wrote plan to ${options.writePlan}`);
  }

  if (plan.steps.length === 0) {
    console.log("verify: 0 checks passed");
    process.exit(0);
  }

  const run = await runVerificationPlan(plan, {
    heartbeatMs: options.heartbeatMs,
  });
  if (!run.ok) {
    process.exit(1);
  }

  console.log(`verify: ${run.steps} check${run.steps === 1 ? "" : "s"} passed`);
}

// --- output formatters ---

function outputGitHub(scope) {
  const env = process.env.GITHUB_OUTPUT;
  const lines = [
    `docs=${scope.docs}`,
    `standard=${scope.standard}`,
    `fallback_full=${scope.fallbackFull}`,
  ];

  if (env) {
    writeFileSync(env, `${lines.join("\n")}\n`, { flag: "a" });
  }

  console.log(lines.join("\n"));
}

// --- CLI ---

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      format: { type: "string", default: "json" },
      local: { type: "boolean", default: false },
      run: { type: "boolean", default: false },
      commands: { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
      "write-plan": { type: "string" },
      "heartbeat-ms": { type: "string" },
      "force-full": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const heartbeatMs = values["heartbeat-ms"]
    ? Number(values["heartbeat-ms"])
    : DEFAULT_HEARTBEAT_MS;

  if (values.run && values.local) {
    await runLocalVerification({
      writePlan: values["write-plan"],
      heartbeatMs,
    });
    return;
  }

  if (values.run && values.base) {
    await runBaseVerification(values.base, {
      writePlan: values["write-plan"],
      heartbeatMs,
      forceFull: values["force-full"],
    });
    return;
  }

  if (values.run) {
    console.error("verify: --run requires --local or --base <ref>");
    process.exit(2);
  }

  let files;
  let mergeBase;
  let baseResolved;
  let failSafe = false;
  let changeSet;

  if (values.local) {
    try {
      const collected = await collectLocalChangedFiles();
      files = collected.files;
      mergeBase = collected.mergeBase;
      baseResolved = collected.baseResolved;
      changeSet = collected;
      if (collected.indeterminate || !baseResolved) failSafe = true;
    } catch (err) {
      console.error(
        `verify:local: failed to determine changed files: ${err.message}`,
      );
      files = [];
      mergeBase = null;
      baseResolved = false;
      changeSet = {
        baseFiles: [],
        workingTreeFiles: [],
        untrackedFiles: [],
        indeterminate: true,
      };
      failSafe = true;
    }
  } else if (values.base) {
    try {
      const collected = await collectBaseChangedFiles(values.base);
      files = collected.files;
      mergeBase = collected.mergeBase;
      baseResolved = mergeBase !== null;
      changeSet = {
        baseFiles: files,
        workingTreeFiles: [],
        untrackedFiles: [],
        indeterminate: mergeBase === null,
      };
      if (mergeBase === null) failSafe = true;
    } catch (err) {
      console.error(
        `verify: failed to determine changed files for base ${values.base}: ${err.message}`,
      );
      files = [];
      mergeBase = null;
      baseResolved = false;
      changeSet = {
        baseFiles: [],
        workingTreeFiles: [],
        untrackedFiles: [],
        indeterminate: true,
      };
      failSafe = true;
    }
  } else {
    console.error("verify: pass --local or --base <ref>");
    process.exit(2);
  }

  const scope = failSafe
    ? buildFailSafeScope(files)
    : classifyChangedFiles(files);

  const headSha = await resolveHeadSha();

  const plan = buildVerificationPlan({
    scope,
    changeSet,
    mergeBase,
    baseSha: baseResolved ? mergeBase : null,
    headSha,
  });

  if (values.commands) {
    console.log(
      JSON.stringify(
        {
          scope: { ...scope, changedFiles: files, mergeBase },
          commands: plan.steps.map(s => s.command),
          failSafe,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (values.plan || values["write-plan"]) {
    if (values["write-plan"]) {
      writeFileSync(values["write-plan"], JSON.stringify(plan, null, 2) + "\n");
      console.error(`verify: wrote plan to ${values["write-plan"]}`);
    }
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (values.format === "github") {
    outputGitHub(scope);
  } else {
    console.log(JSON.stringify(scope, null, 2));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
