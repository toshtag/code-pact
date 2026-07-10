export type OutputExcerpt = {
  head: string;
  tail: string;
  captured_bytes: number;
  omitted_bytes: number;
  truncated: boolean;
};

export type StreamExcerptLimits = {
  headBytes: number;
  tailBytes: number;
};

export const STDOUT_EXCERPT_LIMITS: StreamExcerptLimits = {
  headBytes: 2 * 1024,
  tailBytes: 4 * 1024,
};

export const STDERR_EXCERPT_LIMITS: StreamExcerptLimits = {
  headBytes: 2 * 1024,
  tailBytes: 8 * 1024,
};

function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

function safeEnd(buffer: Buffer, end: number): number {
  let safe = Math.min(Math.max(0, end), buffer.length);
  while (safe > 0 && safe < buffer.length && isContinuationByte(buffer[safe]!)) {
    safe -= 1;
  }
  return safe;
}

function safeStart(buffer: Buffer, start: number): number {
  let safe = Math.min(Math.max(0, start), buffer.length);
  while (safe < buffer.length && isContinuationByte(buffer[safe]!)) {
    safe += 1;
  }
  return safe;
}

function sliceUtf8(buffer: Buffer, start: number, end: number): string {
  const safeStartByte = safeStart(buffer, start);
  const safeEndByte = safeEnd(buffer, end);
  if (safeEndByte <= safeStartByte) return "";
  return buffer.subarray(safeStartByte, safeEndByte).toString("utf8");
}

export function excerptText(
  text: string,
  limits: StreamExcerptLimits,
): OutputExcerpt {
  const buffer = Buffer.from(text, "utf8");
  const capturedBytes = buffer.byteLength;
  const maxBytes = limits.headBytes + limits.tailBytes;

  if (capturedBytes <= maxBytes) {
    return {
      head: text,
      tail: "",
      captured_bytes: capturedBytes,
      omitted_bytes: 0,
      truncated: false,
    };
  }

  const headEnd = safeEnd(buffer, limits.headBytes);
  const tailStart = safeStart(buffer, capturedBytes - limits.tailBytes);
  const omittedBytes = Math.max(0, tailStart - headEnd);

  return {
    head: sliceUtf8(buffer, 0, headEnd),
    tail: sliceUtf8(buffer, tailStart, capturedBytes),
    captured_bytes: capturedBytes,
    omitted_bytes: omittedBytes,
    truncated: true,
  };
}
