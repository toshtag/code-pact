import type { PhaseEntry } from "../state.ts";
import type { PlanIssue } from "../shared.ts";

/**
 * `depends_on` references a task id not present in any phase.
 *
 * Same-phase lookup first; cross-phase lookup as fallback. An id
 * present in another phase is a valid cross-phase dependency and is
 * NOT reported here.
 */
export function detectTaskDependsOnUnresolved(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const globalTaskIds = new Set<string>();
  for (const { phase } of phases) {
    for (const task of phase.tasks ?? []) {
      globalTaskIds.add(task.id);
    }
  }
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const deps = task.depends_on ?? [];
      deps.forEach((dep, index) => {
        if (!globalTaskIds.has(dep)) {
          issues.push({
            code: "TASK_DEPENDS_ON_UNRESOLVED",
            severity: "error",
            message: `Task "${task.id}" depends_on references unknown task id "${dep}" (not in any phase)`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `depends_on[${index}]`,
            details: { value: dep },
          });
        }
      });
    }
  }
  return issues;
}

/**
 * `depends_on` includes the task's own id — a direct self-cycle.
 *
 * Multi-node cycles (A → B → A, A → B → C → A, etc.) are reported
 * separately by `detectTaskDependsOnCycle`. Self-cycles
 * keep this dedicated diagnostic because it is narrower and points
 * directly at the offending line.
 */
export function detectTaskDependsOnSelfReference(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const deps = task.depends_on ?? [];
      deps.forEach((dep, index) => {
        if (dep === task.id) {
          issues.push({
            code: "TASK_DEPENDS_ON_SELF_REFERENCE",
            severity: "error",
            message: `Task "${task.id}" depends_on lists itself (direct self-cycle)`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `depends_on[${index}]`,
          });
        }
      });
    }
  }
  return issues;
}

/**
 * Multi-node depends_on cycles across the entire project graph.
 *
 * Builds a directed graph (task id → its depends_on list)
 * over every task in every phase, then runs Tarjan's strongly connected
 * components algorithm iteratively (no recursion, safe for deep chains).
 *
 * Any SCC of size > 1 is a multi-node cycle. One PlanIssue is emitted
 * per task in the cycle, with `details.cycle` listing the cycle members
 * in SCC traversal order so a human reading the diagnostic can see the
 * shape at a glance.
 *
 * Self-cycles (size-1 SCCs whose only node has a self-edge) are
 * intentionally NOT reported here — they keep their dedicated
 * `TASK_DEPENDS_ON_SELF_REFERENCE` diagnostic, which is narrower.
 *
 * Severity matches `TASK_DEPENDS_ON_SELF_REFERENCE` (error) — both are
 * dep-graph integrity diagnostics; demoting only the multi-node case
 * would create an arbitrary cliff.
 */
export function detectTaskDependsOnCycle(phases: PhaseEntry[]): PlanIssue[] {
  // Build the global task index + dep adjacency.
  const taskLocation = new Map<string, { phase: PhaseEntry["phase"]; ref: PhaseEntry["ref"] }>();
  const adjacency = new Map<string, string[]>();
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      if (!taskLocation.has(task.id)) {
        taskLocation.set(task.id, { phase, ref });
      }
      // Drop self-loops here — they are reported by SELF_REFERENCE.
      const deps = (task.depends_on ?? []).filter((d) => d !== task.id);
      adjacency.set(task.id, deps);
    }
  }

  // Iterative Tarjan's SCC.
  const sccs = tarjanScc(Array.from(adjacency.keys()), adjacency);

  const issues: PlanIssue[] = [];
  for (const scc of sccs) {
    if (scc.length < 2) continue;
    // Every member of an SCC of size > 1 participates in a cycle.
    const cycleDescription = scc.join(" → ") + " → " + scc[0];
    for (const taskId of scc) {
      const loc = taskLocation.get(taskId);
      if (!loc) continue;
      issues.push({
        code: "TASK_DEPENDS_ON_CYCLE",
        severity: "error",
        message: `Task "${taskId}" participates in a depends_on cycle: ${cycleDescription}`,
        file: loc.ref.path,
        phase_id: loc.phase.id,
        task_id: taskId,
        details: { cycle: [...scc] },
      });
    }
  }
  return issues;
}

/**
 * Iterative Tarjan's SCC. Returns SCCs in reverse topological order;
 * the order is deterministic given a sorted node list.
 */
function tarjanScc(
  nodes: string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const sortedNodes = [...nodes].sort();
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let index = 0;
  const sccs: string[][] = [];

  type Frame = { node: string; iter: number };
  for (const start of sortedNodes) {
    if (indexOf.has(start)) continue;

    const frames: Frame[] = [{ node: start, iter: 0 }];
    indexOf.set(start, index);
    lowlink.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const neighbours = adjacency.get(frame.node) ?? [];
      if (frame.iter < neighbours.length) {
        const next = neighbours[frame.iter]!;
        frame.iter++;
        if (!indexOf.has(next)) {
          // Skip nodes we have no record of (unresolved deps are not
          // part of the graph for cycle purposes).
          if (!adjacency.has(next)) continue;
          indexOf.set(next, index);
          lowlink.set(next, index);
          index++;
          stack.push(next);
          onStack.add(next);
          frames.push({ node: next, iter: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node)!, indexOf.get(next)!),
          );
        }
      } else {
        if (lowlink.get(frame.node) === indexOf.get(frame.node)) {
          const scc: string[] = [];
          while (stack.length > 0) {
            const popped = stack.pop()!;
            onStack.delete(popped);
            scc.push(popped);
            if (popped === frame.node) break;
          }
          // Normalise ordering: rotate so the lexicographically smallest
          // id sits first. Keeps test fixtures deterministic regardless
          // of traversal order.
          if (scc.length > 1) {
            const reversed = scc.reverse();
            let minIdx = 0;
            for (let i = 1; i < reversed.length; i++) {
              if (reversed[i]! < reversed[minIdx]!) minIdx = i;
            }
            sccs.push([...reversed.slice(minIdx), ...reversed.slice(0, minIdx)]);
          } else {
            sccs.push(scc);
          }
        }
        frames.pop();
        if (frames.length > 0) {
          const parent = frames[frames.length - 1]!;
          lowlink.set(
            parent.node,
            Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!),
          );
        }
      }
    }
  }
  return sccs;
}
