export function isInteractive(): boolean {
  if (process.env.CI && process.env.CI !== "false" && process.env.CI !== "0") {
    return false;
  }
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}
