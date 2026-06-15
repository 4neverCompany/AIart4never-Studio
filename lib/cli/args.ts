/**
 * 4NE-13 — headless CLI: a tiny, dependency-free argument parser.
 *
 * Deliberately minimal (no external dep): splits a token stream into the
 * leading positional words, `--flag` booleans, `--key value` options, and
 * repeatable `--header k=v` pairs. Good enough for the four CLI commands and
 * fully unit-testable.
 */

export interface ParsedArgs {
  /** Leading positional tokens (e.g. `['connectors','add']`). */
  positionals: string[];
  /** `--flag` → true; `--key value` → the value string. */
  options: Record<string, string | boolean>;
  /** Repeatable `--header k=v` pairs, collected in order. */
  headers: Record<string, string>;
}

/** Options that take a following value rather than being a boolean flag. */
const VALUE_OPTIONS = new Set(['character', 'name', 'url']);

/**
 * Parse `argv` (already sliced past the node/script entries). Positionals are
 * everything before the first `--option`; after that, `--flag`/`--key value`
 * are consumed. `--header k=v` may repeat and is gathered separately.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  const headers: Record<string, string> = {};

  let i = 0;
  // Leading positionals (until the first flag).
  while (i < argv.length && !argv[i]!.startsWith('-')) {
    positionals.push(argv[i]!);
    i++;
  }

  for (; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith('--')) {
      // A stray positional after flags — keep it (e.g. ordering quirks).
      positionals.push(tok);
      continue;
    }
    const key = tok.slice(2);

    if (key === 'header') {
      const pair = argv[i + 1];
      if (pair !== undefined && !pair.startsWith('--')) {
        const eq = pair.indexOf('=');
        if (eq > 0) {
          headers[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        i++;
      }
      continue;
    }

    if (VALUE_OPTIONS.has(key)) {
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        options[key] = val;
        i++;
      } else {
        options[key] = true; // flag-shaped use; command layer can reject
      }
      continue;
    }

    // Boolean flag (e.g. --yes, --execute, --help).
    options[key] = true;
  }

  return { positionals, options, headers };
}

/** Read a string option, or undefined when absent / boolean-shaped. */
export function strOption(args: ParsedArgs, key: string): string | undefined {
  const v = args.options[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read a boolean flag (true only when explicitly present). */
export function flag(args: ParsedArgs, key: string): boolean {
  return args.options[key] === true;
}
