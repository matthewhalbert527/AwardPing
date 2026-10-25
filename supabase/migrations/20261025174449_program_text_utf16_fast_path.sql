-- Keep the exact UTF-16 proof contract without allocating/walking one SQL
-- character per code point for every block on an ordinary long page.
-- The fixed range is evaluated with C collation, independent of text locale.
-- Existing validators, hashes, ownership and publication checks are unchanged.
create or replace function private.awardping_program_utf16_length(p_text text)
returns integer language sql immutable strict set search_path='' as $$
select char_length(p_text) + regexp_count(p_text collate pg_catalog."C",U&'[\+010000-\+10FFFF]');
$$;

create or replace function private.awardping_program_utf16_slice(p_text text,p_start integer,p_end integer)
returns text language plpgsql immutable strict set search_path='' as $$
declare v_i integer:=0; v_at integer:=0; v_size integer; v_start_index integer; v_ch text;
begin
 if p_start<0 or p_end<=p_start then return null; end if;
 -- PostgreSQL character offsets equal UTF-16 offsets only when no
 -- supplementary code points occur. Bounds must precede substr: SQL substr
 -- otherwise truncates an out-of-range end that this contract must reject.
 if p_text collate pg_catalog."C" !~ U&'[\+010000-\+10FFFF]' then
   if p_end>char_length(p_text) then return null; end if;
   return substr(p_text,p_start+1,p_end-p_start);
 end if;
 -- Preserve the previously verified astral-aware loop verbatim. In particular,
 -- neither endpoint may split a UTF-16 surrogate pair, and an empty slice is NULL.
 foreach v_ch in array string_to_array(p_text,null) loop
   v_i:=v_i+1; v_size:=case when ascii(v_ch)>65535 then 2 else 1 end;
   if v_at=p_start then v_start_index:=v_i;
   elsif v_at<p_start and v_at+v_size>p_start then return null; end if;
   v_at:=v_at+v_size;
   if v_at=p_end then
     if v_start_index is null then return null; end if;
     return substr(p_text,v_start_index,v_i-v_start_index+1);
   elsif v_at>p_end then return null; end if;
 end loop;
 return null;
end;
$$;
revoke all on function private.awardping_program_utf16_length(text) from public,anon,authenticated;
revoke all on function private.awardping_program_utf16_slice(text,integer,integer) from public,anon,authenticated;
grant execute on function private.awardping_program_utf16_length(text) to service_role;
grant execute on function private.awardping_program_utf16_slice(text,integer,integer) to service_role;
