import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uploadMetadataSchema } from "@/lib/validation";
import { DOCUMENTS_BUCKET } from "@/lib/constants";

/**
 * POST /api/documents
 * Body: { filename, size, contentType }
 * Creates a pending document row and returns a signed upload URL.
 * (Same logic as the createSignedUpload Server Action, exposed as REST for
 * non-RSC clients / external callers.)
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = uploadMetadataSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid file" },
      { status: 422 },
    );
  }

  const { filename, size, contentType } = parsed.data;
  const documentId = crypto.randomUUID();
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
    return NextResponse.json(
      { error: "Could not save document metadata" },
      { status: 500 },
    );
  }

  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    await supabase.from("documents").delete().eq("id", documentId);
    return NextResponse.json(
      { error: "Could not create upload URL" },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { documentId, path, signedUrl: data.signedUrl, token: data.token },
    { status: 201 },
  );
}

/**
 * GET /api/documents — list the signed-in user's documents (RLS-scoped).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json(
      { error: "Could not load documents" },
      { status: 500 },
    );
  }

  return NextResponse.json({ documents: data });
}
