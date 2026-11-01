-- Estrutura mínima para sincronização opcional do PDF Editor.
-- O editor continua local por padrão; estas tabelas só são usadas após consentimento explícito.

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  mime_type text not null default 'application/pdf',
  size_bytes bigint not null default 0,
  page_count integer not null default 0,
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  version_number integer not null,
  created_at timestamptz not null default now(),
  unique (document_id, version_number)
);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  storage_path text not null,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.document_members (
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (document_id, user_id)
);

-- Operações e snapshots são separados dos bytes do PDF. A colaboração transmite
-- operações do modelo local; o PDF só é enviado ao Storage em uma sincronização
-- explícita do usuário.
create table if not exists public.document_operations (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  client_sequence bigint not null,
  base_revision bigint not null default 0,
  operation_type text not null check (operation_type in ('replacePages')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (document_id, client_id, client_sequence)
);

create table if not exists public.document_snapshots (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  revision bigint not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  unique (document_id, revision)
);

create table if not exists public.signing_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  certificate_fingerprint text,
  subject_name text,
  issuer_name text,
  valid_until timestamptz,
  provider_reference text,
  created_at timestamptz not null default now()
);

create table if not exists public.signing_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  signature_field text not null,
  sequence_number integer not null,
  revision bigint not null,
  certificate_fingerprint text,
  status text not null default 'pending' check (status in ('pending', 'signed', 'rejected', 'invalidated')),
  provider_reference text,
  created_at timestamptz not null default now(),
  unique (document_id, sequence_number)
);

create index if not exists document_operations_document_created_idx
  on public.document_operations(document_id, created_at);
create index if not exists signing_events_document_sequence_idx
  on public.signing_events(document_id, sequence_number);

alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.files enable row level security;
alter table public.document_members enable row level security;
alter table public.document_operations enable row level security;
alter table public.document_snapshots enable row level security;
alter table public.signing_profiles enable row level security;
alter table public.signing_events enable row level security;

create policy "documents readable by owner or member" on public.documents
  for select using (
    owner_id = auth.uid()
    or exists (select 1 from public.document_members m where m.document_id = id and m.user_id = auth.uid())
  );

create policy "documents owner write" on public.documents
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "document versions owner access" on public.document_versions
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "files owner access" on public.files
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "members can read membership" on public.document_members
  for select using (
    user_id = auth.uid()
    or exists (select 1 from public.documents d where d.id = document_id and d.owner_id = auth.uid())
  );

create policy "owners manage membership" on public.document_members
  for all using (
    exists (select 1 from public.documents d where d.id = document_id and d.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.documents d where d.id = document_id and d.owner_id = auth.uid())
  );

create policy "document collaborators can read operations" on public.document_operations
  for select using (
    exists (select 1 from public.documents d where d.id = document_id and (
      d.owner_id = auth.uid()
      or exists (select 1 from public.document_members m where m.document_id = d.id and m.user_id = auth.uid())
    ))
  );

create policy "document editors can append operations" on public.document_operations
  for insert with check (
    actor_id = auth.uid()
    and exists (select 1 from public.documents d where d.id = document_id and (
      d.owner_id = auth.uid()
      or exists (select 1 from public.document_members m where m.document_id = d.id and m.user_id = auth.uid() and m.role = 'editor')
    ))
  );

create policy "document owners manage snapshots" on public.document_snapshots
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owners manage signing profiles" on public.signing_profiles
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "document collaborators can read signing events" on public.signing_events
  for select using (
    exists (select 1 from public.documents d where d.id = document_id and (
      d.owner_id = auth.uid()
      or exists (select 1 from public.document_members m where m.document_id = d.id and m.user_id = auth.uid())
    ))
  );

create policy "document editors can create signing events" on public.signing_events
  for insert with check (
    actor_id = auth.uid()
    and exists (select 1 from public.documents d where d.id = document_id and (
      d.owner_id = auth.uid()
      or exists (select 1 from public.document_members m where m.document_id = d.id and m.user_id = auth.uid() and m.role = 'editor')
    ))
  );

-- O bucket deve ser criado como privado no Supabase Storage:
-- insert into storage.buckets (id, name, public) values ('documents', 'documents', false)
-- on conflict (id) do nothing;

create policy "document objects owner access" on storage.objects
  for all using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
