import { z } from "zod";

export const LocaleCode = z.enum(["ja-JP", "en-US"]);
export type LocaleCode = z.infer<typeof LocaleCode>;

export const LocaleConfig = z.union([
  LocaleCode,
  z.object({
    default: LocaleCode,
    cli: LocaleCode.optional(),
    docs: LocaleCode.optional(),
    context: LocaleCode.optional(),
  }),
]);
export type LocaleConfig = z.infer<typeof LocaleConfig>;
