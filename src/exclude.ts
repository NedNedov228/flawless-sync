/**
 * Glob-based path exclusions.
 *
 * The plugin previously synced every file Obsidian reports, which meant large
 * caches (installers, screen recordings, PDFs) were uploaded on every run.
 *
 * Semantics, kept deliberately simple so users can predict what a pattern does:
 * - Patterns are vault-relative and use `/` as the separator.
 * - `*` matches within one path segment, `**` crosses segments, `?` matches one character.
 * - A pattern with no wildcard that names a folder also excludes everything inside it.
 * - A pattern containing a slash is matched against the whole path.
 * - A pattern without a slash (e.g. `*.dmg`) is matched against the file name at any depth.
 * - A leading `/` anchors the pattern to the vault root and disables name matching.
 */

export type ExcludeMatcher = (path: string) => boolean;

interface CompiledPattern {
  regex: RegExp;
  /** Literal folder: also excludes every path nested underneath it. */
  literalPrefix?: string;
  /** No slash in the pattern, so it may match the file name alone. */
  basenameOnly: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExpSource(glob: string): string {
  const pattern = normalizePath(glob).replace(/\/+$/g, "");
  let source = "";

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        let end = i + 2;
        while (pattern[end] === "*") {
          end++;
        }

        if (pattern[end] === "/") {
          // `**/` matches zero or more leading directories.
          source += "(?:.*/)?";
          i = end;
        } else {
          source += ".*";
          i = end - 1;
        }
        continue;
      }

      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char ?? "");
  }

  return source;
}

/**
 * Builds a predicate that reports whether a vault-relative path is excluded.
 */
export function compileExcludes(patterns: string[]): ExcludeMatcher {
  const compiled: CompiledPattern[] = [];

  for (const rawPattern of patterns) {
    const trimmed = rawPattern.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const anchored = trimmed.startsWith("/");
    const body = normalizePath(trimmed).replace(/\/+$/g, "");
    if (body.length === 0) {
      continue;
    }

    const hasWildcard = /[*?]/.test(body);
    const hasSlash = body.includes("/");

    compiled.push({
      regex: new RegExp(`^(?:${globToRegExpSource(body)})$`),
      literalPrefix: hasWildcard ? undefined : body,
      basenameOnly: !anchored && !hasSlash,
    });
  }

  if (compiled.length === 0) {
    return () => false;
  }

  return (path: string): boolean => {
    const normalized = normalizePath(path);
    const basename = normalized.split("/").pop() ?? normalized;

    for (const pattern of compiled) {
      if (pattern.regex.test(normalized)) {
        return true;
      }

      if (pattern.literalPrefix !== undefined) {
        // `folder` and `folder/**` must behave the same for anything inside.
        const prefix = `${pattern.literalPrefix}/`;
        if (normalized.startsWith(prefix)) {
          return true;
        }
      }

      if (pattern.basenameOnly && pattern.regex.test(basename)) {
        return true;
      }
    }

    return false;
  };
}
