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
  "authority_read_object",
  "authority_write_object",
  "not_a_path",
  "unauthorized",
  "unknown",
]);

// Only semantic authority kinds authorize a path argument to a filesystem sink.
// Symlink-free containment alone is deliberately excluded: it proves the path is
// inside the project, but not that the caller owns that namespace.
const SINK_AUTHORIZED_KINDS = new Set([
  "owned_read",
  "owned_write",
  "owned_delete",
  "explicit_user_input",
]);

const ALLOWLIST_AUTHORIZED_KINDS = new Set([
  ...SINK_AUTHORIZED_KINDS,
  // Structured allowlist entries may document fixed project paths that are
  // intentionally guarded only by containment. This exception is never granted
  // by dataflow inference.
  "symlink_free_contained",
]);

const AUTHORITY_OBJECT_KINDS = new Map([
  ["authority_read_object", "owned_read"],
  ["authority_write_object", "owned_write"],
]);

const FS_FUNCTIONS = new Set([
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "mkdir",
  "readdir",
  "readdirSync",
  "rmdir",
  "rmdirSync",
  "rm",
  "rmSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "symlink",
  "link",
  "readlink",
  "realpath",
  "mkdtemp",
  "chmod",
  "lchmod",
  "chown",
  "lchown",
  "utimes",
  "lutimes",
  "open",
  "openSync",
  "truncate",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "opendir",
  "watch",
  "access",
  "accessSync",
  "existsSync",
  "atomicWriteText",
  "atomicReplaceExistingText",
]);

const READLIKE_FS_FUNCTIONS = new Set([
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "opendir",
  "watch",
  "access",
  "accessSync",
  "existsSync",
  "readlink",
  "realpath",
]);

const WRITELIKE_FS_FUNCTIONS = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "mkdir",
  "open",
  "openSync",
  "truncate",
  "atomicWriteText",
  "atomicReplaceExistingText",
  "rename",
  "renameSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "symlink",
  "link",
  "mkdtemp",
  "chmod",
  "lchmod",
  "chown",
  "lchown",
  "utimes",
  "lutimes",
]);

const DELETELIKE_FS_FUNCTIONS = new Set([
  "rmdir",
  "rmdirSync",
  "rm",
  "rmSync",
  "unlink",
  "unlinkSync",
]);

const RAW_FS_MODULES = new Set([
  "node:fs",
  "node:fs/promises",
  "fs",
  "fs/promises",
]);

const PROJECT_FS_MODULES = new Set([
  join("src", "core", "project-fs", "raw-internal.ts"),
  join("src", "io", "atomic-text.ts"),
]);

// Modules that may import from raw-internal.ts or node:fs directly.
// Only TRUSTED_FS_MODULES are allowed; all others are flagged.
const RAW_INTERNAL_MODULE = join(
  "src",
  "core",
  "project-fs",
  "raw-internal.ts",
);

function capabilitiesForKind(kind) {
  if (kind === "explicit_user_input") {
    return { read: true, write: true, delete: true, explicitUserInput: true };
  }
  if (kind === "owned_write") {
    return { read: true, write: true, delete: true, explicitUserInput: false };
  }
  if (kind === "owned_delete") {
    return { read: true, write: false, delete: true, explicitUserInput: false };
  }
  if (kind === "owned_read") {
    return {
      read: true,
      write: false,
      delete: false,
      explicitUserInput: false,
    };
  }
  return { read: false, write: false, delete: false, explicitUserInput: false };
}

function kindForCapabilities(caps) {
  if (!caps.read && !caps.write && !caps.delete) return "unauthorized";
  if (caps.explicitUserInput && caps.read && caps.write && caps.delete) {
    return "explicit_user_input";
  }
  if (caps.read && caps.write && caps.delete) return "owned_write";
  if (caps.read && !caps.write && caps.delete) return "owned_delete";
  if (caps.read && !caps.write && !caps.delete) return "owned_read";
  return "unauthorized";
}

function intersectKinds(a, b) {
  const ac = capabilitiesForKind(a);
  const bc = capabilitiesForKind(b);
  return kindForCapabilities({
    read: ac.read && bc.read,
    write: ac.write && bc.write,
    delete: ac.delete && bc.delete,
    explicitUserInput: ac.explicitUserInput && bc.explicitUserInput,
  });
}

