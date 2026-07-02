import type { SupportedAgent } from "../agents.ts";
import type { AdapterDescriptor } from "./types.ts";
import { claudeAdapterDescriptor } from "./claude.ts";
import { codexAdapterDescriptor } from "./codex.ts";
import { genericAdapterDescriptor } from "./generic.ts";
import { cursorAdapterDescriptor } from "./cursor.ts";
import { geminiCliAdapterDescriptor } from "./gemini-cli.ts";
import { validateAdapterDescriptor } from "./descriptor-validation.ts";

export const adapterRegistry: Record<SupportedAgent, AdapterDescriptor> = {
  "claude-code": validateAdapterDescriptor(
    "claude-code",
    claudeAdapterDescriptor,
  ),
  codex: validateAdapterDescriptor("codex", codexAdapterDescriptor),
  generic: validateAdapterDescriptor("generic", genericAdapterDescriptor),
  cursor: validateAdapterDescriptor("cursor", cursorAdapterDescriptor),
  "gemini-cli": validateAdapterDescriptor(
    "gemini-cli",
    geminiCliAdapterDescriptor,
  ),
};
