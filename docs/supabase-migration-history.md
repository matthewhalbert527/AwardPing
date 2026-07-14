# Supabase migration-history repair

Production contains `shared_awards_status_id_idx`. Its previously missing
`20260703093000_shared_award_source_cleanup_indexes.sql` history row was repaired
and verified on 2026-07-14. The other four indexes from that file are obsolete
and intentionally absent from production.

If another environment is missing that history row, repair its linked migration
history before applying `*_converge_shared_award_source_cleanup_indexes.sql`
(or any later local migration):

```powershell
supabase migration repair 20260703093000 --status applied --linked
supabase migration list --linked
```

Confirm that `20260703093000` appears in both the local and remote columns. Do
not repeat this repair when the row is already present.
Several reviewed forward migrations currently sort before an already-applied
production migration. Preview and apply that intentional out-of-order set with:

```powershell
supabase db push --include-all --linked --dry-run
supabase db push --include-all --linked
```

Only run the second command after the dry run lists exactly the reviewed forward
migrations. The convergence migration preserves the live `(status, id)` index
and drops the four obsolete indexes if another environment previously created
them.

Do not execute `20260703093000_shared_award_source_cleanup_indexes.sql` against
production. Applying it now would build indexes for superseded query shapes and
increase index storage and write amplification before the convergence migration
removes them.
