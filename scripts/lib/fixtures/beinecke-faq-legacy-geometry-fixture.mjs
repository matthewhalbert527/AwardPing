import { gunzipSync } from "node:zlib";
import { encoded as mainLayout } from "./beinecke-faq-main-layout.mjs";
import { encoded as state01Layout } from "./beinecke-faq-state-01-layout.mjs";
import { encoded as state02Layout } from "./beinecke-faq-state-02-layout.mjs";
import { encoded as state03Layout } from "./beinecke-faq-state-03-layout.mjs";
import { encoded as state04Layout } from "./beinecke-faq-state-04-layout.mjs";
import { encoded as metadata } from "./beinecke-faq-meta.mjs";
import { encoded as r2BindingReceipt } from "./beinecke-faq-r2-binding-receipt.mjs";
import {
  legacyFullText,
  reviewedIntakeText,
} from "./beinecke-faq-texts.mjs";

// Exact immutable public-page evidence for the reviewed Beinecke FAQ bridge.
// Compression only keeps the committed test fixture compact. Production does
// not import this directory and continues to consume independently verified
// local/R2 bytes supplied by the Stage 1 canary.
const compressedBodies = Object.freeze({
  layout: mainLayout,
  expansion_state_01_layout: state01Layout,
  expansion_state_02_layout: state02Layout,
  expansion_state_03_layout: state03Layout,
  expansion_state_04_layout: state04Layout,
  meta: metadata,
  r2_binding_receipt: r2BindingReceipt,
  legacy_full_text: legacyFullText,
  reviewed_intake_text: reviewedIntakeText,
});

export function beineckeFaqLegacyFixtureBody(role) {
  const encoded = compressedBodies[role];
  if (!encoded) throw new Error(`Unknown Beinecke FAQ legacy fixture role: ${role}.`);
  return gunzipSync(Buffer.from(encoded, "base64"));
}

export function beineckeFaqLegacyFixtureJson(role) {
  return JSON.parse(beineckeFaqLegacyFixtureBody(role).toString("utf8"));
}
