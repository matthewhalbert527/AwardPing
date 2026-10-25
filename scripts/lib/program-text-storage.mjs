import { createHash } from "node:crypto";
import { mkdirSync, lstatSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { programTextReference, validateProgramTextReference, programTextArtifactMap as artifactMap, readProgramTextArtifact as readArtifact } from "./program-text-artifacts.mjs";
export { PROGRAM_TEXT_REFERENCE_SCHEMA, programTextReference, validateProgramTextReference, loadProgramTextCapture } from "./program-text-artifacts.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const fail = reason => { throw new Error(`Program text storage: ${reason}`); };

function contained(root, target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== target) fail("archive_scope");
  for (let p = target; p !== root; p = dirname(p)) {
    try { const st = lstatSync(p); if (st.isSymbolicLink()) fail("archive_reparse"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

/** Create-only private local retention. Callers supply the installer-owned archive. */
export function retainProgramTextCapture(capture, archiveRoot) {
  const root = realpathSync.native(resolve(archiveRoot)), artifacts = artifactMap(capture);
  const directory = resolve(root, "program-text", "sources", capture.source.id, capture.capture_id);
  contained(root, directory); mkdirSync(directory, { recursive: true, mode: 0o700 }); contained(root, directory);
  for (const a of artifacts) {
    const path = join(directory, a.name);
    try { writeFileSync(path, a.body, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size !== a.body.length || sha(readFileSync(path)) !== a.binding.sha256) fail("local_retention_mismatch");
  }
  return { reference: programTextReference(capture), directory };
}

/** Content-addressed immutable keys; each upload is followed by a raw readback. */
export async function uploadProgramTextCapture(capture, { client, bucket }) {
  const ref = validateProgramTextReference(programTextReference(capture));
  for (const a of artifactMap(capture)) {
    try { await readArtifact(client, bucket, a.binding); }
    catch (error) {
      if (!["NoSuchKey", "NotFound"].includes(error.name) && error.$metadata?.httpStatusCode !== 404) throw error;
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: a.binding.object_key, Body: a.body,
          ContentType: a.binding.content_type, CacheControl: "private, max-age=31536000, immutable", IfNoneMatch: "*" }), { abortSignal: AbortSignal.timeout(30_000) });
      } catch (putError) { if (putError.$metadata?.httpStatusCode !== 412) throw putError; }
      await readArtifact(client, bucket, a.binding);
    }
  }
  return ref;
}
