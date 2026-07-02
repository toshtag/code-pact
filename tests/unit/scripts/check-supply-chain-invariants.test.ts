import { describe, it, expect } from "vitest";
import {
  checkActionShaPins,
  checkNoTokenSecrets,
  checkCheckoutPersistCredentials,
  checkSupplyChainInvariants,
} from "../../../scripts/check-supply-chain-invariants.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

describe("checkActionShaPins", () => {
  it("passes when all uses are 40-char SHA pinned", () => {
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
    const content = "      - uses: actions/checkout@v6.0.2\n";
    const violations = checkActionShaPins(content);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("40-char commit SHA");
  });

  it("fails when a uses references main", () => {
    const content = "      - uses: actions/checkout@main\n";
    const violations = checkActionShaPins(content);
    expect(violations.length).toBe(1);
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

describe("checkCheckoutPersistCredentials", () => {
  it("passes when persist-credentials: false is set", () => {
    const content = [
      "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
      "        with:",
      "          persist-credentials: false",
    ].join("\n");
    expect(checkCheckoutPersistCredentials(content)).toEqual([]);
  });

  it("fails when persist-credentials is not set", () => {
    const content =
      "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd\n";
    const violations = checkCheckoutPersistCredentials(content);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("persist-credentials");
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

  async function buildTree(
    overrides: {
      publishContent?: string;
      ciContent?: string;
      securityContent?: string;
    } = {},
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sci-"));
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });

    const defaultPublish = [
      "name: Publish",
      "",
      "on:",
      "  push:",
      "    tags:",
      "      - 'v*'",
      "",
      "permissions: {}",
      "",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    environment: npm-publish",
      "    permissions:",
      "      contents: read",
      "      id-token: write",
      "    steps:",
      "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
      "        with:",
      "          persist-credentials: false",
      "      - run: pnpm release:check",
      "      - run: node scripts/check-package-tarball.mjs",
      "      - run: npm publish",
      "      - run: node scripts/verify-published-tarball.mjs",
      "",
      "  github-release:",
      "    runs-on: ubuntu-latest",
      "    needs: publish",
      "    permissions:",
      "      contents: write",
      "    steps:",
      "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
      "        with:",
      "          persist-credentials: false",
    ].join("\n");

    const defaultCi = [
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

    await writeFile(
      join(dir, ".github", "workflows", "publish.yml"),
      overrides.publishContent ?? defaultPublish,
    );
    await writeFile(
      join(dir, ".github", "workflows", "ci.yml"),
      overrides.ciContent ?? defaultCi,
    );
    await writeFile(
      join(dir, "SECURITY.md"),
      overrides.securityContent ?? "No local build references.",
    );
    return dir;
  }

  it("passes on a well-formed tree", async () => {
    root = await buildTree();
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBe(0);
    await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("fails when publish.yml has a tag-pinned action", async () => {
    root = await buildTree({
      publishContent: [
        "name: Publish",
        "on:",
        "  push:",
        "    tags:",
        "      - 'v*'",
        "permissions: {}",
        "jobs:",
        "  publish:",
        "    environment: npm-publish",
        "    permissions:",
        "      contents: read",
        "      id-token: write",
        "    steps:",
        "      - uses: actions/checkout@v6.0.2",
        "        with:",
        "          persist-credentials: false",
        "      - run: pnpm release:check",
        "      - run: node scripts/check-package-tarball.mjs",
        "      - run: npm publish",
        "      - run: node scripts/verify-published-tarball.mjs",
      ].join("\n"),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("fails when NPM_TOKEN is in publish.yml", async () => {
    root = await buildTree({
      publishContent: [
        "name: Publish",
        "on:",
        "  push:",
        "    tags:",
        "      - 'v*'",
        "permissions: {}",
        "jobs:",
        "  publish:",
        "    environment: npm-publish",
        "    permissions:",
        "      contents: read",
        "      id-token: write",
        "    steps:",
        "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
        "        with:",
        "          persist-credentials: false",
        "      - run: pnpm release:check",
        "      - run: node scripts/check-package-tarball.mjs",
        "      - env:",
        "          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}",
        "        run: npm publish",
        "      - run: node scripts/verify-published-tarball.mjs",
      ].join("\n"),
    });
    const { failures } = checkSupplyChainInvariants(root);
    expect(failures).toBeGreaterThan(0);
    await rm(root, { recursive: true, force: true });
    root = undefined;
  });
});
