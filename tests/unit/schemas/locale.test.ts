import { describe, it, expect } from "vitest";
import { LocaleCode, LocaleConfig } from "../../../src/core/schemas/locale.ts";

describe("LocaleCode", () => {
  it("accepts valid codes", () => {
    expect(LocaleCode.parse("ja-JP")).toBe("ja-JP");
    expect(LocaleCode.parse("en-US")).toBe("en-US");
  });

  it("rejects unknown codes", () => {
    expect(() => LocaleCode.parse("fr-FR")).toThrow();
    expect(() => LocaleCode.parse("")).toThrow();
  });
});

describe("LocaleConfig", () => {
  it("accepts a bare locale string", () => {
    expect(LocaleConfig.parse("ja-JP")).toBe("ja-JP");
  });

  it("accepts a full locale object", () => {
    const result = LocaleConfig.parse({
      default: "ja-JP",
      cli: "en-US",
    });
    expect(result).toMatchObject({ default: "ja-JP", cli: "en-US" });
  });

  it("accepts a locale object with only default", () => {
    expect(LocaleConfig.parse({ default: "en-US" })).toMatchObject({ default: "en-US" });
  });

  it("rejects an invalid locale string", () => {
    expect(() => LocaleConfig.parse("de-DE")).toThrow();
  });

  it("rejects a locale object with an invalid default", () => {
    expect(() => LocaleConfig.parse({ default: "zh-CN" })).toThrow();
  });
});