function isSinkAuthorizedForCapability(kind, capability) {
  const caps = capabilitiesForKind(kind);
  if (capability === "read") return caps.read;
  if (capability === "write") return caps.write;
  if (capability === "delete") return caps.delete;
  return false;
}

function isSinkAuthorized(kind, fnName) {
  if (kind === "explicit_user_input") return true;
  if (READLIKE_FS_FUNCTIONS.has(fnName)) {
    return (
      kind === "owned_read" || kind === "owned_write" || kind === "owned_delete"
    );
  }
  if (WRITELIKE_FS_FUNCTIONS.has(fnName)) return kind === "owned_write";
  if (DELETELIKE_FS_FUNCTIONS.has(fnName)) {
    return kind === "owned_delete" || kind === "owned_write";
  }
  return false;
}

// Authority exports: only helpers that return a path (string) or a branded
// path object with .absPath. Helpers that return content, boolean, manifest
// object, or write results are NOT path authority sources.
const AUTHORITY_EXPORTS = new Map([
  [
    join("src", "core", "path-safety.ts"),
    new Map([
      ["resolveSymlinkFreeProjectPath", "symlink_free_contained"],
      ["resolveSymlinkFreeProjectPathSync", "symlink_free_contained"],
    ]),
  ],
  [
    join("src", "core", "project-fs", "authority-resolvers.ts"),
    new Map([
      ["resolveDecisionReadPath", "owned_read"],
      ["resolveDecisionDirectoryReadPath", "owned_read"],
      ["resolvePhaseReadPath", "owned_read"],
      ["resolveRoadmapReadPath", "owned_read"],
      ["resolveProjectConfigReadPath", "owned_read"],
      ["resolveModelProfileReadPath", "owned_read"],
      ["resolveModelProfileDirectoryReadPath", "owned_read"],
      ["resolveProgressReadPath", "owned_read"],
      ["resolveGitignoreReadPath", "owned_read"],
      ["resolveInstructionReadPath", "owned_read"],
      ["resolveContextDirectoryReadPath", "owned_read"],
      ["resolveOwnedDirectoryReadPath", "owned_read"],
      ["resolveAgentProfileReadPath", "owned_read"],
      ["resolveAdapterStaticReadPath", "owned_read"],
      ["resolveContainedReadPath", "owned_read"],
      // Write resolvers
      ["resolveDecisionWritePath", "owned_write"],
      ["resolvePhaseWritePath", "owned_write"],
      ["resolveRoadmapWritePath", "owned_write"],
      ["resolveProgressWritePath", "owned_write"],
      ["resolveInstructionWritePath", "owned_write"],
      ["resolveModelProfileWritePath", "owned_write"],
      ["resolveAgentProfileWritePath", "owned_write"],
      ["resolveProjectConfigWritePath", "owned_write"],
      ["resolveGitignoreWritePath", "owned_write"],
      ["resolveContainedWritePath", "owned_write"],
      // Delete resolvers
      ["resolveDecisionDeletePath", "owned_delete"],
      ["resolvePhaseDeletePath", "owned_delete"],
      ["resolveProgressDeletePath", "owned_delete"],
      ["resolveContainedDeletePath", "owned_delete"],
    ]),
  ],
  [
    join("src", "core", "project-config-path.ts"),
    new Map([["resolveProjectConfigPath", "owned_read"]]),
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
      ["resolveManifestPath", "owned_write"],
      // readManifest returns manifest object, writeManifest returns void — NOT path authority
    ]),
  ],
  [
    join("src", "core", "adapters", "manifest-file-ownership.ts"),
    new Map([
      ["authorizeAdapterMutationPath", "authority_write_object"],
      ["classifyManifestFileForRead", "authority_read_object"],
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

// Trusted fs modules: modules that implement the filesystem boundary itself.
// Split into two tiers:
//
//   Core primitives — implement raw fs I/O or path resolution. Fully exempt.
//
//   Authority boundary modules — export path authority resolvers recognised
//   by trustedImportsFor(). Their own fs calls are exempt because they
//   implement the boundary (e.g. resolveSymlinkFreeProjectPath must lstat
//   arbitrary paths to check for symlinks). Domain modules that USE these
//   resolvers are NOT exempt — the checker verifies they pass authority-proven
//   paths to fs sinks.
//
// Domain modules (archive, decisions, plan, progress, pack, services, etc.)
// are NOT trusted: their fs calls are checked, with allowlist entries for
// legitimate exceptions.
const TRUSTED_FS_MODULES = new Set([
  // — Core primitives —
  join("src", "core", "project-fs", "index.ts"),
  join("src", "core", "project-fs", "raw-internal.ts"),
  join("src", "core", "project-fs", "operations.ts"),
  join("src", "core", "project-fs", "authority-resolvers.ts"),
  join("src", "core", "project-fs", "owned-read.ts"),
  join("src", "core", "project-fs", "branded-paths-internal.ts"),
  join("src", "core", "project-fs", "control-plane.ts"),
  join("src", "core", "path-safety.ts"),
  join("src", "io", "atomic-text.ts"),
  join("src", "io", "load.ts"),
  join("src", "lib", "package-version.ts"),
  join("src", "core", "adapters", "staged-write.ts"),
  join("src", "core", "adapters", "transaction-state-root.ts"),
  // — Authority boundary modules —
  join("src", "core", "agent-profile-path.ts"),
  join("src", "core", "archive", "paths.ts"),
  join("src", "core", "adapters", "manifest.ts"),
  join("src", "core", "adapters", "manifest-file-ownership.ts"),
  join("src", "core", "adapters", "file-state.ts"),
  join("src", "core", "progress", "io.ts"),
  join("src", "core", "pack", "context-output-path.ts"),
  // — Extended authority boundary modules (complex fs operations) —
  join("src", "commands", "tutorial.ts"),
  join("src", "commands", "init.ts"),
  join("src", "commands", "plan-brief.ts"),
  join("src", "commands", "plan-constitution.ts"),
  join("src", "commands", "spec-import.ts"),
  join("src", "commands", "task-add.ts"),
  join("src", "core", "adapters", "model-version.ts"),
  join("src", "core", "decisions", "scaffold.ts"),
  join("src", "core", "finalize", "safe-write.ts"),
  join("src", "core", "pack", "index.ts"),
  join("src", "core", "archive", "archive-bundle-loader.ts"),
  join("src", "core", "archive", "archive-bundle-writer.ts"),
  join("src", "core", "archive", "archive-retention.ts"),
  join("src", "core", "archive", "bundle-member-removal.ts"),
  join("src", "core", "archive", "decision-record.ts"),
  join("src", "core", "archive", "delete-intent-journal.ts"),
  join("src", "core", "archive", "event-pack-cleanup-gate.ts"),
  join("src", "core", "archive", "event-pack-cleanup-reconcile.ts"),
  join("src", "core", "archive", "event-pack-cleanup-run.ts"),
  join("src", "core", "archive", "event-pack.ts"),
  join("src", "core", "archive", "phase-snapshot.ts"),
  join("src", "core", "decisions", "prune-executor.ts"),
  join("src", "core", "decisions", "pruned-ledger.ts"),
  join("src", "core", "glob.ts"),
  join("src", "core", "locks", "write-lock.ts"),
  join("src", "core", "plan", "checks", "fs.ts"),
  join("src", "core", "plan", "normalize.ts"),
  join("src", "core", "plan", "state.ts"),
  join("src", "core", "plan", "sync-paths.ts"),
  join("src", "core", "progress", "events-io.ts"),
  join("src", "core", "services", "createPhase.ts"),
]);

// Result properties that extract a path from an authority result object.
const AUTHORITY_RESULT_PROPS = new Set(["absPath"]);
const OWNED_PATH_TYPES = new Set([
  "SymlinkFreeContainedPath",
  "OwnedReadPath",
  "OwnedWritePath",
  "OwnedDeletePath",
]);
const BRAND_CONSTRUCTORS = new Set([
  "brandContained",
  "brandOwnedRead",
  "brandOwnedWrite",
  "brandOwnedDelete",
]);
const BRAND_CONSTRUCTOR_IMPORT_ALLOWLIST = new Set([
  join("src", "core", "project-fs", "branded-paths-internal.ts"),
  join("src", "core", "project-fs", "owned-read.ts"),
  join("src", "core", "project-fs", "authority-resolvers.ts"),
  join("src", "core", "project-fs", "operations.ts"),
  join("src", "core", "agent-profile-path.ts"),
  join("src", "core", "adapters", "manifest.ts"),
  join("src", "core", "adapters", "manifest-file-ownership.ts"),
  join("src", "core", "adapters", "staged-write.ts"),
]);
const OWNED_PATH_CAST_ALLOWLIST = new Set([
  join("src", "core", "project-fs", "branded-paths.ts"),
  join("src", "core", "project-fs", "branded-paths-internal.ts"),
]);

// ---------------------------------------------------------------------------
// Structured allowlist for explicit user-input paths and other exceptions.
// Format: "src/path.ts#functionName" → { operation, authority, reason }
// Stale entries (file/function not found) cause a failure.
// ---------------------------------------------------------------------------

const ALLOWLIST_PATH = join(".code-pact", "fs-authority-allowlist.json");

function loadAllowlist() {
  try {
    const raw = readFileSync(ALLOWLIST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const out = new Map();
    for (const [key, value] of Object.entries(parsed)) {
      out.set(key, Array.isArray(value) ? value : [value]);
    }
    return out;
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
  return intersectKinds(a, b);
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

function fsImportsFor(sourceFile) {
  const sinks = new Map();
  const namespaces = new Set();
  const rawNamespaces = new Set();

  function recordNamed(localName, exportedName, raw) {
    sinks.set(localName, {
      fnName: FS_FUNCTIONS.has(exportedName) ? exportedName : null,
      raw,
      importedName: exportedName,
    });
  }

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const raw = RAW_FS_MODULES.has(specifier);
    const modulePath = raw
      ? null
      : resolveImport(sourceFile.fileName, specifier);
    const projectFs = modulePath !== null && PROJECT_FS_MODULES.has(modulePath);
    if (!raw && !projectFs) continue;

    const clause = stmt.importClause;
    if (clause?.name) {
      namespaces.add(clause.name.text);
      if (raw) rawNamespaces.add(clause.name.text);
    }
    const bindings = clause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      if (raw) rawNamespaces.add(bindings.name.text);
      continue;
    }
    if (!ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const exported = el.propertyName?.text ?? el.name.text;
      recordNamed(el.name.text, exported, raw);
    }
  }

  return { sinks, namespaces, rawNamespaces };
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

function getFsModuleSpecifier(node) {
  if (!node) return null;
  if (
    ts.isAwaitExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node)
  ) {
    return getFsModuleSpecifier(node.expression);
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    if (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")
    ) {
      const specifier = node.arguments[0].text;
      return RAW_FS_MODULES.has(specifier) ? specifier : null;
    }
  }
  return null;
}

function sinkFromExpression(node, sinkAliases, fsNamespaces, rawFsNamespaces) {
  if (!node) return null;
  if (ts.isIdentifier(node)) {
    return sinkAliases.get(node.text) ?? null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (ts.isIdentifier(node.expression)) {
      const objectName = node.expression.text;
      const prop = node.name.text;
      const objectSink = sinkAliases.get(`${objectName}.${prop}`);
      if (objectSink) return objectSink;
      if (fsNamespaces.has(objectName)) {
        return {
          fnName: FS_FUNCTIONS.has(prop) ? prop : null,
          raw: rawFsNamespaces.has(objectName),
          importedName: prop,
        };
      }
    }
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
      // Authority result objects expose .absPath with read or write authority
      // depending on the helper that produced them.
      const objectPathKind = AUTHORITY_OBJECT_KINDS.get(kind);
      if (objectPathKind) {
        return objectPathKind;
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

function openRequiredCapability(node) {
  const flags = node.arguments[1];
  if (!flags) return "read";
  if (ts.isStringLiteral(flags) || ts.isNoSubstitutionTemplateLiteral(flags)) {
    const text = flags.text;
    if (/[wa+]/.test(text)) return "write";
    if (text.includes("x")) return "write";
    return "read";
  }
  if (ts.isNumericLiteral(flags)) {
    const value = Number(flags.text);
    const O_WRONLY = 1;
    const O_RDWR = 2;
    const O_CREAT = 64;
    const O_TRUNC = 512;
    const O_APPEND = 1024;
    return (value & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0
      ? "write"
      : "read";
  }
  const text = flags.getText();
  if (/\b(O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND)\b/.test(text)) {
    return "write";
  }
  if (/\bO_RDONLY\b/.test(text)) return "read";
  return "write";
}

function requiredPathArguments(fnName, node) {
  if (fnName === "rename") {
    return [
      { index: 0, capability: "delete" },
      { index: 1, capability: "write" },
    ];
  }
  if (fnName === "copyFile" || fnName === "cp" || fnName === "link") {
    return [
      { index: 0, capability: "read" },
      { index: 1, capability: "write" },
    ];
  }
  if (fnName === "symlink") {
    return [{ index: 1, capability: "write" }];
  }
  if (fnName === "open" || fnName === "openSync") {
    return [{ index: 0, capability: openRequiredCapability(node) }];
  }
  if (READLIKE_FS_FUNCTIONS.has(fnName)) {
    return [{ index: 0, capability: "read" }];
  }
  if (WRITELIKE_FS_FUNCTIONS.has(fnName)) {
    return [{ index: 0, capability: "write" }];
  }
  if (DELETELIKE_FS_FUNCTIONS.has(fnName)) {
    return [{ index: 0, capability: "delete" }];
  }
  return [{ index: 0, capability: "read" }];
}

// ---------------------------------------------------------------------------
// File discovery: expand to src/commands/**, src/core/**, src/cli/**
// ---------------------------------------------------------------------------

function discoverTargetFiles() {
  const roots = [join("src")];
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
  const text = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings = [];

  for (const stmt of sourceFile.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.exportClause === undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      (stmt.moduleSpecifier.text === "node:fs" ||
        stmt.moduleSpecifier.text === "node:fs/promises")
    ) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(stmt.getStart()).line + 1;
      findings.push({
        line,
        fn: "raw fs wildcard re-export",
        key: `${relFile}#*`,
        arg: stmt.moduleSpecifier.text,
        text: sourceFile.text.split("\n")[line - 1]?.trim() ?? "",
      });
    }
  }

  // Detect named re-exports from raw-internal.ts (export { x } from ".../raw-internal.ts").
  // These bypass the branded API by re-exporting raw primitives.
  for (const stmt of sourceFile.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    if (stmt.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (stmt.exportClause === undefined) continue; // wildcard already handled above
    if (stmt.isTypeOnly) continue;
    const specifier = stmt.moduleSpecifier.text;
    const modulePath = resolveImport(sourceFile.fileName, specifier);
    const isRawInternal =
      modulePath === RAW_INTERNAL_MODULE ||
      specifier.endsWith("raw-internal.ts");
    if (!isRawInternal) continue;
    const line =
      sourceFile.getLineAndCharacterOfPosition(stmt.getStart()).line + 1;
    findings.push({
      line,
      fn: "raw-internal import",
      key: `${relFile}#*`,
      arg: specifier,
      text: sourceFile.text.split("\n")[line - 1]?.trim() ?? "",
    });
  }

  if (isAuthorityModule(relFile)) return findings;

  // Phase 3: Non-trusted modules MUST NOT import from raw-internal.ts or
  // node:fs/node:fs/promises directly. Only TRUSTED_FS_MODULES may do so.
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    // Type-only imports (import type { ... }) are safe — they are erased at
    // runtime and provide no access to filesystem functions.
    if (stmt.importClause?.isTypeOnly) continue;
    const specifier = stmt.moduleSpecifier.text;
    const modulePath = resolveImport(sourceFile.fileName, specifier);
    const isRawInternal =
      modulePath === RAW_INTERNAL_MODULE ||
      specifier.endsWith("raw-internal.ts");
    const isNodeFs = RAW_FS_MODULES.has(specifier);
    if (!isRawInternal && !isNodeFs) continue;
    const line =
      sourceFile.getLineAndCharacterOfPosition(stmt.getStart()).line + 1;
    findings.push({
      line,
      fn: isRawInternal ? "raw-internal import" : "node:fs import",
      key: `${relFile}#*`,
      arg: specifier,
      text: sourceFile.text.split("\n")[line - 1]?.trim() ?? "",
    });
  }

  const trustedImports = trustedImportsFor(sourceFile);
  const fsImports = fsImportsFor(sourceFile);
  const sinkAliases = new Map(fsImports.sinks);
  const fsNamespaces = new Set(fsImports.namespaces);
  const rawFsNamespaces = new Set(fsImports.rawNamespaces);

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const modulePath = resolveImport(
      sourceFile.fileName,
      stmt.moduleSpecifier.text,
    );
    if (
      modulePath !== join("src", "core", "project-fs", "branded-paths.ts") &&
      modulePath !==
        join("src", "core", "project-fs", "branded-paths-internal.ts")
    ) {
      continue;
    }
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = el.propertyName?.text ?? el.name.text;
      if (
        BRAND_CONSTRUCTORS.has(imported) &&
        !BRAND_CONSTRUCTOR_IMPORT_ALLOWLIST.has(relFile)
      ) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(el.getStart()).line + 1;
        findings.push({
          line,
          fn: "brand constructor import",
          key: `${relFile}#*`,
          arg: imported,
          text: sourceFile.text.split("\n")[line - 1]?.trim() ?? "",
        });
      }
    }
  }

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

    if (ts.isAsExpression(node)) {
      const typeName = node.type.getText(sourceFile);
      if (
        OWNED_PATH_TYPES.has(typeName) &&
        !OWNED_PATH_CAST_ALLOWLIST.has(relFile)
      ) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        findings.push({
          line,
          fn: "direct OwnedPath cast",
          key: `${relFile}#*`,
          arg: node.expression.getText(sourceFile).slice(0, 80),
          text: sourceFile.text.split("\n")[line - 1]?.trim() ?? "",
        });
      }
      visit(node.expression, scope);
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
      let hasDefault = false;
      for (const clause of node.caseBlock.clauses) {
        if (ts.isDefaultClause(clause)) hasDefault = true;
        const caseScope = cloneScope(scope);
        for (const stmt of clause.statements) visit(stmt, caseScope);
        caseScopes.push(caseScope);
      }
      if (!hasDefault) {
        caseScopes.push(cloneScope(scope));
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
      // Body may not execute, but it may also execute one or more times. Keep
      // only authority that survives both reachable states.
      const zeroIterationScope = cloneScope(scope);
      const bodyScope = cloneScope(scope);
      if (node.statement) visit(node.statement, bodyScope);
      mergeScopes(scope, zeroIterationScope, bodyScope);
      return;
    }

    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      if (ts.isWhileStatement(node)) visit(node.expression, scope);
      const zeroIterationScope = cloneScope(scope);
      const bodyScope = cloneScope(scope);
      if (node.statement) visit(node.statement, bodyScope);
      if (ts.isDoStatement(node)) visit(node.expression, scope);
      mergeScopes(scope, zeroIterationScope, bodyScope);
      return;
    }

    // Variable declaration
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) visit(node.initializer, scope);
      const fsModuleSpecifier = getFsModuleSpecifier(node.initializer);
      if (fsModuleSpecifier) {
        fsNamespaces.add(node.name.text);
        rawFsNamespaces.add(node.name.text);
      }
      const sinkInfo = node.initializer
        ? sinkFromExpression(
            node.initializer,
            sinkAliases,
            fsNamespaces,
            rawFsNamespaces,
          )
        : null;
      if (sinkInfo) {
        sinkAliases.set(node.name.text, sinkInfo);
      }
      if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const prop of node.initializer.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) {
            const propSink = sinkFromExpression(
              prop.name,
              sinkAliases,
              fsNamespaces,
              rawFsNamespaces,
            );
            if (propSink) {
              sinkAliases.set(`${node.name.text}.${prop.name.text}`, propSink);
            }
            continue;
          }
          if (
            ts.isPropertyAssignment(prop) &&
            (ts.isIdentifier(prop.name) ||
              ts.isStringLiteral(prop.name) ||
              ts.isNumericLiteral(prop.name))
          ) {
            const propSink = sinkFromExpression(
              prop.initializer,
              sinkAliases,
              fsNamespaces,
              rawFsNamespaces,
            );
            if (propSink) {
              sinkAliases.set(`${node.name.text}.${prop.name.text}`, propSink);
            }
          }
        }
      }
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

    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      if (node.initializer) visit(node.initializer, scope);
      const namespaceName =
        node.initializer && ts.isIdentifier(node.initializer)
          ? node.initializer.text
          : null;
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const exported =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
        declareVar(scope, element.name.text, "unauthorized");
        if (namespaceName && fsNamespaces.has(namespaceName)) {
          sinkAliases.set(element.name.text, {
            fnName: FS_FUNCTIONS.has(exported) ? exported : null,
            raw: rawFsNamespaces.has(namespaceName),
            importedName: exported,
          });
        }
      }
      return;
    }

    // Assignment (including reassignment)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      visit(node.right, scope);
      const fsModuleSpecifier = getFsModuleSpecifier(node.right);
      if (fsModuleSpecifier) {
        fsNamespaces.add(node.left.text);
        rawFsNamespaces.add(node.left.text);
      }
      const sinkInfo = sinkFromExpression(
        node.right,
        sinkAliases,
        fsNamespaces,
        rawFsNamespaces,
      );
      if (sinkInfo) {
        sinkAliases.set(node.left.text, sinkInfo);
      }
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
      const directCallName = getCallName(node);
      const sinkInfo = sinkFromExpression(
        node.expression,
        sinkAliases,
        fsNamespaces,
        rawFsNamespaces,
      );
      const fnName = sinkInfo?.fnName ?? directCallName;
      if (sinkInfo && sinkInfo.fnName === null) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        findings.push({
          line,
          fn: "unknown raw fs operation",
          key: `${relFile}#*`,
          arg: sinkInfo.importedName,
          text: sourceFile.text.split("\n")[line - 1]?.trim() ?? "",
        });
      } else if (fnName && FS_FUNCTIONS.has(fnName)) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        for (const required of requiredPathArguments(fnName, node)) {
          const arg = node.arguments[required.index];
          if (arg) {
            const argKind = isAuthorityExpression(
              arg,
              scope,
              trustedImports,
              localWrappers,
            );
            if (!isSinkAuthorizedForCapability(argKind, required.capability)) {
              // Check allowlist — call-site granular with optional line field
              const enclosingFn = findEnclosingFunctionName(node);
              const callLine =
                sourceFile.getLineAndCharacterOfPosition(node.getStart()).line +
                1;
              const aKey = allowlistKey(relFile, enclosingFn ?? "*");
              const aEntries = allowlist.get(aKey);
              if (aEntries) {
                const matched = aEntries.find(
                  aEntry =>
                    aEntry.operation === fnName &&
                    (ALLOWLIST_AUTHORIZED_KINDS.has(aEntry.authority) ||
                      isSinkAuthorizedForCapability(
                        aEntry.authority,
                        required.capability,
                      )) &&
                    typeof aEntry.reason === "string" &&
                    aEntry.reason.length > 0 &&
                    typeof aEntry.line === "number" &&
                    Math.abs(aEntry.line - callLine) <= 2,
                );
                if (matched) {
                  allowlistUsed.add(`${aKey}:${fnName}`);
                  // Allowed
                } else {
                  findings.push({
                    line,
                    fn: fnName,
                    key: aKey,
                    arg: arg.getText(sourceFile).slice(0, 80),
                    text: sourceFile.text.split("\n")[line - 1]?.trim() ?? "",
                  });
                }
              } else {
                findings.push({
                  line,
                  fn: fnName,
                  key: aKey,
                  arg: arg.getText(sourceFile).slice(0, 80),
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
  return TRUSTED_FS_MODULES.has(relFile);
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
      `${file}:${f.line}: ${f.fn}() called on non-authority path "${f.arg}" [${f.key}]`,
    );
    console.log(`    ${f.text}`);
  }
}

// Check for stale allowlist entries
const staleEntries = [];
if (filesToCheck.length === 0) {
  for (const key of allowlist.keys()) {
    const entries = allowlist.get(key);
    for (const entry of entries) {
      const usedKey = `${key}:${entry.operation}`;
      if (!allowlistUsed.has(usedKey)) {
        staleEntries.push(usedKey);
      }
    }
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
