# Later AI — System Architecture & Implementation Plan

A production-quality RAG (Retrieval-Augmented Generation) SaaS. Users upload PDFs, the system chunks + embeds them into pgvector, and a chat interface answers questions grounded in the user's own documents with inline source citations.

**Status:** Supabase project `Later-AI` (ref `zhweehmmilodlzftrzam`, region `ap-south-1`) is provisioned with the full schema, RLS, pgvector, the `match_documents` RPC, and a private `documents` storage bucket. Security advisors pass clean. Next step is the Next.js app.

---

## 1. Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router, RSC, Route Handlers) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS + shadcn/ui |
| Auth | Supabase Auth (`@supabase/ssr` cookie-based sessions) |
| Storage | Supabase Storage (private `documents` bucket) |
| Database | Supabase Postgres 17 + `pgvector` (HNSW) |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dims) |
| Generation | OpenAI `gpt-4o` (Gemini-swappable via the Vercel AI SDK) |
| Streaming/LLM glue | Vercel AI SDK (`ai`, `@ai-sdk/openai`) |
| PDF parsing | `pdf-parse` (or `unpdf` for serverless-friendly parsing) |
| Deployment | Vercel |

---

## 2. System Architecture

### 2.1 High-level flow

```
                          ┌─────────────────────────────────────────────┐
                          │                Vercel (Next.js 15)           │
                          │                                              │
  Browser ───────────────▶  RSC pages + Client components (shadcn/ui)   │
   (cookies:              │  middleware.ts → refresh Supabase session    │
    sb session)           │                                              │
                          │  Route Handlers (/api/*) — server-only       │
                          └───────┬───────────────┬───────────────┬──────┘
                                  │               │               │
                       upload &   │   embed/query │   generate    │
                       signed URL │   (server)    │   (stream)    │
                                  ▼               ▼               ▼
                    ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐
                    │ Supabase Storage │  │  OpenAI API  │  │  OpenAI API  │
                    │  (documents)     │  │  embeddings  │  │  gpt-4o chat │
                    └──────────────────┘  └──────────────┘  └──────────────┘
                                  │               │
                                  ▼               ▼
                    ┌─────────────────────────────────────────┐
                    │       Supabase Postgres + pgvector       │
                    │  profiles, documents, document_chunks,   │
                    │  conversations, messages (sources jsonb)  │
                    │  match_documents() RPC  ·  RLS ON         │
                    └─────────────────────────────────────────┘
```

### 2.2 The two core pipelines

**A. Ingestion pipeline** (write path — triggered after upload)
```
PDF upload → Storage  →  parse text per page  →  chunk (token-aware, overlap)
   →  embed batches (OpenAI)  →  insert document_chunks rows (embedding + page)
   →  update documents.status = 'completed', chunk_count
```
Run as a background job (see §7) so the HTTP request returns immediately. Status is tracked on `documents.status` (`pending → processing → completed | failed`) and surfaced live to the dashboard via Supabase Realtime or polling.

**B. Query pipeline** (read path — per chat turn)
```
user question  →  embed question (OpenAI)
   →  match_documents(query_embedding, threshold, k)   [pgvector ANN, RLS-scoped]
   →  build grounded prompt (top-k chunks + citation tags)
   →  gpt-4o stream answer  →  persist assistant message (citations in sources jsonb)
```

### 2.3 Supabase client topology (`@supabase/ssr`)

Three distinct clients, never mixed:

1. **Browser client** — `createBrowserClient`, uses the publishable/anon key. RLS-enforced. For client components and realtime subscriptions.
2. **Server client** — `createServerClient` bound to the request's cookies. Used in RSC, Server Actions, and Route Handlers. Acts **as the signed-in user**; RLS applies. This is the default for all user-facing reads/writes.
3. **Admin/service client** — `createClient` with the `service_role` key, **server-only**. Bypasses RLS. Used *only* by the ingestion worker to write chunks/update status on behalf of the user (every insert still sets `user_id` explicitly). Never imported into any client bundle.

`middleware.ts` runs `supabase.auth.getUser()` on every request to refresh the session cookie and gate `/dashboard/*` routes.

