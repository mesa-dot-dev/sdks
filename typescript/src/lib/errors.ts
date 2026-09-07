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
