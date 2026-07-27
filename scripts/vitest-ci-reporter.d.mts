export interface TestErrorLike {
  message?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface TestCaseResultLike {
  state?: string;
  errors?: Array<TestErrorLike | Error>;
}

export interface TestCaseLike {
  fullName?: string;
  name?: string;
  module?: { moduleId?: string; id?: string };
  result?: (() => TestCaseResultLike | undefined) | TestCaseResultLike;
}

export interface TestModuleLike {
  moduleId?: string;
  id?: string;
  state?: string | (() => string);
  diagnostic?: () => { duration?: number };
  errors?: () => Array<TestErrorLike | Error>;
  result?: {
    state?: string;
    duration?: number;
    errors?: Array<TestErrorLike | Error>;
  };
}

export default class VitestCiReporter {
  files: Array<{ path: string; duration: number; state: string }>;
  failedCaseModules: Set<string>;
  constructor();
  onTestRunStart(specifications: unknown[]): void;
  onTestModuleStart(testModule: TestModuleLike): void;
  onTestCaseResult(testCase: TestCaseLike): void;
  onTestModuleEnd(testModule: TestModuleLike): void;
  onTestRunEnd(
    testModules: unknown[],
    unhandledErrors?: unknown[],
    reason?: string,
  ): void;
}
