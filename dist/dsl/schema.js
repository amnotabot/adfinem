import { z } from "zod";
const value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const catalogParamType = z.enum(["string", "number", "boolean", "string[]", "number[]", "boolean[]"]);
const apiMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const apiBodyMode = z.enum(["none", "json", "raw", "formdata", "urlencoded"]);
const apiRequestSpecSchema = z.object({
    method: apiMethod.optional(),
    path: z.string().optional(),
    headers: z.record(z.string()).optional(),
    query: z.record(z.unknown()).optional(),
    body: z.unknown().optional(),
    rawBody: z.string().optional(),
    bodyMode: apiBodyMode.optional(),
    auth: z.unknown().optional(),
    acceptStatuses: z.array(z.number().int().min(100).max(599)).optional()
}).strict();
const apiAssertionSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("status"),
        operator: z.enum(["in", "="]).optional(),
        value: z.union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599))])
    }).strict(),
    z.object({ type: z.literal("jsonpath_exists"), path: z.string().min(1) }).strict(),
    z.object({ type: z.literal("jsonpath_equals"), path: z.string().min(1), value: z.unknown() }).strict(),
    z.object({ type: z.literal("jsonpath_contains"), path: z.string().min(1), value: z.unknown() }).strict(),
    z.object({ type: z.literal("header_exists"), header: z.string().min(1) }).strict(),
    z.object({ type: z.literal("header_equals"), header: z.string().min(1), value: z.string() }).strict(),
    z.object({ type: z.literal("body_contains"), value: z.string() }).strict(),
    z.object({ type: z.literal("body_not_contains"), value: z.string() }).strict()
]);
const expectedOutcomeSchema = z.enum(["positive", "negative", "setup", "teardown"]);
const parallelJoinModeSchema = z.enum(["all", "any", "fail_fast"]);
const loopDateFormatSchema = z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"]);
const loopDateCursorSchema = z.object({
    outputName: z.string().min(1).optional(),
    start: z.string().min(1).optional(),
    inputFormat: loopDateFormatSchema.optional(),
    outputFormat: loopDateFormatSchema.optional(),
    advance: z.object({
        mode: z.enum(["days", "months", "nth_day_of_month", "first_of_month", "end_of_month"]),
        amount: z.number().int().positive().optional(),
        day: z.number().int().min(1).max(31).optional()
    }).strict().optional()
}).strict();
const loopSpecSchema = z.object({
    mode: z.enum(["count", "foreach"]),
    count: z.union([z.number().int().nonnegative(), z.string()]).optional(),
    items: z.unknown().optional(),
    itemName: z.string().min(1).optional(),
    maxIterations: z.number().int().positive().optional(),
    dateCursor: loopDateCursorSchema.optional()
}).strict();
const catalogParamSchema = z.object({
    required: z.boolean().optional(),
    type: catalogParamType.optional(),
    pattern: z.string().optional(),
    luhn: z.boolean().optional()
}).strict();
const batchInputFileSchema = z.object({
    name: z.string().min(1),
    required: z.boolean().optional(),
    remotePath: z.string().min(1).optional(),
    paramName: z.string().min(1).optional(),
    appendAsArg: z.boolean().optional()
}).strict();
const batchOutputFileSchema = z.object({
    name: z.string().min(1),
    required: z.boolean().optional(),
    source: z.enum(["stdout", "stderr", "both", "explicit"]).optional(),
    pathPattern: z.string().min(1).optional(),
    remotePath: z.string().min(1).optional(),
    download: z.boolean().optional(),
    decrypt: z.object({
        command: z.string().min(1).optional(),
        outputRemotePath: z.string().min(1).optional(),
        required: z.boolean().optional()
    }).strict().optional()
}).strict();
export const scenarioStepSchema = z.lazy(() => z.object({
    id: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/),
    action: z.string().min(1),
    via: z.string().optional(),
    retry: z.object({
        attempts: z.number().int().positive().optional(),
        delaySeconds: z.number().nonnegative().optional()
    }).strict().optional(),
    input: z.record(z.unknown()).optional(),
    params: z.record(z.unknown()).optional(),
    query: z.string().optional(),
    batch: z.string().optional(),
    request: apiRequestSpecSchema.optional(),
    assertions: z.array(apiAssertionSchema).optional(),
    capture: z.record(z.string()).optional(),
    continueOnFailure: z.boolean().optional(),
    expectedOutcome: expectedOutcomeSchema.optional(),
    captureOnFailure: z.boolean().optional(),
    control: z.enum(["parallel", "loop"]).optional(),
    branches: z.array(z.object({
        id: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/),
        label: z.string().min(1).optional(),
        steps: z.array(scenarioStepSchema)
    }).strict()).optional(),
    steps: z.array(scenarioStepSchema).optional(),
    loop: loopSpecSchema.optional(),
    join: parallelJoinModeSchema.optional()
}).strict());
export const scenarioSchema = z.object({
    id: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/),
    environment: z.string().min(1),
    tenant: z.record(z.string()).optional(),
    variables: z.record(z.union([value, z.array(value), z.record(value)])).optional(),
    steps: z.array(scenarioStepSchema).min(1)
}).strict();
export const queryCatalogSchema = z.record(z.object({
    description: z.string().optional(),
    mode: z.enum(["query", "execute"]).optional(),
    sql: z.string().min(1),
    params: z.record(catalogParamSchema).optional(),
    expect: z.object({
        type: z.enum(["number", "string", "boolean", "rowCount"]),
        column: z.string().optional(),
        operator: z.enum(["=", "!=", ">", ">=", "<", "<=", "contains"]),
        value: z.unknown()
    }).strict()
        .refine((expect) => expect.type === "rowCount" || Boolean(expect.column), {
        message: "expect.column is required when expect.type is not rowCount."
    })
        .optional(),
    captures: z.record(z.string()).optional(),
    maxRows: z.number().int().positive().optional()
}).strict());
export const batchCatalogSchema = z.record(z.object({
    description: z.string().optional(),
    hostRef: z.string().min(1),
    command: z.string().min(1).refine((value) => !/[\r\n]/.test(value), {
        message: "command must be a single executable token; put arguments in fixedArgs."
    }),
    fixedArgs: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    workingDirectory: z.string().min(1).optional(),
    useWorkingDirectory: z.boolean().optional(),
    environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.union([z.string(), z.number(), z.boolean()])).optional(),
    args: z.array(z.object({
        name: z.string().min(1),
        required: z.boolean().optional(),
        type: catalogParamType.optional(),
        pattern: z.string().optional(),
        luhn: z.boolean().optional()
    }).strict()).optional(),
    inputFiles: z.array(batchInputFileSchema).optional(),
    outputFiles: z.array(batchOutputFileSchema).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    success: z.object({
        exitCodes: z.array(z.number().int()).optional(),
        requiredOutput: z.array(z.string()).optional()
    }).strict().optional(),
    captures: z.record(z.string()).optional()
}).strict());
export const apiOperationsCatalogSchema = z.record(z.object({
    description: z.string().optional(),
    type: z.enum(["rest", "soap"]),
    method: apiMethod.optional(),
    path: z.string().optional(),
    headers: z.record(z.string()).optional(),
    query: z.record(z.unknown()).optional(),
    body: z.unknown().optional(),
    rawBody: z.string().optional(),
    bodyMode: apiBodyMode.optional(),
    auth: z.unknown().optional(),
    params: z.record(catalogParamSchema).optional(),
    assertions: z.array(apiAssertionSchema).optional(),
    requestTemplate: z.string().optional(),
    captures: z.record(z.string()).optional(),
    acceptStatuses: z.array(z.number().int().min(100).max(599)).optional(),
    idempotent: z.boolean().optional(),
    source: z.object({
        collectionId: z.string().optional(),
        collectionName: z.string().optional(),
        requestId: z.string().optional(),
        folderPath: z.array(z.string()).optional()
    }).strict().optional()
}).strict());
export { apiRequestSpecSchema, apiAssertionSchema };
