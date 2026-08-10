import { type Options as RestOptions, type WhoamiData, type WhoamiResponse, whoami } from '@mesadev/rest';
import { SDK_VERSION } from '../version.js';
import { normalizeApiError } from './errors.js';

const SDK_USER_AGENT = `mesa-sdk-ts/${SDK_VERSION}`;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type RestDataShape = {
  body?: unknown;
  headers?: unknown;
  path?: unknown;
  query?: unknown;
  url: string;
};

export type RestOperation = (options: never) => Promise<unknown>;

export type RestRequestOptions<TData extends RestDataShape> = Simplify<
  Omit<RestOptions<TData, boolean>, 'baseUrl' | 'fetch' | 'headers' | 'responseStyle' | 'throwOnError'>
>;

export type RestClientConfig = {
  /** Bearer credential, or a local signer that returns one for each request. */
  credential: string | (() => string);
  apiUrl: string;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
};

type RestErrorResponse = {
  error?: unknown;
  response?: Response;
};

export type RestClient = {
  request<TData extends RestDataShape, TResult>(
    operation: RestOperation,
    options?: RestRequestOptions<TData>,
    credentialOverride?: string
  ): Promise<TResult>;
  whoami(): Promise<WhoamiResponse>;
};

export function createRestClient(config: RestClientConfig): RestClient {
  const userAgent = config.userAgent?.trim();
  const defaultHeaders: Record<string, string> = {};

  if (typeof process === 'undefined') {
    defaultHeaders['X-Mesa-User-Agent'] = userAgent ? `${SDK_USER_AGENT} ${userAgent}` : SDK_USER_AGENT;
  } else {
    defaultHeaders['User-Agent'] = userAgent ? `${SDK_USER_AGENT} ${userAgent}` : SDK_USER_AGENT;
  }

  const request = async <TData extends RestDataShape, TResult>(
    operation: RestOperation,
    options: RestRequestOptions<TData> = {} as RestRequestOptions<TData>,
    credentialOverride?: string
  ): Promise<TResult> => {
    const credential =
      credentialOverride ?? (typeof config.credential === 'function' ? config.credential() : config.credential);
    const requestOptions = {
      ...options,
      baseUrl: config.apiUrl,
      fetch: config.fetch,
      headers: { ...defaultHeaders, Authorization: `Bearer ${credential}` },
      responseStyle: 'fields',
      throwOnError: false,
    } as RestOptions<TData, boolean>;

    const response = await (operation as (options: RestOptions<TData, boolean>) => Promise<unknown>)(requestOptions);

    if (response && typeof response === 'object') {
      const typedResponse = response as { data?: TResult } & RestErrorResponse;

      if (typedResponse.error !== undefined) {
        throw normalizeApiError(typedResponse.error, typedResponse.response);
      }

      if ('data' in typedResponse) {
        return typedResponse.data as TResult;
      }
    }

    return response as TResult;
  };

  return {
    request,
    whoami: () => request<WhoamiData, WhoamiResponse>(whoami),
  };
}
