import { describe, it, expect } from "vitest";
import {
  checkActionShaPins,
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
    "",
    "  publish:",
    "    runs-on: ubuntu-latest",
    "    needs: prepare",
    "    environment: npm-publish",
    "    permissions:",
    "      contents: read",
    "      id-token: write",
    "    steps:",
    "      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0 # v5.0.0",
    "        with:",
    "          name: release-artifact",
    "          path: release-artifact",
    "      - run: npm publish release-artifact/package.tgz --ignore-scripts",
    "",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    needs: [publish, prepare]",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0 # v5.0.0",
    "        with:",
    "          name: release-artifact",
    "          path: release-artifact",
    "      - run: node scripts/verify-published-tarball.mjs",
    "",
    "  github-release:",
    "    runs-on: ubuntu-latest",
    "    needs: [verify, prepare]",
    "    permissions:",
    "      contents: write",
    "    steps:",
    "      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0 # v5.0.0",
    "        with:",
    "          name: release-artifact",
    "          path: release-artifact",
    "      - run: gh release create",
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
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          persist-credentials: false",
  ].join("\n");

  async function buildTree(
    overrides: {
      publishContent?: string;
      ciContent?: string;
      securityContent?: string;
    } = {},
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sci-"));
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(dir, ".github", "workflows", "publish.yml"),
      overrides.publishContent ?? wellFormedPublish,
    );
    await writeFile(
      join(dir, ".github", "workflows", "ci.yml"),
      overrides.ciContent ?? wellFormedCi,
    );
    await writeFile(
      join(dir, "SECURITY.md"),
      overrides.securityContent ?? "No local build references.",
    );
    return dir;
  }

  async function cleanup() {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  }

  it("passes on a well-formed tree", async () => {
    root = await buildTree();
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBe(0);
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
      publishContent: wellFormedPublish.replace(
        "npm publish release-artifact/package.tgz --ignore-scripts",
        "env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n        run: npm publish release-artifact/package.tgz --ignore-scripts",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has checkout", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0 # v5.0.0\n        with:\n          name: release-artifact\n          path: release-artifact\n      - run: npm publish",
        "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2\n        with:\n          persist-credentials: false\n      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0 # v5.0.0\n        with:\n          name: release-artifact\n          path: release-artifact\n      - run: npm publish",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has pnpm install", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - run: npm publish release-artifact/package.tgz --ignore-scripts",
        "      - run: pnpm install --frozen-lockfile\n      - run: npm publish release-artifact/package.tgz --ignore-scripts",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when publish job has release:check", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - run: npm publish release-artifact/package.tgz --ignore-scripts",
        "      - run: pnpm release:check\n      - run: npm publish release-artifact/package.tgz --ignore-scripts",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when prepare job has id-token: write", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish
        .replace("  prepare:", "  prepare:")
        .replace(
          "    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout",
          "    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - uses: actions/checkout",
        ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when verify job has id-token: write", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish
        .replace("  verify:", "  verify:")
        .replace(
          "    needs: [publish, prepare]\n    permissions:\n      contents: read\n    steps:",
          "    needs: [publish, prepare]\n    permissions:\n      contents: read\n      id-token: write\n    steps:",
        ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when github-release job has id-token: write", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "    permissions:\n      contents: write\n    steps:\n      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0 # v5.0.0\n        with:\n          name: release-artifact\n          path: release-artifact\n      - run: gh release create",
        "    permissions:\n      contents: write\n      id-token: write\n    steps:\n      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0 # v5.0.0\n        with:\n          name: release-artifact\n          path: release-artifact\n      - run: gh release create",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when github-release job has checkout", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "    steps:\n      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0 # v5.0.0\n        with:\n          name: release-artifact\n          path: release-artifact\n      - run: gh release create",
        "    steps:\n      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2\n        with:\n          persist-credentials: false\n      - run: gh release create",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });

  it("fails when github-release job has repository script", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "      - run: gh release create",
        "      - run: node scripts/release-notes.mjs\n      - run: gh release create",
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

  it("fails when publish job does not use --ignore-scripts", async () => {
    root = await buildTree({
      publishContent: wellFormedPublish.replace(
        "npm publish release-artifact/package.tgz --ignore-scripts",
        "npm publish release-artifact/package.tgz",
      ),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await cleanup();
  });
});
