/**
 * A `rg` that searches next to the storage instead of walking the mount.
 *
 * just-bash's built-in `rg` reads the filesystem, which over a Mesa mount costs
 * a round trip per directory. This one translates the same command line into a
 * single repository search and formats the response the way ripgrep would.
 *
 * A path may span several repositories, because a layout can nest one mount
 * inside another. Each becomes its own search, issued in parallel, with the
 * parent excluding the subtrees its children shadow so no file is counted
 * twice or attributed to the wrong repository.
 *
 * It only replaces the built-in when it can answer exactly what was asked. A
 * flag it does not implement, or a path outside every mount, defers to the
 * built-in, so the worst case is the behaviour that exists today rather than a
 * wrong answer.
 */

import type { Command, CommandContext, ExecResult } from 'just-bash';
import type { Layout, Repo } from './layout.js';

/** One repository as it appears in the mount namespace. */
export type Mount = {
  /** Absolute path in the mount where this repository's root sits. */
  path: string;
  repo: string;
  bookmark?: string;
  changeId?: string;
};

/** One repository's share of a search. */
export type SearchLeg = {
  mount: Mount;
  /** Repo-relative directory to search under. */
  pathPrefix: string;
  /** Subtrees this repository owns but a nested mount covers. */
  excludes: string[];
};

/** What the server needs to answer one search, across every repository it spans. */
type SearchQuery = {
  legs: SearchLeg[];
  /**
   * The search path as the caller typed it, and its absolute form.
   *
   * ripgrep reports each file the way the caller named its directory: a
   * relative argument yields relative output, an absolute one absolute, and no
   * argument at all yields paths relative to the working directory. Results
   * come back repo-relative, so both are needed to put them back.
   */
  target: { typed: string; absolute: string };
  hidden: boolean;
  request: SearchRequest;
};

/**
 * One search, in the endpoint's own vocabulary rather than any command's.
 *
 * `rg` and `grep` disagree about defaults — smart case against case-sensitive,
 * Rust regex against a translated BRE — so each planner spells out what it
 * means here and the request is sent as written.
 */
export type SearchRequest = {
  pattern: string;
  mode: 'lines' | 'count' | 'files';
  caseMode: 'smart' | 'sensitive' | 'insensitive';
  literal: boolean;
  word: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
};

/**
 * Searches issued at once for a single command.
 *
 * The server admits a small number of concurrent searches per task, so a
 * layout with many nested repositories would otherwise let one `rg` fill the
 * queue by itself and stall every other caller.
 */
export const MAX_PARALLEL_LEGS = 4;

/** Why a command line could not be served, phrased for the reader of a log. */
export type Unservable = { unservable: string };

export type ServerSearchConfig = {
  /** Versioned API root, e.g. `https://api.mesa.dev/v1`. */
  apiBaseUrl: string;
  org: string;
  accessToken: string;
  layout: Layout;
  fetch?: typeof globalThis.fetch;
};

/**
 * Flatten a layout into the repository roots it presents, longest path first.
 *
 * A single declaration mounts at its key; an array mounts each element in a
 * child directory named by its alias. Nested declarations shadow the parent at
 * their own path, which is why the list is ordered longest-first: the deepest
 * mount containing a path is the one that owns it.
 */
export function mountsFromLayout(layout: Layout): Mount[] {
  const mounts: Mount[] = [];

  const visit = (base: string, entries: Record<string, Repo | Repo[]>): void => {
    for (const [key, entry] of Object.entries(entries)) {
      const parent = joinPath(base, key);
      const declarations = Array.isArray(entry) ? entry : [entry];
      for (const declaration of declarations) {
        // A lone declaration is the directory; siblings each get their own.
        const path = Array.isArray(entry) ? joinPath(parent, declaration.alias ?? declaration.name) : parent;
        mounts.push({
          path,
          repo: declaration.name,
          bookmark: declaration.at?.bookmark,
          changeId: declaration.at?.changeId,
        });
        if (declaration.subPaths) visit(path, declaration.subPaths);
      }
    }
  };

  visit('', layout as Record<string, Repo | Repo[]>);
  return mounts.sort((a, b) => b.path.length - a.path.length);
}

