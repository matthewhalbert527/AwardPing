import { createSyntheticSmartKbPublisherJsonFixture } from "./smart-kb-publisher-json.mjs";

// Synthetic article prose with the exact dependency strings observed together
// in the anonymous public FAQ response on 2026-11-02. Controllers, templates,
// CSS, graph, source identities and other static data remain the reviewed bytes.
// Private original response SHA:
// 15032caaf901187863af9bd9f61cb4e382b08381bb566e4532b4b61a27b788e4.
export function createSyntheticSmartKbPlatformBuildFixture(key) {
  const document = createSyntheticSmartKbPublisherJsonFixture(key);
  document.result.theme.header.data.menu.dependencies[0].files[0].url =
    "/scripts/angular-truncate.js?v=10-26-2026_2343";
  document.result.containers[1].rows[0].columns[0].widgets[0].widget.data.technical_help_widget.dependencies[0].files[0].url =
    "https://www.google.com/recaptcha/api.js?v=10-26-2026_2343";
  return document;
}
