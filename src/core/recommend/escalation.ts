import type { ModelTier } from "../schemas/model-profile.ts";
import type { EscalationStep } from "../schemas/recommend-result.ts";

// ---------------------------------------------------------------------------
// Decision table — allowedEscalation (by tier)
//
// | tier              | escalation order                                                |
// | cheap_mechanical  | [increase_effort, increase_context, escalate_tier]              |
// | balanced_coding   | [increase_context, increase_effort, escalate_tier, ask_human]   |
// | highest_reasoning | [increase_context, ask_human]                                   |
//
// Why the order matters: agents read this list left-to-right when their
// first attempt is insufficient. cheap_mechanical starts with effort because
// the model is small — more thinking is the cheapest lever. balanced_coding
// and highest_reasoning start with context because reasoning models benefit
// more from richer surroundings than from longer thinking budgets.
// ---------------------------------------------------------------------------

export function recommendEscalation(tier: ModelTier): EscalationStep[] {
  switch (tier) {
    case "cheap_mechanical":
      return ["increase_effort", "increase_context", "escalate_tier"];
    case "balanced_coding":
      return ["increase_context", "increase_effort", "escalate_tier", "ask_human"];
    case "highest_reasoning":
      return ["increase_context", "ask_human"];
  }
}
