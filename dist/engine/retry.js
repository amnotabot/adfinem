export async function withTimeout(promise, timeoutMs, label) {
    let timeout;
    const timeoutPromise = new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
