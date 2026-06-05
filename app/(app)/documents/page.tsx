import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UploadDropzone } from "@/components/upload-dropzone";
import { DocumentList } from "@/components/document-list";
import type { DocumentRow } from "@/types/documents";

// Always reflect the latest documents/status.
export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Middleware already gates this, but never trust a single layer.
  if (!user) redirect("/login");

  const { data: documents } = await supabase
    .from("documents")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-neutral-900">Documents</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Upload PDFs to make them searchable in chat.
        </p>
      </header>

      <section className="mb-8">
        <UploadDropzone />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-neutral-700">
          Your documents
        </h2>
        <DocumentList documents={(documents as DocumentRow[]) ?? []} />
      </section>
    </main>
  );
}
