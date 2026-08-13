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

/** Exactly one of `bookmark` or `changeId` (TypeScript exclusive union). */
export type RevisionIdentifier = { bookmark: string; changeId?: never } | { bookmark?: never; changeId: string };

export type MountRevisionProperties = {
  /** Optional; omit for an anonymous (unbookmarked) tip. */
  bookmark?: string;
  describe?: string | null;
};

/**
 * Fork-on-open declaration: parent tip plus optional bookmark/describe on
 * the new empty descendant.
 */
export type BranchedRevision = RevisionIdentifier & {
  /** Optional; omit `as` or `as.bookmark` for an anonymous tip. */
  as?: MountRevisionProperties;
};

/** Options for one repository declaration. */
export type RepoOptions = {
  /** Read-only or read-write presentation. Always explicit. */
  mode: MountMode;
  /** Child-directory name override. Only valid on array elements. */
  alias?: string;
  /** Nested mounts declared beneath this repository's path. */
  subPaths?: Record<string, Repo | Repo[]>;
} & (
  | {
      /** Pin an existing revision. Mutually exclusive with `branchedFrom`. */
      at?: RevisionIdentifier;
      branchedFrom?: never;
    }
  | {
      /** Fork-on-open requires a writable mount. */
      mode: 'rw';
      at?: never;
      branchedFrom: BranchedRevision;
    }
);

/**
 * One repository declaration in serialized `LayoutSpec` form. Produced by
 * {@link repo}; do not construct by hand.
 */
export type Repo = {
  /** What this entry mounts; always `'repo'` today. */
  readonly kind: 'repo';
  /** Repository name within the mount's organization. */
  readonly name: string;
  readonly mode: MountMode;
  readonly alias?: string;
  readonly subPaths?: Record<string, Repo | Repo[]>;
} & (
  | {
      /** Pin an existing revision. Mutually exclusive with `branchedFrom`. */
      readonly at?: RevisionIdentifier;
      readonly branchedFrom?: never;
    }
  | {
      /** Fork-on-open requires a writable mount. */
      readonly mode: 'rw';
      readonly at?: never;
      readonly branchedFrom: BranchedRevision;
    }
);

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
  if (name.includes('/')) {
    // A layout entry names a repository within the client's organization, so
    // a slash can only be an "org/repo" selector. Left unchecked it is signed
    // into the token verbatim and fails as an opaque repo-not-found at mount.
    throw new Error(
      `repo(): repository name '${name}' must not contain '/'. Cross-org mounts are not supported; pass '${name.slice(name.indexOf('/') + 1)}' without the organization prefix.`
    );
  }
  if (options.mode !== 'ro' && options.mode !== 'rw') {
    throw new Error(`repo(): mode must be 'ro' or 'rw'`);
  }
  if (options.at !== undefined && options.branchedFrom !== undefined) {
    throw new Error('repo(): at and branchedFrom are mutually exclusive');
  }
  if (options.at !== undefined) {
    if (options.at.bookmark !== undefined && options.at.changeId !== undefined) {
      throw new Error('repo(): at.bookmark and at.changeId are mutually exclusive');
    }
    if (options.at.bookmark === undefined && options.at.changeId === undefined) {
      throw new Error('repo(): at requires a bookmark or changeId');
    }
  }
  if (options.branchedFrom !== undefined) {
    if (options.mode !== 'rw') {
      throw new Error('repo(): branchedFrom requires mode "rw"');
    }
    const parent = options.branchedFrom;
    if (parent.bookmark !== undefined && parent.changeId !== undefined) {
      throw new Error('repo(): branchedFrom.bookmark and branchedFrom.changeId are mutually exclusive');
    }
    if (parent.bookmark === undefined && parent.changeId === undefined) {
      throw new Error('repo(): branchedFrom requires a parent bookmark or changeId');
    }
  }
  const declaration = {
    kind: 'repo',
    name,
    mode: options.mode,
  } as const;
  const nested = {
    ...(options.alias !== undefined && { alias: options.alias }),
    ...(options.subPaths !== undefined && { subPaths: options.subPaths }),
  };

  // Copy revision selections so mutating the caller's options object later
  // cannot silently rewrite the declaration.
  if (options.branchedFrom !== undefined) {
    return {
      ...declaration,
      mode: options.mode,
      branchedFrom: {
        ...options.branchedFrom,
        ...(options.branchedFrom.as !== undefined && { as: { ...options.branchedFrom.as } }),
      },
      ...nested,
    };
  }
  return {
    ...declaration,
    ...(options.at !== undefined && { at: { ...options.at } }),
    ...nested,
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
