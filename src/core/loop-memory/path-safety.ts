const ABSOLUTE_PATH_BOUNDARY = String.raw`(^|[\s="'(])`;
const POSIX_ABSOLUTE_PATH = String.raw`/[^\s"']+`;
const WINDOWS_DRIVE_ABSOLUTE_PATH = String.raw`[A-Za-z]:[\\/][^\s"']+`;
const WINDOWS_UNC_PATH = String.raw`\\\\[^\s\\]+\\[^\s\\]+`;
const POSIX_UNC_PATH = String.raw`//[^\s/]+/[^\s"']+`;

const ABSOLUTE_PATH_PATTERN = new RegExp(
  `${ABSOLUTE_PATH_BOUNDARY}(?:${POSIX_ABSOLUTE_PATH}|${WINDOWS_DRIVE_ABSOLUTE_PATH}|${WINDOWS_UNC_PATH}|${POSIX_UNC_PATH})`,
);

export function containsAbsolutePathLike(value: string): boolean {
  return ABSOLUTE_PATH_PATTERN.test(value);
}
