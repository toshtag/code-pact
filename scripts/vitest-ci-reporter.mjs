// Minimal CI reporter for Vitest: prints per-test-file progress and a final
// slowest-files summary.  Designed to be consumed by scripts that parse
// `[vitest:*]` lines for heartbeat/state reporting.

import { relative } from "node:path";
import process from "node:process";

function relPath(moduleId) {
  if (typeof moduleId !== "string" || moduleId.length === 0)
    return String(moduleId);
  const cwd = process.cwd();
  if (moduleId.startsWith(cwd)) {
    const tail = moduleId.slice(cwd.length);
    return tail.startsWith("/") ? tail.slice(1) : tail;
  }
  try {
    return relative(cwd, moduleId);
  } catch {
    return moduleId;
  }
}

export default class VitestCiReporter {
  constructor() {
    this.files = [];
  }

  onTestRunStart(specifications) {
    const total = Array.isArray(specifications) ? specifications.length : 0;
    console.log(`[vitest:total] ${total}`);
  }

  onTestModuleStart(testModule) {
    const path = relPath(testModule?.moduleId ?? testModule?.id ?? "");
    console.log(`[vitest:start] ${path}`);
  }

  onTestModuleEnd(testModule) {
    const path = relPath(testModule?.moduleId ?? testModule?.id ?? "");
    const state =
      typeof testModule?.state === "function"
        ? testModule.state()
        : (testModule?.result?.state ?? "unknown");
    let duration = 0;
    if (typeof testModule?.diagnostic === "function") {
      const diag = testModule.diagnostic();
      duration = diag?.duration ?? 0;
    } else if (typeof testModule?.result?.duration === "number") {
      duration = testModule.result.duration;
    }
    console.log(`[vitest:done] ${path} ${duration}ms ${state}`);
    this.files.push({ path, duration, state });

    if (state === "fail") {
      const errors = testModule?.result?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        for (const err of errors) {
          const message =
            typeof err?.message === "string" ? err.message : String(err);
          console.error(`[vitest:failed] ${path}: ${message}`);
        }
      } else {
        console.error(`[vitest:failed] ${path}`);
      }
    }
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    if (Array.isArray(testModules)) {
      for (const m of testModules) {
        const path = relPath(m?.moduleId ?? m?.id ?? "");
        const state =
          typeof m?.state === "function"
            ? m.state()
            : (m?.result?.state ?? "unknown");
        let duration = 0;
        if (typeof m?.diagnostic === "function") {
          duration = m.diagnostic().duration ?? 0;
        } else if (typeof m?.result?.duration === "number") {
          duration = m.result.duration;
        }
        if (!this.files.some(f => f.path === path)) {
          this.files.push({ path, duration, state });
        }
      }
    }

    if (Array.isArray(unhandledErrors) && unhandledErrors.length > 0) {
      console.log("[vitest:unhandled] unhandled errors during run");
    }
    if (reason && reason !== "passed") {
      console.log(`[vitest:reason] ${reason}`);
    }

    const slowest = [...this.files]
      .filter(f => f.duration >= 0)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    console.log("\nSlowest test files:");
    for (let i = 0; i < slowest.length; i++) {
      const f = slowest[i];
      const sec = (f.duration / 1000).toFixed(1);
      console.log(`${i + 1}. ${f.path} ${sec}s`);
    }
  }
}
