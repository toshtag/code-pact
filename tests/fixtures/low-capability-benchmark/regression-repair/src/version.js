export function parseVersion(version) {
  const [major, minor] = version.split(".");
  return {
    major: Number(major),
    minor: Number(minor),
  };
}
