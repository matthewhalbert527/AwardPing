-- Catalog and transactional behavior proof for the durable public-update
-- confirmation outbox. No provider request is performed: acceptance is
-- simulated only after the database authorize boundary.

do $catalog_smoke$
declare
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_signature text;
  v_oid oid;
begin
  if pg_catalog.to_regclass(
    'private.public_update_confirmation_outbox'
  ) is null then
    raise exception 'The private confirmation outbox table is missing.';
  end if;
  if pg_catalog.has_table_privilege(
    'anon',
    'private.public_update_confirmation_outbox',
    'SELECT'
  ) or pg_catalog.has_table_privilege(
    'authenticated',
    'private.public_update_confirmation_outbox',
    'SELECT'
  ) or pg_catalog.has_table_privilege(
    'service_role',
    'private.public_update_confirmation_outbox',
    'SELECT'
  ) then
    raise exception 'A runtime role can read confirmation outbox material directly.';
  end if;
  if not pg_catalog.has_schema_privilege('anon', 'private', 'USAGE')
    or not pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE')
    or not pg_catalog.has_schema_privilege('service_role', 'private', 'USAGE')
    or not pg_catalog.has_function_privilege(
      'anon', 'private.is_office_member(uuid)', 'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'authenticated', 'private.is_office_member(uuid)', 'EXECUTE'
    ) then
    raise exception 'The existing private-schema RLS helper grants were changed.';
  end if;

  foreach v_signature in array array[
    'public.enqueue_public_update_confirmation(uuid,timestamp with time zone,text,text,text,text,text,text,text,text,text)',
    'public.claim_public_update_confirmations(text,integer,integer,uuid)',
    'public.authorize_public_update_confirmation_send(uuid,uuid)',
    'public.complete_public_update_confirmation_send(uuid,uuid,text)',
    'public.fail_public_update_confirmation_send(uuid,uuid,text,boolean,boolean)',
    'public.confirm_public_update_subscription(text)',
    'public.unsubscribe_public_update_subscriber(text)'
  ]
  loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    if v_oid is null or not exists (
      select 1
      from pg_catalog.pg_proc candidate
      where candidate.oid = v_oid
        and pg_catalog.pg_get_userbyid(candidate.proowner) = 'postgres'
        and candidate.prokind = 'f'
        and candidate.provolatile = 'v'
        and candidate.prosecdef
        and not candidate.proleakproof
        and candidate.proconfig is not distinct from
          array['search_path=""']::text[]
        and pg_catalog.has_function_privilege(
          'service_role', candidate.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon', candidate.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', candidate.oid, 'EXECUTE'
        )
        and not exists (
          select 1
          from pg_catalog.aclexplode(
            coalesce(
              candidate.proacl,
              pg_catalog.acldefault('f', candidate.proowner)
            )
          ) privilege
          where privilege.grantee = 0
            or privilege.grantee not in (
              candidate.proowner,
              v_service_role_oid
            )
            or privilege.privilege_type <> 'EXECUTE'
            or (
              privilege.grantee = v_service_role_oid
              and privilege.is_grantable
            )
        )
    ) then
      raise exception
        'A confirmation RPC owner, security, volatility, search path, or ACL is unsafe: %',
        v_signature;
    end if;
  end loop;

  v_oid := pg_catalog.to_regprocedure(
    'public.erase_public_update_subscriber(text,text)'
  );
  if v_oid is null or not exists (
    select 1
    from pg_catalog.pg_proc candidate
    where candidate.oid = v_oid
      and pg_catalog.pg_get_userbyid(candidate.proowner) = 'postgres'
      and candidate.prokind = 'f'
      and candidate.provolatile = 'v'
      and candidate.prosecdef
      and not candidate.proleakproof
      and candidate.proconfig is not distinct from
        array['search_path=""']::text[]
      and not pg_catalog.has_function_privilege(
        'service_role', candidate.oid, 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'anon', candidate.oid, 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated', candidate.oid, 'EXECUTE'
      )
      and not exists (
        select 1
        from pg_catalog.aclexplode(
          coalesce(
            candidate.proacl,
            pg_catalog.acldefault('f', candidate.proowner)
          )
        ) privilege
        where privilege.grantee <> candidate.proowner
          or privilege.privilege_type <> 'EXECUTE'
      )
  ) then
    raise exception
      'The superseded direct erasure RPC became callable or changed its safety metadata.';
  end if;

  if pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        'public.enqueue_public_update_confirmation(uuid,timestamp with time zone,text,text,text,text,text,text,text,text,text)'
      )
    ),
    'v_now := pg_catalog.clock_timestamp()'
  ) = 0 or pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        'public.confirm_public_update_subscription(text)'
      )
    ),
    'v_now := pg_catalog.clock_timestamp()'
  ) = 0 then
    raise exception 'Enqueue or activation is not bound to the PostgreSQL clock.';
  end if;
