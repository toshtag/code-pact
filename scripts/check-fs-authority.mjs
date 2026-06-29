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
//   - The authority resolver definitions themselves are exempt.
//   - Import statements are exempt.
//
// Usage: node scripts/check-fs-authority.mjs [file ...]
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
  join("src", "commands", "doctor.ts"),
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

function createScope(parent = null) {
  return { parent, vars: new Map() };
}

function declareVar(scope, name, authority) {
  scope.vars.set(name, authority);
}

function assignVar(scope, name, authority) {
  let current = scope;
  while (current) {
    if (current.vars.has(name)) {
      current.vars.set(name, authority);
      return;
    }
    current = current.parent;
  }
  scope.vars.set(name, authority);
}

function hasAuthority(scope, name) {
  let current = scope;
  while (current) {
    if (current.vars.has(name)) return current.vars.get(name) === true;
    current = current.parent;
  }
  return false;
}

function isAuthorityExpression(node, scope) {
  if (!node) return false;

  if (ts.isAwaitExpression(node)) {
    return isAuthorityExpression(node.expression, scope);
  }

  if (ts.isCallExpression(node)) {
    const name = getCallName(node);
    if (name && AUTHORITY_CALLS.has(name)) return true;
    // dirname() of an authority expression is also authority — the parent
    // directory of a symlink-free resolved path is still within the project.
    if (name === "dirname" && node.arguments.length > 0) {
      return isAuthorityExpression(node.arguments[0], scope);
    }
    return false;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const propName = node.name.text;
    if (ts.isIdentifier(node.expression)) {
      const objName = node.expression.text;
      if (
        AUTHORITY_RESULT_PROPS.has(propName) &&
        hasAuthority(scope, objName)
      ) {
        return true;
      }
    }
    return false;
  }

  if (ts.isIdentifier(node)) {
    const name = node.text;
    return hasAuthority(scope, name);
  }

  if (ts.isBinaryExpression(node)) {
    return (
      isAuthorityExpression(node.left, scope) &&
      isAuthorityExpression(node.right, scope)
    );
  }

  if (ts.isConditionalExpression(node)) {
    return (
      isAuthorityExpression(node.whenTrue, scope) &&
      isAuthorityExpression(node.whenFalse, scope)
    );
  }

  if (ts.isParenthesizedExpression(node)) {
    return isAuthorityExpression(node.expression, scope);
  }

  if (ts.isAsExpression(node)) {
    return isAuthorityExpression(node.expression, scope);
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

  const findings = [];

  function visit(node, scope) {
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) declareVar(scope, node.name.text, false);
      const fnScope = createScope(scope);
      for (const param of node.parameters) {
        if (ts.isIdentifier(param.name)) declareVar(fnScope, param.name.text, false);
      }
      if (node.body) visit(node.body, fnScope);
      return;
    }

    if (
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const fnScope = createScope(scope);
      for (const param of node.parameters) {
        if (ts.isIdentifier(param.name)) declareVar(fnScope, param.name.text, false);
      }
      if (node.body) visit(node.body, fnScope);
      return;
    }

    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const blockScope = ts.isSourceFile(node) ? scope : createScope(scope);
      ts.forEachChild(node, child => visit(child, blockScope));
      return;
    }

    if (ts.isCatchClause(node)) {
      const catchScope = createScope(scope);
      if (node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
        declareVar(catchScope, node.variableDeclaration.name.text, false);
      }
      visit(node.block, catchScope);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) visit(node.initializer, scope);
      declareVar(
        scope,
        node.name.text,
        node.initializer
          ? isAuthorityExpression(node.initializer, scope)
          : false,
      );
      return;
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      visit(node.right, scope);
      assignVar(
        scope,
        node.left.text,
        isAuthorityExpression(node.right, scope),
      );
      return;
    }

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

        const firstArg = node.arguments[0];
        if (!firstArg) {
          ts.forEachChild(node, child => visit(child, scope));
          return;
        }

        if (!isAuthorityExpression(firstArg, scope)) {
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

    ts.forEachChild(node, child => visit(child, scope));
  }

  visit(sourceFile, createScope());
  return findings;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const filesToCheck = process.argv.slice(2);
const runFiles = filesToCheck.length > 0 ? filesToCheck : TARGET_FILES;

let total = 0;
for (const file of runFiles) {
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
  process.exit(1);
}
process.exit(0);
