import { deleteDocument } from "@/app/(app)/documents/actions";
import type { DocumentRow, DocumentStatus } from "@/types/documents";

const STATUS_STYLES: Record<DocumentStatus, string> = {
  pending: "bg-neutral-100 text-neutral-600",
  processing: "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
};

function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

export function DocumentList({ documents }: { documents: DocumentRow[] }) {
  if (documents.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500">
        No documents yet. Upload a PDF to get started.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
      {documents.map((doc) => (
        <li key={doc.id} className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-neutral-900">
              {doc.title}
            </p>
            <p className="mt-0.5 text-xs text-neutral-500">
              {doc.file_size
                ? `${(doc.file_size / 1024 / 1024).toFixed(1)} MB · `
                : ""}
              {new Date(doc.created_at).toLocaleDateString()}
              {doc.status === "failed" && doc.error ? ` · ${doc.error}` : ""}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <StatusBadge status={doc.status} />
            {/* Inline Server Action — works without JS (progressive enhancement). */}
            <form
              action={async () => {
                "use server";
                await deleteDocument(doc.id);
              }}
            >
              <button
                type="submit"
                className="text-xs font-medium text-red-600 hover:underline"
              >
                Delete
              </button>
            </form>
          </div>
        </li>
      ))}
    </ul>
  );
}
