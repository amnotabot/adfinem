import { z } from "zod";
import { apiAssertionSchema, apiRequestSpecSchema } from "../dsl/schema.js";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  scalar,
  z.array(jsonValue),
  z.record(jsonValue)
]));

const id = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);
const mappingObject = z.record(jsonValue);
const captureObject = z.record(z.string().min(1));
const environmentInputSetSchema = z.object({
  variables: mappingObject.optional(),
  nodes: z.record(mappingObject).optional()
}).strict();

const retrySchema = z.object({
  attempts: z.number().int().positive().optional(),
  delaySeconds: z.number().nonnegative().optional()
}).strict();
const expectedOutcomeSchema = z.enum(["positive", "negative", "setup", "teardown"]);
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
  items: jsonValue.optional(),
  itemName: z.string().min(1).optional(),
  maxIterations: z.number().int().positive().optional(),
  dateCursor: loopDateCursorSchema.optional()
}).strict();
const parallelJoinModeSchema = z.enum(["all", "any", "fail_fast"]);

const actionBase = {
  id,
  label: z.string().min(1).optional(),
  input: mappingObject.optional(),
  params: mappingObject.optional(),
  request: apiRequestSpecSchema.optional(),
  assertions: z.array(apiAssertionSchema).optional(),
  capture: captureObject.optional(),
  continueOnFailure: z.boolean().optional(),
  expectedOutcome: expectedOutcomeSchema.optional(),
  captureOnFailure: z.boolean().optional(),
  disabled: z.boolean().optional(),
  section: z.string().min(1).optional()
};

export const flowDbQueryNodeSchema = z.object({
  ...actionBase,
  type: z.literal("db_query"),
  query: z.string().min(1)
}).strict();

export const flowDbAssertNodeSchema = z.object({
  ...actionBase,
  type: z.literal("db_assert"),
  query: z.string().min(1)
}).strict();

export const flowDbExecuteNodeSchema = z.object({
  ...actionBase,
  type: z.literal("db_execute"),
  query: z.string().min(1)
}).strict();

export const flowUnixBatchNodeSchema = z.object({
  ...actionBase,
  type: z.literal("unix_batch"),
  batch: z.string().min(1),
  retry: retrySchema.optional()
}).strict();

export const flowActionNodeSchema = z.discriminatedUnion("type", [
  flowDbQueryNodeSchema,
  flowDbAssertNodeSchema,
  flowDbExecuteNodeSchema,
  flowUnixBatchNodeSchema
]);

export const flowApiOperationNodeSchema = z.object({
  id,
  label: z.string().min(1).optional(),
  type: z.literal("api_operation"),
  operation: z.string().min(1),
  input: mappingObject.optional(),
  params: mappingObject.optional(),
  request: apiRequestSpecSchema.optional(),
  assertions: z.array(apiAssertionSchema).optional(),
  capture: captureObject.optional(),
  continueOnFailure: z.boolean().optional(),
  expectedOutcome: expectedOutcomeSchema.optional(),
  captureOnFailure: z.boolean().optional(),
  disabled: z.boolean().optional(),
  section: z.string().min(1).optional(),
  postActions: z.array(flowActionNodeSchema).optional()
}).strict();

export const flowNodeSchema: z.ZodType<unknown> = z.lazy(() => z.discriminatedUnion("type", [
  flowApiOperationNodeSchema,
  flowDbQueryNodeSchema,
  flowDbAssertNodeSchema,
  flowDbExecuteNodeSchema,
  flowUnixBatchNodeSchema,
  z.object({
    ...actionBase,
    type: z.literal("parallel"),
    branches: z.array(z.object({
      id,
      label: z.string().min(1).optional(),
      nodes: z.array(flowNodeSchema)
    }).strict()).min(1),
    join: parallelJoinModeSchema.optional()
  }).strict(),
  z.object({
    ...actionBase,
    type: z.literal("loop"),
    loop: loopSpecSchema,
    nodes: z.array(flowNodeSchema).min(1)
  }).strict()
]));

export const flowFileSchema = z.object({
  version: z.literal(1),
  id,
  name: z.string().min(1).optional(),
  environment: z.string().min(1),
  variables: mappingObject.optional(),
  environmentInputs: z.record(environmentInputSetSchema).optional(),
  nodes: z.array(flowNodeSchema),
  edges: z.array(z.object({
    from: id,
    to: id
  }).strict()).optional(),
  ui: z.object({
    positions: z.record(z.object({
      x: z.number(),
      y: z.number()
    }).strict()).optional(),
    manualEdges: z.boolean().optional()
  }).strict().optional()
}).strict();
