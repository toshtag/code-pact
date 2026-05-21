import { z } from "zod";

const RELATIVE_POSIX_PATH_HINT =
  "path must be project-relative POSIX (no leading `/`, no `..`, no `.`, no empty segments, no `\\`)";

export const RelativePosixPath = z
  .string()
  .min(1, "path must not be empty")
  .refine((s) => !s.startsWith("/"), RELATIVE_POSIX_PATH_HINT)
  .refine((s) => !s.startsWith("~"), RELATIVE_POSIX_PATH_HINT)
  .refine((s) => !s.includes("\\"), RELATIVE_POSIX_PATH_HINT)
  .refine((s) => !/^[A-Za-z]:/.test(s), RELATIVE_POSIX_PATH_HINT)
  .refine((s) => {
    const segs = s.split("/");
    return !segs.some((seg) => seg === ".." || seg === "." || seg === "");
  }, RELATIVE_POSIX_PATH_HINT);
export type RelativePosixPath = z.infer<typeof RelativePosixPath>;
