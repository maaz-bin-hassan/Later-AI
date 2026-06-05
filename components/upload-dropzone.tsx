"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ACCEPTED_EXTENSIONS,
  ACCEPTED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_MB,
} from "@/lib/constants";
import {
  createSignedUpload,
  deleteDocument,
  finalizeUpload,
} from "@/app/(app)/documents/actions";
import type { UploadItem } from "@/types/documents";

/** Client-side guard rails (mirrored server-side + at the Storage bucket). */
function validateFile(file: File): string | null {
  const isPdf =
    (ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type) ||
    file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) return "Only PDF files are allowed.";
  if (file.size === 0) return "File is empty.";
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File exceeds the ${MAX_FILE_SIZE_MB}MB limit.`;
  }
  return null;
}

/** PUT the file to the Supabase signed URL, reporting upload progress. */
function putWithProgress(
  signedUrl: string,
  file: File,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/pdf");
    xhr.setRequestHeader("x-upsert", "false");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));

    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

export function UploadDropzone() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);

  const patch = useCallback((id: string, next: Partial<UploadItem>) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...next } : it)),
    );
  }, []);

  const uploadOne = useCallback(
    async (item: UploadItem) => {
      // 1. Reserve a row + signed URL.
      const created = await createSignedUpload({
        filename: item.file.name,
        size: item.file.size,
        contentType: item.file.type || "application/pdf",
      });
      if (!created.ok) {
        patch(item.id, { phase: "error", error: created.error });
        return;
      }
      patch(item.id, { phase: "uploading", documentId: created.documentId });

      // 2. Stream the bytes straight to Storage with progress.
      try {
        await putWithProgress(created.signedUrl, item.file, (pct) =>
          patch(item.id, { progress: pct }),
        );
      } catch (err) {
        // Clean up the orphaned pending row.
        await deleteDocument(created.documentId);
        patch(item.id, {
          phase: "error",
          error: err instanceof Error ? err.message : "Upload failed.",
        });
        return;
      }

      // 3. Confirm + hand off to processing.
      patch(item.id, { phase: "finalizing", progress: 100 });
      const finalized = await finalizeUpload(created.documentId);
      if (!finalized.ok) {
        patch(item.id, { phase: "error", error: finalized.error });
        return;
      }
      patch(item.id, { phase: "done" });
      router.refresh();
    },
    [patch, router],
  );

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList?.length) return;
      const accepted: UploadItem[] = [];

      for (const file of Array.from(fileList)) {
        const error = validateFile(file);
        const id = crypto.randomUUID();
        const base: UploadItem = { id, file, progress: 0, phase: "queued" };
        if (error) {
          accepted.push({ ...base, phase: "error", error });
        } else {
          accepted.push(base);
        }
      }

      setItems((prev) => [...accepted, ...prev]);
      // Kick off uploads for the valid ones.
      accepted
        .filter((it) => it.phase === "queued")
        .forEach((it) => void uploadOne(it));
    },
    [uploadOne],
  );

  return (
    <div className="space-y-4">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragging
            ? "border-blue-500 bg-blue-50"
            : "border-neutral-300 bg-white hover:border-neutral-400"
        }`}
      >
        <p className="text-sm font-medium text-neutral-800">
          Drag &amp; drop PDFs here, or click to browse
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          PDF only · up to {MAX_FILE_SIZE_MB}MB each
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={`${ACCEPTED_EXTENSIONS.join(",")},application/pdf`}
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = ""; // allow re-selecting the same file
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((it) => (
            <li
              key={it.id}
              className="rounded-lg border border-neutral-200 bg-white p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-sm text-neutral-800">
                  {it.file.name}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {(it.file.size / 1024 / 1024).toFixed(1)} MB
                </span>
              </div>

              {it.phase === "error" ? (
                <p className="mt-1 text-xs text-red-600">{it.error}</p>
              ) : (
                <div className="mt-2">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                    <div
                      className={`h-full rounded-full transition-all ${
                        it.phase === "done" ? "bg-green-500" : "bg-blue-500"
                      }`}
                      style={{ width: `${it.progress}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    {it.phase === "uploading" && `Uploading… ${it.progress}%`}
                    {it.phase === "finalizing" && "Finalizing…"}
                    {it.phase === "done" && "Uploaded — queued for processing"}
                    {it.phase === "queued" && "Queued…"}
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
