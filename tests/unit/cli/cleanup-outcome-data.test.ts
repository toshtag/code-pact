import { describe, expect, it } from "vitest";
import { cleanupOutcomeData } from "../../../src/cli/commands/state.ts";
import type {
  CleanupOutcome,
  CleanupAdvisory,
  CleanupSkip,
} from "../../../src/core/archive/event-pack-cleanup.ts";

// The `CleanupOutcome` type guarantees `cleanup_pending` / `partial_applied` /
// `cleanup_started` / `loose_deleted_count` / `cleanup_remaining_loose` /
// `vanished_count` / `advisories` on EVERY result (success AND failure) so a consumer
// reads them unconditionally; `skipped` is on the FAILURE variants only.
// `cleanupOutcomeData` is the single CLI mapper — these tests pin that it never drops a
// contract field on the error paths (the happy-path E2E can't see the error shapes),
// strips only `ok`/`code`, and adds the CLI-only `phase_id` / `pack_path` / `next_action`.

const cwd = "/tmp/proj";
const phaseId = "P1";
const ADVISORY: CleanupAdvisory = { code: "unclassified_loose_after_cleanup", path: ".x" };
const SKIP: CleanupSkip = { path: ".code-pact/state/events/a.yaml", reason: "unreadable" };

// The fields present on EVERY result (success AND failure) — `skipped` is NOT here
// (failure-only). A consumer reads each of these unconditionally.
const UNIVERSAL_KEYS = [
  "phase_id",
  "cleanup_pending",
  "partial_applied",
  "cleanup_started",
  "loose_deleted_count",
  "cleanup_remaining_loose",
  "vanished_count",
  "advisories",
] as const;

describe("cleanupOutcomeData — success variants carry the full contract, minus `ok`", () => {
  it("cleaned (normal): every contract field present, no `ok`/`code`", () => {
    const outcome: CleanupOutcome = {
      ok: true,
      kind: "cleaned",
      cleanup_pending: false,
      cleanup_started: true,
      cleanup_remaining_loose: 0,
      vanished_count: 0,
      partial_applied: true,
      loose_deleted_count: 2,
      advisories: [],
    };
    const data = cleanupOutcomeData(outcome, phaseId, cwd);
    expect(data).toMatchObject({
      phase_id: "P1",
      kind: "cleaned",
      cleanup_pending: false,
      cleanup_started: true,
      loose_deleted_count: 2,
      cleanup_remaining_loose: 0,
      vanished_count: 0,
      partial_applied: true,
      advisories: [],
    });
    expect("ok" in data).toBe(false);
  });

  it("cleaned carries advisories through to the JSON data", () => {
    const outcome: CleanupOutcome = {
      ok: true,
      kind: "cleaned",
      cleanup_pending: false,
      cleanup_started: true,
      cleanup_remaining_loose: 0,
      vanished_count: 1,
      partial_applied: true,
      loose_deleted_count: 1,
      advisories: [ADVISORY],
    };
    const data = cleanupOutcomeData(outcome, phaseId, cwd);
    expect(data.advisories).toEqual([ADVISORY]);
  });

  it("already_cleaned: every universal field present, kind kept, no ok/code", () => {
    const outcome: CleanupOutcome = {
      ok: true,
      kind: "already_cleaned",
      cleanup_pending: false,
      partial_applied: false,
      cleanup_started: false,
      loose_deleted_count: 0,
      cleanup_remaining_loose: 0,
      vanished_count: 0,
      advisories: [ADVISORY],
    };
    const data = cleanupOutcomeData(outcome, phaseId, cwd);
    for (const k of UNIVERSAL_KEYS) expect(k in data).toBe(true);
    expect(data.kind).toBe("already_cleaned");
    expect(data.advisories).toEqual([ADVISORY]);
    expect("ok" in data).toBe(false);
    expect("code" in data).toBe(false);
  });

  it("noop_no_events: every universal field present, kind kept, no ok/code", () => {
    const outcome: CleanupOutcome = {
      ok: true,
      kind: "noop_no_events",
      cleanup_pending: false,
      partial_applied: false,
      cleanup_started: false,
      loose_deleted_count: 0,
      cleanup_remaining_loose: 0,
      vanished_count: 0,
      advisories: [],
    };
    const data = cleanupOutcomeData(outcome, phaseId, cwd);
    for (const k of UNIVERSAL_KEYS) expect(k in data).toBe(true);
    expect(data.kind).toBe("noop_no_events");
    expect("ok" in data).toBe(false);
    expect("code" in data).toBe(false);
  });
});

