#!/usr/bin/env node
// Change-aware verification scope classifier.
//
// Used by both local `pnpm verify:local` and the GitHub Actions classify job.
// No external dependencies — only Node.js built-ins and `git`.

import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { runBoundedProcess } from "./lib/run-bounded-process.mjs";

const repoRoot = process.cwd();

const REPORTER_PATH = "scripts/vitest-ci-reporter.mjs";
const DEFAULT_HEARTBEAT_MS = 30_000;
const LEDGER_DIR = ".code-pact/cache/verification-runs";
const LEDGER_FILE = `${LEDGER_DIR}/ledger.jsonl`;
const MAX_FULL_ATTEMPTS = 2;

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
    file === "scripts/verification-scope.d.mts" ||
    file === "scripts/lib/run-bounded-process.mjs" ||
    file === REPORTER_PATH ||
    file === "scripts/vitest-ci-reporter.d.mts"
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

function isProductionSource(file) {
  return (
    isGenericCode(file) &&
    (file.startsWith("src/") ||
      (file.startsWith("scripts/") && /\.[cm]?[jt]s$/.test(file)))
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

  const classifierChanged = changedFiles.some(isClassifier);
  const workflowChanged = changedFiles.some(isWorkflow);
  const testRunnerBaseChanged = changedFiles.some(isSharedTestInfra);
  const toolchainOnlyChanged = changedFiles.some(
    f => isToolchain(f) && !isWorkflow(f) && !isSharedTestInfra(f),
  );
  const unknownChanged = changedFiles.some(isUnknown);

  const fallbackReason = classifierChanged
    ? "verification_classifier_changed"
    : workflowChanged
      ? "workflow_changed"
      : testRunnerBaseChanged
        ? "test_runner_base_changed"
        : toolchainOnlyChanged
          ? "toolchain_changed"
          : unknownChanged
            ? "unknown_path"
            : unmappedReleaseScript
              ? "unmapped_release_script"
              : unmappedWorkflow
                ? "unmapped_workflow"
                : null;

  const fallbackFull =
    classifierChanged ||
    workflowChanged ||
    testRunnerBaseChanged ||
    toolchainOnlyChanged ||
    unknownChanged ||
    unmappedReleaseScript ||
    unmappedWorkflow;
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
    fallbackReason,
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
    fallbackReason: "fail_safe",
    mode: "full",
    reason: "fail-safe",
  };
}

function buildFullScope(files = []) {
  return {
    changedFiles: files,
    docs: true,
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
    fallbackReason: "main_full_gate",
    mode: "full",
    reason: "main full gate",
  };
}

function uniqueFiles(files) {
  return [...new Set(files)];
}

