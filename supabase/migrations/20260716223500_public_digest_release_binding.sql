-- Retain the exact Stage 1 release identity used for every irreversible
-- public digest attempt. Provider retries use the same durable idempotency key.

alter table public.public_update_deliveries
  add column if not exists release_epoch uuid,
  add column if not exists release_policy_version text,
  add column if not exists release_identity_hash text,
  add column if not exists provider_idempotency_key text;

alter table public.public_update_deliveries
  drop constraint if exists public_update_deliveries_release_identity_check;

alter table public.public_update_deliveries
  add constraint public_update_deliveries_release_identity_check check (
    (
      release_epoch is null
      and release_policy_version is null
      and release_identity_hash is null
      and provider_idempotency_key is null
    )
    or (
      release_epoch is not null
      and nullif(pg_catalog.btrim(release_policy_version), '') is not null
      and release_identity_hash ~ '^[0-9a-f]{64}$'
      and nullif(pg_catalog.btrim(provider_idempotency_key), '') is not null
    )
  );

create unique index if not exists public_update_deliveries_provider_idempotency_idx
  on public.public_update_deliveries (provider_idempotency_key)
  where provider_idempotency_key is not null;
