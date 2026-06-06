export function normalizeJsonRawBody(rawBody: string): string {
  return stripStandaloneBackslashLines(rawBody);
}

function stripStandaloneBackslashLines(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^\s*\\\s*$/.test(line))
    .join("\n");
}
