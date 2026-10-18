/* Bounded ancillary DOM/readiness observation. Native CDP layout supplies visible text. */
() => {
  const fail = (reason) => { throw new Error(reason); };
  if (!document.body || !document.documentElement) fail("missing_document");
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ALL);
  let nodes = 0;
  while (walker.nextNode()) { if (++nodes > 50000) fail("dom_node_limit"); }
  const html = document.documentElement.outerHTML;
  if (new TextEncoder().encode(html).length > 5 * 1024 * 1024) fail("html_size_limit");
  return {
    html, url: document.URL, ready_state: document.readyState,
    fonts_status: document.fonts?.status || "loaded", captured_at: new Date().toISOString(),
  };
}
