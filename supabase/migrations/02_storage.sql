-- Private bucket for PDFs (50MB limit, PDF only)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

-- Files are stored under <user_id>/<document_id>.pdf so the first path
-- segment must equal the caller's uid.
create policy "Users can read own files"
  on storage.objects for select
  using (bucket_id = 'documents' and (select auth.uid())::text = (storage.foldername(name))[1]);

create policy "Users can upload own files"
  on storage.objects for insert
  with check (bucket_id = 'documents' and (select auth.uid())::text = (storage.foldername(name))[1]);

create policy "Users can update own files"
  on storage.objects for update
  using (bucket_id = 'documents' and (select auth.uid())::text = (storage.foldername(name))[1]);

create policy "Users can delete own files"
  on storage.objects for delete
  using (bucket_id = 'documents' and (select auth.uid())::text = (storage.foldername(name))[1]);
