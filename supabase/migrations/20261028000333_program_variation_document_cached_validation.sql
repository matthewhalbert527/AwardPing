-- PROPOSED ONLY. No migration ledger name is assigned here.
-- Reuse the existing strict cached document proof; outer provider/auth/currentness/append functions stay exact.
DO $provider_document_cache$
DECLARE v_row record;v_actual text;v_definition text;v_old text;v_meta jsonb;v_after jsonb;
 v_new text:=$new_body$
begin
 return private.awardping_program_source_approval_document_valid(p_doc) is true;
end;
$new_body$;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 FOR v_row IN SELECT * FROM (VALUES
   ('append_program_variation_scopes(uuid,uuid,jsonb,jsonb,text)','a103837a8fc477c108e073ea8bf51b1bd38295cf63c8d0256d77e5d160c6f22e'),
   ('private.awardping_program_block_valid(jsonb,text)','fba5fe463c44d0c610b773e170a610dc5087dd0a15c8a71ae53e2a14d5b4ecd8'),
   ('private.awardping_program_source_approval_document_valid(jsonb)','28d177e66a6a3f54bdaa19926d5377c3d04eeec266cbbce01ec24bd189d118a6'),
   ('private.awardping_variation_provider_document_valid(jsonb)','1da33e8b8cc41b7cad2fed01a83ed70d84cb8435f2b3fc547faceb6a5e00895c'),
   ('private.awardping_variation_provider_proof_valid(jsonb,text)','93543f509b0c7afc7933412775dd41616a6289d0c14d25d8876e33a57f1c6aab'),
   ('private.awardping_variation_quote_valid(jsonb,jsonb)','0a4103880263a1ce61a4f0e16816a780e9726546d4a2f581352e7c90f139c2b3')
 ) AS expected(signature,body_sha256) LOOP
  SELECT encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex') INTO STRICT v_actual FROM pg_catalog.pg_proc p WHERE p.oid=v_row.signature::regprocedure;
  IF v_actual IS DISTINCT FROM v_row.body_sha256 THEN RAISE EXCEPTION 'Provider-cache preimage changed: %',v_row.signature USING ERRCODE='40001';END IF;
 END LOOP;
 SELECT p.prosrc,pg_catalog.pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc'-'probin'-'prosqlbody' INTO STRICT v_old,v_definition,v_meta FROM pg_catalog.pg_proc p WHERE p.oid='private.awardping_variation_provider_document_valid(jsonb)'::regprocedure;
 IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'Provider document body is not uniquely bound.' USING ERRCODE='40001';END IF;
 EXECUTE replace(v_definition,v_old,v_new);
 SELECT to_jsonb(p)-'prosrc'-'probin'-'prosqlbody' INTO STRICT v_after FROM pg_catalog.pg_proc p WHERE p.oid='private.awardping_variation_provider_document_valid(jsonb)'::regprocedure;
 IF v_after IS DISTINCT FROM v_meta THEN RAISE EXCEPTION 'Provider document metadata or ACL changed.' USING ERRCODE='40001';END IF;
 FOR v_row IN SELECT * FROM (VALUES
   ('append_program_variation_scopes(uuid,uuid,jsonb,jsonb,text)','a103837a8fc477c108e073ea8bf51b1bd38295cf63c8d0256d77e5d160c6f22e'),
   ('private.awardping_program_block_valid(jsonb,text)','fba5fe463c44d0c610b773e170a610dc5087dd0a15c8a71ae53e2a14d5b4ecd8'),
   ('private.awardping_program_source_approval_document_valid(jsonb)','28d177e66a6a3f54bdaa19926d5377c3d04eeec266cbbce01ec24bd189d118a6'),
   ('private.awardping_variation_provider_document_valid(jsonb)','1da33e8b8cc41b7cad2fed01a83ed70d84cb8435f2b3fc547faceb6a5e00895c'),
   ('private.awardping_variation_provider_proof_valid(jsonb,text)','93543f509b0c7afc7933412775dd41616a6289d0c14d25d8876e33a57f1c6aab'),
   ('private.awardping_variation_quote_valid(jsonb,jsonb)','0a4103880263a1ce61a4f0e16816a780e9726546d4a2f581352e7c90f139c2b3')
 ) AS expected(signature,body_sha256) LOOP
  SELECT encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex') INTO STRICT v_actual FROM pg_catalog.pg_proc p WHERE p.oid=v_row.signature::regprocedure;
  IF v_actual IS DISTINCT FROM (CASE WHEN v_row.signature='private.awardping_variation_provider_document_valid(jsonb)' THEN 'd4e80496da7ee86ab768962e31c3d6cc87c94306be7e75ade5e290565eac40df' ELSE v_row.body_sha256 END) THEN RAISE EXCEPTION 'Provider-cache postimage changed: %',v_row.signature USING ERRCODE='40001';END IF;
 END LOOP;
END $provider_document_cache$;
