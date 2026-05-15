import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ZodType, ZodTypeDef } from "zod";

export class ParseError extends Error {
  constructor(
    public readonly file: string,
    public readonly issues: unknown,
  ) {
    super(`Validation failed for "${file}"`);
    this.name = "ParseError";
  }
}

export async function loadYaml<Output, Def extends ZodTypeDef, Input>(
  file: string,
  schema: ZodType<Output, Def, Input>,
): Promise<Output> {
  const raw = await readFile(file, "utf8");
  const data: unknown = parseYaml(raw);
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ParseError(file, result.error.issues);
  }
  return result.data;
}

export function parseYamlString<Output, Def extends ZodTypeDef, Input>(
  content: string,
  schema: ZodType<Output, Def, Input>,
  label = "<string>",
): Output {
  const data: unknown = parseYaml(content);
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ParseError(label, result.error.issues);
  }
  return result.data;
}
