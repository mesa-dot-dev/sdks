import { MesaApiError } from '../lib/errors.js';

type ApiErrorBody = {
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object';
};

const stringifyErrorValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getErrorBody = (error: unknown): unknown => {
  if (isRecord(error) && 'body' in error) {
    return error.body;
  }

  return error;
};

const getApiErrorField = (body: unknown, error: unknown, field: 'code' | 'message'): unknown => {
  if (isRecord(body)) {
    const errorBody = (body as ApiErrorBody).error;
    if (isRecord(errorBody) && errorBody[field] !== undefined) {
      return errorBody[field];
    }

    if (body[field] !== undefined) {
      return body[field];
    }
  }

  if (isRecord(error) && error[field] !== undefined) {
    return error[field];
  }

  return undefined;
};

const getApiErrorStatus = (error: unknown, response?: Response): number | undefined => {
  if (response) {
    return response.status;
  }

  if (isRecord(error) && typeof error.status === 'number') {
    return error.status;
  }

  return undefined;
};

export const normalizeApiError = (error: unknown, response?: Response): Error => {
  const body = getErrorBody(error);
  const codeValue = getApiErrorField(body, error, 'code');
  const messageValue = getApiErrorField(body, error, 'message');
  const code = typeof codeValue === 'string' && codeValue.length > 0 ? codeValue : undefined;
  const message =
    typeof messageValue === 'string' && messageValue.length > 0
      ? messageValue
      : error instanceof Error && error.message !== '[object Object]'
        ? error.message
        : stringifyErrorValue(error) || 'API request failed';

  if (error instanceof Error && !code && body === error) {
    return error;
  }

  return new MesaApiError({
    body,
    cause: error,
    code,
    headers: response?.headers,
    message,
    status: getApiErrorStatus(error, response),
  });
};
