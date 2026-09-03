import {
  Bash,
  type BashOptions,
  type BufferEncoding,
  type CpOptions,
  type FileContent,
  type FsStat,
  type IFileSystem,
  type MkdirOptions,
  type RmOptions,
} from 'just-bash';
import { looksLikePrivateKey } from '../api/credentials.js';
import { InvalidOptionsError, MissingCredentialError } from '../lib/errors.js';
import type {
  NativeMesaFileSystem,
  NativeMesaFileSystemWatcher,
  NativeConfig,
  NativeModule,
  NativeRepoConfig,
  NativeWatchEvent,
} from './native-loader.js';
import { loadNativeAddon } from './native-loader.js';
import type { BranchedRevision, Layout, RevisionIdentifier } from './layout.js';

export interface ChangeResult {
  /** Reverse-hex-encoded change ID of the now-active change (JJ format, lowercase letters `k`–`z`). */
  changeOid: string;
}

/**
 * Result of {@link ChangeOps.checkpoint}.
 *
 * Unlike {@link ChangeResult}, checkpoint both saves the current change and
 * switches the checkout to a new empty descendant, so callers need both IDs.
 * Concurrent writes and tree mutations in the same repo are serialized with
 * the flush-and-fork boundary.
 */
export interface CheckpointResult {
  /** Reverse-hex-encoded change ID of the described (saved) change. */
  savedChangeOid: string;
  /** Reverse-hex-encoded change ID of the now-active empty descendant. */
  activeChangeOid: string;
}

export type ChangeRevArgs = {
  repo: string;
} & ({ bookmark: string; changeId?: never } | { bookmark?: never; changeId: string });

export type ChangeNewArgs = ChangeRevArgs & {
  /** Description/message for a newly created change. Defaults to empty. */
  message?: string;
};

export type ChangeEditArgs = ChangeRevArgs;

export interface ChangeListArgs {
  repo: string;
  /** Maximum number of changes to return. Defaults to 50. Pass 0 for no limit. */
  limit?: number;
}

export interface ChangeInfo {
  /** Reverse-hex-encoded change ID (JJ format, lowercase letters `k`–`z`). */
  changeId: string;
  /** Hex-encoded commit OID that the change currently points to. */
  commitOid: string;
}

export interface BookmarkCreateArgs {
  repo: string;
  name: string;
}

interface BookmarkMoveArgs {
  repo: string;
  /** Name of the bookmark to move. */
  name: string;
  /** Reverse-hex-encoded change ID to move the bookmark to (JJ format, lowercase letters `k`–`z`). */
  changeId: string;
  /** Allow moving the bookmark backward or sideways in history. Defaults to false. */
  allowBackwards?: boolean;
}

export interface BookmarkListArgs {
  repo: string;
}

export type WatchEvent = {
  path: string;
  recursive: boolean;
};

export type WatchEventHandler = (event: WatchEvent) => void | Promise<void>;

/** Sub-object for change management operations on a MesaFileSystem. */
export interface ChangeOps {
  /**
   * Create a new change on the specified revision. Always creates.
   *
   * - `{ bookmark }` — create a new change from the bookmark's HEAD commit.
   *   Throws if the bookmark doesn't exist.
   * - `{ changeId }` — fork a new change from an existing change's latest
   *   commit. Throws if the source change doesn't exist.
   *
   * Exactly one of `bookmark` or `changeId` must be specified.
   */
  new: (args: ChangeNewArgs) => Promise<ChangeResult>;

  /**
   * Check out the existing change for the specified revision. Never creates
   * a new change.
   *
   * - `{ bookmark }` — switch to the change pointed to by the bookmark.
   *   Throws if the bookmark doesn't exist.
   * - `{ changeId }` — switch to an existing detached change. Throws if it
   *   doesn't exist.
   *
   * Exactly one of `bookmark` or `changeId` must be specified.
   */
  edit: (args: ChangeEditArgs) => Promise<ChangeResult>;

  /**
   * List changes reachable from the current checkout's commit.
   */
  list: (args: ChangeListArgs) => Promise<ChangeInfo[]>;

  /** Return the currently active change for the given repo. */
  current: (args: { repo: string }) => Promise<ChangeInfo>;

