import { z } from "zod";
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from "./constants";

/**
 * Server-side validation of the upload metadata the client sends before we
 * mint a signed upload URL. The actual bytes are validated again by the
 * Storage bucket (mime + 50MB limit) as defense-in-depth.
 */
export const uploadMetadataSchema = z.object({
  filename: z
    .string()
    .min(1, "Filename is required")
    .max(255, "Filename is too long")
    .refine((n) => n.toLowerCase().endsWith(".pdf"), "Only PDF files are allowed"),
  size: z
    .number({ message: "File size is required" })
    .int()
    .positive("File is empty")
    .max(MAX_FILE_SIZE_BYTES, `File exceeds the ${MAX_FILE_SIZE_MB}MB limit`),
  contentType: z.literal("application/pdf", {
    message: "Only PDF files are allowed",
  }),
});

export type UploadMetadata = z.infer<typeof uploadMetadataSchema>;
