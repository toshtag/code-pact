#!/usr/bin/env node
// AST gate: verify that filesystem operations use paths proven by approved
// project authority helpers. The checker classifies authority kinds and is
// intentionally conservative: after branch joins, a path variable remains
// authorized only when every reachable branch assigns it from an approved
// resolver. Unknown control flow fails closed.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Authority kinds — the checker distinguishes containment from ownership.
//
//   symlink_free_contained: resolveSymlinkFreeProjectPath() proves the path
//     is inside the project and has no symlink component, but does NOT prove
//     the caller has namespace authority (e.g. profile path, manifest path).
//   owned_read / owned_write / owned_delete: domain-specific helpers that
//     prove semantic ownership for a specific operation kind.
//   explicit_user_input: paths selected by the user (e.g. --from-file flags).
//   not_a_path: helpers that return content/boolean/object, not a path.
//   unauthorized: anything else.
//   unknown: uninitialized or unreachable.
// ---------------------------------------------------------------------------

const AUTHORITY_KINDS = new Set([
  "symlink_free_contained",
  "owned_read",
  "owned_write",
  "owned_delete",
  "explicit_user_input",
  "authority_object",
  "not_a_path",
  "unauthorized",
  "unknown",
]);

// Only these kinds authorize a path argument to a filesystem sink.
const SINK_AUTHORIZED_KINDS = new Set([
  "symlink_free_contained",
  "owned_read",
  "owned_write",
  "owned_delete",
  "explicit_user_input",
]);

// authority_object is a special kind: the variable holds an object whose
// .absPath property is an authorized path. The .absPath access extracts it.
const AUTHORITY_OBJECT_KINDS = new Set(["authority_object"]);

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

// Authority exports: only helpers that return a path (string) or a branded
// path object with .absPath. Helpers that return content, boolean, manifest
// object, or write results are NOT path authority sources.
const AUTHORITY_EXPORTS = new Map([
  [
    join("src", "core", "path-safety.ts"),
    new Map([
      ["resolveSymlinkFreeProjectPath", "symlink_free_contained"],
      ["resolveSymlinkFreeProjectPathSync", "symlink_free_contained"],
      ["resolveWithinProject", "explicit_user_input"],
      ["resolveWithinProjectSync", "explicit_user_input"],
    ]),
  ],
  [
    join("src", "core", "project-fs", "owned-read.ts"),
    new Map([["resolveOwnedReadPath", "owned_read"]]),
  ],
  [
    join("src", "core", "project-config-path.ts"),
    new Map([["resolveProjectConfigPath", "symlink_free_contained"]]),
  ],
  [
    join("src", "core", "agent-profile-path.ts"),
    new Map([
      ["resolveAgentProfilePath", "owned_read"],
      ["resolveOwnedAgentProfilePath", "owned_write"],
    ]),
  ],
  [
    join("src", "core", "archive", "paths.ts"),
    new Map([
      ["resolveArchiveOwnedPath", "owned_read"],
      ["resolveArchiveOwnedPathSync", "owned_read"],
    ]),
  ],
  [
    join("src", "core", "adapters", "manifest.ts"),
    new Map([
      ["resolveManifestPath", "owned_read"],
      // readManifest returns manifest object, writeManifest returns void — NOT path authority
    ]),
  ],
  [
    join("src", "core", "adapters", "manifest-file-ownership.ts"),
    new Map([
      ["authorizeAdapterMutationPath", "authority_object"],
      ["classifyManifestFileForRead", "authority_object"],
    ]),
  ],
  [
    join("src", "core", "adapters", "file-state.ts"),
    new Map([
      // readAuthorizedRegularFileMaybe returns string|null content — NOT path authority
      // authorizedPathExists returns boolean — NOT path authority
    ]),
  ],
  [
    join("src", "core", "progress", "io.ts"),
    new Map([["resolveProgressPath", "owned_read"]]),
  ],
  [
    join("src", "core", "pack", "context-output-path.ts"),
    new Map([["resolveProfileContextOutputPath", "owned_write"]]),
  ],
  // atomicWriteText is a sink wrapper, not an authority source
]);