  /**
   * Flush pending writes (serializing concurrent writes and tree mutations in
   * the same repo), optionally describe the current change, create a new
   * descendant change, and advance bookmarks onto that descendant. Requires the
   * current checkout to be on a bookmark. Omit `message` to preserve the
   * existing description; pass a string (including `''`) to overwrite. Returns
   * both the saved (described) change and the now-active descendant.
   */
  checkpoint: (args: { repo: string; message?: string }) => Promise<CheckpointResult>;
}

/** Sub-object for bookmark management operations on a MesaFileSystem. */
export interface BookmarkOps {
  /** Create a new bookmark on the current commit without switching to it. */
  create(args: BookmarkCreateArgs): Promise<void>;

  /**
   * Move an existing bookmark to point at the specified change. Use this
   * after forking a change through a mount write to publish the forked
   * change back onto the bookmark. Moves must advance history unless
   * `allowBackwards` is true.
   */
  move(args: BookmarkMoveArgs): Promise<void>;

  /** List all bookmark names for a repo. */
  list(args: BookmarkListArgs): Promise<string[]>;
}

export interface TelemetryConfig {
  /** Minimum log level for the onLog callback. Default: "warn". */
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
  /**
   * Per-instance structured log callback. Receives log records from the
   * Rust internals for operations on this filesystem instance.
   */
  onLog?: (record: LogRecord) => void;
}

export interface LogRecord {
  /** Log level: "error", "warn", "info", or "debug". */
  level: string;
  /** Rust module path that emitted the log (e.g. "mesafs_core::mesa_ll"). */
  target: string;
  /** Human-readable log message. */
  message: string;
  /** Timestamp as epoch milliseconds. */
  timestamp: number;
  /** Event fields from the tracing span. */
  fields: Record<string, unknown>;
}

export type MesaBashOptions = Pick<
  BashOptions,
  | 'env'
  | 'cwd'
  | 'executionLimits'
  | 'fetch'
  | 'network'
  | 'python'
  | 'javascript'
  | 'commands'
  | 'customCommands'
  | 'logger'
>;

let nativeModule: NativeModule | null = null;

export type { BranchedRevision, MountRevisionProperties, RevisionIdentifier } from './layout.js';

type RepoConfigBase = {
  name: string;
};

/**
 * Per-repo mount configuration.
 *
 * Open an existing revision with `at`, or fork a new revision at mount time
 * with `branchedFrom` (writable only). Exactly one of `at` or `branchedFrom`
 * may be set. `mode` lives in the union so `branchedFrom` permits only
 * `mode?: "rw"` (default writable); the existing-revision / default arm
 * permits `"rw" | "ro"`.
 */
export type RepoConfig = RepoConfigBase &
  (
    | { at?: RevisionIdentifier; branchedFrom?: never; mode?: 'rw' | 'ro' }
    | { at?: never; branchedFrom?: BranchedRevision; mode?: 'rw' }
  );

/** Preserve the exclusive `at` | `branchedFrom` union when crossing to napi. */
function toNativeRepoConfig(repo: RepoConfig): NativeRepoConfig {
  if (repo.branchedFrom !== undefined) {
    return {
      name: repo.name,
      mode: repo.mode,
      branchedFrom: repo.branchedFrom,
    };
  }
  return {
    name: repo.name,
    mode: repo.mode,
    at: repo.at,
  };
}

export interface MesaFileSystemConfigBase {
  org: string;
  repos: RepoConfig[];
  /** Layout mounted as the complete namespace. */
  layout: Layout;
  cache?: {
    diskCache?: { path: string; maxSizeBytes?: number };
  };
  apiBaseUrl?: string;
  /** Telemetry and logging configuration. */
  telemetry?: TelemetryConfig;
}

/** Bearer access token used for all storage operations. */
export type MesaFileSystemConfig = MesaFileSystemConfigBase & { credential: string };

function getEncoding(
  options?: { encoding?: BufferEncoding | null } | BufferEncoding | null | undefined
): string | undefined {
  if (options === null || options === undefined) return undefined;
  if (typeof options === 'string') return options;
  return options.encoding ?? undefined;
}

// "binary" isn't a real encoding — it's a Node.js/just-bash convention where each
// byte is represented as the corresponding latin1 character (U+0000–U+00FF). We
// intercept it in the TS layer and convert between raw bytes and latin1 strings,
// bypassing the Rust text encoding path. This matches just-bash's fromBuffer/toBuffer:
// https://github.com/vercel-labs/just-bash/blob/main/src/fs/encoding.ts