function joinPath(base: string, segment: string): string {
  const trimmed = segment.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? base || '/' : `${base}/${trimmed}`;
}

/** Absolute form of a path as typed on the command line. */
export function absolute(cwd: string, path: string): string {
  if (path.startsWith('/')) return path.replace(/\/+$/, '') || '/';
  const base = cwd.replace(/\/+$/, '');
  const joined = path === '.' || path === '' ? base : `${base}/${path}`;
  return joined.replace(/\/+$/, '') || '/';
}

/**
 * Split a target path into one search per repository it covers.
 *
 * The mount containing the target supplies the first leg, scoped to the part
 * of the target below its root. Every mount nested under the target supplies
 * another, searched whole. A parent excludes each nested mount's subtree,
 * because in the mount namespace those paths show the child's content, not
 * the parent's.
 */
/** Whether `child` sits strictly inside `parent`. The root contains everything. */
function isUnder(child: string, parent: string): boolean {
  return parent === '/' ? child !== '/' : child.startsWith(`${parent}/`);
}

export function resolveLegs(target: string, mounts: Mount[]): SearchLeg[] | Unservable {
  const owner = mounts.find((mount) => target === mount.path || isUnder(target, mount.path));
  // A target above every mount — the namespace root, most obviously — belongs
  // to no repository but still covers several, so it yields a leg for each
  // rather than falling back to a walk of the whole mount.
  const nested = mounts.filter((mount) => isUnder(mount.path, target));
  if (!owner && nested.length === 0) {
    return { unservable: `${target} is not inside a Mesa repository` };
  }
  const covered = owner ? [owner, ...nested] : nested;

  return covered.map((mount) => ({
    mount,
    pathPrefix: mount === owner ? target.slice(owner.path.length).replace(/^\/+/, '') : '',
    excludes: covered
      .filter((other) => other !== mount && isUnder(other.path, mount.path))
      .map((child) => `${child.path.slice(mount.path.length).replace(/^\/+/, '')}/**`),
  }));
}

/**
 * Translate a ripgrep command line into one search.
 *
 * The supported set is deliberately small. Anything else defers rather than
 * approximating, because a flag that silently does nothing changes the answer.
 */
export function planSearch(args: string[], cwd: string, mounts: Mount[]): SearchQuery | Unservable {
  args = expandShortFlags(args, 'eg');
  let pattern: string | undefined;
  const targets: string[] = [];
  const globs: string[] = [];
  let mode: SearchRequest['mode'] = 'lines';
  // The built-in `rg` is smart-case by default, unlike ripgrep itself, and the
  // served answer has to agree with the one the fallback would give.
  let caseMode: SearchRequest['caseMode'] = 'smart';
  let literal = false;
  let word = false;
  let hidden = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      // Everything after is positional, pattern first.
      for (const rest of args.slice(i + 1)) {
        if (pattern === undefined) pattern = rest;
        else targets.push(rest);
      }
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      if (pattern === undefined) pattern = arg;
      else targets.push(arg);
      continue;
    }
    switch (arg) {
      case '-i':
      case '--ignore-case':
        caseMode = 'insensitive';
        break;
      case '-s':
      case '--case-sensitive':
        caseMode = 'sensitive';
        break;
      case '-S':
      case '--smart-case':
        caseMode = 'smart';
        break;
      case '-F':
      case '--fixed-strings':
        literal = true;
        break;
      case '-w':
      case '--word-regexp':
        word = true;
        break;
      case '-c':
      case '--count':
        mode = 'count';
        break;
      case '-l':
      case '--files-with-matches':
        mode = 'files';
        break;
      case '--hidden':
        hidden = true;
        break;
      case '-n':
      case '--line-number':
        // Line numbers are always available; this is the default shape.
        break;
      case '-g':
      case '--glob': {
        const glob = args[++i];
        if (glob === undefined) return { unservable: `${arg} requires a pattern` };
        globs.push(glob);
        break;
      }
      default:
        return { unservable: `${arg} is not supported by server-side search` };
    }
  }

  if (pattern === undefined) return { unservable: 'no pattern given' };
  if (targets.length > 1) return { unservable: 'more than one search path' };

  const typed = targets[0] ?? '.';
  const absoluteTarget = absolute(cwd, typed);
  const legs = resolveLegs(absoluteTarget, mounts);
  if ('unservable' in legs) return legs;

  return {
    legs,
    target: { typed, absolute: absoluteTarget },
    hidden,
    request: { pattern, mode, caseMode, literal, word, includeGlobs: globs, excludeGlobs: [] },
  };
}