// Trusted fs modules: modules that are trusted to do raw fs operations
// internally because they use resolveSymlinkFreeProjectPath internally.
// These are excluded from checking (like authority export modules).
const TRUSTED_FS_MODULES = new Set([
  join("src", "core", "project-fs", "index.ts"),
  join("src", "core", "path-safety.ts"),
  join("src", "core", "project-config-path.ts"),
  join("src", "core", "project-fs", "owned-read.ts"),
  join("src", "core", "project-fs", "control-plane.ts"),
  join("src", "core", "agent-profile-path.ts"),
  join("src", "core", "archive", "paths.ts"),
  join("src", "core", "archive", "archive-bundle-cleanup.ts"),
  join("src", "core", "archive", "archive-bundle-writer.ts"),
  join("src", "core", "archive", "archive-maintenance.ts"),
  join("src", "core", "archive", "archive-retention.ts"),
  join("src", "core", "archive", "bundle-member-removal.ts"),
  join("src", "core", "archive", "decision-record.ts"),
  join("src", "core", "archive", "delete-intent-journal.ts"),
  join("src", "core", "archive", "event-pack-cleanup-gate.ts"),
  join("src", "core", "archive", "event-pack-cleanup-reconcile.ts"),
  join("src", "core", "archive", "event-pack-cleanup-run.ts"),
  join("src", "core", "archive", "event-pack.ts"),
  join("src", "core", "archive", "load-phase-snapshot.ts"),
  join("src", "core", "archive", "phase-snapshot.ts"),
  join("src", "core", "adapters", "manifest.ts"),
  join("src", "core", "adapters", "manifest-file-ownership.ts"),
  join("src", "core", "adapters", "file-state.ts"),
  join("src", "core", "progress", "io.ts"),
  join("src", "core", "progress", "events-io.ts"),
  join("src", "core", "progress", "all-sources.ts"),
  join("src", "core", "progress", "migrate.ts"),
  join("src", "core", "pack", "context-output-path.ts"),
  join("src", "core", "pack", "index.ts"),
  join("src", "core", "plan", "load-phase.ts"),
  join("src", "core", "plan", "normalize.ts"),
  join("src", "core", "plan", "roadmap.ts"),
  join("src", "core", "plan", "state.ts"),
  join("src", "core", "plan", "sync-paths.ts"),
  join("src", "core", "plan", "checks", "fs.ts"),
  join("src", "core", "services", "createPhase.ts"),
  join("src", "core", "decisions", "adr.ts"),
  join("src", "core", "decisions", "decision-gate-archive.ts"),
  join("src", "core", "decisions", "link-collector.ts"),
  join("src", "core", "decisions", "prune-executor.ts"),
  join("src", "core", "finalize", "safe-write.ts"),
  join("src", "core", "glob.ts"),
  join("src", "core", "locks", "write-lock.ts"),
  join("src", "core", "context-fit", "load-context-budget.ts"),
  join("src", "io", "atomic-text.ts"),
]);

// Result properties that extract a path from an authority result object.
const AUTHORITY_RESULT_PROPS = new Set(["absPath"]);

// ---------------------------------------------------------------------------
// Structured allowlist for explicit user-input paths and other exceptions.
// Format: "src/path.ts#functionName" → { operation, authority, reason }
// Stale entries (file/function not found) cause a failure.
// ---------------------------------------------------------------------------

const ALLOWLIST_PATH = join(".code-pact", "fs-authority-allowlist.json");

