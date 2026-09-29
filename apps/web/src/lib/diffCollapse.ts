export function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  expandedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => !expandedFileKeys.has(fileKey));
}

export function toggleAllDiffFileExpansion(
  fileKeys: ReadonlyArray<string>,
  expandedFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  return areAllDiffFilesCollapsed(fileKeys, expandedFileKeys) ? new Set(fileKeys) : new Set();
}
