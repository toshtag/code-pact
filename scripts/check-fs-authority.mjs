#!/usr/bin/env node
// AST gate: verify that every filesystem operation in the checked source
// files uses a path that has been through an authority resolution.
//
// This script uses the TypeScript compiler API to parse each file into an
// AST and walk every CallExpression. For each call to a known fs function
// (readFile, writeFile, mkdir, stat, etc.), it checks whether the first
// argument (the path) is sourced from an authority resolver or a variable
// that was assigned from one.
//
// Authority resolvers (function calls that produce safe paths):
//   resolveSymlinkFreeProjectPath
//   resolveSymlinkFreeProjectPathSync
//   resolveOwnedReadPath
//   resolveProjectConfigPath
//   resolveAgentProfilePath
//   resolveArchiveOwnedPath
//   resolveManifestPath
//   authorizeAdapterMutationPath
//   readAuthorizedRegularFileMaybe
//   authorizedPathExists
//   assertAdapterWritePathsContained
//   atomicWriteText
//   writeManifest
//   readManifest
//
// Exemptions:
//   - Lines with `// fs-safe: <reason>` are exempt.
//   - The authority resolver definitions themselves are exempt.
//   - Import statements are exempt.
//
// Usage: node scripts/check-fs-authority.mjs
// Exit: 0 = clean; 1 = findings printed to stdout

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TARGET_FILES = [
  join("src", "commands", "adapter-install.ts"),
  join("src", "commands", "adapter-upgrade.ts"),
  join("src", "commands", "adapter-doctor.ts"),
];

const FS_FUNCTIONS = new Set([
  "readFile",
  "writeFile",
  "appendFile",
  "mkdir",
  "readdir",
  "rmdir",
  "rm",
  "unlink",
  "rename",
  "copyFile",
  "cp",
  "open",
  "truncate",
  "stat",
  "lstat",
  "opendir",
  "watch",
  "access",
  "atomicWriteText",
]);

const AUTHORITY_CALLS = new Set([
  "resolveSymlinkFreeProjectPath",
  "resolveSymlinkFreeProjectPathSync",
  "resolveOwnedReadPath",
  "resolveProjectConfigPath",
  "resolveAgentProfilePath",
  "resolveArchiveOwnedPath",
  "resolveManifestPath",
  "authorizeAdapterMutationPath",
  "readAuthorizedRegularFileMaybe",
  "authorizedPathExists",
  "assertAdapterWritePathsContained",
  "atomicWriteText",
  "writeManifest",
  "readManifest",
]);

const AUTHORITY_RESULT_PROPS = new Set(["absPath"]);

// ---------------------------------------------------------------------------
// AST analysis
// ---------------------------------------------------------------------------

function isAuthorityExpression(node, varProvenance) {
  if (!node) return false;

  if (ts.isAwaitExpression(node)) {
    return isAuthorityExpression(node.expression, varProvenance);
  }

  if (ts.isCallExpression(node)) {
    const name = getCallName(node);
    if (name && AUTHORITY_CALLS.has(name)) return true;
    // dirname() of an authority expression is also authority — the parent
    // directory of a symlink-free resolved path is still within the project.
    if (name === "dirname" && node.arguments.length > 0) {
      return isAuthorityExpression(node.arguments[0], varProvenance);
    }
    return false;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const propName = node.name.text;
    if (ts.isIdentifier(node.expression)) {
      const objName = node.expression.text;
      if (
        AUTHORITY_RESULT_PROPS.has(propName) &&
        varProvenance.has(objName)
      ) {
        return true;
      }
    }
    return false;
  }

  if (ts.isIdentifier(node)) {
    const name = node.text;
    if (varProvenance.has(name)) return true;
    return false;
  }

  if (ts.isBinaryExpression(node)) {
    return (
      isAuthorityExpression(node.left, varProvenance) &&
      isAuthorityExpression(node.right, varProvenance)
    );
  }

  if (ts.isConditionalExpression(node)) {
    return (
      isAuthorityExpression(node.whenTrue, varProvenance) &&
      isAuthorityExpression(node.whenFalse, varProvenance)
    );
  }

  if (ts.isParenthesizedExpression(node)) {
    return isAuthorityExpression(node.expression, varProvenance);
  }

  if (ts.isAsExpression(node)) {
    return isAuthorityExpression(node.expression, varProvenance);
  }

  return false;
}