---

## 3. Database Schema (already applied)

Full DDL lives in [`supabase/migrations/`](supabase/migrations). Summary:

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | 1:1 with `auth.users`, auto-created by trigger | `id`, `email`, `full_name`, `avatar_url` |
| `documents` | One row per uploaded PDF | `user_id`, `title`, `storage_path`, `status`, `page_count`, `chunk_count`, `error` |
| `document_chunks` | Chunk text + embedding | `document_id`, `user_id`, `content`, `chunk_index`, `page_number`, `embedding vector(1536)`, `metadata jsonb` |
| `conversations` | Conversation thread | `user_id`, `title` |
| `messages` | Turn in a conversation | `conversation_id`, `user_id`, `role`, `content`, `sources jsonb` (inline citations) |

**Enums:** `document_status (pending|processing|completed|failed)`, `message_role (user|assistant|system)`.

**Indexes:**
- `document_chunks_embedding_idx` — **HNSW** on `vector_cosine_ops` (ANN search).
- B-tree on every `user_id` FK and on `documents.status` (partial), `messages(conversation_id, created_at)`, `conversations(user_id, updated_at desc)`.

**RPC:** `match_documents(query_embedding, match_threshold=0.3, match_count=6, filter_document_id=null)` — `SECURITY INVOKER` so RLS automatically restricts the search to the caller's own chunks. Returns chunk content + `similarity` + `document_title`.

**RLS:** enabled on all tables; every policy keys on `(select auth.uid()) = user_id`. Storage policies enforce that the first path segment equals the user's UID (`<uid>/<document_id>.pdf`).

### Why these choices
- **1536-dim `text-embedding-3-small`** — strong quality/cost ratio; cheap enough to re-embed at scale.
- **HNSW over IVFFlat** — better recall at low latency and no need to `ANALYZE`/retrain as data grows; ideal for a multi-tenant table that grows continuously.
- **`user_id` denormalized onto `document_chunks`** — lets the HNSW search filter by owner via RLS without a join to `documents`, keeping ANN fast and tenant-isolated.
- **Citations inline as `messages.sources` (jsonb)** — keeps the model to five tables. Promote to a normalized `message_citations` table if you need to query citations directly (e.g. "most-cited document").

---

## 4. Folder Structure

```
later-ai/
├── ARCHITECTURE.md
├── .env.local.example
├── middleware.ts                      # session refresh + route protection
├── supabase/
│   └── migrations/                    # 01..05 SQL, version-controlled
├── types/
│   └── database.types.ts              # generated from the live schema
├── lib/
│   ├── supabase/
│   │   ├── client.ts                  # browser client
│   │   ├── server.ts                  # cookie-bound server client (RLS)
│   │   ├── admin.ts                   # service_role client (server-only)
│   │   └── middleware.ts              # updateSession helper
│   ├── ai/
│   │   ├── embeddings.ts              # embedText / embedBatch (OpenAI)
│   │   ├── chunking.ts                # token-aware splitter w/ overlap
│   │   ├── pdf.ts                     # extract text per page
│   │   └── rag.ts                     # retrieve() + buildPrompt()
│   └── utils.ts                       # cn(), formatting
├── app/
│   ├── layout.tsx
│   ├── page.tsx                       # marketing / landing
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   └── auth/callback/route.ts     # OAuth / magic-link exchange
│   ├── (app)/
│   │   ├── layout.tsx                 # sidebar shell, requires session
│   │   ├── dashboard/page.tsx         # document list + upload + status
│   │   ├── documents/[id]/page.tsx    # doc detail, chunks, delete
│   │   └── chat/
│   │       ├── page.tsx               # new conversation
│   │       └── [conversationId]/page.tsx  # existing thread + history
│   └── api/
│       ├── documents/
│       │   ├── route.ts               # GET list, POST create+signed upload URL
│       │   ├── [id]/route.ts          # GET one, DELETE (cascade chunks+file)
│       │   └── [id]/process/route.ts  # POST kick off ingestion
│       ├── chat/route.ts              # POST: retrieve + stream answer
│       └── conversations/
│           ├── route.ts               # GET list, POST create
│           └── [id]/route.ts          # GET messages, DELETE
├── components/
│   ├── ui/                            # shadcn primitives
│   ├── upload-dropzone.tsx
│   ├── document-card.tsx
│   ├── document-status-badge.tsx
│   ├── chat/
│   │   ├── chat-panel.tsx             # useChat() stream UI
│   │   ├── message.tsx
│   │   └── citation-popover.tsx       # [1] → doc title + page + snippet
│   └── sidebar.tsx
└── package.json
```

