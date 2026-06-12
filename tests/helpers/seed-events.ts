import { parse as parseYaml } from "yaml";
import { ProgressLog } from "../../src/core/schemas/progress-event.ts";
import { writeEventFile } from "../../src/core/progress/events-io.ts";

/**
 * Seed progress events as DURABLE loose event files (the source the
 * phase-snapshot producer reads), parsed from a legacy-shaped `events:` YAML
 * string. The producer mints `terminal_evidence` from loose ∪ packs only — never
 * legacy `progress.yaml` — so fixtures that need a done event must write loose
 * files, not the monolith.
 */
export async function seedDurableEvents(cwd: string, progressYaml: string): Promise<void> {
  const parsed = ProgressLog.parse(parseYaml(progressYaml));
  for (const event of parsed.events) await writeEventFile(cwd, event);
}
