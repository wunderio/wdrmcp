import { z } from "zod";

export const ValidationRuleSchema = z
  .object({
    pattern: z.string(),
    message: z.string().optional(),
    field: z.string().optional(),
  })
  .strict();

export const JsonSchemaPropertySchema: z.ZodType = z.lazy(() =>
  z
    .object({
      type: z.string(),
      description: z.string().optional(),
      enum: z.array(z.string()).optional(),
      default: z.unknown().optional(),
      items: z.lazy(() => JsonSchemaPropertySchema).optional(),
    })
    .strict(),
);

export const JsonSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      type: z.string(),
      properties: z.record(JsonSchemaPropertySchema).optional(),
      required: z.array(z.string()).optional(),
    })
    .strict(),
);
