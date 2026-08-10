/**
 * Mount-layout constructors.
 *
 * `repo()` and `createLayout()` build the serializable layout schema
 * (`LayoutSpec`) shared with the CLI and the Python SDK. The authoritative
 * normalization — path expansion, collision, organization scope, and
 * repository-uniqueness semantics — lives in core Rust
 * (`mesafs-core::layout`); this module only performs cheap, early checks
 * that produce friendlier errors without defining semantics.
 */

/** Whether a mount accepts mutations. There is no default. */
export type MountMode = 'ro' | 'rw';

/**
 * How a layout entry selects its repository, by repository name (a bare
 * string or `{ name }`). Names are resolved to their canonical repository
 * at the service boundary.
 */
export type RepoSelectorInput = string | { name: string };

/** Options for one repository declaration. */
export type RepoOptions = {
  /** Read-only or read-write presentation. Always explicit. */
  mode: MountMode;
  /** Child-directory name override. Only valid on array elements. */
  alias?: string;
  /** Nested mounts declared beneath this repository's path. */
  subPaths?: Record<string, Repo | Repo[]>;
} & ({ bookmark?: string; changeId?: never } | { bookmark?: never; changeId: string });

/**
 * One repository declaration in serialized `LayoutSpec` form. Produced by
 * {@link repo}; do not construct by hand.
 */
export interface Repo {
  /** What this entry mounts; always `'repo'` today. */
  readonly kind: 'repo';
  /** Repository name within the mount's organization. */
  readonly name: string;
  readonly mode: MountMode;
  readonly bookmark?: string;
  readonly changeId?: string;
  readonly alias?: string;
  readonly subPaths?: Record<string, Repo | Repo[]>;
}

/**
 * The mount-layout schema: a pure path map. Every key is an absolute
 * (`/`-prefixed) namespace path — the compiler rejects non-absolute keys in
 * object literals, and pre-typed records with a stray non-absolute key fail
 * the early runtime check. The organization is not part of the document —
 * it comes from mount context (the client, or `MESA_ORG` for a CLI mount)
 * — so a layout file is portable shape.
 */
export type LayoutSpec = {
  [path: `/${string}`]: Repo | Repo[];
};

/** A serializable layout value for `mesa mount --layout` and future mounts. */
export interface Layout {
  /** The layout in canonical `LayoutSpec` form. */
  readonly spec: LayoutSpec;
  /** Serialize as deterministic, pretty-printed JSON (for `layout.json`). */
  toString(): string;
  /** The canonical `LayoutSpec`, for `JSON.stringify` interoperability. */
  toJSON(): LayoutSpec;
}

/**
 * Declare one repository mount.
 *
 * @param selector - Repository name, as a bare string or `{ name }`.
 * @param options - Mount options; `mode` is required.
 */
export function repo(selector: RepoSelectorInput, options: RepoOptions): Repo {
  const name = typeof selector === 'string' ? selector : selector.name;
  if (name.length === 0) {
    throw new Error('repo(): repository name must not be empty');
  }
  if (options.mode !== 'ro' && options.mode !== 'rw') {
    throw new Error(`repo(): mode must be 'ro' or 'rw'`);
  }
  if (options.bookmark !== undefined && options.changeId !== undefined) {
    throw new Error('repo(): bookmark and changeId are mutually exclusive');
  }
  return {
    kind: 'repo',
    name,
    mode: options.mode,
    ...(options.bookmark !== undefined && { bookmark: options.bookmark }),
    ...(options.changeId !== undefined && { changeId: options.changeId }),
    ...(options.alias !== undefined && { alias: options.alias }),
    ...(options.subPaths !== undefined && { subPaths: options.subPaths }),
  };
}

/**
 * Build a serializable mount layout.
 *
 * The returned value is local; it does not create a server-stored resource.
 * Its string form deserializes as the core `LayoutSpec` consumed by
 * `mesa mount --layout`. The document carries no organization: the mount
 * that consumes it resolves every selector within the organization its
 * mount context provides — the client's organization, or `MESA_ORG` for
 * the CLI.
 */
export function createLayout(paths: LayoutSpec): Layout {
  // Pre-typed `Record<string, Repo | Repo[]>` values still assign to
  // `LayoutSpec`, so keep the runtime absolute-path check for them.
  for (const path of Object.keys(paths)) {
    if (!path.startsWith('/')) {
      throw new Error(`createLayout(): top-level path '${path}' must be absolute`);
    }
  }
  const spec: LayoutSpec = { ...paths };
  return {
    spec,
    toString: () => stableStringify(spec),
    toJSON: () => spec,
  };
}

/** Pretty-print with recursively sorted object keys for deterministic output. */
function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)])
    );
  }
  return value;
}
