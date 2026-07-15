const BACKTICK = "`";
const ABSOLUTE_PATH_BOUNDARY = String.raw`(^|[\s="'=(\[<>${BACKTICK}])`;
const PATH_TERMINATOR = String.raw`[^\s"'${BACKTICK}\])]+`;
const POSIX_ABSOLUTE_PATH = String.raw`/${PATH_TERMINATOR}`;
const FILE_URI_ABSOLUTE_PATH = String.raw`file:///${PATH_TERMINATOR}`;
const WINDOWS_DRIVE_ABSOLUTE_PATH = String.raw`[A-Za-z]:[\\/]${PATH_TERMINATOR}`;
const WINDOWS_UNC_PATH = String.raw`\\\\[^\s\\]+\\${PATH_TERMINATOR}`;
const POSIX_UNC_PATH = String.raw`//[^\s/]+/${PATH_TERMINATOR}`;

const ABSOLUTE_PATH_PATTERN = new RegExp(
  `${ABSOLUTE_PATH_BOUNDARY}(?:${FILE_URI_ABSOLUTE_PATH}|${POSIX_ABSOLUTE_PATH}|${WINDOWS_DRIVE_ABSOLUTE_PATH}|${WINDOWS_UNC_PATH}|${POSIX_UNC_PATH})`,
);

export function containsAbsolutePathLike(value: string): boolean {
  return ABSOLUTE_PATH_PATTERN.test(value);
}
