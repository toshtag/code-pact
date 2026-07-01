import { join } from "node:path";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtemp } from "../raw-internal.ts";
import {
  brandTemporarySandbox,
  type TemporarySandboxPath,
  unbrand,
} from "../branded-paths-internal.ts";

export async function createTutorialSandbox(
  parent: string = tmpdir(),
): Promise<TemporarySandboxPath> {
  const path = await mkdtemp(join(parent, "code-pact-tutorial-"));
  return brandTemporarySandbox(path);
}

export async function removeTutorialSandbox(
  path: TemporarySandboxPath,
): Promise<void> {
  await rm(unbrand(path), { recursive: true, force: true });
}
