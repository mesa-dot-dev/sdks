type RepoTagEqFilter = {
  $eq: string;
  $in?: never;
  $contains?: never;
  $starts_with?: never;
  $ends_with?: never;
  $exists?: never;
};

type RepoTagInFilter = {
  $eq?: never;
  $in: string[];
  $contains?: never;
  $starts_with?: never;
  $ends_with?: never;
  $exists?: never;
};

type RepoTagContainsFilter = {
  $eq?: never;
  $in?: never;
  $contains: string;
  $starts_with?: never;
  $ends_with?: never;
  $exists?: never;
};

type RepoTagStartsWithFilter = {
  $eq?: never;
  $in?: never;
  $contains?: never;
  $starts_with: string;
  $ends_with?: never;
  $exists?: never;
};

type RepoTagEndsWithFilter = {
  $eq?: never;
  $in?: never;
  $contains?: never;
  $starts_with?: never;
  $ends_with: string;
  $exists?: never;
};

type RepoTagExistsFilter = {
  $eq?: never;
  $in?: never;
  $contains?: never;
  $starts_with?: never;
  $ends_with?: never;
  $exists: boolean;
};

export type RepoTagValueFilter =
  | string
  | string[]
  | RepoTagEqFilter
  | RepoTagInFilter
  | RepoTagContainsFilter
  | RepoTagStartsWithFilter
  | RepoTagEndsWithFilter
  | RepoTagExistsFilter;

// `$`-prefixed logical operators can appear beside arbitrary tag keys in the
// same object, so this type is intentionally permissive. The server parses
// operator names case-insensitively ($and, $AND, ...) and reserves the `$`
// prefix for operators; the types use the canonical lowercase spelling.
// Runtime validation happens on the server; the SDK only serializes
// structured filters for the REST query.
export type RepoTagFilter = {
  $and?: RepoTagFilter[];
  $or?: RepoTagFilter[];
  $not?: RepoTagFilter;
  [tagKey: string]: RepoTagValueFilter | RepoTagFilter | RepoTagFilter[] | undefined;
};

export function serializeRepoTagsFilter(tags: RepoTagFilter | undefined): string | undefined {
  if (tags === undefined) return tags;
  if (typeof tags !== 'object') throw new TypeError('Repository tag filters must be objects');
  return JSON.stringify(tags);
}
