import { messages as enUS } from "./en-US.ts";
import { messages as jaJP } from "./ja-JP.ts";

export type Locale = "en-US" | "ja-JP";

export const messages = {
  "en-US": enUS,
  "ja-JP": jaJP,
} as const;

export type Messages = typeof enUS;