end;
$catalog_smoke$;

set role anon;
do $anon_denied$
declare
  v_denied boolean := false;
begin
  if private.is_office_member(gen_random_uuid()) then
    raise exception 'An anonymous smoke identity unexpectedly belongs to an office.';
  end if;
  begin
    perform public.confirm_public_update_subscription(repeat('a', 64));
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'The anon role invoked confirmation activation.';
  end if;
end;
$anon_denied$;
reset role;

set role authenticated;
do $authenticated_denied$
declare
  v_denied boolean := false;
begin
  if private.is_office_member(gen_random_uuid()) then
    raise exception 'An unauthenticated smoke identity unexpectedly belongs to an office.';
  end if;
  begin
    perform public.confirm_public_update_subscription(repeat('a', 64));
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'The authenticated role invoked confirmation activation.';
  end if;
end;
$authenticated_denied$;
reset role;

set role service_role;
do $service_allowed$
declare
  v_reached_validation boolean := false;
  v_superseded_erasure_denied boolean := false;
begin
  begin
    perform public.erase_public_update_subscriber(
      null::text,
      null::text
    );
  exception when insufficient_privilege then
    v_superseded_erasure_denied := true;
  end;
  if not v_superseded_erasure_denied then
    raise exception 'The service role invoked the superseded direct erasure RPC.';
  end if;
  begin
    perform public.enqueue_public_update_confirmation(
      null, null, null, null, null, null, null, null, null, null, null
    );
  exception when sqlstate '22023' then
    v_reached_validation := true;
  end;
  if not v_reached_validation then
    raise exception 'The service role did not reach enqueue validation.';
  end if;
end;
$service_allowed$;
reset role;

do $behavior_smoke$
declare
  v_subscriber_id uuid := gen_random_uuid();
  v_created_at timestamptz := pg_catalog.clock_timestamp();
  v_recipient_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_token_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_other_token_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_payload_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_other_payload_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_unsubscribe_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_enqueue record;
  v_repeat record;
  v_claim record;
  v_subscriber public.public_update_subscribers%rowtype;
  v_outbox private.public_update_confirmation_outbox%rowtype;
  v_authorized boolean;
  v_completion text;
  v_confirmed boolean;
  v_direct_activation_denied boolean := false;
