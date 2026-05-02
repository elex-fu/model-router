/**
 * Match an input string against a glob pattern.
 *
 * Pattern rules:
 *   - `*` matches any sequence of characters (including empty)
 *   - `?` matches any single character
 *   - All other characters are matched literally (regex metacharacters are escaped)
 *   - Match is anchored (whole-string)
 *   - Case sensitive
 */
export function matchGlob(pattern: string, input: string): boolean {
  const re = globToRegex(pattern);
  return re.test(input);
}

function globToRegex(pattern: string): RegExp {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else {
      out += escapeRegex(ch);
    }
  }
  out += '$';
  return new RegExp(out);
}

function escapeRegex(ch: string): string {
  // Escape any regex metacharacter. Safe to over-escape with \\ for non-meta.
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