export type SearchMatch = {
  path: string;
  line_count: number;
  lines: { line_number: number; text: string }[];
};

/** One newline-delimited row from the endpoint. */
type SearchEvent = ({ type: 'match' } & SearchMatch) | { type: 'summary' };

/**
 * Read a search as it arrives, one row per line.
 *
 * The endpoint answers only in newline-delimited JSON, so rows are parsed and
 * handed on as they land rather than accumulating the whole response first.
 */
async function* searchEvents(
  url: string,
  config: ServerSearchConfig,
  doFetch: typeof globalThis.fetch
): AsyncGenerator<SearchEvent> {
  const response = await doFetch(url, { headers: { Authorization: `Bearer ${config.accessToken}` } });
  if (!response.ok) {
    throw new Error(`search returned ${response.status}`);
  }
  if (!response.body) {
    throw new Error('search returned no body');
  }

  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    // A chunk boundary can fall mid-row, so only whole lines are parsed and
    // the remainder waits for the next chunk.
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line !== '') yield JSON.parse(line) as SearchEvent;
      newline = pending.indexOf('\n');
    }
  }
  const last = pending.trim();
  if (last !== '') yield JSON.parse(last) as SearchEvent;
}

function buildUrl(config: ServerSearchConfig, request: SearchRequest, leg: SearchLeg): string {
  const params = new URLSearchParams({ q: request.pattern, mode: request.mode });
  params.set('case', request.caseMode);
  if (request.literal) params.set('literal', 'true');
  if (request.word) params.set('word', 'true');
  if (leg.pathPrefix) params.set('path', leg.pathPrefix);
  for (const glob of request.includeGlobs) params.append('include', glob);
  // Carve out what a nested mount covers, so the parent does not answer for
  // paths the namespace shows as the child's.
  for (const exclude of [...leg.excludes, ...request.excludeGlobs]) params.append('exclude', exclude);
  // A layout may pin either, and the server defaults to the repo's bookmark.
  if (leg.mount.changeId) params.set('change_id', leg.mount.changeId);
  else if (leg.mount.bookmark) params.set('bookmark', leg.mount.bookmark);
  return `${config.apiBaseUrl}/${config.org}/${leg.mount.repo}/search?${params}`;
}

/**
 * Run one leg's search, yielding each matching file as its row arrives.
 *
 * Shared by both command overrides so there is a single place that knows how
 * the endpoint is addressed and how its rows arrive.
 */
export async function* searchLeg(
  config: ServerSearchConfig,
  leg: SearchLeg,
  request: SearchRequest
): AsyncGenerator<SearchMatch> {
  const doFetch = config.fetch ?? globalThis.fetch;
  for await (const event of searchEvents(buildUrl(config, request, leg), config, doFetch)) {
    if (event.type === 'match') yield event;
  }
}

/**
 * Whether the search target is a directory the endpoint can search under.
 *
 * The endpoint's path prefix names a directory, so a file operand or a missing
 * path would come back empty where the built-in prints the file's matches or
 * its own error. Either way the built-in has to answer.
 */
