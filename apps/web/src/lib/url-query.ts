/** Append a query fragment without corrupting an existing query string. */
export function appendResourceQuery(path: string, query: string): string {
  if (!query) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${query.replace(/^[?&]+/, '')}`;
}
