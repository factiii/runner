/** The mark that covers a folder — its own or an ancestor's — or null. */
export const skipCovering = (marks: string[], folder: string): string | null =>
  marks.find((mark) => folder === mark || folder.startsWith(`${mark}/`)) ??
  null;
