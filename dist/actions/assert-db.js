export async function assertDb(oracle, entry, params) {
    return await oracle.assert(entry, params);
}
