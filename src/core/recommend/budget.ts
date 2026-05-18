import type { Task } from "../schemas/task.ts";
import type {
  BudgetProfile,
  BudgetToolCalls,
  BudgetContextFiles,
  BudgetVerificationCommands,
} from "../schemas/recommend-result.ts";

// ---------------------------------------------------------------------------
// Decision tables — budgetProfile
//
// Categorical, deterministic. NOT an estimate of actual tokens, cost, or
// time. Agents use these as relative-magnitude hints when choosing how to
// scope context fetches, tool budgets, and verification depth.
//
// toolCalls
// | condition                                                   | toolCalls |
// | write_surface=high OR expected_duration=long                | high      |
// | write_surface=low  (and not the high case above)            | low       |
// | otherwise (write_surface=medium with non-long duration)     | medium    |
//
// contextFiles
// | context_size=small  | few     |
// | context_size=medium | several |
// | context_size=large  | many    |
//
// verificationCommands (passthrough of verification_strength)
// | weak   | minimal  |
// | medium | standard |
// | strong | full     |
// ---------------------------------------------------------------------------

function toolCallsProfile(task: Task): BudgetToolCalls {
  if (task.write_surface === "high" || task.expected_duration === "long") return "high";
  if (task.write_surface === "low") return "low";
  return "medium";
}

function contextFilesProfile(task: Task): BudgetContextFiles {
  switch (task.context_size) {
    case "small":
      return "few";
    case "medium":
      return "several";
    case "large":
      return "many";
  }
}

function verificationCommandsProfile(task: Task): BudgetVerificationCommands {
  switch (task.verification_strength) {
    case "weak":
      return "minimal";
    case "medium":
      return "standard";
    case "strong":
      return "full";
  }
}

export function recommendBudgetProfile(task: Task): BudgetProfile {
  return {
    toolCalls: toolCallsProfile(task),
    contextFiles: contextFilesProfile(task),
    verificationCommands: verificationCommandsProfile(task),
  };
}
