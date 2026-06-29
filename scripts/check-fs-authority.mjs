#!/usr/bin/env node
// AST gate: verify that filesystem operations use paths proven by approved
// project authority helpers. The checker is intentionally conservative: after
// branch joins, a path variable remains authorized only when every reachable
// branch assigns it from an approved resolver.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

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

const AUTHORITY_EXPORTS = new Map([
  [join("src", "core", "path-safety.ts"), new Set([
    "resolveSymlinkFreeProjectPath",
    "resolveSymlinkFreeProjectPathSync",
  ])],
  [join("src", "core", "project-fs", "owned-read.ts"), new Set(["resolveOwnedReadPath"])],
  [join("src", "core", "project-config-path.ts"), new Set(["resolveProjectConfigPath"])],
  [join("src", "core", "agent-profile-path.ts"), new Set(["resolveAgentProfilePath"])],
  [join("src", "core", "archive", "paths.ts"), new Set(["resolveArchiveOwnedPath"])],
  [join("src", "core", "adapters", "manifest.ts"), new Set(["resolveManifestPath", "readManifest", "writeManifest"])],
  [join("src", "core", "adapters", "manifest-file-ownership.ts"), new Set(["authorizeAdapterMutationPath"])],
  [join("src", "core", "adapters", "file-state.ts"), new Set(["readAuthorizedRegularFileMaybe", "authorizedPathExists"])],
  [join("src", "io", "atomic-text.ts"), new Set(["atomicWriteText"])],
]);

const AUTHORITY_RESULT_PROPS = new Set(["absPath"]);
const AUTHORIZED = "authorized";
const UNAUTHORIZED = "unauthorized";
const UNKNOWN = "unknown";

function createScope(parent = null) {
  return { parent, vars: new Map() };
}

function cloneScope(scope) {
  return { parent: scope.parent, vars: new Map(scope.vars) };
}

function declareVar(scope, name, state) {
  scope.vars.set(name, state);
}

function assignVar(scope, name, state) {
  let current = scope;
  while (current) {
    if (current.vars.has(name)) {
      current.vars.set(name, state);
      return;
    }
    current = current.parent;
  }
  scope.vars.set(name, state);
}

function getVarState(scope, name) {
  let current = scope;
  while (current) {
    if (current.vars.has(name)) return current.vars.get(name);
    current = current.parent;
  }
  return UNKNOWN;
}

function mergeState(a, b) {
  return a === AUTHORIZED && b === AUTHORIZED ? AUTHORIZED : UNAUTHORIZED;
}

function mergeScopes(base, left, right) {
  const names = new Set([...base.vars.keys(), ...left.vars.keys(), ...right.vars.keys()]);
  for (const name of names) {
    base.vars.set(
      name,
      mergeState(
        left.vars.has(name) ? left.vars.get(name) : getVarState(left.parent, name),
        right.vars.has(name) ? right.vars.get(name) : getVarState(right.parent, name),
      ),
    );
  }
}

