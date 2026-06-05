# Later AI

A production-quality **RAG SaaS**: upload PDFs, ask questions, get answers grounded in your own documents with inline source citations. Built on Next.js 15, Supabase (Postgres + pgvector + Auth + Storage), and OpenAI.

> 📐 Full system design, schema rationale, API contracts, security & scalability notes, and the phased build plan live in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Stack
Next.js 15 (App Router) · TypeScript · Tailwind · shadcn/ui · Supabase Auth/Storage/Postgres · pgvector (HNSW) · OpenAI embeddings + GPT-4o · Vercel.

## Backend status — provisioned ✅
Supabase project **Later-AI** (`zhweehmmilodlzftrzam`, `ap-south-1`) is live with:
- Tables: `profiles`, `documents`, `document_chunks`, `conversations`, `messages` (citations stored inline as `messages.sources jsonb`)
- `pgvector` + HNSW cosine index on 1536-dim embeddings
- `match_documents()` RPC for RLS-scoped semantic search
- Row Level Security on every table, policies scoped `to authenticated` (advisors pass clean)
- Private `documents` storage bucket with per-user folder isolation

Canonical schema: [`supabase/schema.sql`](supabase/schema.sql). Runnable migrations in [`supabase/migrations/`](supabase/migrations). Types in [`types/database.types.ts`](types/database.types.ts).

## Getting started
The Next.js 15 app is scaffolded (App Router, TypeScript, Tailwind) with the
document-upload feature implemented end to end.

```bash
# 1. Install deps
npm install

# 2. Configure env
cp .env.local.example .env.local
#   → fill in SUPABASE_SERVICE_ROLE_KEY and OPENAI_API_KEY

# 3. Run
npm run dev          # http://localhost:3000/documents
```

> Auth pages (`/login`, `/signup`) are not built yet — middleware redirects
> unauthenticated users to `/login`. Build auth (Phase 1) or create a test user
> in the Supabase dashboard to exercise the upload flow.

### Implemented so far
- **Upload system** — `components/upload-dropzone.tsx`, Server Actions in
  `app/(app)/documents/actions.ts`, REST in `app/api/documents/`, types in
  `types/documents.ts`. Direct-to-Storage signed-URL upload with live progress,
  client + server + bucket-level validation (PDF, 50MB), and RLS isolation.

## Regenerate DB types after schema changes
```bash
supabase gen types typescript --project-id zhweehmmilodlzftrzam > types/database.types.ts
```