function isBinaryEncoding(encoding: string | undefined): boolean {
  return encoding === 'binary';
}

function binaryStringToBytes(content: string): Uint8Array {
  return Buffer.from(content, 'latin1');
}

function bytesToBinaryString(content: Uint8Array): string {
  return Buffer.from(content).toString('latin1');
}

function toWatchEvent(event: NativeWatchEvent): WatchEvent {
  return {
    path: event.path,
    recursive: event.recursive,
  };
}

export class MesaFileSystemSubscription {
  private readonly native: NativeMesaFileSystemWatcher;
  private closed = false;

  constructor(native: NativeMesaFileSystemWatcher, handler: WatchEventHandler) {
    this.native = native;
    void this.pump(handler);
  }

  unsubscribe(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    void this.native.close();
  }

  private async pump(handler: WatchEventHandler): Promise<void> {
    try {
      while (!this.closed) {
        const nativeEvent = await this.native.next();
        if (!nativeEvent) {
          this.unsubscribe();
          return;
        }
        await handler(toWatchEvent(nativeEvent));
      }
    } finally {
      this.unsubscribe();
    }
  }
}

/**
 * Mesa-backed implementation of the just-bash IFileSystem interface.
 *
 * Uses native Rust code via NAPI to provide a high-performance filesystem
 * backed by Mesa's cloud storage. The native addon is loaded lazily on the
 * first call to `MesaFileSystem.createAsync()`.
 */
export class MesaFileSystem implements IFileSystem {
  private native: NativeMesaFileSystem;

  private constructor(nativeInstance: NativeMesaFileSystem) {
    this.native = nativeInstance;
  }

  /**
   * Validate a serialized layout document against the core mount schema's
   * structural rules without mounting. Throws the exact error a mount would
   * report for a structurally invalid document. Repository names are not
   * resolved here — a nonexistent repository only fails at mount time.
   */
  static validateLayout(layoutJson: string): void {
    nativeModule ??= loadNativeAddon();
    nativeModule.validateLayout(layoutJson);
  }

  /**
   * @internal Open a filesystem from an already-minted access token.
   *
   * Not part of the public surface: `index.ts` exports this class as a type
   * only. Callers go through `mesa.fs({ layout, authors }).mount()`, which
   * derives the token's scopes from the layout and mints it for the mount.
   * This path instead takes a token minted elsewhere, so its scopes and TTL
   * are the caller's to get right. Neither path can refresh: when the token
   * expires the mount fails closed, and resuming means signing a new token
   * and opening a new filesystem.
   *
   * Rejects with {@link MissingCredentialError} when `credential` is empty and
   * {@link InvalidOptionsError} when it is a private key rather than an access
   * token.
   */
  static async createAsync(config: MesaFileSystemConfig): Promise<MesaFileSystem> {
    const credential = config.credential;
    if (!credential) {
      throw new MissingCredentialError();
    }
    if (looksLikePrivateKey(credential)) {
      throw new InvalidOptionsError('MesaFileSystem requires an access token, not a private key.');
    }

    const { onLog, ...telemetryRest } = config.telemetry ?? {};
    const { credential: _credential, ...rest } = config;
    const napiConfig: NativeConfig = {
      ...rest,
      credential,
      layout: config.layout.toString(),
      telemetry: Object.keys(telemetryRest).length > 0 ? telemetryRest : undefined,
      repos: config.repos.map(toNativeRepoConfig),
    };

    nativeModule ??= loadNativeAddon();
    const nativeInstance = await nativeModule.MesaFileSystem.createAsync(napiConfig);
    // Registered after construction rather than passed into it: the native
    // factory's future must be Send, and a JS function is bound to its thread.
    if (onLog) nativeInstance.setLogCallback(onLog, napiConfig.telemetry?.logLevel);
    return new MesaFileSystem(nativeInstance);
  }

