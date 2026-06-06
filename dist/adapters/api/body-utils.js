export function normalizeJsonRawBody(rawBody) {
    return stripStandaloneBackslashLines(rawBody);
}
function stripStandaloneBackslashLines(value) {
    return value
        .split(/\r?\n/)
        .filter((line) => !/^\s*\\\s*$/.test(line))
        .join("\n");
}