begin
  select * into v_enqueue
  from public.enqueue_public_update_confirmation(
    v_subscriber_id,
    v_created_at,
    'rollback-probe@example.invalid',
    v_recipient_hash,
    'ap:v2:probe:recipient',
    v_token_hash,
    'ap:v2:probe:token',
    'ap:v2:probe:frozen-provider-payload',
    'public-confirmation-render-v1',
    v_payload_hash,
    v_unsubscribe_hash
  );
  if v_enqueue.outbox_id is null or not v_enqueue.needs_delivery then
    raise exception 'Initial confirmation work was not durably enqueued.';
  end if;

  select * into v_subscriber
  from public.public_update_subscribers subscriber
  where subscriber.id = v_subscriber_id;
  if v_subscriber.confirmation_expires_at <>
      v_subscriber.confirmation_issued_at + interval '24 hours'
    or v_subscriber.confirmation_contract_version <>
      'public-confirmation-outbox-v1' then
    raise exception 'The database did not seal the exact confirmation interval.';
  end if;

  select * into v_repeat
  from public.enqueue_public_update_confirmation(
    gen_random_uuid(),
    pg_catalog.clock_timestamp(),
    'rollback-probe@example.invalid',
    v_recipient_hash,
    'ap:v2:probe:recipient-repeat',
    v_other_token_hash,
    'ap:v2:probe:token-repeat',
    'ap:v2:probe:frozen-provider-payload-repeat',
    'public-confirmation-render-v1',
    v_other_payload_hash,
    v_unsubscribe_hash
  );
  if v_repeat.outbox_id <> v_enqueue.outbox_id
    or not v_repeat.needs_delivery then
    raise exception 'A same-generation request rotated or duplicated confirmation work.';
  end if;

  select * into v_claim
  from public.claim_public_update_confirmations(
    'confirmation-smoke', 1, 300, v_enqueue.outbox_id
  );
  if v_claim.id <> v_enqueue.outbox_id then
    raise exception 'The exact confirmation row could not be claimed.';
  end if;
  if v_claim.payload_schema_version <> 'public-confirmation-render-v1'
    or v_claim.payload_hash <> v_payload_hash
    or v_claim.rendered_payload_encrypted <>
      'ap:v2:probe:frozen-provider-payload'
    or v_claim.provider_idempotency_key <>
      'awardping-public-confirmation:' || v_payload_hash then
    raise exception 'The claim did not preserve the exact frozen provider payload.';
  end if;
  v_authorized := public.authorize_public_update_confirmation_send(
    v_claim.id,
    v_claim.lease_token
  );
  if not v_authorized then
    raise exception 'The current generation was not authorized for provider send.';
  end if;
  v_completion := public.complete_public_update_confirmation_send(
    v_claim.id,
    v_claim.lease_token,
    'confirmation-smoke-provider-id'
  );
  if v_completion <> 'accepted' then
    raise exception 'Provider acceptance was not recorded truthfully.';
  end if;

  begin
    update public.public_update_subscribers subscriber
    set
      status = 'active',
      confirmation_token_hash = null,
      confirmed_at = pg_catalog.clock_timestamp(),
      digest_started_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
    where subscriber.id = v_subscriber_id;
  exception when serialization_failure then
    v_direct_activation_denied := true;
  end;
  if not v_direct_activation_denied then
    raise exception 'A direct subscriber activation bypassed the atomic confirmation RPC.';
  end if;

  v_confirmed := public.confirm_public_update_subscription(v_token_hash);
  if not v_confirmed then
    raise exception 'The accepted unexpired token did not activate.';
  end if;
  select * into v_subscriber
  from public.public_update_subscribers subscriber
  where subscriber.id = v_subscriber_id;
  select * into v_outbox
  from private.public_update_confirmation_outbox outbox
  where outbox.id = v_enqueue.outbox_id;
  if v_subscriber.status <> 'active'
    or v_subscriber.confirmed_at is null
    or v_subscriber.digest_started_at <> v_subscriber.confirmed_at
    or v_outbox.status <> 'confirmed'
    or v_outbox.provider_message_id <>
      'confirmation-smoke-provider-id'
    or v_outbox.accepted_at is null
    or v_outbox.rendered_payload_encrypted is not null
    or v_outbox.payload_hash <> v_payload_hash
    or v_outbox.confirmed_at <> v_subscriber.confirmed_at then
    raise exception 'Activation or its provider receipt is incomplete.';
  end if;

  delete from public.public_update_subscribers subscriber
  where subscriber.id = v_subscriber_id;
  select * into v_outbox
  from private.public_update_confirmation_outbox outbox
  where outbox.id = v_enqueue.outbox_id;
  if v_outbox.status <> 'privacy_scrubbed'
    or v_outbox.subscriber_id is not null
    or v_outbox.recipient_hash is not null
    or v_outbox.confirmation_token_hash is not null
    or v_outbox.rendered_payload_encrypted is not null
    or v_outbox.payload_hash is not null
    or v_outbox.provider_message_id is not null then
    raise exception 'Subscriber erasure did not scrub confirmation material.';
  end if;
  delete from private.public_update_confirmation_outbox outbox
  where outbox.id = v_enqueue.outbox_id;
end;
$behavior_smoke$;

do $rolling_deploy_smoke$
declare
  v_subscriber_id uuid := gen_random_uuid();
  v_recipient_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_initial_token_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_old_refresh_token_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_payload_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_unsubscribe_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_seal timestamptz := pg_catalog.clock_timestamp();
  v_row public.public_update_subscribers%rowtype;
  v_enqueue record;
  v_outbox private.public_update_confirmation_outbox%rowtype;