describe("cleanupOutcomeData — error variants must NOT drop contract fields", () => {
  it("STATE_COMPACT_INELIGIBLE: full pre-cleanup contract + block + advisories, no `ok`/`code`", () => {
    const outcome: CleanupOutcome = {
      ok: false,
      code: "STATE_COMPACT_INELIGIBLE",
      kind: "ineligible",
      block: { kind: "snapshot_missing" },
      cleanup_pending: true,
      partial_applied: false,
      cleanup_started: false,
      loose_deleted_count: 0,
      cleanup_remaining_loose: null,
      vanished_count: 0,
      skipped: [],
      advisories: [],
    };
    const data = cleanupOutcomeData(outcome, phaseId, cwd);
    expect(data).toMatchObject({
      phase_id: "P1",
      kind: "ineligible",
      block: { kind: "snapshot_missing" },
      cleanup_pending: true,
      partial_applied: false,
      cleanup_started: false,
      loose_deleted_count: 0,
      cleanup_remaining_loose: null,
      vanished_count: 0,
      skipped: [],
      advisories: [],
    });
    // The envelope owns `ok` and `error.code` — they must not be duplicated in data.
    expect("ok" in data).toBe(false);
    expect("code" in data).toBe(false);
  });

  it("STATE_COMPACT_WRITE_FAILED (verify_pack): full contract + pack_path + next_action", () => {
    const outcome: CleanupOutcome = {
      ok: false,
      code: "STATE_COMPACT_WRITE_FAILED",
      phase: "verify_pack",
      cleanup_pending: true,
      partial_applied: true,
      cleanup_started: false,
      loose_deleted_count: 0,
      cleanup_remaining_loose: 2,
      vanished_count: 0,
      skipped: [],
      advisories: [],
    };
    const data = cleanupOutcomeData(outcome, phaseId, cwd);
    expect(data).toMatchObject({
      phase_id: "P1",
      phase: "verify_pack",
      cleanup_pending: true,
      partial_applied: true,
      cleanup_started: false,
      loose_deleted_count: 0,
      cleanup_remaining_loose: 2,
      vanished_count: 0,
      skipped: [],
      advisories: [],
    });
    expect(typeof data.pack_path).toBe("string");
    expect(typeof data.next_action).toBe("string"); // verify_pack only
    expect("ok" in data).toBe(false);
    expect("code" in data).toBe(false);
  });

  it("STATE_COMPACT_WRITE_FAILED (write_pack): pack_path present, NO next_action", () => {
    const outcome: CleanupOutcome = {
      ok: false,
      code: "STATE_COMPACT_WRITE_FAILED",
      phase: "write_pack",
      cleanup_pending: true,
      partial_applied: false,
      cleanup_started: false,
      loose_deleted_count: 0,
      cleanup_remaining_loose: 2,
      vanished_count: 0,
      skipped: [],
      advisories: [],
    };
    const data = cleanupOutcomeData(outcome, phaseId, cwd);
    expect(typeof data.pack_path).toBe("string");
    expect("next_action" in data).toBe(false);
  });

  it("STATE_COMPACT_CLEANUP_FAILED: cleanup_pending + skipped + counts preserved", () => {
    const outcome: CleanupOutcome = {
      ok: false,
      code: "STATE_COMPACT_CLEANUP_FAILED",
      block: "pack_stale_after_cleanup",
      cleanup_pending: true,
      cleanup_started: true,
      cleanup_remaining_loose: 1,
      vanished_count: 0,
      skipped: [SKIP],
      advisories: [],
      partial_applied: true,
      loose_deleted_count: 1,
    };
    const data = cleanupOutcomeData(outcome, phaseId, cwd);
    expect(data).toMatchObject({
      phase_id: "P1",
      block: "pack_stale_after_cleanup",
      cleanup_pending: true,
      cleanup_started: true,
      cleanup_remaining_loose: 1,
      vanished_count: 0,
      skipped: [SKIP],
      partial_applied: true,
      loose_deleted_count: 1,
    });
    expect("ok" in data).toBe(false);
    expect("code" in data).toBe(false);
  });

  it("STATE_COMPACT_CLEANUP_INCOMPLETE: every universal field + skipped preserved", () => {
    const outcome: CleanupOutcome = {
      ok: false,
      code: "STATE_COMPACT_CLEANUP_INCOMPLETE",
      cleanup_pending: true,
      cleanup_started: true,
      cleanup_remaining_loose: 1,
      vanished_count: 2,
      skipped: [SKIP],
      advisories: [ADVISORY],
      partial_applied: true,
      loose_deleted_count: 1,
    };
    const data = cleanupOutcomeData(outcome, phaseId, cwd);
    // Pin the FULL contract — a mapper that hand-listed a subset would fail here.
    expect(data).toMatchObject({
      phase_id: "P1",
      cleanup_pending: true,
      cleanup_started: true,
      cleanup_remaining_loose: 1,
      vanished_count: 2,
      skipped: [SKIP],
      advisories: [ADVISORY],
      partial_applied: true,
      loose_deleted_count: 1,
    });
    expect("ok" in data).toBe(false);
    expect("code" in data).toBe(false);
  });
});

// Every FAILURE variant must carry the universal keys AND `skipped` (failure-only).
describe("cleanupOutcomeData — every failure variant carries the universal keys + skipped", () => {
  const failures: CleanupOutcome[] = [
    {
      ok: false,
      code: "STATE_COMPACT_INELIGIBLE",
      kind: "ineligible",
      block: { kind: "snapshot_missing" },
      cleanup_pending: true,
      partial_applied: false,
      cleanup_started: false,
      loose_deleted_count: 0,
      cleanup_remaining_loose: null,
      vanished_count: 0,
      skipped: [],
      advisories: [],
    },
    {
      ok: false,
      code: "STATE_COMPACT_WRITE_FAILED",
      phase: "write_pack",
      cleanup_pending: true,
      partial_applied: false,
      cleanup_started: false,
      loose_deleted_count: 0,
      cleanup_remaining_loose: 2,
      vanished_count: 0,
      skipped: [],
      advisories: [],
    },
    {
      ok: false,
      code: "STATE_COMPACT_CLEANUP_FAILED",
      cleanup_pending: true,
      cleanup_started: true,
      cleanup_remaining_loose: 1,
      vanished_count: 0,
      skipped: [],
      advisories: [],
      partial_applied: true,
      loose_deleted_count: 1,
    },
  ];
  for (const outcome of failures) {
    if (outcome.ok) continue;
    it(`${outcome.code}: universal keys + skipped present, no ok/code`, () => {
      const data = cleanupOutcomeData(outcome, phaseId, cwd);
      for (const k of UNIVERSAL_KEYS) expect(k in data).toBe(true);
      expect("skipped" in data).toBe(true);
      expect("ok" in data).toBe(false);
      expect("code" in data).toBe(false);
    });
  }
});