function trustedImportsFor(sourceFile) {
  const trusted = new Set();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const modulePath = resolveImport(sourceFile.fileName, stmt.moduleSpecifier.text);
    if (modulePath === null) continue;
    const allowed = AUTHORITY_EXPORTS.get(modulePath);
    if (!allowed) continue;
    const clause = stmt.importClause;
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const exported = el.propertyName?.text ?? el.name.text;
      if (allowed.has(exported)) trusted.add(el.name.text);
    }
  }
  return trusted;
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}.js`];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    return rel(c);
  }
  return rel(base);
}

function rel(path) {
  return resolve(path).split(/[\\/]/).join("/").replace(`${process.cwd().split(/[\\/]/).join("/")}/`, "");
}

function getCallName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function isTrustedAuthorityCall(node, trustedImports) {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isIdentifier(node.expression)) return false;
  return trustedImports.has(node.expression.text);
}

function isAuthorityExpression(node, scope, trustedImports) {
  if (!node) return false;
  if (ts.isAwaitExpression(node)) return isAuthorityExpression(node.expression, scope, trustedImports);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return isAuthorityExpression(node.expression, scope, trustedImports);
  }
  if (ts.isCallExpression(node)) {
    if (isTrustedAuthorityCall(node, trustedImports)) return true;
    const name = getCallName(node);
    return name === "dirname" && node.arguments.length > 0
      ? isAuthorityExpression(node.arguments[0], scope, trustedImports)
      : false;
  }
  if (ts.isIdentifier(node)) return getVarState(scope, node.text) === AUTHORIZED;
  if (ts.isPropertyAccessExpression(node)) {
    return (
      AUTHORITY_RESULT_PROPS.has(node.name.text) &&
      ts.isIdentifier(node.expression) &&
      getVarState(scope, node.expression.text) === AUTHORIZED
    );
  }
  if (ts.isConditionalExpression(node)) {
    return (
      isAuthorityExpression(node.whenTrue, scope, trustedImports) &&
      isAuthorityExpression(node.whenFalse, scope, trustedImports)
    );
  }
  return false;
}

function isInsideTrustedAuthorityDefinition(node, trustedImports) {
  let current = node;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name &&
      trustedImports.has(current.name.text)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function checkFile(filePath) {
  if (AUTHORITY_EXPORTS.has(rel(filePath))) return [];
  const text = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];
  const trustedImports = trustedImportsFor(sourceFile);

  function visit(node, scope) {
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) declareVar(scope, node.name.text, UNAUTHORIZED);
      const fnScope = createScope(scope);
      for (const param of node.parameters) {
        if (ts.isIdentifier(param.name)) declareVar(fnScope, param.name.text, UNAUTHORIZED);
      }
      if (node.body) visit(node.body, fnScope);
      return;
    }

    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const fnScope = createScope(scope);
      for (const param of node.parameters) {
        if (ts.isIdentifier(param.name)) declareVar(fnScope, param.name.text, UNAUTHORIZED);
      }
      if (node.body) visit(node.body, fnScope);
      return;
    }

    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const blockScope = ts.isSourceFile(node) ? scope : createScope(scope);
      for (const stmt of node.statements ?? []) visit(stmt, blockScope);
      return;
    }

    if (ts.isIfStatement(node)) {
      visit(node.expression, scope);
      const thenScope = cloneScope(scope);
      const elseScope = cloneScope(scope);
      visit(node.thenStatement, thenScope);
      if (node.elseStatement) visit(node.elseStatement, elseScope);
      mergeScopes(scope, thenScope, elseScope);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) visit(node.initializer, scope);
      declareVar(
        scope,
        node.name.text,
        node.initializer && isAuthorityExpression(node.initializer, scope, trustedImports)
          ? AUTHORIZED
          : UNAUTHORIZED,
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
        isAuthorityExpression(node.right, scope, trustedImports) ? AUTHORIZED : UNAUTHORIZED,
      );
      return;
    }

    if (ts.isCallExpression(node)) {
      const fnName = getCallName(node);
      if (fnName && FS_FUNCTIONS.has(fnName)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (!isInsideTrustedAuthorityDefinition(node, trustedImports)) {
          const firstArg = node.arguments[0];
          if (firstArg && !isAuthorityExpression(firstArg, scope, trustedImports)) {
            findings.push({
              line,
              fn: fnName,
              arg: firstArg.getText(sourceFile).slice(0, 80),
              text: sourceFile.text.split("\n")[line - 1]?.trim() ?? "",
            });
          }
        }
      }
    }

    ts.forEachChild(node, child => visit(child, scope));
  }

  visit(sourceFile, createScope());
  return findings;
}

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
    console.log(`${file}:${f.line}: ${f.fn}() called on non-authority path "${f.arg}"`);
    console.log(`    ${f.text}`);
  }
}

if (total > 0) {
  console.log(`\nfs-authority: ${total} finding(s). Fs operations must use approved project authority helpers.`);
  process.exit(1);
}
process.exit(0);
