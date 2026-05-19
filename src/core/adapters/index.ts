import type { SupportedAgent } from "../agents.ts";
import type { AdapterDescriptor } from "./types.ts";
import { claudeAdapterDescriptor } from "./claude.ts";
import { codexAdapterDescriptor } from "./codex.ts";
import { genericAdapterDescriptor } from "./generic.ts";
import { cursorAdapterDescriptor } from "./cursor.ts";
import { geminiCliAdapterDescriptor } from "./gemini-cli.ts";

export const adapterRegistry: Record<SupportedAgent, AdapterDescriptor> = {
  "claude-code": claudeAdapterDescriptor,
  codex: codexAdapterDescriptor,
  generic: genericAdapterDescriptor,
  cursor: cursorAdapterDescriptor,
  "gemini-cli": geminiCliAdapterDescriptor,
};
