export function isCIEnv(): boolean {
  const ci = process.env.CI;
  return Boolean(ci) && ci !== "false" && ci !== "0";
}

export function isInteractive(): boolean {
  if (isCIEnv()) return false;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}
