// Type declarations for changelog-archive.mjs (consumed by the unit test;
// the script itself runs as plain Node ESM).

export type ChangelogBlock = {
  heading: string;
  version: string | null;
  major: number | null;
  text: string;
};

export type ArchiveEntry = {
  major: number;
  path: string;
  content: string;
  versions: (string | null)[];
};

export function majorOf(version: string): number | null;
export function parseChangelog(text: string): { preamble: string; blocks: ChangelogBlock[] };
export function partitionByMajor(
  blocks: ChangelogBlock[],
  currentMajor: number,
): { kept: ChangelogBlock[]; archivedByMajor: Map<number, ChangelogBlock[]> };
export function renderArchiveFile(major: number, blocks: ChangelogBlock[]): string;
export function renderPointer(majors: number[]): string;
export function majorsFromPointer(pointerText: string): number[];
export function archiveMajorsOnDisk(filenames: string[]): number[];
export function archiveConflicts(
  archive: ArchiveEntry[],
  readOrNull: (path: string) => string | null,
): string[];
export function renderChangelog(
  preamble: string,
  keptBlocks: ChangelogBlock[],
  pointerMajors: number[],
): string;
export function planArchive(
  changelogText: string,
  currentMajor: number,
  existingArchiveMajors?: number[],
): { archive: ArchiveEntry[]; newChangelog: string; changed: boolean; pointerMajors: number[] };
