import { types } from 'node:util';

export type MesaErrorCode =
  | 'INVALID_API_URL'
  | 'INVALID_OPTIONS'
  | 'MISSING_ACCESS_TOKEN'
  | 'MISSING_PRIVATE_KEY'
  | 'MISSING_WEBHOOK_SECRET'
  | 'ORG_RESOLUTION_FAILED'
  | 'WEBHOOK_VERIFICATION_FAILED';

export class MesaError extends Error {
  readonly code: MesaErrorCode;

  constructor(code: MesaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MesaError';
    this.code = code;
  }
}

export type MesaApiErrorOptions = {
  body?: unknown;
  cause?: unknown;
  code?: string;
  headers?: Headers;
  message: string;
  status?: number;
};

export class MesaApiError extends Error {
  readonly body?: unknown;
  readonly code?: string;
  readonly headers?: Headers;
  readonly status?: number;

  constructor({ body, cause, code, headers, message, status }: MesaApiErrorOptions) {
    super(code ? `${code}: ${message}` : message, { cause });
    this.name = 'MesaApiError';
    this.body = body;
    this.code = code;
    this.headers = headers;
    this.status = status;
  }
}

export class MissingPrivateKeyError extends MesaError {
  constructor(message = 'Missing private key.') {
    super('MISSING_PRIVATE_KEY', message);
    this.name = 'MissingPrivateKeyError';
  }
}

export class MissingAccessTokenError extends MesaError {
  constructor(message = 'Missing access token.') {
    super('MISSING_ACCESS_TOKEN', message);
    this.name = 'MissingAccessTokenError';
  }
}

export class InvalidApiUrlError extends MesaError {
  constructor(apiUrl: string) {
    super('INVALID_API_URL', `Invalid API URL: ${apiUrl}`);
    this.name = 'InvalidApiUrlError';
  }
}

export class InvalidOptionsError extends MesaError {
  constructor(message: string) {
    super('INVALID_OPTIONS', message);
    this.name = 'InvalidOptionsError';
  }
}

export class OrgResolutionError extends MesaError {
  constructor(message: string, options?: ErrorOptions) {
    super('ORG_RESOLUTION_FAILED', message, options);
    this.name = 'OrgResolutionError';
  }
}

export class MesaWebhookVerificationError extends MesaError {
  constructor(message: string, options?: ErrorOptions) {
    super('WEBHOOK_VERIFICATION_FAILED', message, options);
    this.name = 'MesaWebhookVerificationError';
  }
}

export class MissingWebhookSecretError extends MesaError {
  constructor() {
    super('MISSING_WEBHOOK_SECRET', 'Missing webhook secret. Pass `webhookSecret` to the Mesa constructor.');
    this.name = 'MissingWebhookSecretError';
  }
}

/**
 * How a caller should react to a failed filesystem operation. The same three
 * classes drive the `mesa` CLI's exit codes and the Python SDK's
 * `error_class`.
 */
export type MesaFileSystemErrorClass = 'transient' | 'bad-input' | 'fatal';

/** A failure from the native filesystem, classified. */
export class MesaFileSystemError extends Error {
  readonly errorClass: MesaFileSystemErrorClass;
  readonly code: string | undefined;

  constructor(errorClass: MesaFileSystemErrorClass, message: string, options?: ErrorOptions & { code?: string }) {
    super(message, options);
    this.name = 'MesaFileSystemError';
    this.errorClass = errorClass;
    this.code = options?.code;
  }
}

/** The same filesystem operation may succeed on retry. */
export class MesaTransientError extends MesaFileSystemError {
  constructor(message: string, options?: ErrorOptions & { code?: string }) {
    super('transient', message, options);
    this.name = 'MesaTransientError';
  }
}

/** Arguments, credentials, or state must change before retrying. */
export class MesaBadInputError extends MesaFileSystemError {
  constructor(message: string, options?: ErrorOptions & { code?: string }) {
    super('bad-input', message, options);
    this.name = 'MesaBadInputError';
  }
}

/** A Mesa bug or a failure the caller cannot fix; report it. */
export class MesaFatalError extends MesaFileSystemError {
  constructor(message: string, options?: ErrorOptions & { code?: string }) {
    super('fatal', message, options);
    this.name = 'MesaFatalError';
  }
}

const FILESYSTEM_ERROR_TYPES = {
  transient: MesaTransientError,
  'bad-input': MesaBadInputError,
  fatal: MesaFatalError,
};

const NATIVE_ARGUMENT_ERROR_CODES = new Set([
  'InvalidArg',
  'ObjectExpected',
  'StringExpected',
  'NameExpected',
  'FunctionExpected',
  'NumberExpected',
  'BooleanExpected',
  'ArrayExpected',
  'BigintExpected',
  'DateExpected',
  'ArrayBufferExpected',
  'DetachableArraybufferExpected',
]);

/**
 * Turn the native addon's structured error into a {@link MesaFileSystemError}.
 * Errors from other sources pass through unchanged.
 */
export function classifyNativeError(error: unknown): unknown {
  // The addon's errors belong to Node's main realm, so `instanceof Error` is
  // false when the SDK runs in a vm realm such as Jest's or vitest's vmThreads.
  if (!types.isNativeError(error) || error instanceof MesaFileSystemError) return error;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  // NAPI validates argument types before entering Rust, so those rejections
  // carry argument status codes but never reach our structured conversion.
  const errorClass =
    'errorClass' in error ? error.errorClass : code && NATIVE_ARGUMENT_ERROR_CODES.has(code) ? 'bad-input' : undefined;
  if (errorClass !== 'transient' && errorClass !== 'bad-input' && errorClass !== 'fatal') return error;
  return new FILESYSTEM_ERROR_TYPES[errorClass](error.message, {
    cause: error,
    code,
  });
}
