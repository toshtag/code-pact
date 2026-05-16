import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isInteractive } from "../../../src/lib/tty.ts";

type TTYDescriptor = PropertyDescriptor | undefined;

function getDescriptor(target: object, key: PropertyKey): TTYDescriptor {
  return Object.getOwnPropertyDescriptor(target, key);
}

function setTTY(target: object, key: PropertyKey, value: boolean | undefined): void {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    writable: true,
  });
}

function restore(target: object, key: PropertyKey, descriptor: TTYDescriptor): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    delete (target as Record<PropertyKey, unknown>)[key];
  }
}

describe("isInteractive", () => {
  let originalCI: string | undefined;
  let stdinTTY: TTYDescriptor;
  let stdoutTTY: TTYDescriptor;

  beforeEach(() => {
    originalCI = process.env.CI;
    stdinTTY = getDescriptor(process.stdin, "isTTY");
    stdoutTTY = getDescriptor(process.stdout, "isTTY");
    delete process.env.CI;
  });

  afterEach(() => {
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
    restore(process.stdin, "isTTY", stdinTTY);
    restore(process.stdout, "isTTY", stdoutTTY);
  });

  it("returns true when both stdin and stdout are TTY and CI is unset", () => {
    setTTY(process.stdin, "isTTY", true);
    setTTY(process.stdout, "isTTY", true);
    expect(isInteractive()).toBe(true);
  });

  it("returns false when stdin is not a TTY", () => {
    setTTY(process.stdin, "isTTY", false);
    setTTY(process.stdout, "isTTY", true);
    expect(isInteractive()).toBe(false);
  });

  it("returns false when stdout is not a TTY", () => {
    setTTY(process.stdin, "isTTY", true);
    setTTY(process.stdout, "isTTY", false);
    expect(isInteractive()).toBe(false);
  });

  it("returns false when CI=true even with TTY", () => {
    setTTY(process.stdin, "isTTY", true);
    setTTY(process.stdout, "isTTY", true);
    process.env.CI = "true";
    expect(isInteractive()).toBe(false);
  });

  it("returns false for any non-falsy CI value", () => {
    setTTY(process.stdin, "isTTY", true);
    setTTY(process.stdout, "isTTY", true);
    process.env.CI = "1";
    expect(isInteractive()).toBe(false);
  });

  it("ignores CI=false (treats as not in CI)", () => {
    setTTY(process.stdin, "isTTY", true);
    setTTY(process.stdout, "isTTY", true);
    process.env.CI = "false";
    expect(isInteractive()).toBe(true);
  });

  it("ignores CI=0 (treats as not in CI)", () => {
    setTTY(process.stdin, "isTTY", true);
    setTTY(process.stdout, "isTTY", true);
    process.env.CI = "0";
    expect(isInteractive()).toBe(true);
  });

  it("returns false when isTTY is undefined", () => {
    setTTY(process.stdin, "isTTY", undefined);
    setTTY(process.stdout, "isTTY", undefined);
    expect(isInteractive()).toBe(false);
  });
});
