export function batchInputFiles(entry) {
    return entry?.inputFiles ?? [];
}
export function batchInputFileParamNames(entry) {
    return batchInputFiles(entry).flatMap((file) => {
        const names = [file.name];
        if (file.paramName && file.paramName !== file.name)
            names.push(file.paramName);
        return names;
    });
}
export function batchFileBackedArgNames(entry) {
    return new Set(batchInputFiles(entry).map((file) => file.paramName || file.name));
}
export function isBatchInputFileValue(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function hasBatchInputFilePayload(value) {
    if (typeof value === "string")
        return value.trim().length > 0;
    if (!isBatchInputFileValue(value))
        return false;
    return Boolean(value.localPath || value.contentBase64);
}
export function batchArgParamsForValidation(params, entry) {
    const next = { ...params };
    for (const file of batchInputFiles(entry)) {
        const value = params[file.name];
        if (!hasBatchInputFilePayload(value))
            continue;
        next[file.paramName || file.name] = isBatchInputFileValue(value)
            ? value.remotePath || file.remotePath || "__uploaded_input_file__"
            : file.remotePath || "__uploaded_input_file__";
    }
    return next;
}