function loadAllowlist() {
  try {
    const raw = readFileSync(ALLOWLIST_PATH, "utf8");
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

function allowlistKey(relFile, fnName) {
  return `${relFile}#${fnName}`;
}

// ---------------------------------------------------------------------------
// Scope tracking with authority kinds
// ---------------------------------------------------------------------------

function createScope(parent = null) {
  return { parent, vars: new Map() };
}

function cloneScope(scope) {
  return { parent: scope.parent, vars: new Map(scope.vars) };
}

function declareVar(scope, name, kind) {
  scope.vars.set(name, kind);
}

function assignVar(scope, name, kind) {
  let current = scope;
  while (current) {
    if (current.vars.has(name)) {
      current.vars.set(name, kind);
      return;
    }
    current = current.parent;
  }
  scope.vars.set(name, kind);
}

function getVarKind(scope, name) {
  let current = scope;
  while (current) {
    if (current.vars.has(name)) return current.vars.get(name);
    current = current.parent;
  }
  return "unknown";
}

function mergeKind(a, b) {
  if (a === b) return a;
  // Both must be sink-authorized for the merge to be sink-authorized
  if (SINK_AUTHORIZED_KINDS.has(a) && SINK_AUTHORIZED_KINDS.has(b)) {
    // If they're different authorized kinds, pick the more restrictive
    // (owned_* is more restrictive than symlink_free_contained)
    if (a === "symlink_free_contained" || b === "symlink_free_contained") {
      return "symlink_free_contained";
    }
    return a; // both are owned_*, pick either
  }
  return "unauthorized";
}

function mergeScopes(base, left, right) {
  const names = new Set([
    ...base.vars.keys(),
    ...left.vars.keys(),
    ...right.vars.keys(),
  ]);
  for (const name of names) {
    base.vars.set(
      name,
      mergeKind(
        left.vars.has(name)
          ? left.vars.get(name)
          : getVarKind(left.parent, name),
        right.vars.has(name)
          ? right.vars.get(name)
          : getVarKind(right.parent, name),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Trusted import resolution with shadowing detection
// ---------------------------------------------------------------------------

function trustedImportsFor(sourceFile) {
  // Map from local binding name → { kind, importPath, exportName }
  const trusted = new Map();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const modulePath = resolveImport(
      sourceFile.fileName,
      stmt.moduleSpecifier.text,
    );
    if (modulePath === null) continue;
    const allowed = AUTHORITY_EXPORTS.get(modulePath);
    if (!allowed) continue;
    const clause = stmt.importClause;
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const exported = el.propertyName?.text ?? el.name.text;
      const kind = allowed.get(exported);
      if (kind) {
        trusted.set(el.name.text, {
          kind,
          importPath: modulePath,
          exportName: exported,
        });
      }
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
  return resolve(path)
    .split(/[\\/]/)
    .join("/")
    .replace(`${process.cwd().split(/[\\/]/).join("/")}/`, "");
}

// ---------------------------------------------------------------------------
// Check if an identifier is shadowed by a function parameter or local
// ---------------------------------------------------------------------------

function isShadowed(node, localName, scope) {
  // Check if any scope declares this name as a parameter or local
  let current = scope;
  while (current) {
    if (current.vars.has(localName)) {
      // If it was declared as a parameter (kind "unauthorized" at function entry)
      // or as a local variable, it shadows the import
      const kind = current.vars.get(localName);
      if (kind === "unauthorized" || kind === "unknown") {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Authority expression evaluation
// ---------------------------------------------------------------------------

function getCallName(node) {
  if (!node) return null;
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression)) return node.expression.text;
    if (ts.isPropertyAccessExpression(node.expression))
      return node.expression.name.text;
  }
  return null;
}

function isTrustedAuthorityCall(node, scope, trustedImports, localWrappers) {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isIdentifier(node.expression)) return null;
  const name = node.expression.text;
  const info = trustedImports.get(name);
  if (info) {
    if (isShadowed(node, name, scope)) return null;
    return info.kind;
  }
  // Check local wrappers (no shadowing check needed — these are local
  // function declarations, not imported identifiers that could be shadowed
  // by parameters or local variables)
  if (localWrappers && localWrappers.has(name)) {
    return localWrappers.get(name);
  }
  return null;
}

function isAuthorityExpression(node, scope, trustedImports, localWrappers) {
  if (!node) return "unauthorized";
  if (ts.isAwaitExpression(node))
    return isAuthorityExpression(
      node.expression,
      scope,
      trustedImports,
      localWrappers,
    );
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return isAuthorityExpression(
      node.expression,
      scope,
      trustedImports,
      localWrappers,
    );
  }
  if (ts.isCallExpression(node)) {
    const kind = isTrustedAuthorityCall(
      node,
      scope,
      trustedImports,
      localWrappers,
    );
    if (kind) return kind;
    const name = getCallName(node);
    if (name === "dirname" && node.arguments.length > 0) {
      const argKind = isAuthorityExpression(
        node.arguments[0],
        scope,
        trustedImports,
        localWrappers,
      );
      return SINK_AUTHORIZED_KINDS.has(argKind) ? argKind : "unauthorized";
    }
    return "unauthorized";
  }
  if (ts.isIdentifier(node)) {
    const kind = getVarKind(scope, node.text);
    return SINK_AUTHORIZED_KINDS.has(kind) ? kind : "unauthorized";
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (
      AUTHORITY_RESULT_PROPS.has(node.name.text) &&
      ts.isIdentifier(node.expression)
    ) {
      const kind = getVarKind(scope, node.expression.text);
      // If the variable is an authority_object, its .absPath is a sink-authorized path.
      if (AUTHORITY_OBJECT_KINDS.has(kind)) {
        return "symlink_free_contained";
      }
      // If the variable itself is sink-authorized, its .absPath is also authorized.
      return SINK_AUTHORIZED_KINDS.has(kind) ? kind : "unauthorized";
    }
    return "unauthorized";
  }
  if (ts.isConditionalExpression(node)) {
    return mergeKind(
      isAuthorityExpression(
        node.whenTrue,
        scope,
        trustedImports,
        localWrappers,
      ),
      isAuthorityExpression(
        node.whenFalse,
        scope,
        trustedImports,
        localWrappers,
      ),
    );
  }
  return "unauthorized";
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

// ---------------------------------------------------------------------------
// File discovery: expand to src/commands/**, src/core/**, src/cli/**
// ---------------------------------------------------------------------------

function discoverTargetFiles() {
  const roots = [
    join("src", "commands"),
    join("src", "core"),
    join("src", "cli"),
  ];
  const files = [];
  for (const root of roots) {
    const absRoot = resolve(root);
    if (!existsSync(absRoot)) continue;
    walkTs(absRoot, files);
  }
  return files;
}

function walkTs(dir, files) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTs(full, files);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      files.push(rel(full));
    }
  }
}

// ---------------------------------------------------------------------------
// Check a single file
// ---------------------------------------------------------------------------

function checkFile(filePath, allowlist, allowlistUsed) {
  const relFile = rel(filePath);
  if (isAuthorityModule(relFile)) return [];
  const text = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings = [];
  const trustedImports = trustedImportsFor(sourceFile);

  // Detect local wrapper functions: functions whose body is a single
  // return statement returning a trusted authority call (possibly wrapped
  // in try/catch that re-throws). These are treated as authority sources.
  const localWrappers = new Map();
  function scanForWrappers(node) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      if (node.name && node.body) {
        const kind = detectWrapperKind(node, trustedImports);
        if (kind) {
          localWrappers.set(node.name.text, kind);
        }
      }
    }
    ts.forEachChild(node, scanForWrappers);
  }
  scanForWrappers(sourceFile);

  function visit(node, scope) {
    // Function declaration: parameters shadow imports
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) declareVar(scope, node.name.text, "unauthorized");
      const fnScope = createScope(scope);
      for (const param of node.parameters) {
        if (ts.isIdentifier(param.name))
          declareVar(fnScope, param.name.text, "unauthorized");
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
        if (ts.isIdentifier(param.name))
          declareVar(fnScope, param.name.text, "unauthorized");
      }
      if (node.body) visit(node.body, fnScope);
      return;
    }

    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const blockScope = ts.isSourceFile(node) ? scope : createScope(scope);
      for (const stmt of node.statements ?? []) visit(stmt, blockScope);
      return;
    }

    // if / else
    if (ts.isIfStatement(node)) {
      visit(node.expression, scope);
      const thenScope = cloneScope(scope);
      const elseScope = cloneScope(scope);
      visit(node.thenStatement, thenScope);
      if (node.elseStatement) visit(node.elseStatement, elseScope);
      mergeScopes(scope, thenScope, elseScope);
      return;
    }

    // switch — merge all case scopes conservatively
    if (ts.isSwitchStatement(node)) {
      visit(node.expression, scope);
      const caseScopes = [];
      for (const clause of node.caseBlock.clauses) {
        const caseScope = cloneScope(scope);
        for (const stmt of clause.statements) visit(stmt, caseScope);
        caseScopes.push(caseScope);
      }
      if (caseScopes.length === 0) return;
      // Merge all case scopes into the parent scope
      let merged = caseScopes[0];
      for (let i = 1; i < caseScopes.length; i++) {
        const tmp = createScope(scope.parent);
        mergeScopes(tmp, merged, caseScopes[i]);
        merged = tmp;
      }
      mergeScopes(scope, merged, merged);
      return;
    }

    // try / catch / finally — catch block may execute without try completing.
    // However, if the catch block always re-throws (all paths lead to throw),
    // the catch scope is unreachable after the try/catch, so the try scope's
    // state persists into the parent scope.
    if (ts.isTryStatement(node)) {
      const tryScope = cloneScope(scope);
      if (node.tryBlock) visit(node.tryBlock, tryScope);
      const catchScope = cloneScope(scope);
      let catchAlwaysThrows = false;
      if (node.catchClause) {
        const catchFnScope = createScope(catchScope);
        if (
          node.catchClause.variableDeclaration &&
          ts.isIdentifier(node.catchClause.variableDeclaration.name)
        ) {
          declareVar(
            catchFnScope,
            node.catchClause.variableDeclaration.name.text,
            "unauthorized",
          );
        }
        visit(node.catchClause.block, catchFnScope);
        catchAlwaysThrows = blockAlwaysExits(node.catchClause.block);
      }
      if (catchAlwaysThrows) {
        // Catch always re-throws → only try scope's state is reachable
        mergeScopes(scope, tryScope, tryScope);
      } else {
        // Merge try and catch conservatively (catch may run when try failed mid-way)
        mergeScopes(scope, tryScope, catchScope);
      }
      if (node.finallyBlock) visit(node.finallyBlock, scope);
      return;
    }

    // for / for-of / while / do-while — body may not execute or may execute multiple times
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node)
    ) {
      if (node.initializer) visit(node.initializer, scope);
      if (ts.isForStatement(node) && node.condition)
        visit(node.condition, scope);
      if (ts.isForStatement(node) && node.incrementor)
        visit(node.incrementor, scope);
      if (ts.isForInStatement(node) || ts.isForOfStatement(node))
        visit(node.expression, scope);
      // Body may not execute at all → merge conservatively (body vars don't persist)
      const bodyScope = cloneScope(scope);
      if (node.statement) visit(node.statement, bodyScope);
      // Don't merge body scope back — body may not execute
      return;
    }

    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      if (ts.isWhileStatement(node)) visit(node.expression, scope);
      const bodyScope = cloneScope(scope);
      if (node.statement) visit(node.statement, bodyScope);
      if (ts.isDoStatement(node)) visit(node.expression, scope);
      return;
    }

    // Variable declaration
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) visit(node.initializer, scope);
      const kind = node.initializer
        ? isAuthorityExpression(
            node.initializer,
            scope,
            trustedImports,
            localWrappers,
          )
        : "unauthorized";
      declareVar(scope, node.name.text, kind);
      return;
    }

    // Assignment (including reassignment)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      visit(node.right, scope);
      const kind = isAuthorityExpression(
        node.right,
        scope,
        trustedImports,
        localWrappers,
      );
      assignVar(scope, node.left.text, kind);
      return;
    }

    // Filesystem sink call check
    if (ts.isCallExpression(node)) {
      const fnName = getCallName(node);
      if (fnName && FS_FUNCTIONS.has(fnName)) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (!isInsideTrustedAuthorityDefinition(node, trustedImports)) {
          const firstArg = node.arguments[0];
          if (firstArg) {
            const argKind = isAuthorityExpression(
              firstArg,
              scope,
              trustedImports,
              localWrappers,
            );
            if (!SINK_AUTHORIZED_KINDS.has(argKind)) {
              // Check allowlist
              const enclosingFn = findEnclosingFunctionName(node);
              const aKey = allowlistKey(relFile, enclosingFn ?? "*");
              const aEntry = allowlist.get(aKey);
              if (aEntry) {
                allowlistUsed.add(aKey);
                if (
                  aEntry.operation === fnName &&
                  SINK_AUTHORIZED_KINDS.has(aEntry.authority)
                ) {
                  // Allowed
                } else {
                  findings.push({
                    line,
                    fn: fnName,
                    arg: firstArg.getText(sourceFile).slice(0, 80),
                    text: sourceFile.text.split("\n")[line - 1]?.trim() ?? "",
                  });
                }
              } else {
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
      }
    }

    ts.forEachChild(node, child => visit(child, scope));
  }

  visit(sourceFile, createScope());
  return findings;
}

function isAuthorityModule(relFile) {
  if (TRUSTED_FS_MODULES.has(relFile)) return true;
  for (const key of AUTHORITY_EXPORTS.keys()) {
    if (relFile === key) return true;
  }
  return false;
}

function detectWrapperKind(fnNode, trustedImports) {
  if (!fnNode.body) return null;
  const body = fnNode.body;
  // Case 1: arrow function with expression body: (args) => await trustedCall(...)
  if (ts.isAwaitExpression(body) || ts.isCallExpression(body)) {
    const kind = isAuthorityExpression(
      body,
      createScope(),
      trustedImports,
      null,
    );
    return SINK_AUTHORIZED_KINDS.has(kind) ? kind : null;
  }
  if (!ts.isBlock(body)) return null;
  // Case 2: block body with single return statement: return await trustedCall(...)
  // Or try/catch wrapping a return of trustedCall, where catch always re-throws.
  return detectBlockWrapperKind(body, createScope(), trustedImports);
}

function detectBlockWrapperKind(block, scope, trustedImports) {
  if (!block || !ts.isBlock(block)) return null;
  for (const stmt of block.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      const kind = isAuthorityExpression(
        stmt.expression,
        scope,
        trustedImports,
        null,
      );
      return SINK_AUTHORIZED_KINDS.has(kind) ? kind : null;
    }
    if (ts.isTryStatement(stmt)) {
      // Check if try block returns a trusted call and catch always exits
      const tryKind = detectBlockWrapperKind(
        stmt.tryBlock,
        createScope(scope),
        trustedImports,
      );
      if (
        tryKind &&
        stmt.catchClause &&
        blockAlwaysExits(stmt.catchClause.block)
      ) {
        return tryKind;
      }
      return null;
    }
  }
  return null;
}