begin
  insert into public.public_update_subscribers (
    id,
    email_hash,
    email_encrypted,
    status,
    confirmation_token_hash,
    unsubscribe_token_hash,
    confirmation_sent_at,
    created_at,
    updated_at
  ) values (
    v_subscriber_id,
    v_recipient_hash,
    'ap:v2:probe:rolling-recipient',
    'pending',
    v_initial_token_hash,
    v_unsubscribe_hash,
    null,
    v_seal,
    v_seal
  ) returning * into v_row;
  if v_row.confirmation_token_hash is not null
    or v_row.confirmation_generation <> 0
    or v_row.confirmation_contract_version is not null then
    raise exception 'An old-shaped rolling-deploy insert was not neutralized.';
  end if;

  select * into v_enqueue
  from public.enqueue_public_update_confirmation(
    gen_random_uuid(),
    pg_catalog.clock_timestamp(),
    null,
    v_recipient_hash,
    'ap:v2:probe:rolling-recipient',
    v_initial_token_hash,
    'ap:v2:probe:rolling-token',
    'ap:v2:probe:rolling-frozen-payload',
    'public-confirmation-render-v1',
    v_payload_hash,
    v_unsubscribe_hash
  );

  update public.public_update_subscribers subscriber
  set
    status = 'pending',
    confirmation_token_hash = v_old_refresh_token_hash,
    confirmation_sent_at = null,
    confirmed_at = null,
    unsubscribed_at = null,
    updated_at = pg_catalog.clock_timestamp()
  where subscriber.id = v_subscriber_id
  returning * into v_row;
  select * into v_outbox
  from private.public_update_confirmation_outbox outbox
  where outbox.id = v_enqueue.outbox_id;
  if v_row.confirmation_token_hash <> v_initial_token_hash
    or v_outbox.status <> 'queued'
    or v_outbox.confirmation_token_hash <> v_initial_token_hash then
    raise exception 'An old-shaped rolling refresh rotated or staled durable work.';
  end if;

  update public.public_update_subscribers subscriber
  set confirmation_contract_version = null
  where subscriber.id = v_subscriber_id;
  select * into v_outbox
  from private.public_update_confirmation_outbox outbox
  where outbox.id = v_enqueue.outbox_id;
  if v_outbox.status <> 'stale'
    or v_outbox.rendered_payload_encrypted is not null then
    raise exception 'A nullable confirmation-contract mutation was not fenced.';
  end if;
  delete from private.public_update_confirmation_outbox outbox
  where outbox.id = v_enqueue.outbox_id;

  v_payload_hash := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  select * into v_enqueue
  from public.enqueue_public_update_confirmation(
    gen_random_uuid(),
    pg_catalog.clock_timestamp(),
    null,
    v_recipient_hash,
    'ap:v2:probe:rolling-recipient',
    v_old_refresh_token_hash,
    'ap:v2:probe:rolling-token-two',
    'ap:v2:probe:rolling-frozen-payload-two',
    'public-confirmation-render-v1',
    v_payload_hash,
    v_unsubscribe_hash
  );
  update public.public_update_subscribers subscriber
  set confirmation_sent_at = pg_catalog.clock_timestamp()
  where subscriber.id = v_subscriber_id;
  select * into v_outbox
  from private.public_update_confirmation_outbox outbox
  where outbox.id = v_enqueue.outbox_id;
  if v_outbox.status <> 'stale'
    or v_outbox.rendered_payload_encrypted is not null then
    raise exception 'A direct confirmation-sent mutation was not fenced.';
  end if;

  delete from public.public_update_subscribers subscriber
  where subscriber.id = v_subscriber_id;
  delete from private.public_update_confirmation_outbox outbox
  where outbox.id = v_enqueue.outbox_id;

  -- Model a ded6636 provider request that was already in flight when the
  -- migration committed. Only its exact acceptance-mark mutation may be
  -- preserved, without moving its original expiry anchor.
  v_subscriber_id := gen_random_uuid();
  v_recipient_hash := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_initial_token_hash := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_unsubscribe_hash := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_seal := pg_catalog.clock_timestamp() - interval '1 minute';
  insert into public.public_update_subscribers (
    id,
    email_hash,
    email_encrypted,
    status,
    confirmation_token_hash,
    unsubscribe_token_hash,
    created_at,
    updated_at
  ) values (
    v_subscriber_id,
    v_recipient_hash,
    'ap:v2:probe:inflight-recipient',
    'pending',
    v_initial_token_hash,
    v_unsubscribe_hash,
    v_seal,
    v_seal
  );
  update public.public_update_subscribers subscriber
  set
    confirmation_token_hash = v_initial_token_hash,
    confirmation_generation = 1,
    updated_at = v_seal
  where subscriber.id = v_subscriber_id;
  update public.public_update_subscribers subscriber
  set
    confirmation_sent_at = v_seal,
    updated_at = pg_catalog.clock_timestamp()
  where subscriber.id = v_subscriber_id
  returning * into v_row;
  if v_row.confirmation_issued_at is null
    or v_row.confirmation_expires_at <>
      v_row.confirmation_issued_at + interval '24 hours'
    or v_row.confirmation_issued_at <> v_row.confirmation_sent_at then
    raise exception 'An exact pre-migration in-flight acceptance extended its token.';
  end if;
  if not public.confirm_public_update_subscription(v_initial_token_hash) then
    raise exception 'A preserved in-flight legacy acceptance did not activate through the RPC.';
  end if;
  select * into v_outbox
  from private.public_update_confirmation_outbox outbox
  where outbox.subscriber_id = v_subscriber_id;
  if v_outbox.status <> 'confirmed'
    or v_outbox.payload_hash is not null
    or v_outbox.provider_idempotency_key is not null then
    raise exception 'The legacy activation receipt synthesized delivery material.';
  end if;
  delete from public.public_update_subscribers subscriber
  where subscriber.id = v_subscriber_id;
  delete from private.public_update_confirmation_outbox outbox
  where outbox.id = v_outbox.id;
