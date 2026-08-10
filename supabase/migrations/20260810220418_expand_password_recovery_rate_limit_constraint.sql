-- Widen the durable public-form ledger before password recovery uses its own
-- kind. Keep the existing constraint in force while the replacement is
-- validated so no unconstrained write window is introduced.

alter table public.public_form_rate_limits
  drop constraint if exists public_form_rate_limits_kind_check_v2;

alter table public.public_form_rate_limits
  add constraint public_form_rate_limits_kind_check_v2
  check (kind in ('subscribe', 'contact', 'source_request', 'password_recovery'))
  not valid;

alter table public.public_form_rate_limits
  validate constraint public_form_rate_limits_kind_check_v2;

alter table public.public_form_rate_limits
  drop constraint public_form_rate_limits_kind_check;

alter table public.public_form_rate_limits
  rename constraint public_form_rate_limits_kind_check_v2
  to public_form_rate_limits_kind_check;
