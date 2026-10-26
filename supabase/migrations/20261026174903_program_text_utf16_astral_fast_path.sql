-- Preserve the exact UTF16 slice proof, while scanning only native-regex
-- BMP runs and supplementary characters instead of one PL/pgSQL row per
-- code point. Source text, hashes, validators and approval rules are unchanged.
create or replace function private.awardping_program_utf16_slice(p_text text,p_start integer,p_end integer)
returns text language plpgsql immutable strict set search_path='' as $$
declare v_at integer:=0; v_start integer:=p_start; v_end integer:=p_end; v_match text[];
begin
 if p_start<0 or p_end<=p_start then return null; end if;
 -- Keep the established BMP-only fast path and its strict end bound.
 if p_text collate pg_catalog."C" !~ U&'[\+010000-\+10FFFF]' then
   if p_end>char_length(p_text) then return null; end if;
   return substr(p_text,p_start+1,p_end-p_start);
 end if;
 if p_end>private.awardping_program_utf16_length(p_text) then return null; end if;
 -- Each match consumes one complete BMP run and exactly one astral scalar.
 -- v_at is its exclusive UTF16 end; v_at-1 is the forbidden half-surrogate
 -- boundary. Completed astrals contribute one extra UTF16 code unit each.
 for v_match in select regexp_matches(p_text collate pg_catalog."C",
   U&'([^\+010000-\+10FFFF]*)([\+010000-\+10FFFF])','g') loop
   v_at:=v_at+char_length(v_match[1])+2;
   if p_start=v_at-1 or p_end=v_at-1 then return null; end if;
   if p_start>=v_at then v_start:=v_start-1; end if;
   if p_end>=v_at then v_end:=v_end-1; end if;
   exit when v_at>=p_end;
 end loop;
 return substr(p_text,v_start+1,v_end-v_start);
end;
$$;
revoke all on function private.awardping_program_utf16_slice(text,integer,integer) from public,anon,authenticated;
grant execute on function private.awardping_program_utf16_slice(text,integer,integer) to service_role;
