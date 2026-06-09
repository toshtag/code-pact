import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Phase } from "../schemas/phase.ts";

// The single seam that reads one phase YAML file off disk and validates it.
//
// This exact body used to be byte-duplicated in ~8 command/core files (pack,
// verify, progress, recommend, task-prepare, task-add, phase-import, phase).
// Consolidating it here mirrors the PR0 `loadRoadmap` consolidation
// (control-plane-v2-rfc) one level down, and gives the design-docs-ephemeral
// directive ONE place to teach archive-fallback (resolve a removed *completed*
// phase from its `.code-pact/state` snapshot) instead of ~10 independent reads.
//
// Fail-closed by construction: a missing or invalid phase file throws (ENOENT /
// ZodError). A roadmap-referenced phase is a control-plane input, not optional
// context — callers that want missing-tolerance must add it explicitly here (and
// scope it to *archived* phases), never by swallowing the throw at the call site.
export async function loadPhase(cwd: string, path: string): Promise<Phase> {
  const raw = await readFile(join(cwd, path), "utf8");
  return Phase.parse(parseYaml(raw) as unknown);
}
