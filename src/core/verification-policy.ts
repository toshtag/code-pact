import type { Project } from "./schemas/project.ts";

export type VerificationStage = "focused" | "full";

export function hasVerificationPolicy(project: Project): boolean {
  return project.verification_policy !== undefined;
}

export function focusedVerificationCommand(
  project: Project,
  taskId: string,
  phaseId: string,
): string | null {
  const policy = project.verification_policy;
  if (!policy) return null;
  return policy.focused_command
    .replaceAll("{task_id}", taskId)
    .replaceAll("{phase_id}", phaseId);
}

export function maxFullAttempts(project: Project): number {
  return project.verification_policy?.max_full_attempts ?? 2;
}

export function canonicalFocusedVerifyCommand(
  phaseId: string,
  taskId: string,
): string {
  return `code-pact verify --phase ${phaseId} --task ${taskId} --stage focused --json --detail agent`;
}

