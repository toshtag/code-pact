import { z } from "zod";

export const EventStatus = z.enum(["started", "done", "failed"]);
export const ActorType = z.enum(["human", "agent"]);

export const ProgressEvent = z.object({
  task_id: z.string().min(1),
  status: EventStatus,
  // ISO 8601 datetime string. Stored as string to avoid tz ambiguity in YAML.
  at: z.iso.datetime({ offset: true }),
  actor: ActorType,
  // Agent name that produced the event. Optional for backward compatibility
  // with v0.1 logs written before `task complete` existed.
  agent: z.string().min(1).optional(),
  evidence: z.array(z.string()).optional(),
  notes: z.string().optional(),
});
export type ProgressEvent = z.infer<typeof ProgressEvent>;

// The file stored at .code-pact/state/progress.yaml
export const ProgressLog = z.object({
  events: z.array(ProgressEvent),
});
export type ProgressLog = z.infer<typeof ProgressLog>;