---

## 5. API Routes

All handlers run server-side, use the **cookie-bound server client** (RLS on), and return JSON or a stream. The service-role client is used only inside the ingestion step.

| Method & Path | Purpose | Notes |
|---|---|---|
| `POST /api/documents` | Create a `documents` row (`status=pending`) and return a **signed upload URL** for `<uid>/<docId>.pdf` | Client uploads directly to Storage with the signed URL — no large body through the server |
| `POST /api/documents/[id]/process` | Trigger ingestion: parse → chunk → embed → insert | Returns `202`; sets `status=processing`. Idempotent (clears prior chunks) |
| `GET /api/documents` | List the user's documents w/ status | RLS-scoped |
| `GET /api/documents/[id]` | One document + chunk count | |
| `DELETE /api/documents/[id]` | Delete row (cascades chunks) + remove the Storage object | |
| `POST /api/conversations` | Create a conversation | Auto-title from first question later |
| `GET /api/conversations` | List conversations (history sidebar) | ordered by `updated_at` |
| `GET /api/conversations/[id]` | Messages (with inline `sources`) for a thread | |
| `DELETE /api/conversations/[id]` | Delete a thread (cascades messages) | |
| `POST /api/chat` | The RAG turn: embed question → `match_documents` → stream `gpt-4o` → persist user+assistant messages (citations in `messages.sources`) | Streams via Vercel AI SDK `toDataStreamResponse()` |

### `POST /api/chat` contract (the heart of the app)
```jsonc
// Request
{ "conversationId": "uuid", "message": "What is the refund policy?", "documentId": "uuid|null" }

// Behavior
1. authn via server client; 403 if no session
2. insert user message
3. embed the question (OpenAI)
4. supabase.rpc('match_documents', { query_embedding, match_count: 6, filter_document_id })
5. if 0 matches above threshold → answer "I couldn't find this in your documents."
6. build system prompt: instructions + numbered context blocks [1..k] with {title, page}
7. stream gpt-4o; on finish, persist assistant message with the used chunks in `sources` (jsonb)
8. return the stream; citations sent as a data annotation for the UI
```

**Grounding prompt rules:** answer *only* from the provided context; cite with `[n]`; if context is insufficient, say so — never fabricate. This is what makes it a trustworthy RAG product rather than a chatbot with extra steps.

---

## 6. Security Considerations

- **RLS everywhere** — every table has `enable row level security` and owner-scoped policies. Even a leaked anon key cannot read another tenant's rows. Verified clean by Supabase security advisors.
- **Storage isolation** — private bucket; policies require `(<uid>) == (storage.foldername(name))[1]`, so users can only touch files under their own UID prefix. Files are served via short-lived signed URLs, never public links.
- **Service-role key containment** — lives only in `lib/supabase/admin.ts`, imported exclusively by server code. Never `NEXT_PUBLIC_*`. The example env file ships a placeholder only.
- **`SECURITY DEFINER` hygiene** — `handle_new_user()` has `EXECUTE` revoked from `anon`/`authenticated`/`public`, so it can't be called via PostgREST RPC; it only fires from the auth trigger. All functions set `search_path = ''` to prevent search-path hijacking.
- **Input validation** — validate body shapes with Zod in every route handler; enforce PDF mime + size at the bucket level (50 MB, `application/pdf`) *and* in the UI.
- **Prompt-injection posture** — retrieved document text is untrusted; keep it in clearly delimited context blocks, instruct the model to treat it as data not instructions, and never let it trigger tools/actions.
- **Rate limiting & cost control** — per-user limits on uploads and chat turns (e.g. Upstash Redis / `@vercel/kv` sliding window) to cap OpenAI spend and abuse. Cap `match_count` and max context tokens.
- **Secrets & PII** — OpenAI keys server-only; consider disabling OpenAI training retention; document data is user-owned and deletable (cascade on `documents` delete + Storage object removal).
- **Auth hardening** — email confirmation on, sensible session TTL, OAuth providers configured in Supabase, `auth/callback` exchanges the code server-side.

