import { readOwnedText } from "../core/project-fs/operations.ts";
import type { OwnedReadPath } from "../core/project-fs/branded-paths.ts";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";

export class ParseError extends Error {
  constructor(
    public readonly file: string,
    public readonly issues: unknown,
  ) {
    super(`Validation failed for "${file}"`);
    this.name = "ParseError";
  }
}

export async function loadYaml<Output>(
  file: OwnedReadPath,
  schema: ZodType<Output>,
): Promise<Output> {
  const raw = await readOwnedText(file);
  const data: unknown = parseYaml(raw);
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ParseError(file, result.error.issues);
  }
  return result.data;
}
