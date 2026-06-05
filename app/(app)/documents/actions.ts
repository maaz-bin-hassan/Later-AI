"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { uploadMetadataSchema } from "@/lib/validation";
import { DOCUMENTS_BUCKET } from "@/lib/constants";
import type {
  ActionResult,
  CreateUploadInput,
  CreateUploadResult,
} from "@/types/documents";

/**
 * Step 1 of the upload. Authenticate, validate the metadata, insert a
 * `documents` row (status = 'pending'), and return a signed URL the browser
 * can PUT the bytes to directly. Keeping the bytes off the Server Action
 * avoids the 1–2MB action body limit and lets us stream with progress.
 */
export async function createSignedUpload(
  input: CreateUploadInput,
): Promise<CreateUploadResult> {
  const parsed = uploadMetadataSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid file" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You must be signed in to upload." };

  const { filename, size, contentType } = parsed.data;
  const documentId = crypto.randomUUID();
  // Path MUST start with the user's id — storage RLS enforces this prefix.
  const path = `${user.id}/${documentId}.pdf`;
  const title = filename.replace(/\.pdf$/i, "");

  const { error: insertError } = await supabase.from("documents").insert({
    id: documentId,
    user_id: user.id,
    title,
    filename,
    storage_path: path,
    mime_type: contentType,
    file_size: size,
    status: "pending",
  });
  if (insertError) {
    return { ok: false, error: "Could not save document metadata." };
  }

  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    // Roll back the orphaned metadata row.
    await supabase.from("documents").delete().eq("id", documentId);
    return { ok: false, error: "Could not create an upload URL." };
  }

  return {
    ok: true,
    documentId,
    path,
    signedUrl: data.signedUrl,
    token: data.token,
  };
}

/**
 * Step 2. Called after the browser finishes PUTting the bytes. Confirms the
 * object really landed in Storage, then flips the row to 'processing' to hand
 * off to the ingestion pipeline (parse → chunk → embed — a separate feature).
 */
export async function finalizeUpload(
  documentId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You must be signed in." };

  const { data: doc, error: fetchError } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("id", documentId)
    .eq("user_id", user.id)
    .single();
  if (fetchError || !doc) {
    return { ok: false, error: "Document not found." };
  }

  // Defense-in-depth: verify the file actually exists before marking it ready.
  const folder = doc.storage_path.split("/").slice(0, -1).join("/");
  const name = doc.storage_path.split("/").pop()!;
  const { data: listed } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .list(folder, { search: name });
  const uploaded = listed?.some((f) => f.name === name) ?? false;

  if (!uploaded) {
    await supabase
      .from("documents")
      .update({ status: "failed", error: "Upload did not complete." })
      .eq("id", documentId)
      .eq("user_id", user.id);
    return { ok: false, error: "Upload did not complete." };
  }

  const { error: updateError } = await supabase
    .from("documents")
    // 'processing' = uploaded, awaiting the ingestion worker.
    .update({ status: "processing", error: null })
    .eq("id", documentId)
    .eq("user_id", user.id);
  if (updateError) {
    return { ok: false, error: "Could not update the document status." };
  }

  // TODO (ingestion feature): trigger POST /api/documents/[id]/process here.

  revalidatePath("/documents");
  return { ok: true, data: undefined };
}

/**
 * Delete a document: removes the Storage object and the metadata row
 * (chunks cascade via FK). Also used to clean up after a failed upload.
 */
export async function deleteDocument(
  documentId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You must be signed in." };

  const { data: doc } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("id", documentId)
    .eq("user_id", user.id)
    .single();

  if (doc?.storage_path) {
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([doc.storage_path]);
  }

  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: "Could not delete the document." };

  revalidatePath("/documents");
  return { ok: true, data: undefined };
}