function genericFiles(files) {
  return uniqueFiles(files.filter(isProductionSource));
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
  if (
    forceReporter &&
    args.includes("vitest") &&
    (args.includes("run") || args.includes("related"))
  ) {
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
  const sourceFiles = allChanged.filter(isProductionSource);
  const untrackedFiles = new Set(changeSet.untrackedFiles ?? []);
  const directUnitFilesToRun =
    sourceFiles.length === 0
      ? directUnitFiles
      : directUnitFiles.filter(file => untrackedFiles.has(file));
  const targetedUnitFiles = collectTargetedUnitTests(scope, changeSet);

  const processUnitFiles = scope.processControl
    ? uniqueFiles([
        "tests/unit/core/project-fs-authority-resolvers.test.ts",
        "tests/unit/commands/verify-process.test.ts",
        ...directUnitFilesToRun,
      ])
    : [];

  const explicitFiles = uniqueFiles([
    ...directUnitFilesToRun,
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
      explicitFiles.length > 0 ||
      mergeBase === null ||
      changeSet.indeterminate ||
      hasGenericFiles(changeSet.untrackedFiles ?? [])
    ) {
      addVitestStep(
        steps,
        "unit-related",
        "focused",
        "pnpm",
        [
          "exec",
          "vitest",
          "related",
          ...sourceFiles,
          "--run",
          "--passWithNoTests",
        ],
        300_000,
        `related selection: ${sourceFiles.length} source file(s)`,
      );
    } else {
      const sourceFileSet = new Set(sourceFiles);
      const baseGenericFiles = uniqueFiles(
        (changeSet.baseFiles ?? []).filter(file => sourceFileSet.has(file)),
      );
      const workingGenericFiles = uniqueFiles(
        (changeSet.workingTreeFiles ?? []).filter(file =>
          sourceFileSet.has(file),
        ),
      );
      const hasBaseGenericFiles = baseGenericFiles.length > 0;
      const hasWorkingGenericFiles = workingGenericFiles.length > 0;

      if (hasBaseGenericFiles) {
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
          `changed/affected tests since base: ${uniqueFiles([
            ...baseGenericFiles,
            ...workingGenericFiles,
          ]).length} source file(s)`,
        );
      } else if (hasWorkingGenericFiles) {
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
  const sourceFiles = allChanged.filter(isProductionSource);
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

function countSelectedUnitTests(steps) {
  if (steps.some(s => s.id === "unit")) return null;
  if (
    steps.some(
      s =>
        s.id === "unit-base" ||
        s.id === "unit-working" ||
        s.id === "unit-related",
    )
  )
    return null;
  const selected = new Set(
    steps
      .filter(s => s.id === "unit-focused")
      .flatMap(s => s.command.filter(arg => arg.startsWith("tests/unit/"))),
  );
  return selected.size;
}

function countSelectedIntegrationTests(steps) {
  if (
    steps.some(
      s => s.id === "integration-full" || s.id === "integration-smoke",
    )
  )
    return null;
  const selected = new Set(
    steps
      .filter(
        s =>
          s.id === "integration-direct" ||
          s.id === "integration-process-control",
      )
      .flatMap(s =>
        s.command.filter(arg => arg.startsWith("tests/integration/")),
      ),
  );
  return selected.size;
}

function finalizePlan({
  steps,
  mode,
  planStage,
  scope,
  changeSet,
  mergeBase,
  baseSha,
  headSha,
}) {
  return {
    schema_version: "p87-t3/1",
    base_sha: baseSha ?? mergeBase ?? null,
    head_sha: headSha ?? null,
    mode,
    stage: planStage,
    fallback_full: scope.fallbackFull,
    fallback_reason: scope.fallbackReason ?? null,
    reason: scope.reason,
    changed_files: scope.changedFiles,
    selected_unit_tests: countSelectedUnitTests(steps),
    selected_integration_tests: countSelectedIntegrationTests(steps),
    command_count: steps.length,
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
    scope: {
      ...scope,
      changedFiles: scope.changedFiles,
    },
    change_set: changeSet,
    steps,
  };
}

export function buildVerificationPlan({
  scope,
  changeSet = {},
  mergeBase = null,
  baseSha = null,
  headSha = null,
  stage = null,
}) {
  if (stage !== null && stage !== "focused" && stage !== "full") {
    throw new Error(
      `PLAN_INVALID: stage must be "focused" or "full", received ${String(stage)}`,
    );
  }
  const mode = getTestMode(scope, changeSet, mergeBase);
  const planStage = stage ?? mode;
  const steps = [];

  if (scope.docs) {
    steps.push(
      makeStep("docs", "docs", ["pnpm", "check:docs"], 300_000, "docs"),
    );
  }

  if (planStage === "full") {
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
    return finalizePlan({
      steps,
      mode,
      planStage,
      scope,
      changeSet,
      mergeBase,
      baseSha,
      headSha,
    });
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

  return finalizePlan({
    steps,
    mode,
    planStage,
    scope,
    changeSet,
    mergeBase,
    baseSha,
    headSha,
  });
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

function parseVitestFiles(stdout, stderr = "") {
  const combined = `${stdout}\n${stderr}`;
  const totalMatch = /\[vitest:total\]\s+(\d+)/.exec(combined);
  const total = totalMatch ? Number(totalMatch[1]) : null;
  const starts = [...combined.matchAll(/\[vitest:start\]\s+(\S+)/g)].map(
    match => match[1],
  );
  const selected = new Set(total === null ? starts : starts.slice(0, total));
  const failedCandidates = new Set();
  for (const match of combined.matchAll(
    /\[vitest:failed\]\s+(\S+?)(?::|\s|$)/g,
  )) {
    failedCandidates.add(match[1]);
  }
  for (const match of combined.matchAll(
    /\[vitest:done\]\s+(\S+)\s+\S+ms\s+fail(?:ed)?/g,
  )) {
    failedCandidates.add(match[1]);
  }
  const failed = [...failedCandidates].filter(
    file => selected.size === 0 || selected.has(file),
  );

  return {
    selected: [...selected],
    failed,
  };
}

function formatDuration(ms) {
  if (ms === undefined || ms === null) return "-";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes > 0) return `${minutes}m ${remSeconds}s`;
  return `${remSeconds}s`;
}

function writeGitHubSummary(plan, stepResults, fullAttemptCount) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  const totalMs = stepResults.reduce((sum, s) => sum + (s.elapsedMs ?? 0), 0);
  const observedFiles = new Set(stepResults.flatMap(s => s.testFiles ?? []));
  const observedUnit = [...observedFiles].filter(isUnitTest).length;
  const observedIntegration =
    [...observedFiles].filter(isIntegrationTest).length;
  const ranUnit = stepResults.some(s => s.id.startsWith("unit"));
  const ranIntegration = stepResults.some(s => s.id.startsWith("integration"));
  const unitCount = ranUnit
    ? String(observedUnit)
    : plan.selected_unit_tests === null
      ? "-"
      : String(plan.selected_unit_tests);
  const intCount = ranIntegration
    ? String(observedIntegration)
    : plan.selected_integration_tests === null
      ? "-"
      : String(plan.selected_integration_tests);

  const lines = [
    "## Verification summary",
    "",
    `| Key | Value |`,
    `|---|---|`,
    `| Mode | ${plan.mode} |`,
    `| Stage | ${plan.stage} |`,
    `| Fallback full | ${plan.fallback_full} |`,
    `| Fallback reason | ${plan.fallback_reason ?? "-"} |`,
    `| Changed files | ${plan.changed_files.length} |`,
    `| Unit tests selected | ${unitCount} |`,
    `| Integration tests selected | ${intCount} |`,
    `| Commands | ${plan.steps.length} |`,
    `| Full-suite attempt count | ${fullAttemptCount} |`,
    `| Total duration | ${formatDuration(totalMs)} |`,
    "",
    "### Steps",
    "",
    `| Step | Scope | Duration | Reason |`,
    `|---|---|---|---|`,
    ...stepResults.map(
      s =>
        `| ${s.id} | ${s.scope} | ${formatDuration(s.elapsedMs)} | ${s.reason} |`,
    ),
    "",
  ];

  writeFileSync(summaryFile, lines.join("\n"), { flag: "a" });
}

function buildFocusedNextPlan(plan) {
  if (!plan.scope || !plan.change_set) return null;
  const nextScope = {
    ...plan.scope,
    fallbackFull: false,
    fallbackReason: null,
    highRisk: false,
    unknown: false,
    mode: "focused",
    reason: "focused-retry",
  };
  return buildVerificationPlan({
    scope: nextScope,
    changeSet: plan.change_set,
    mergeBase: plan.base_sha,
    baseSha: plan.base_sha,
    headSha: plan.head_sha,
    stage: "focused",
  });
}

function findNextCommand(plan, failedStepId) {
  const focused = buildFocusedNextPlan(plan);
  if (!focused) return { stage: "focused", command: null };

  const preferredOrder = [
    "unit-focused",
    "unit-base",
    "unit-working",
    "unit-related",
    "integration-direct",
    "integration-process-control",
    "integration-smoke",
  ];
  for (const id of preferredOrder) {
    const step = focused.steps.find(s => s.id === id);
    if (step) {
      return { stage: "focused", command: step.command.join(" ") };
    }
  }

  const failedStep = plan.steps.find(s => s.id === failedStepId);
  if (failedStep) {
    return {
      stage: plan.stage ?? "focused",
      command: failedStep.command.join(" "),
    };
  }
  return { stage: "focused", command: null };
}

export function validatePlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("PLAN_INVALID: plan must be an object");
  }
  if (!Array.isArray(plan.steps)) {
    throw new Error("PLAN_INVALID: plan.steps must be an array");
  }
  if (plan.stage !== "focused" && plan.stage !== "full") {
    throw new Error('PLAN_INVALID: plan.stage must be "focused" or "full"');
  }
  if (typeof plan.fallback_full !== "boolean") {
    throw new Error("PLAN_INVALID: plan.fallback_full must be a boolean");
  }
  if (plan.fallback_full === true && !plan.fallback_reason) {
    throw new Error(
      "PLAN_INVALID: fallback_full=true requires a machine-readable fallback_reason",
    );
  }
  if (plan.fallback_full === true && !plan.reason) {
    throw new Error("PLAN_INVALID: fallback_full=true requires a human reason");
  }
  if (
    plan.fallback_reason !== null &&
    plan.fallback_reason !== undefined &&
    !/^[a-z0-9_]+$/.test(plan.fallback_reason)
  ) {
    throw new Error(
      "PLAN_INVALID: fallback_reason must be a machine-readable identifier",
    );
  }
  for (const [index, step] of plan.steps.entries()) {
    if (
      !step ||
      typeof step.id !== "string" ||
      typeof step.reason !== "string" ||
      typeof step.enabled !== "boolean" ||
      !Array.isArray(step.command) ||
      step.command.length === 0 ||
      !step.command.every(arg => typeof arg === "string") ||
      !Number.isSafeInteger(step.timeout_ms) ||
      step.timeout_ms <= 0
    ) {
      throw new Error(`PLAN_INVALID: invalid step at index ${index}`);
    }
  }
  return true;
}

function normalizeRunnablePlan(plan) {
  if (!plan || typeof plan !== "object") return plan;
  if (plan.schema_version === "p87-t3/1") return plan;
  if (plan.schema_version !== "p87-t2/1") {
    throw new Error(
      `PLAN_INVALID: unsupported schema_version ${String(plan.schema_version)}`,
    );
  }

  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  return {
    ...plan,
    stage: plan.mode === "full" ? "full" : "focused",
    fallback_full: plan.fallback_full === true,
    fallback_reason:
      plan.fallback_full === true ? "legacy_trusted_classifier" : null,
    selected_unit_tests: countSelectedUnitTests(steps),
    selected_integration_tests: countSelectedIntegrationTests(steps),
    command_count: steps.length,
  };
}

export async function runVerificationPlan(plan, options = {}) {
  validatePlan(plan);
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const commandLabel = cmd => cmd.join(" ");
  const enabledSteps = plan.steps.filter(s => s.enabled);
  const stepResults = [];
  const fullAttemptCount = options.fullAttemptCount ?? 0;
  const startMs = Date.now();

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
    const vitestFiles = parseVitestFiles(result.stdout, result.stderr);

    const stepResult = {
      id: step.id,
      scope: step.scope,
      command: step.command,
      reason: step.reason,
      elapsedMs: result.elapsedMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      ok: result.ok,
      testFiles: vitestFiles.selected,
      failedTestFiles: vitestFiles.failed,
    };
    stepResults.push(stepResult);

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
      writeGitHubSummary(plan, stepResults, fullAttemptCount);
      return {
        ok: false,
        failed: true,
        step: step.id,
        result: stepResult,
        stepResults,
        totalMs: Date.now() - startMs,
        next: findNextCommand(plan, step.id),
      };
    }

    console.error(
      `verify:local: step=${step.id} passed in ${result.elapsedMs}ms`,
    );
  }

  console.error(`verify:local: ${enabledSteps.length} step(s) passed`);
  writeGitHubSummary(plan, stepResults, fullAttemptCount);
  return {
    ok: true,
    failed: false,
    steps: stepResults,
    stepResults,
    totalMs: Date.now() - startMs,
  };
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

// --- local verification run ledger ---

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function digestObject(obj) {
  return sha256(JSON.stringify(obj));
}

function diffDigest(changeSet, headSha) {
  const workingFiles = uniqueFiles([
    ...(changeSet.workingTreeFiles ?? []),
    ...(changeSet.untrackedFiles ?? []),
  ])
    .sort()
    .map(file => ({
      file,
      content_digest: existsSync(file)
        ? sha256(readFileSync(file))
        : "deleted",
    }));

  return digestObject({
    headSha,
    workingFiles,
  });
}

function planDigest(plan) {
  return digestObject(plan.steps.map(s => [s.id, s.command]));
}

function ensureLedgerDir() {
  mkdirSync(LEDGER_DIR, { recursive: true });
}

function loadLedger() {
  if (!existsSync(LEDGER_FILE)) return [];
  const content = readFileSync(LEDGER_FILE, "utf8");
  try {
    return content
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (cause) {
    throw new Error(
      `VERIFICATION_LEDGER_INVALID: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function appendLedgerEntry(entry) {
  ensureLedgerDir();
  appendFileSync(LEDGER_FILE, JSON.stringify(entry) + "\n");
}

function stageAttemptCount(ledger, taskId, stage) {
  return ledger.filter(e => e.task_id === taskId && e.stage === stage).length;
}

function fullAttemptCount(ledger, taskId) {
  return stageAttemptCount(ledger, taskId, "full");
}

function lastEntryForDiff(ledger, taskId, diffDigest, stage) {
  return ledger.findLast(
    e =>
      e.task_id === taskId &&
      e.working_tree_diff_digest === diffDigest &&
      e.stage === stage,
  );
}

function canRunFull(ledger, taskId, diffDigestValue) {
  if (fullAttemptCount(ledger, taskId) >= MAX_FULL_ATTEMPTS) {
    return {
      allowed: false,
      error: "FULL_VERIFICATION_BUDGET_EXCEEDED",
      message: `Full verification budget exceeded for task ${taskId} (max ${MAX_FULL_ATTEMPTS}).`,
    };
  }

  const focusedSuccess = lastEntryForDiff(
    ledger,
    taskId,
    diffDigestValue,
    "focused",
  );
  if (!focusedSuccess || focusedSuccess.failure) {
    return {
      allowed: false,
      error: "FULL_RETRY_REQUIRES_FOCUSED_PASS",
      message: `Full verification requires a successful focused run first for the current change set.`,
    };
  }

  const lastFull = ledger.findLast(
    e =>
      e.task_id === taskId &&
      e.working_tree_diff_digest === diffDigestValue &&
      e.stage === "full",
  );

  if (
    lastFull &&
    new Date(focusedSuccess.finished_at).getTime() <=
      new Date(lastFull.finished_at).getTime()
  ) {
    return {
      allowed: false,
      error: "FULL_RETRY_REQUIRES_FOCUSED_PASS",
      message: `A new focused pass is required after the last full attempt before retrying full.`,
    };
  }

  return { allowed: true };
}

function recordVerificationRun({
  taskId,
  headSha,
  diffDigestValue,
  planDigestValue,
  stage,
  stepResults,
  failure,
}) {
  const ledger = loadLedger();
  const attemptNumber = stageAttemptCount(ledger, taskId, stage) + 1;
  const totalMs = stepResults.reduce((sum, s) => sum + (s.elapsedMs ?? 0), 0);
  const selectedTestFiles = stepResults.flatMap(s => [
    ...(s.testFiles ?? []),
    ...s.command.filter(
      arg =>
        arg.startsWith("tests/unit/") || arg.startsWith("tests/integration/"),
    ),
  ]);

  appendLedgerEntry({
    id: `${taskId}-${stage}-${Date.now()}`,
    task_id: taskId,
    head_sha: headSha,
    working_tree_diff_digest: diffDigestValue,
    plan_digest: planDigestValue,
    stage,
    started_at: new Date(Date.now() - totalMs).toISOString(),
    finished_at: new Date().toISOString(),
    commands: stepResults.map(s => ({
      id: s.id,
      command: s.command,
      exit_code: s.exitCode,
      duration_ms: s.elapsedMs,
    })),
    duration_ms: totalMs,
    selected_test_files: [...new Set(selectedTestFiles)],
    failure,
    attempt_number: attemptNumber,
  });
}

function buildFocusedTestRetryPlan(plan, testFiles) {
  const unitFiles = uniqueFiles(testFiles.filter(isUnitTest));
  const integrationFiles = uniqueFiles(testFiles.filter(isIntegrationTest));
  const steps = [];

  if (unitFiles.length > 0) {
    addVitestStep(
      steps,
      "unit-focused",
      "focused",
      "pnpm",
      ["exec", "vitest", "run", ...unitFiles],
      300_000,
      `failed tests: ${unitFiles.length} unit test file(s)`,
    );
  }
  if (integrationFiles.length > 0) {
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
        ...integrationFiles,
      ],
      300_000,
      `failed tests: ${integrationFiles.length} integration test file(s)`,
    );
  }

  if (steps.length === 0) return plan;
  return {
    ...plan,
    mode: "focused",
    stage: "focused",
    fallback_full: false,
    fallback_reason: null,
    reason: "failed_test_retry",
    selected_unit_tests: unitFiles.length,
    selected_integration_tests: integrationFiles.length,
    command_count: steps.length,
    steps,
  };
}

function localStageCommand(taskId, stage, testFiles = []) {
  const args = [
    "node",
    "scripts/verification-scope.mjs",
    "--local",
    "--stage",
    stage,
    "--run",
    "--task-id",
    taskId,
  ];
  for (const file of testFiles) {
    args.push("--test-file", file);
  }
  return args.join(" ");
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
  const stage = options.stage ?? (options.forceFull ? "full" : "focused");
  const taskId = options.taskId ?? "local";

  let plan = buildVerificationPlan({
    scope,
    changeSet,
    mergeBase: changeSet.mergeBase,
    baseSha,
    headSha,
    stage,
  });
  if (stage === "focused" && (options.testFiles?.length ?? 0) > 0) {
    plan = buildFocusedTestRetryPlan(plan, options.testFiles);
  }

  console.log(
    `verify:local: scope=${scope.reason} mode=${plan.mode} stage=${plan.stage} steps=${plan.steps.length}`,
  );

  if (options.writePlan) {
    writeFileSync(options.writePlan, JSON.stringify(plan, null, 2) + "\n");
    console.error(`verify:local: wrote plan to ${options.writePlan}`);
  }

  if (plan.steps.length === 0) {
    console.log("verify:local: 0 checks passed");
    process.exit(0);
  }

  const diffDigestValue = diffDigest(changeSet, headSha);
  const planDigestValue = planDigest(plan);
  const ledger = options.noLedger ? [] : loadLedger();

  if (!options.noLedger && stage === "full") {
    const permission = canRunFull(ledger, taskId, diffDigestValue);
    if (!permission.allowed) {
      const nextCommand = localStageCommand(taskId, "focused");
      console.error(`verify:local: ${permission.error}`);
      console.log(
        JSON.stringify({
          status: "rejected",
          stage: "full",
          error: permission.error,
          message: permission.message,
          next: {
            stage: "focused",
            command: nextCommand,
          },
        }),
      );
      process.exit(2);
    }
  }

  const fullAttempts = fullAttemptCount(ledger, taskId);
  const fullAttemptCounter = stage === "full" ? fullAttempts + 1 : fullAttempts;

  const run = await runVerificationPlan(plan, {
    heartbeatMs: options.heartbeatMs,
    fullAttemptCount: fullAttemptCounter,
  });

  if (!options.noLedger) {
    recordVerificationRun({
      taskId,
      headSha,
      diffDigestValue,
      planDigestValue,
      stage,
      stepResults: run.stepResults,
      failure: !run.ok,
    });
  }

  if (!run.ok) {
    const failedStep = run.stepResults.find(s => !s.ok) ?? run.result;
    const failedTestFiles = uniqueFiles(
      run.stepResults.flatMap(s => s.failedTestFiles ?? []),
    );
    const next = {
      stage: "focused",
      command: localStageCommand(taskId, "focused", failedTestFiles),
    };
    console.log(
      JSON.stringify({
        status: "failed",
        stage,
        failed_steps: [failedStep?.id ?? run.step].filter(Boolean),
        failed_test_files: failedTestFiles,
        next,
      }),
    );
    process.exit(1);
  }

  console.log(
    `verify:local: ${run.steps.length} check${run.steps.length === 1 ? "" : "s"} passed`,
  );
  if (stage === "focused") {
    console.log(
      JSON.stringify({
        status: "passed",
        stage: "focused",
        next: {
          stage: "full",
          command: localStageCommand(taskId, "full"),
        },
      }),
    );
  }
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
  const stage =
    options.stage ??
    (forceFull || scope.fallbackFull || scope.mode === "full"
      ? "full"
      : "focused");
  const plan = buildVerificationPlan({
    scope,
    changeSet,
    mergeBase,
    baseSha: mergeBase,
    headSha,
    stage,
  });

  console.log(
    `verify: scope=${scope.reason} mode=${plan.mode} stage=${plan.stage} steps=${plan.steps.length}`,
  );

  if (options.writePlan) {
    writeFileSync(options.writePlan, JSON.stringify(plan, null, 2) + "\n");
    console.error(`verify: wrote plan to ${options.writePlan}`);
  }

  if (plan.steps.length === 0) {
    console.log("verify: 0 checks passed");
    process.exit(0);
  }

  const fullAttemptCount = stage === "full" ? 1 : 0;
  const run = await runVerificationPlan(plan, {
    heartbeatMs: options.heartbeatMs,
    fullAttemptCount,
  });
  if (!run.ok) {
    process.exit(1);
  }

  console.log(
    `verify: ${run.steps.length} check${run.steps.length === 1 ? "" : "s"} passed`,
  );
}

// --- output formatters ---

function outputGitHub(scope) {
  const env = process.env.GITHUB_OUTPUT;
  const lines = [
    `docs=${scope.docs}`,
    `standard=${scope.standard}`,
    `fallback_full=${scope.fallbackFull}`,
    `mode=${scope.mode}`,
    `fallback_reason=${scope.fallbackReason ?? ""}`,
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
      stage: { type: "string" },
      "task-id": { type: "string" },
      "run-plan": { type: "string" },
      "test-file": { type: "string", multiple: true },
      "no-ledger": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const heartbeatMs = values["heartbeat-ms"]
    ? Number(values["heartbeat-ms"])
    : DEFAULT_HEARTBEAT_MS;
  if (
    values.stage !== undefined &&
    values.stage !== "focused" &&
    values.stage !== "full"
  ) {
    console.error('verify: --stage must be "focused" or "full"');
    process.exit(2);
  }
  if (values["force-full"] && values.stage === "focused") {
    console.error(
      'verify: --force-full cannot be combined with --stage focused',
    );
    process.exit(2);
  }
  if ((values["test-file"]?.length ?? 0) > 0 && values.stage !== "focused") {
    console.error("verify: --test-file requires --stage focused");
    process.exit(2);
  }

  if (values["run-plan"]) {
    const planPath = values["run-plan"];
    let plan;
    try {
      plan = normalizeRunnablePlan(JSON.parse(readFileSync(planPath, "utf8")));
    } catch (err) {
      console.error(`verify: failed to load plan ${planPath}: ${err.message}`);
      process.exit(2);
    }
    validatePlan(plan);
    if (
      process.env.GITHUB_SHA &&
      plan.head_sha &&
      process.env.GITHUB_SHA !== plan.head_sha
    ) {
      console.error(
        `verify: plan head_sha ${plan.head_sha} does not match GITHUB_SHA ${process.env.GITHUB_SHA}`,
      );
      process.exit(2);
    }
    const fullAttemptCount = plan.stage === "full" ? 1 : 0;
    const run = await runVerificationPlan(plan, {
      heartbeatMs,
      fullAttemptCount,
    });
    process.exit(run.ok ? 0 : 1);
  }

  if (values.run && values.local) {
    await runLocalVerification({
      writePlan: values["write-plan"],
      heartbeatMs,
      stage: values.stage,
      taskId: values["task-id"],
      forceFull: values["force-full"],
      testFiles: values["test-file"],
      noLedger: values["no-ledger"],
    });
    return;
  }

  if (values.run && values.base) {
    await runBaseVerification(values.base, {
      writePlan: values["write-plan"],
      heartbeatMs,
      forceFull: values["force-full"],
      stage: values.stage,
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
