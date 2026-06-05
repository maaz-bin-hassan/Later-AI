/** Shared upload constraints — imported by both client and server validation. */
export const DOCUMENTS_BUCKET = "documents";

export const MAX_FILE_SIZE_MB = 50;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export const ACCEPTED_MIME_TYPES = ["application/pdf"] as const;
export const ACCEPTED_EXTENSIONS = [".pdf"] as const;

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number];