---

## 7. Scalability Considerations

- **Ingestion as background work.** PDF parse + embedding is slow and bursty — don't block the request. Options, cheapest first:
  1. **Supabase Edge Function** invoked from `/process`, or
  2. **Vercel background function / `waitUntil`** for short jobs, or
  3. A real queue (**Supabase Queues / pgmq**, Inngest, or QStash) for large PDFs and retries. Status on `documents.status` makes any of these observable to the UI.
- **Batch + concurrency-limit embeddings.** Embed chunks in batches (e.g. 96/req) with a small concurrency pool and exponential backoff on 429s. Store `token_count` to predict cost.
- **Vector index scaling.** HNSW handles millions of rows with sub-100ms ANN. As the table grows, tune `m` / `ef_construction` and set `hnsw.ef_search` per query for the recall/latency trade-off. Partition `document_chunks` by `user_id` hash only if a single tenant gets huge.
- **Read scaling.** RLS-scoped queries hit B-tree indexes on `user_id`; add a Supabase read replica if dashboards get heavy. Cache document lists at the edge per-user where safe.
- **Streaming generation** keeps perceived latency low and avoids long-held connections; the AI SDK handles backpressure.
- **Stateless app tier.** All state is in Postgres/Storage, so Vercel scales horizontally with zero session affinity.
- **Cost guards.** Rate limits, max tokens, `match_threshold` to drop weak context, and choosing `text-embedding-3-small` + `gpt-4o-mini` for cheaper tiers. Make the generation model an env var so you can downshift under load.
- **Observability.** Log retrieval hit counts, similarity distributions, token usage per turn, and ingestion failures; alert on `status='failed'` rates.

---

## 8. Implementation Plan (phased)

**Phase 0 — Infra (DONE)**
Supabase project, schema, RLS, pgvector, `match_documents`, storage bucket, generated types, git repo.

**Phase 1 — App skeleton & auth**
`create-next-app` (TS, Tailwind, App Router) → init shadcn/ui → add the three Supabase clients + `middleware.ts` → login/signup/callback → protected `(app)` layout. *Exit:* a logged-in user sees an empty dashboard.

**Phase 2 — Upload & ingestion**
Upload dropzone → `POST /api/documents` (signed URL) → direct Storage upload → `POST /api/documents/[id]/process` → `lib/ai/pdf.ts` + `chunking.ts` + `embeddings.ts` write chunks and flip status. *Exit:* an uploaded PDF reaches `completed` with chunk rows + embeddings.

**Phase 3 — Retrieval & chat**
`lib/ai/rag.ts` (`retrieve` + `buildPrompt`) → `POST /api/chat` streaming with `useChat` → render messages → persist turns. *Exit:* ask a question, get a grounded streamed answer.

**Phase 4 — Citations & history**
Emit citation annotations → `citation-popover.tsx` (`[n]` → title + page + snippet) → persist citations in `messages.sources` → conversation list sidebar + thread reload. *Exit:* answers cite real sources; history reloads.

**Phase 5 — Document management & polish**
Document detail page, delete (row + file + chunks), status badges via Realtime, empty/error states, rate limiting, loading skeletons.

**Phase 6 — Ship**
Vercel project, env vars, Supabase auth redirect URLs for the prod domain, smoke test, re-run security + performance advisors.

---

## 9. Environment Variables

See [`.env.local.example`](.env.local.example). The public Supabase URL and publishable key are filled in for project `Later-AI`; you must supply `SUPABASE_SERVICE_ROLE_KEY` (Dashboard → Project Settings → API) and `OPENAI_API_KEY` yourself. Never commit real secrets — `.gitignore` already excludes `.env*.local`.
