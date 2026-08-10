export type RepoTagEqFilter = {
  $eq: string;
  $in?: never;
  $contains?: never;
  $starts_with?: never;
  $ends_with?: never;
  $exists?: never;
};

export type RepoTagInFilter = {
  $eq?: never;
  $in: string[];
  $contains?: never;
  $starts_with?: never;
  $ends_with?: never;
  $exists?: never;
};

export type RepoTagContainsFilter = {
  $eq?: never;
  $in?: never;
  $contains: string;
  $starts_with?: never;
  $ends_with?: never;
  $exists?: never;
};

export type RepoTagStartsWithFilter = {
  $eq?: never;
  $in?: never;
  $contains?: never;
  $starts_with: string;
  $ends_with?: never;
  $exists?: never;
};

export type RepoTagEndsWithFilter = {
  $eq?: never;
  $in?: never;
  $contains?: never;
  $starts_with?: never;
  $ends_with: string;
  $exists?: never;
};

export type RepoTagExistsFilter = {
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

export function serializeRepoTagsFilter(tags: RepoTagFilter | string | undefined): string | undefined {
  if (tags === undefined) return tags;
  return typeof tags === 'string' ? tags : JSON.stringify(tags);
}
