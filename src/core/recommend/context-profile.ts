import type { Task } from "../schemas/task.ts";
import type { ContextProfile } from "../schemas/recommend-result.ts";

// ---------------------------------------------------------------------------
// Decision table — contextProfile
//
// | context_size | ambiguity | contextProfile |
// | large        | (any)     | large          |
// | medium       | high      | large          |
// | medium       | (else)    | medium         |
// | small        | high      | medium         |
// | small        | (else)    | small          |
//
// High ambiguity pushes the profile up one notch — the agent needs more
// surrounding context to disambiguate, not just files directly touched.
// ---------------------------------------------------------------------------

export function recommendContextProfile(task: Task): ContextProfile {
  if (task.context_size === "large") return "large";
  if (task.context_size === "medium") {
    return task.ambiguity === "high" ? "large" : "medium";
  }
  // context_size === "small"
  return task.ambiguity === "high" ? "medium" : "small";
}
