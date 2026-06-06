export function buildBatchCommand(entry, params) {
    return buildBatchCommandDetails(entry, params).command;
}
export function buildBatchDisplayCommand(entry, params) {
    return buildBatchCommandDetails(entry, params).displayCommand;
}
export function buildBatchCommandDetails(entry, params, extraArgs = []) {
    const fixedArgs = (entry.fixedArgs ?? []).map((value) => resolvePlaceholders(String(value), params));
    const args = (entry.args ?? []).map((arg) => {
        const hasValue = Object.prototype.hasOwnProperty.call(params, arg.name);
        const value = params[arg.name];
        if (!hasValue || value === undefined || value === null) {
            return undefined;
        }
        if (value === "") {
            if (arg.required === false)
                return undefined;
            throw new Error(`Missing required batch arg '${arg.name}'.`);
        }
        if (arg.pattern && !new RegExp(arg.pattern).test(String(value))) {
            throw new Error(`Batch arg '${arg.name}' does not match ${arg.pattern}.`);
        }
        return resolvePlaceholders(String(value), params);
    }).filter((value) => Boolean(value));
    const appendedArgs = extraArgs.map((value) => resolvePlaceholders(String(value), params));
    const commandTokens = [resolvePlaceholders(entry.command, params), ...fixedArgs, ...args, ...appendedArgs];
    const command = commandTokens.map(shellQuote).join(" ");
    const displayCommand = commandTokens.map(displayToken).join(" ");
    const envEntries = Object.entries(entry.environment ?? {})
        .map(([name, value]) => [name, resolvePlaceholders(String(value), params)]);
    const envPrefix = envEntries
        .map(([name, value]) => `${name}=${shellQuote(value)}`)
        .join(" ");
    const displayEnvPrefix = envEntries
        .map(([name, value]) => `${name}=${displayToken(value)}`)
        .join(" ");
    const commandWithEnv = envPrefix ? `${envPrefix} ${command}` : command;
    const displayCommandWithEnv = displayEnvPrefix ? `${displayEnvPrefix} ${displayCommand}` : displayCommand;
    const workingDirectory = entry.useWorkingDirectory === true
        ? blankToUndefined(entry.workingDirectory ? resolvePlaceholders(entry.workingDirectory, params) : undefined)
        : undefined;
    return {
        command: workingDirectory
            ? `cd ${shellQuote(workingDirectory)} && ${commandWithEnv}`
            : commandWithEnv,
        displayCommand: workingDirectory
            ? `cd ${displayToken(workingDirectory)} && ${displayCommandWithEnv}`
            : displayCommandWithEnv
    };
}
function shellQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function resolvePlaceholders(value, params) {
    return value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_match, name) => {
        const paramValue = params[name];
        if (paramValue !== undefined && paramValue !== null)
            return String(paramValue);
        return process.env[name] ?? "";
    });
}
function displayToken(value) {
    if (value === "")
        return "\"\"";
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value))
        return value;
    return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
function blankToUndefined(value) {
    return value && value.trim() ? value : undefined;
}
