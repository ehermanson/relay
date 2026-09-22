interface ParsedVersion {
  parts: number[];
  /**
   * Pre-release identifiers split on `.`, e.g. `["beta", "2"]`. Empty array
   * means a stable release. Build metadata (after `+`) is ignored per semver.
   */
  prerelease: string[];
}

/**
 * Compare two semver-ish strings. Returns -1 if a<b, 0 if equal, 1 if a>b.
 *
 * Behavior:
 * - Strips a leading "v" (case-insensitive)
 * - Compares the numeric MAJOR.MINOR.PATCH triple first; non-numeric segments
 *   are treated as 0 for the main triple, but at least one segment must be a
 *   real number or the input is rejected
 * - Per semver, a version WITH a prerelease ranks BELOW the same version
 *   WITHOUT one (e.g. `1.2.3-beta` < `1.2.3`)
 * - When both have prereleases, prerelease identifiers are compared
 *   left-to-right: numeric identifiers compare numerically; alphanumeric
 *   identifiers compare ASCII; numeric ranks below alphanumeric; a shorter
 *   prerelease list with all prior identifiers equal ranks below a longer one
 * - Build metadata (after `+`) is ignored
 * - Returns 0 for unparseable input on either side — the caller treats that
 *   as "no advisory" so the UI stays in `status: "unknown"`
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (raw: string): ParsedVersion | null => {
    const trimmed = raw.trim().replace(/^v/i, "");
    if (!trimmed) return null;
    // Strip build metadata (after `+`) entirely — semver says it doesn't
    // affect precedence — then split the prerelease (after `-`) from the
    // main triple.
    const withoutBuild = trimmed.split("+", 1)[0];
    const dashIdx = withoutBuild.indexOf("-");
    const main = dashIdx >= 0 ? withoutBuild.slice(0, dashIdx) : withoutBuild;
    const prerelease = dashIdx >= 0 ? withoutBuild.slice(dashIdx + 1).split(".") : [];
    if (!main) return null;
    let sawNumber = false;
    const parts = main.split(".").map((p) => {
      const n = parseInt(p, 10);
      if (Number.isFinite(n)) {
        sawNumber = true;
        return n;
      }
      return 0;
    });
    if (!sawNumber) return null;
    while (parts.length < 3) parts.push(0);
    return { parts, prerelease };
  };

  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;

  // Compare numeric triple first.
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const av = pa.parts[i] ?? 0;
    const bv = pb.parts[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }

  // Triple is equal: a stable release outranks any prerelease.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1; // a is stable, b is prerelease → a > b
  if (pb.prerelease.length === 0) return -1; // a is prerelease, b is stable → a < b

  // Both have prereleases: compare identifiers left-to-right.
  return comparePrereleaseIdentifiers(pa.prerelease, pb.prerelease);
}

function comparePrereleaseIdentifiers(a: string[], b: string[]): -1 | 0 | 1 {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const cmp = compareSinglePrereleaseIdentifier(a[i], b[i]);
    if (cmp !== 0) return cmp;
  }
  // All shared identifiers equal: shorter list ranks lower (e.g. 1.0.0-alpha < 1.0.0-alpha.1)
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return 0;
}

function compareSinglePrereleaseIdentifier(a: string, b: string): -1 | 0 | 1 {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const av = parseInt(a, 10);
    const bv = parseInt(b, 10);
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  }
  // Numeric identifiers rank below alphanumeric ones.
  if (aNum) return -1;
  if (bNum) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
