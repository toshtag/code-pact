export interface TestModuleLike {
  moduleId?: string;
  id?: string;
  state?: string | (() => string);
  diagnostic?: () => { duration?: number };
  result?: {
    state?: string;
    duration?: number;
    errors?: Array<{ message?: string } | Error>;
  };
}

export default class VitestCiReporter {
  files: Array<{ path: string; duration: number; state: string }>;
  constructor();
  onTestRunStart(specifications: unknown[]): void;
  onTestModuleStart(testModule: TestModuleLike): void;
  onTestModuleEnd(testModule: TestModuleLike): void;
  onTestRunEnd(
    testModules: unknown[],
    unhandledErrors?: unknown[],
    reason?: string,
  ): void;
}
