/**
 * A `grep -r` that searches next to the storage instead of walking the mount.
 *
 * This is a narrower replacement than the `rg` one, because grep's defaults
 * differ from ripgrep's in ways that change answers rather than performance:
 * patterns are Basic Regular Expressions, matching is case-sensitive, and
 * recursion happens only with `-r` and a named path. Anything the built-in
 * would reject, or answer from standard input, is left to the built-in, so a
 * command line means the same thing whether or not the endpoint answered it.
 *
 * `-c` is left to the built-in for the same reason: grep counts every file it
 * visited, printing `path:0` for the ones that did not match, and the endpoint
 * reports only the files that did.
 */

import type { Command, CommandContext, ExecResult } from 'just-bash';
import { breToRustRegex, ereToRustRegex } from './grep-pattern.js';
import {
  absolute,
  belowTarget,
  displayPath,
  expandShortFlags,
  isDirectory,
  isHidden,
  MAX_PARALLEL_LEGS,
  mapBounded,
  mountsFromLayout,
  resolveLegs,
  searchLeg,
  type Mount,
  type SearchLeg,
  type SearchMatch,
  type SearchRequest,
  type ServerSearchConfig,
  type Unservable,
} from './search-rg.js';

/** What grep was asked to do, once it is known to be answerable. */
type GrepQuery = {
  legs: SearchLeg[];
  target: { typed: string; absolute: string };
  request: SearchRequest;
  lineNumbers: boolean;
  /** Recursive grep names the file on every line unless `-h` says not to. */
  showFilename: boolean;
};

/**
 * Translate a grep command line into one search, or explain why it cannot be.
 *
 * Only what the built-in accepts is accepted here, and only what the endpoint
 * answers exactly is served. Everything else falls back.
 */
export function planGrep(args: string[], cwd: string, mounts: Mount[]): GrepQuery | Unservable {
  let pattern: string | undefined;
  let patternFromFlag = false;
  const positionals: string[] = [];
  const includeGlobs: string[] = [];
  const excludeGlobs: string[] = [];
  let recursive = false;
  let caseInsensitive = false;
  let literal = false;
  let extended = false;
  let word = false;
  let mode: SearchRequest['mode'] = 'lines';
  let lineNumbers = false;
  let showFilename = true;

  const expanded = expandShortFlags(args, 'e');
  for (let i = 0; i < expanded.length; i++) {
    const arg = expanded[i] ?? '';
    if (arg.startsWith('--include=') || arg.startsWith('--exclude=')) {
      const glob = arg.slice('--include='.length);
      // The built-in matches these against the basename alone and reads braces
      // literally; the endpoint anchors a slashed glob at the repo root and
      // expands braces. Neither is wrong, so neither is approximated.
      if (/[/{]/.test(glob)) return { unservable: 'glob with a path or braces' };
      (arg.startsWith('--include=') ? includeGlobs : excludeGlobs).push(glob);
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') {
      if (pattern === undefined && !patternFromFlag) pattern = arg;
      else positionals.push(arg);
      continue;
    }
    switch (arg) {
      case '-r':
      case '-R':
      case '--recursive':
        recursive = true;
        break;
      case '-i':
      case '--ignore-case':
        caseInsensitive = true;
        break;
      case '-F':
      case '--fixed-strings':
        literal = true;
        break;
      case '-E':
      case '--extended-regexp':
        extended = true;
        break;
      case '-w':
      case '--word-regexp':
        word = true;
        break;
      case '-l':
      case '--files-with-matches':
        mode = 'files';
        break;
      case '-n':
      case '--line-number':
        lineNumbers = true;
        break;
      case '-h':
      case '--no-filename':
        showFilename = false;
        break;
      case '-e': {
        const value = expanded[++i];
        if (value === undefined) return { unservable: '-e requires a pattern' };
        // One pattern per search: a second would need a union the endpoint
        // does not take.
        if (patternFromFlag || pattern !== undefined) return { unservable: 'more than one pattern' };
        pattern = value;
        patternFromFlag = true;
        break;
      }
      default:
        return { unservable: `${arg} is not supported by server-side search` };
    }
  }

  if (pattern === undefined) return { unservable: 'no pattern given' };
  // Without -r, or without a path, the built-in reads a named file or standard
  // input rather than walking anything.
  if (!recursive || positionals.length === 0) return { unservable: 'not a recursive search of a path' };
  if (positionals.length > 1) return { unservable: 'more than one search path' };

  // `-F` is literal in both dialects and needs no translation.
  let translated = pattern;
  if (!literal) {
    const converted = extended ? ereToRustRegex(pattern) : breToRustRegex(pattern);
    if (converted === null) return { unservable: 'pattern has no equivalent in the search dialect' };
    translated = converted;
  }

  const typed = positionals[0] as string;
  const legs = resolveLegs(absolute(cwd, typed), mounts);
  if ('unservable' in legs) return legs;

  return {
    legs,
    target: { typed, absolute: absolute(cwd, typed) },
    request: {
      pattern: translated,
      mode,
      caseMode: caseInsensitive ? 'insensitive' : 'sensitive',
      literal,
      word,
      includeGlobs,
      excludeGlobs,
    },
    lineNumbers,
    showFilename,
  };
}

/**
 * Order paths the way a recursive walk over name-sorted directories visits
 * them: segment by segment, so `utils/index.ts` precedes `utils.ts`.
 */
function walkOrder(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const l = left[i] as string;
    const r = right[i] as string;
    if (l !== r) return l < r ? -1 : 1;
  }
  return left.length - right.length;
}

