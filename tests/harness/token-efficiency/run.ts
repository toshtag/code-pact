import { runAllScenarios } from "./harness.ts";

async function main(): Promise<void> {
  const summary = await runAllScenarios();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