  async readFile(path: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const encoding = getEncoding(options);

    if (isBinaryEncoding(encoding)) {
      return bytesToBinaryString(await this.native.readBytes(path));
    }

    return this.native.readText(path, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.native.readBytes(path);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: { encoding?: BufferEncoding } | BufferEncoding
  ): Promise<void> {
    const encoding = getEncoding(options);

    if (typeof content === 'string') {
      if (isBinaryEncoding(encoding)) {
        return this.native.writeBytes(path, binaryStringToBytes(content));
      }

      return this.native.writeText(path, content, encoding);
    }

    return this.native.writeBytes(path, content);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: { encoding?: BufferEncoding } | BufferEncoding
  ): Promise<void> {
    const encoding = getEncoding(options);

    if (typeof content === 'string') {
      if (isBinaryEncoding(encoding)) {
        return this.native.appendBytes(path, binaryStringToBytes(content));
      }

      return this.native.appendText(path, content, encoding);
    }

    return this.native.appendBytes(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.native.exists(path);
  }

  async stat(path: string): Promise<FsStat> {
    const s = await this.native.stat(path);
    return {
      ...s,
      mtime: new Date(s.mtime),
    };
  }

  async lstat(path: string): Promise<FsStat> {
    const s = await this.native.lstat(path);
    return {
      ...s,
      mtime: new Date(s.mtime),
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.native.mkdir(path, options?.recursive);
  }

  async readdir(path: string): Promise<string[]> {
    return this.native.readdir(path);
  }

  async readdirWithFileTypes(path: string): Promise<
    Array<{
      name: string;
      isFile: boolean;
      isDirectory: boolean;
      isSymbolicLink: boolean;
    }>
  > {
    return this.native.readdirWithFileTypes(path);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    return this.native.rm(path, options?.recursive, options?.force);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    return this.native.cp(src, dest, options?.recursive);
  }

  async mv(src: string, dest: string): Promise<void> {
    return this.native.mv(src, dest);
  }

  resolvePath(base: string, path: string): string {
    return this.native.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.native.getAllPaths();
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.native.chmod(path, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    return this.native.symlink(target, linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    return this.native.link(existingPath, newPath);
  }

  async readlink(path: string): Promise<string> {
    return this.native.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    return this.native.realpath(path);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.native.utimes(path, atime.getTime(), mtime.getTime());
  }

  /**
   * Apply metadata changes to `path` (merge semantics). A non-null string sets
   * the key; `null` or an empty string (`""`) deletes it. Keys absent from
   * `entries` are left untouched. A single call may mix sets and deletes; they
   * apply atomically. Naming a reserved key (`org`/`repo`) errors.
   */
  async setMetadata(path: string, entries: Record<string, string | null>): Promise<void> {
    return this.native.setMetadata(path, entries);
  }

  async getMetadata(path: string): Promise<Record<string, string>> {
    return this.native.getMetadata(path);
  }

  /**
   * Remove all metadata on `path` in one shot. Idempotent: clearing a path
   * with no metadata is a no-op. The read-only synthetic `org`/`repo` keys are
   * computed, not stored, so they survive a clear.
   */
  async clearMetadata(path: string): Promise<void> {
    return this.native.clearMetadata(path);
  }

  subscribe(handler: WatchEventHandler): MesaFileSystemSubscription {
    return new MesaFileSystemSubscription(this.native.watch(), handler);
  }

  /** Change management operations (new, edit, list, current, checkpoint). */
  readonly change: ChangeOps = {
    new: async (args: ChangeNewArgs): Promise<ChangeResult> => {
      return this.native.newChange(args.repo, args.bookmark, args.changeId, args.message);
    },
    edit: async (args: ChangeEditArgs): Promise<ChangeResult> => {
      return this.native.editChange(args.repo, args.bookmark, args.changeId);
    },
    list: async (args: ChangeListArgs): Promise<ChangeInfo[]> => {
      return this.native.listChanges(args.repo, args.limit);
    },
    current: async (args: { repo: string }): Promise<ChangeInfo> => {
      return this.native.currentChange(args.repo);
    },
    checkpoint: async (args: { repo: string; message?: string }): Promise<CheckpointResult> => {
      return this.native.checkpoint(args.repo, args.message);
    },
  };

  /** Bookmark management operations (create, move, list). */
  readonly bookmark: BookmarkOps = {
    create: async (args: BookmarkCreateArgs): Promise<void> => {
      return this.native.createBookmark(args.repo, args.name);
    },
    move: async (args: BookmarkMoveArgs): Promise<void> => {
      return this.native.moveBookmark(args.repo, args.name, args.changeId, args.allowBackwards);
    },
    list: async (args: BookmarkListArgs): Promise<string[]> => {
      return this.native.listBookmarks(args.repo);
    },
  };

  bash(options?: MesaBashOptions): Bash {
    return new Bash({ ...options, cwd: options?.cwd ?? '/', fs: this });
  }
}