function blockAlwaysExits(block) {
  if (!block || !ts.isBlock(block)) return false;
  for (const stmt of block.statements) {
    if (statementAlwaysExits(stmt)) return true;
  }
  return false;
}

function statementAlwaysExits(stmt) {
  if (ts.isThrowStatement(stmt)) return true;
  if (ts.isReturnStatement(stmt)) return true;
  if (ts.isBlock(stmt)) return blockAlwaysExits(stmt);
  if (ts.isIfStatement(stmt)) {
    return (
      statementAlwaysExits(stmt.thenStatement) &&
      (stmt.elseStatement ? statementAlwaysExits(stmt.elseStatement) : false)
    );
  }
  if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
    // A bare `throw err` pattern is caught by ThrowStatement above.
    // This won't catch `await someFuncThatAlwaysThrows()` — that's fine,
    // we only need to catch explicit throw/return patterns.
  }
  return false;
}

function findEnclosingFunctionName(node) {
  let current = node;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name
    ) {
      return current.name.text;
    }
    current = current.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const allowlist = loadAllowlist();
const allowlistUsed = new Set();

const filesToCheck = process.argv.slice(2);
const runFiles = filesToCheck.length > 0 ? filesToCheck : discoverTargetFiles();

let total = 0;
for (const file of runFiles) {
  const absPath = resolve(file);
  if (!existsSync(absPath)) continue;
  let findings;
  try {
    findings = checkFile(absPath, allowlist, allowlistUsed);
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

// Check for stale allowlist entries
const staleEntries = [];
for (const key of allowlist.keys()) {
  if (!allowlistUsed.has(key)) {
    staleEntries.push(key);
  }
}
if (staleEntries.length > 0) {
  for (const key of staleEntries) {
    console.log(
      `fs-authority: stale allowlist entry "${key}" — file/function not found or not used.`,
    );
  }
  total += staleEntries.length;
}

if (total > 0) {
  console.log(
    `\nfs-authority: ${total} finding(s). Fs operations must use approved project authority helpers.`,
  );
  process.exit(1);
}
process.exit(0);