end;
$rolling_deploy_smoke$;

do $expired_lease_cleanup_smoke$
declare
  v_subscriber_id uuid := gen_random_uuid();
  v_recipient_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_token_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_payload_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_unsubscribe_hash text := pg_catalog.md5(gen_random_uuid()::text) ||
    pg_catalog.md5(gen_random_uuid()::text);
  v_enqueue record;
  v_claim record;
  v_outbox private.public_update_confirmation_outbox%rowtype;
begin
  select * into v_enqueue
  from public.enqueue_public_update_confirmation(
    v_subscriber_id,
    pg_catalog.clock_timestamp(),
    null,
    v_recipient_hash,
    'ap:v2:probe:cleanup-recipient',
    v_token_hash,
    'ap:v2:probe:cleanup-token',
    'ap:v2:probe:cleanup-frozen-payload',
    'public-confirmation-render-v1',
    v_payload_hash,
    v_unsubscribe_hash
  );
  select * into v_claim
  from public.claim_public_update_confirmations(
    'expired-lease-smoke', 1, 30, v_enqueue.outbox_id
  );

  update private.public_update_confirmation_outbox outbox
  set
    send_attempt_count = outbox.max_attempts,
    claimed_at = pg_catalog.clock_timestamp() - interval '2 minutes',
    lease_expires_at = pg_catalog.clock_timestamp() - interval '1 minute'
  where outbox.id = v_enqueue.outbox_id;
  perform public.claim_public_update_confirmations(
    'expired-lease-cleanup', 1, 30, v_enqueue.outbox_id
  );
  select * into v_outbox
  from private.public_update_confirmation_outbox outbox
  where outbox.id = v_enqueue.outbox_id;
  if v_outbox.status <> 'stale'
    or v_outbox.stale_at is null
    or v_outbox.recipient_encrypted is not null
    or v_outbox.confirmation_token_encrypted is not null
    or v_outbox.rendered_payload_encrypted is not null then
    raise exception 'Expired max-attempt cleanup did not durably stale and scrub work.';
  end if;

  delete from public.public_update_subscribers subscriber
  where subscriber.id = v_subscriber_id;
  delete from private.public_update_confirmation_outbox outbox
  where outbox.id = v_enqueue.outbox_id;
end;
$expired_lease_cleanup_smoke$;
