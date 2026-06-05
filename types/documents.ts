import type { Database } from "@/types/database.types";

export type DocumentRow = Database["public"]["Tables"]["documents"]["Row"];
export type DocumentInsert = Database["public"]["Tables"]["documents"]["Insert"];
export type DocumentStatus = Database["public"]["Enums"]["document_status"];

/** Metadata the client sends to request a signed upload URL. */
export type CreateUploadInput = {
  filename: string;
  size: number;
  contentType: string;
};

/** Result of requesting a signed upload URL. */
export type CreateUploadResult =
  | {
      ok: true;
      documentId: string;
      path: string;
      /** PUT the file bytes here to upload directly to Storage. */
      signedUrl: string;
      token: string;
    }
  | { ok: false; error: string };

/** Generic discriminated result for Server Actions / API routes. */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Per-file UI state in the dropzone. */
export type UploadPhase =
  | "queued"
  | "uploading"
  | "finalizing"
  | "done"
  | "error";

export type UploadItem = {
  id: string;
  file: File;
  progress: number;
  phase: UploadPhase;
  error?: string;
  documentId?: string;
};
