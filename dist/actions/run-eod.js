export async function runBatch(batchRunner, entry, params, options) {
    return await batchRunner.run(entry, params, options);
}
