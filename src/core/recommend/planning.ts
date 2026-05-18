import type { Task } from "../schemas/task.ts";
import type { AmbiguityAction } from "../schemas/recommend-result.ts";

// ---------------------------------------------------------------------------
// Decision table — planningRequired
//
// | Condition                       | planningRequired |
// | type == "architecture"          | true             |
// | ambiguity in {medium, high}     | true             |
// | risk == "high"                  | true             |
// | requires_decision == true       | true             |
// | otherwise                       | false            |
// ---------------------------------------------------------------------------

export function isPlanningRequired(task: Task): boolean {
  if (task.type === "architecture") return true;
  if (task.ambiguity === "medium" || task.ambiguity === "high") return true;
  if (task.risk === "high") return true;
  if (task.requires_decision === true) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Decision table — ambiguityAction (evaluated top-down)
//
// | requires_decision == true                                              | clarify_before_implementation |
// | ambiguity == "high"                                                    | clarify_before_implementation |
// | ambiguity == "medium" AND risk == "high"                               | clarify_before_implementation |
// | expected_duration == "long" AND write_surface == "high" AND ambiguity != "low" | split_recommended    |
// | ambiguity == "medium"                                                  | proceed                       |
// | ambiguity == "low"                                                     | proceed                       |
//
// Note on overlap: split_recommended only fires when ambiguity == "medium"
// AND risk != "high" (otherwise rule 2 or 3 already caught it as clarify).
// ---------------------------------------------------------------------------

export function recommendAmbiguityAction(task: Task): AmbiguityAction {
  if (task.requires_decision === true) return "clarify_before_implementation";
  if (task.ambiguity === "high") return "clarify_before_implementation";
  if (task.ambiguity === "medium" && task.risk === "high") {
    return "clarify_before_implementation";
  }
  if (
    task.expected_duration === "long" &&
    task.write_surface === "high" &&
    task.ambiguity !== "low"
  ) {
    return "split_recommended";
  }
  return "proceed";
}