/** Render results the way grep does. `-h` does not reach `-l`, whose answer is the path. */
function format(matches: { path: string; match: SearchMatch }[], query: GrepQuery): string {
  if (query.request.mode === 'files') {
    return matches.map(({ path }) => `${path}\n`).join('');
  }
  return matches
    .flatMap(({ path, match }) =>
      match.lines.map(
        (line) =>
          `${query.showFilename ? `${path}:` : ''}${query.lineNumbers ? `${line.line_number}:` : ''}${line.text}\n`
      )
    )
    .join('');
}

/**
 * Build the `grep` replacement.
 *
 * `fallback` runs the original command line through the built-in, and is
 * called for anything this cannot answer exactly.
 */
export function createSearchGrep(
  config: ServerSearchConfig,
  fallback: (args: string[], ctx: CommandContext) => Promise<ExecResult>
): Command {
  const mounts = mountsFromLayout(config.layout);

  return {
    name: 'grep',
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      const plan = planGrep(args, ctx.cwd, mounts);
      if ('unservable' in plan || !(await isDirectory(ctx, plan.target.absolute))) {
        return fallback(args, ctx);
      }

      let found: { path: string; match: SearchMatch }[];
      try {
        const perLeg = await mapBounded(plan.legs, MAX_PARALLEL_LEGS, async (leg) => {
          const root = leg.mount.path === '/' ? '' : leg.mount.path;
          const kept: { path: string; match: SearchMatch }[] = [];
          for await (const match of searchLeg(config, leg, plan.request)) {
            const suffix = belowTarget(`${root}/${match.path}`, plan.target);
            // The built-in walks past dot-prefixed entries during recursion,
            // even though POSIX grep does not.
            if (isHidden(suffix)) continue;
            kept.push({ path: displayPath(suffix, plan.target), match });
          }
          return kept;
        });
        // The built-in walks the tree in sorted order and the endpoint does not.
        found = perLeg.flat().sort((a, b) => walkOrder(a.path, b.path));
      } catch {
        return fallback(args, ctx);
      }

      // grep's convention: 0 when something matched, 1 when nothing did.
      return { stdout: format(found, plan), stderr: '', exitCode: found.length > 0 ? 0 : 1 };
    },
  };
}
