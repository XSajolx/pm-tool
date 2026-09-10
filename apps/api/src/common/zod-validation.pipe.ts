import { BadRequestException, type ArgumentMetadata, type PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

/** Validates the request BODY against a Zod schema; 400 with field errors on failure.
 *  Applied at method level, so it must ignore non-body args (headers, params). */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type !== "body") return value;
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "Validation failed",
        errors: result.error.flatten().fieldErrors,
      });
    }
    return result.data;
  }
}