export async function isDirectory(ctx: CommandContext, path: string): Promise<boolean> {
  try {
    return (await ctx.fs.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** The part of a path below the directory the caller named. */
export function belowTarget(absolutePath: string, target: { absolute: string }): string {
  return absolutePath.slice(target.absolute.length).replace(/^\/+/, '');
}

/**
 * Name a file the way ripgrep would, given how the caller named the directory.
 *
 * `rg love sonnets` reports `sonnets/x.md`, `rg love /repo/sonnets` reports
 * `/repo/sonnets/x.md`, and a bare `rg love` reports paths relative to the
 * working directory.
 */
export function displayPath(suffix: string, target: { typed: string }): string {
  if (target.typed === '.' || target.typed === '') return suffix;
  return `${target.typed.replace(/\/+$/, '')}/${suffix}`;
}

/**
 * Whether ripgrep would have walked past this file without opening it.
 *
 * ripgrep skips dot-prefixed entries during traversal, but searches a path the
 * caller named explicitly even when it is hidden. Only the part below the
 * named directory is examined, so `rg foo .agents` still searches `.agents`.
 *
 * The search endpoint does not apply this rule — hiding dotfiles is a
 * convention of the command-line tool, not of the repository — so `rg` applies
 * it here instead.
 */
export function isHidden(suffix: string): boolean {
  return suffix.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Translate one `.gitignore` line into repository-root-relative exclude globs.
 *
 * `dir` is the directory holding the ignore file, so a nested file's rules
 * stay scoped to its own subtree. A bare name matches at any depth below that
 * directory and may name either a file or a directory, so it yields both forms.
 *
 * Returns nothing for blanks and comments, and `null` for a negation, which
 * the exclude parameter cannot express: the server prefixes every exclude with
 * `!` already, so a re-inclusion would arrive as a double negation.
 */
export function gitignoreLineToGlobs(line: string, dir: string): string[] | null {
  const pattern = line.trim();
  if (pattern === '' || pattern.startsWith('#')) return [];
  if (pattern.startsWith('!')) return null;

  const under = (rest: string) => (dir === '' ? rest : `${dir}/${rest}`);
  const directoryOnly = pattern.endsWith('/');
  const body = (directoryOnly ? pattern.slice(0, -1) : pattern).replace(/^\/+/, '');
  if (body === '') return [];

  // A slash anywhere but the end anchors the pattern to this directory;
  // otherwise it matches a basename at any depth below it.
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  const base = anchored ? under(body) : under(`**/${body}`);
  return directoryOnly ? [`${base}/**`] : [`${base}`, `${base}/**`];
}

/**
 * Every ignore rule in a subtree, as exclude globs, or `null` when one of them
 * cannot be expressed and the caller should fall back.
 *
 * The ignore files are read through the search endpoint rather than the mount:
 * one request returns the contents of every `.gitignore` under the path, where
 * walking the tree for them would cost the round trips this command exists to
 * avoid.
 */
export function gitignoreExcludes(files: { path: string; lines: string[] }[]): string[] | null {
  const globs: string[] = [];
  for (const file of files) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    for (const line of file.lines) {
      const translated = gitignoreLineToGlobs(line, dir);
      if (translated === null) return null;
      globs.push(...translated);
    }
  }
  return globs;
}

/**
 * Read every `.gitignore` under a leg and translate it into exclude globs.
 *
 * One search returns the contents of all of them: the pattern matches any
 * non-empty line, and a glob without a slash matches a basename at any depth.
 */
async function ignoreExcludesFor(
  config: ServerSearchConfig,
  leg: SearchLeg,
  doFetch: typeof globalThis.fetch
): Promise<string[] | null> {
  const params = new URLSearchParams({ q: '.', mode: 'lines', include: '.gitignore' });
  if (leg.pathPrefix) params.set('path', leg.pathPrefix);
  if (leg.mount.changeId) params.set('change_id', leg.mount.changeId);
  else if (leg.mount.bookmark) params.set('bookmark', leg.mount.bookmark);

  const url = `${config.apiBaseUrl}/${config.org}/${leg.mount.repo}/search?${params}`;
  const files: { path: string; lines: string[] }[] = [];
  for await (const event of searchEvents(url, config, doFetch)) {
    if (event.type === 'match') {
      files.push({ path: event.path, lines: event.lines.map((line) => line.text) });
    }
  }
  return gitignoreExcludes(files);
}

/**
 * Split clustered short flags into separate ones.
 *
 * `-rn` means `-r -n`, which is how people actually type these commands. The
 * built-in clusters boolean flags only — `-re PATTERN` is an error there rather
 * than a pattern flag — so a cluster naming any flag that takes a value is left
 * whole, and the built-in gets to reject it in its own words.
 *
 * `valueFlags` is the set of short flags that consume the next argument.
 */
export function expandShortFlags(args: string[], valueFlags: string): string[] {
  const expanded: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (arg === '--') {
      // Everything past this point is positional, clusters included.
      expanded.push(...args.slice(index));
      return expanded;
    }
    const isCluster = arg.length > 2 && arg.startsWith('-') && !arg.startsWith('--');
    const letters = isCluster ? arg.slice(1) : '';
    if (isCluster && ![...letters].some((letter) => valueFlags.includes(letter))) {
      expanded.push(...[...letters].map((letter) => `-${letter}`));
      continue;
    }
    expanded.push(arg);
  }
  return expanded;
}

/** Run `work` over `items`, at most `limit` at a time, preserving input order. */
export async function mapBounded<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/**
 * Render results the way ripgrep does, so a caller piping into `head` or
 * `cut -d:` cannot tell the difference.
 *
 * Order is arrival order, which is what ripgrep itself produces: it searches
 * in parallel and prints each file as it finishes, so two runs over the same
 * tree need not agree. Sorting is `--sort path` there, and the manual is blunt
 * about the price — it "forces ripgrep to abandon parallelism and run in a
 * single thread". Imposing it here would have been a divergence dressed up as
 * tidiness; `| sort` remains available to anyone who wants it.
 */
function format(matches: { path: string; match: SearchMatch }[], query: SearchQuery): string {
  if (query.request.mode === 'files') {
    return matches.map(({ path }) => `${path}\n`).join('');
  }
  if (query.request.mode === 'count') {
    return matches.map(({ path, match }) => `${path}:${match.line_count}\n`).join('');
  }
  return matches
    .flatMap(({ path, match }) => match.lines.map((line) => `${path}:${line.line_number}:${line.text}\n`))
    .join('');
}

/**
 * Build the `rg` replacement.
 *
 * `fallback` runs the original command line through the built-in, and is called
 * whenever this command cannot answer precisely.
 */
export function createSearchRg(
  config: ServerSearchConfig,
  fallback: (args: string[], ctx: CommandContext) => Promise<ExecResult>
): Command {
  const mounts = mountsFromLayout(config.layout);
  const doFetch = config.fetch ?? globalThis.fetch;

  return {
    name: 'rg',
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      const plan = planSearch(args, ctx.cwd, mounts);
      if ('unservable' in plan || !(await isDirectory(ctx, plan.target.absolute))) {
        return fallback(args, ctx);
      }

      let responses: { path: string; match: SearchMatch }[][];
      try {
        // Ignore rules first, so the server never fetches a blob the answer
        // would have discarded. A repository with none costs one empty request.
        const ignores = await mapBounded(plan.legs, MAX_PARALLEL_LEGS, (leg) =>
          ignoreExcludesFor(config, leg, doFetch)
        );
        if (ignores.includes(null)) {
          // A negation cannot be expressed as an exclude.
          return fallback(args, ctx);
        }

        responses = await mapBounded(plan.legs, MAX_PARALLEL_LEGS, async (leg) => {
          const extra = ignores[plan.legs.indexOf(leg)] ?? [];
          const root = leg.mount.path === '/' ? '' : leg.mount.path;
          const kept: { path: string; match: SearchMatch }[] = [];
          // Rows are filtered and reshaped as they arrive, so a file the answer
          // will not mention is never held.
          for await (const match of searchLeg(config, leg, { ...plan.request, excludeGlobs: extra })) {
            const suffix = belowTarget(`${root}/${match.path}`, plan.target);
            if (!plan.hidden && isHidden(suffix)) continue;
            kept.push({ path: displayPath(suffix, plan.target), match });
          }
          return kept;
        });
      } catch {
        // Any leg failing makes the whole answer partial, and a partial `rg`
        // result is a wrong one. The mount can still answer without us.
        return fallback(args, ctx);
      }

      const matches = responses.flat();
      const stdout = format(matches, plan);
      // ripgrep's convention: 0 when something matched, 1 when nothing did.
      return { stdout, stderr: '', exitCode: matches.length > 0 ? 0 : 1 };
    },
  };
}
