import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'libpg-query';
import { PROGRAM_TEXT_PUBLIC_DRIVE_PDF_FILE_IDS as ids, PROGRAM_TEXT_PUBLIC_DRIVE_PDF_VERSION as version,
  programTextPublicDrivePdfIdentity, isProgramTextPublicDrivePdfTransition, isProgramTextPublicDrivePdfMetadata } from './lib/program-text-public-drive-pdf.mjs';

const sql = readFileSync(new URL('../supabase/migrations/20261026231050_program_text_public_drive_pdf.sql', import.meta.url), 'utf8');
const original = readFileSync(new URL('../supabase/migrations/20261023180338_program_text_monitoring.sql', import.meta.url), 'utf8');
const identityPattern = /p_url ~ '([^']+)'/.exec(sql)[1];
const sqlIdentity = url => typeof url === 'string' && !/\s/.test(url) && new RegExp(identityPattern).test(url) ? /[?&]id=([^&]+)(&|$)/.exec(url)?.[1] ?? null : null;
const source = `https://drive.usercontent.google.com/uc?id=${ids[0]}&export=download`;
const final = source.replace('/uc?', '/download?');
const metadata = { source: { url: source, page_type: 'pdf' }, final_url: final, acquisition: 'pdf_text', extractor: { name: 'pdf-parse', version } };
const invalidUrls = [null, '', source+'#fragment', source+'&x=1', source+'&id='+ids[0], source.replace('id=', 'ID='), source.replace('id=', 'id=%31'),
  source.replace('https:', 'http:'), source.replace('https:', 'HTTPS:'), source.replace('drive.', 'Drive.'), source.replace('.com/', '.com:443/'),
  source.replace('https://', 'https://user@'), source.replace('/uc?', '/file/d/'), source.replace(ids[0], 'arbitrary-file'), source.replace('&export=download', ''),
  source.replace('id=', 'id=='), source.replace('export=download', 'export=Download'), source.replace('export=download', 'export='), source+'\n', source+' ', source.replace('id=', '%69d='),
  source.replace('&', '&amp;'), source.replace('/uc?', '/uc/?'), source.replace('?id=', '?x=1&id=')];

describe('finite public Drive PDF SQL reference parity', () => {
  it('parses the guarded migration with no source, evidence, approval or scheduler mutation', async () => {
    const parsed = await parse(sql); expect(parsed.stmts.length).toBeGreaterThan(7);
    expect(sql).not.toMatch(/\b(?:insert into|update public|delete from|truncate|alter table)\b/i);
    expect(sql).toContain('77392cce6a93eb73262e6d585470d26fce7d81f4f3db9350fd277e5cc153c74c');
    expect(sql).toContain("raise exception 'Reference validator changed;");
  });
  it.each(ids)('accepts only literal finite file %s in either parameter order and allowed paths', id => {
    for (const path of ['uc', 'download']) for (const query of [`id=${id}&export=download`, `export=download&id=${id}`]) {
      const url = `https://drive.usercontent.google.com/${path}?${query}`;
      expect(sqlIdentity(url)).toBe(programTextPublicDrivePdfIdentity(url)?.file_id ?? null); expect(sqlIdentity(url)).toBe(id);
    }
  });
  it.each(invalidUrls)('rejects malformed or nonfinite source URL %s identically', url => {
    expect(sqlIdentity(url)).toBeNull(); expect(programTextPublicDrivePdfIdentity(url)).toBeNull();
  });
  it('keeps same-file final-download and typed native metadata requirements', () => {
    expect(isProgramTextPublicDrivePdfTransition(source, final)).toBe(true);
    expect(isProgramTextPublicDrivePdfTransition(final, final)).toBe(true);
    expect(isProgramTextPublicDrivePdfTransition(final, source)).toBe(false);
    expect(isProgramTextPublicDrivePdfTransition(source, final.replace(ids[0], ids[1]))).toBe(false);
    expect(isProgramTextPublicDrivePdfMetadata(metadata)).toBe(true);
    for (const invalid of [{ ...metadata, acquisition: 'pdf_ocr' }, { ...metadata, source: { ...metadata.source, page_type: 'application' } },
      { ...metadata, final_url: source }, { ...metadata, extractor: { ...metadata.extractor, name: 'unverified' } },
      { ...metadata, extractor: { ...metadata.extractor, version: '2.4.5/program-text-v1' } }]) expect(isProgramTextPublicDrivePdfMetadata(invalid)).toBe(false);
    for (const guard of ["p_ref#>>'{source,page_type}'='pdf'", "p_ref->>'acquisition'='pdf_text'", "p_ref#>>'{extractor,name}'='pdf-parse'", version,
      "p_final_url ~ '^https://drive[.]usercontent[.]google[.]com/download[?]'"]) expect(sql).toContain(guard);
  });
  it('preserves the complete original reference validator except the two narrow tagged-MIME checks', () => {
    const marker = 'function private.awardping_program_text_reference_valid(p_ref jsonb)';
    const oldTail = original.slice(original.indexOf(marker)); const oldBody = oldTail.slice(oldTail.indexOf('$$')+2, oldTail.indexOf('$$;',oldTail.indexOf('$$')+2)).trim();
    const newTail = sql.slice(sql.toLowerCase().indexOf(marker)); const open = newTail.indexOf('$function$');
    const newBody = newTail.slice(open+10, newTail.indexOf('$function$;',open+10)).trim()
      .replace(" if p_ref#>>'{extractor,version}'='2.4.5/program-text-v1/public-drive-pdf-v1'\n  and not private.awardping_program_public_drive_pdf_metadata_valid(p_ref) then return false;end if;\n", '')
      .replace("(v_artifact->>'content_type' ~* '^application/pdf(;|$)'\n       or private.awardping_program_public_drive_pdf_metadata_valid(p_ref) and v_artifact->>'content_type' ~* '^application/octet-stream(;|$)')", "v_artifact->>'content_type' ~* '^application/pdf(;|$)'");
    expect(newBody).toBe(oldBody);
    expect(sql).not.toMatch(/drop function|rename to/i);
  });
  it('rejects malformed tagged metadata even when generic PDF MIME might otherwise pass', () => {
    const tagGuard=sql.indexOf("if p_ref#>>'{extractor,version}'='"+version+"'");
    expect(tagGuard).toBeGreaterThan(0); expect(tagGuard).toBeLessThan(sql.indexOf("if not private.awardping_program_exact_object(p_ref,"));
    expect(sql).toContain("or private.awardping_program_public_drive_pdf_metadata_valid(p_ref) and v_artifact->>'content_type' ~* '^application/octet-stream(;|$)'");
  });
  it('keeps service-only invoker immutable helpers and the original function identity', () => {
    for(const name of ['identity','transition','metadata_valid']) expect(sql).toContain(`private.awardping_program_public_drive_pdf_${name}`);
    expect((sql.match(/immutable security invoker set search_path=''/g) ?? []).length).toBe(3);
    expect(sql).toContain('from public,anon,authenticated'); expect(sql).toContain('to service_role');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION private.awardping_program_text_reference_valid(p_ref jsonb)');
  });
});
