import { createRequire } from 'node:module';

const NATIVE_PACKAGE_NAME = '@mesadev/mesafs-napi';

export interface NativeTelemetryConfig {
  logLevel?: string;
}

export interface NativeLogRecord {
  level: string;
  target: string;
  message: string;
  timestamp: number;
  fields: Record<string, unknown>;
}

/**
 * Exactly one of `bookmark` or `changeId`.
 * TypeScript exclusive union — analogous to Rust `MountRevTarget`.
 */
export type NativeRevisionIdentifier = { bookmark: string; changeId?: never } | { bookmark?: never; changeId: string };

export interface NativeMountRevisionProperties {
  bookmark?: string;
  describe?: string | null;
}

export type NativeBranchedRevision = NativeRevisionIdentifier & {
  as?: NativeMountRevisionProperties;
};

type NativeRepoConfigBase = {
  name: string;
};

/**
 * Per-repo native mount config. Mirrors SDK {@link RepoConfig}: `at` and
 * `branchedFrom` are mutually exclusive, and `branchedFrom` is writable-only.
 */
export type NativeRepoConfig = NativeRepoConfigBase &
  (
    | { at?: NativeRevisionIdentifier; branchedFrom?: never; mode?: 'rw' | 'ro' }
    | { at?: never; branchedFrom?: NativeBranchedRevision; mode?: 'rw' }
  );

export interface NativeConfig {
  org: string;
  apiKey: string;
  repos: NativeRepoConfig[];
  layout?: string;
  mountedRepos?: string[] | 'all';
  cache?: {
    diskCache?: { path: string; maxSizeBytes?: number };
  };
  apiBaseUrl?: string;
  vcsUrl?: string;
  telemetry?: NativeTelemetryConfig;
}

export interface NativeStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: number;
}

export interface NativeDirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface NativeNewChangeResponse {
  changeOid: string;
}

export interface NativeCheckpointResponse {
  savedChangeOid: string;
  activeChangeOid: string;
}

export interface NativeChangeInfo {
  changeId: string;
  commitOid: string;
}

export interface NativeWatchEvent {
  path: string;
  recursive: boolean;
}

export interface NativeMesaFileSystemWatcher {
  next(): Promise<NativeWatchEvent | null>;
  close(): Promise<void>;
}

export interface NativeMesaFileSystem {
  readText(path: string, encoding?: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, content: string, encoding?: string): Promise<void>;
  writeBytes(path: string, content: Uint8Array): Promise<void>;
  appendText(path: string, content: string, encoding?: string): Promise<void>;
  appendBytes(path: string, content: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<NativeStat>;
  lstat(path: string): Promise<NativeStat>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes(path: string): Promise<NativeDirentEntry[]>;
  rm(path: string, recursive?: boolean, force?: boolean): Promise<void>;
  cp(src: string, dest: string, recursive?: boolean): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  resolvePath(base: string, path: string): string;
  getAllPaths(): string[];
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  utimes(path: string, atime: number, mtime: number): Promise<void>;
  setMetadata(path: string, entries: Record<string, string | null>): Promise<void>;
  getMetadata(path: string): Promise<Record<string, string>>;
  clearMetadata(path: string): Promise<void>;
  watch(): NativeMesaFileSystemWatcher;
  newChange(repo: string, bookmark?: string, changeId?: string, message?: string): Promise<NativeNewChangeResponse>;
  editChange(repo: string, bookmark?: string, changeId?: string): Promise<NativeNewChangeResponse>;
  listChanges(repo: string, limit?: number): Promise<NativeChangeInfo[]>;
  currentChange(repo: string): Promise<NativeChangeInfo>;
  createBookmark(repo: string, name: string): Promise<void>;
  moveBookmark(repo: string, name: string, changeId: string, allowBackwards?: boolean): Promise<void>;
  checkpoint(repo: string, message?: string): Promise<NativeCheckpointResponse>;
  listBookmarks(repo: string): Promise<string[]>;
}

export interface NativeModule {
  MesaFileSystem: new (
    config: NativeConfig,
    onLog?: ((record: NativeLogRecord) => void) | undefined | null
  ) => NativeMesaFileSystem;
  validateLayout: (layoutJson: string) => void;
}

function createMissingNativeAddonError(cause: unknown): Error {
  return new Error(
    `Unable to load mesafs-napi native addon. ` +
      `Build the local native package with pnpm --dir packages/rust/crates/mesafs-napi run build ` +
      `or install ${NATIVE_PACKAGE_NAME}.`,
    { cause }
  );
}

/**
 * Whether a native-addon load failure means the addon is simply absent:
 * either the package itself is not installed, or it resolved but every
 * candidate binary was a module-resolution miss (the local `.node` file is
 * not built and no platform package is installed — napi-rs aggregates those
 * misses under a code-less wrapper error). Any failure with another code in
 * its cause chain (for example a binary that exists but cannot be loaded)
 * is a broken install, not an absent one.
 */
function isAddonAbsentError(error: unknown): boolean {
  let sawModuleNotFound = false;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code === 'MODULE_NOT_FOUND') {
      sawModuleNotFound = true;
    } else if (code !== undefined) {
      return false;
    }
  }
  return sawModuleNotFound;
}

function loadFromEnvPath(require: NodeRequire): NativeModule | null {
  const envPath = process.env.MESA_NAPI_PATH;

  if (!envPath) {
    return null;
  }

  return require(envPath) as NativeModule;
}

function loadInstalledNativeAddon(require: NodeRequire): NativeModule {
  try {
    return require(NATIVE_PACKAGE_NAME) as NativeModule;
  } catch (error) {
    if (!isAddonAbsentError(error)) {
      throw error;
    }
    throw createMissingNativeAddonError(error);
  }
}

export function loadNativeAddon(): NativeModule {
  const require = createRequire(import.meta.url);

  const envAddon = loadFromEnvPath(require);

  if (envAddon) {
    return envAddon;
  }

  return loadInstalledNativeAddon(require);
}
