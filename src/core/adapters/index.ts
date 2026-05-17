import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import type { SupportedAgent } from "../agents.ts";
import type { Locale } from "../../i18n/index.ts";
import { generateClaudeAdapter } from "./claude.ts";
import { generateCodexAdapter } from "./codex.ts";
import { generateGenericAdapter } from "./generic.ts";
import { generateCursorAdapter } from "./cursor.ts";
import { generateGeminiCliAdapter } from "./gemini-cli.ts";

export type AdapterGenerateResult = {
  created: string[];
  skipped: string[];
};

export type AdapterGenerator = (
  cwd: string,
  profile: AgentProfile,
  modelProfiles: ModelProfile[],
  force: boolean,
  locale: Locale,
) => Promise<AdapterGenerateResult>;

export const adapterRegistry: Record<SupportedAgent, AdapterGenerator> = {
  "claude-code": generateClaudeAdapter,
  codex: generateCodexAdapter,
  generic: generateGenericAdapter,
  cursor: generateCursorAdapter,
  "gemini-cli": generateGeminiCliAdapter,
};
