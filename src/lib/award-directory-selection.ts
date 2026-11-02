import { directoryCategoryMatches, type DirectoryFilterField, type DirectoryFilterInput } from "./award-directory-filters";

export type DirectorySelections = Record<DirectoryFilterField, readonly string[]>;

const fields: readonly DirectoryFilterField[] = ["academicLevels", "disciplines", "citizenship"];

/** Choices within one category are alternatives; separate categories combine. */
export function matchesDirectorySelections(categories: DirectoryFilterInput, selections: DirectorySelections): boolean {
  return fields.every((field) =>
    selections[field].length === 0 || selections[field].some((value) => directoryCategoryMatches(field, categories[field], value)),
  );
}

/** Return a new selection in click order, leaving the caller's state untouched. */
export function toggleDirectorySelection(selected: readonly string[], value: string): string[] {
  return selected.includes(value) ? selected.filter((choice) => choice !== value) : [...selected, value];
}