function getCallName(node) {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name.text;
  }
  return null;
}

function hasFsSafeMarker(sourceFile, line) {
  const lineText = sourceFile.text.split("\n")[line - 1] ?? "";
  return /\/\/\s*fs-safe:/.test(lineText);
}

function collectVarProvenance(sourceFile) {
  const provenance = new Set();

  function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          decl.initializer &&
          ts.isIdentifier(decl.name)
        ) {
          if (isAuthorityExpression(decl.initializer, provenance)) {
            provenance.add(decl.name.text);
          } else {
            provenance.delete(decl.name.text);
          }
        }
      }
    }
    if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.expression.left)
    ) {
      const name = node.expression.left.text;
      if (isAuthorityExpression(node.expression.right, provenance)) {
        provenance.add(name);
      } else {
        provenance.delete(name);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return provenance;
}

function isInsideAuthorityDefinition(node) {
  let current = node;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      const name = current.name?.text;
      if (name && AUTHORITY_CALLS.has(name)) return true;
    }
    current = current.parent;
  }
  return false;
}

function isInsideImport(node) {
  let current = node;
  while (current) {
    if (
      ts.isImportDeclaration(current) ||
      ts.isImportEqualsDeclaration(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

function checkFile(filePath) {
  const text = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function setParents(node, parent) {
    node.parent = parent;
    ts.forEachChild(node, child => setParents(child, node));
  }
  setParents(sourceFile, undefined);

  const varProvenance = collectVarProvenance(sourceFile);
  const findings = [];

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const fnName = getCallName(node);

      if (fnName && FS_FUNCTIONS.has(fnName)) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

        if (isInsideImport(node)) {
          ts.forEachChild(node, visit);
          return;
        }

        if (isInsideAuthorityDefinition(node)) {
          ts.forEachChild(node, visit);
          return;
        }

        if (hasFsSafeMarker(sourceFile, line)) {
          ts.forEachChild(node, visit);
          return;
        }

        const firstArg = node.arguments[0];
        if (!firstArg) {
          ts.forEachChild(node, visit);
          return;
        }

        if (!isAuthorityExpression(firstArg, varProvenance)) {
          const argText = firstArg.getText(sourceFile).slice(0, 80);
          const lineText = sourceFile.text.split("\n")[line - 1]?.trim() ?? "";
          findings.push({
            line,
            fn: fnName,
            arg: argText,
            text: lineText,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let total = 0;
for (const file of TARGET_FILES) {
  const absPath = resolve(file);
  let findings;
  try {
    findings = checkFile(absPath);
  } catch (err) {
    console.error(`fs-authority: error checking ${file}: ${err.message}`);
    process.exit(2);
  }
  for (const f of findings) {
    total++;
    console.log(
      `${file}:${f.line}: ${f.fn}() called on non-authority path "${f.arg}"`,
    );
    console.log(`    ${f.text}`);
  }
}

if (total > 0) {
  console.log(
    `\nfs-authority: ${total} finding(s). Fs operations must use paths from:`,
  );
  console.log(
    `  resolveSymlinkFreeProjectPath, resolveOwnedReadPath, resolveProjectConfigPath,`,
  );
  console.log(
    `  resolveAgentProfilePath, resolveArchiveOwnedPath, resolveManifestPath,`,
  );
  console.log(
    `  authorizeAdapterMutationPath, or a pre-resolved variable (absPath, contextDirAbs, etc.).`,
  );
  console.log(
    `  If the path is genuinely safe, append \`// fs-safe: <reason>\`.`,
  );
  process.exit(1);
}
process.exit(0);
