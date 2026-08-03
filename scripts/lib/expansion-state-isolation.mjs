import {
  evaluateWithVisibleTextVisibilitySemantics,
} from "./visible-text-geometry.mjs";

export async function discoverExpansionStateDescriptors(page, {
  maxControls = 8,
  relevanceMode = "award-content",
} = {}) {
  return page.evaluate(({ maxControlsValue, relevanceModeValue }) => {
    function normalizedText(element) {
      return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    }

    function classText(element) {
      return typeof element?.className === "string" ? element.className : "";
    }

    function visible(element) {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
        style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
    }

    function selectorFor(element) {
      if (element.id) return `#${CSS.escape(element.id)}`;
      return structuralSelectorFor(element);
    }

    function structuralSelectorFor(element) {
      const parts = [];
      let current = element;
      while (current && current !== document.documentElement) {
        const tag = current.tagName.toLowerCase();
        const siblings = current.parentElement
          ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName)
          : [];
        const position = siblings.indexOf(current) + 1;
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${position})` : tag);
        current = current.parentElement;
      }
      return `html>${parts.join(">")}`;
    }

    function selectorFromTargetToken(token, { idref = false } = {}) {
      const raw = idref
        ? /^[^\s#]+$/.test(token) ? token : ""
        : /^#[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(token) ? token.slice(1) : "";
      return raw ? { id: raw, selector: `#${CSS.escape(raw)}` } : null;
    }

    function isPlaceholderHref(value) {
      const compact = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
      return ["", "#", "javascript:", "javascript:;", "javascript:void(0)", "javascript:void(0);"].includes(compact);
    }

    function targetEntriesFor(element) {
      const entries = [];
      const seen = new Set();
      let declared = 0;
      let unresolved = 0;
      const addEntry = (attr, token, idref) => {
        declared += 1;
        const parsed = selectorFromTargetToken(token, { idref });
        if (!parsed) {
          unresolved += 1;
          return;
        }
        const target = document.getElementById(parsed.id);
        if (!(target instanceof HTMLElement)) {
          unresolved += 1;
          return;
        }
        if (seen.has(parsed.selector)) return;
        seen.add(parsed.selector);
        entries.push({ attr, selector: parsed.selector, element: target });
      };

      if (element.hasAttribute("aria-controls")) {
        const ariaControls = element.getAttribute("aria-controls")?.trim() || "";
        const tokens = ariaControls.split(/\s+/).filter(Boolean);
        if (!tokens.length) {
          declared += 1;
          unresolved += 1;
        }
        for (const token of tokens) addEntry("aria-controls", token, true);
      }
      for (const attr of ["data-target", "data-bs-target", "href"]) {
        if (!element.hasAttribute(attr)) continue;
        const value = element.getAttribute(attr)?.trim() || "";
        if (attr === "href" && isPlaceholderHref(value)) continue;
        if (!value) {
          declared += 1;
          unresolved += 1;
          continue;
        }
        addEntry(attr, value.trim(), false);
      }
      return { declared, entries, unresolved };
    }

    function semanticAccordionContext(element) {
      const selector = [
        "li.accordion",
        ".accordion__item",
        "[class*='accordion-item' i]",
        "[class*='accordion_item' i]",
        "[class*='accordion' i]",
        "[class*='faq' i]",
        "[id*='faq' i]",
      ].join(", ");
      const context = element.closest(selector);
      return context === element ? element.parentElement?.closest(selector) || null : context;
    }

    function meaningfulPanel(element, control) {
      return element instanceof HTMLElement && element !== control && !element.contains(control) &&
        normalizedText(element).length > 0;
    }

    function visiblePanel(element) {
      if (!(element instanceof HTMLElement) || element.hidden || element.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 1 && style.display !== "none" &&
        style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
    }

    function uniqueCollapsedDescendant(target, control) {
      const candidates = new Set();
      const add = (candidate) => {
        if (meaningfulPanel(candidate, control) && !visiblePanel(candidate)) candidates.add(candidate);
      };
      for (const child of target.children) add(child);
      for (const selector of [
        "[hidden]",
        "[aria-hidden='true']",
        ".collapse:not(.show)",
        ".accordion__item-drawer",
        ".accordion__content",
        ".accordion-content",
        "[class*='accordion' i][class*='content' i]",
        "[class*='accordion' i][class*='drawer' i]",
        "[role='tabpanel']",
      ]) {
        for (const candidate of target.querySelectorAll(selector)) add(candidate);
      }
      return candidates.size === 1 ? [...candidates][0] : null;
    }

    function structuralFingerprintFor(kind, control, stateElements) {
      return JSON.stringify({
        kind,
        control: structuralSelectorFor(control),
        states: stateElements
          .map((element) => ({
            selector: structuralSelectorFor(element),
            text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1_000),
          }))
          .sort((left, right) => left.selector.localeCompare(right.selector)),
      });
    }

    function targetPanelFor(control, target) {
      if (!target.contains(control)) {
        if (visiblePanel(target)) {
          const collapsedDescendant = uniqueCollapsedDescendant(target, control);
          if (collapsedDescendant) return collapsedDescendant;
        }
        return meaningfulPanel(target, control) ? target : null;
      }
      const commonPanel = target.querySelector([
        ".vc_tta-panel-body",
        ".accordion__item-drawer",
        ".accordion__content",
        ".accordion-content",
        "[class*='accordion' i][class*='content' i]",
        "[class*='accordion' i][class*='drawer' i]",
        "[role='tabpanel']",
      ].join(", "));
      if (meaningfulPanel(commonPanel, control)) return commonPanel;
      return [...target.children].find((child) => meaningfulPanel(child, control)) || null;
    }

    function detailsPanelsFor(details, control) {
      return [...details.children]
        .filter((child) => child.tagName !== "SUMMARY" && meaningfulPanel(child, control));
    }

    function targetLooksStateful(control, target) {
      const classTokens = `${classText(control)} ${classText(target)}`.split(/\s+/).filter(Boolean);
      const knownStateClass = classTokens.some((token) =>
        /(?:^|[_-])(?:accordion|collapse|drawer|tab|tabpanel|toggle)(?:$|[_-])/i.test(token) ||
        /^vc[_-]tta[_-]panel(?:$|[_-])/i.test(token));
      return knownStateClass || target.getAttribute("role") === "tabpanel" ||
        (target.contains(control) && Boolean(targetPanelFor(control, target)));
    }

    function targetEntryLooksStateful(element, entry) {
      const role = (element.getAttribute("role") || "").toLowerCase();
      const toggle = (element.getAttribute("data-toggle") || element.getAttribute("data-bs-toggle") || "")
        .toLowerCase();
      if (entry.attr === "aria-controls" && element.getAttribute("aria-expanded") !== null) return true;
      if (role === "tab" || ["accordion", "collapse", "tab"].includes(toggle)) return true;
      return targetLooksStateful(element, entry.element);
    }

    function adjacentPanelFor(element) {
      const context = semanticAccordionContext(element);
      if (!(context instanceof HTMLElement)) return null;
      const directCandidates = [
        element.nextElementSibling,
        element.parentElement && element.parentElement !== context
          ? element.parentElement.nextElementSibling
          : null,
      ];
      for (const candidate of directCandidates) {
        if (meaningfulPanel(candidate, element) && context.contains(candidate)) return candidate;
      }
      for (const selector of [
        ":scope > article",
        ":scope > .accordion__item-drawer",
        ":scope > .accordion__content",
        ":scope > .accordion-content",
        ":scope > [class*='accordion' i][class*='content' i]",
        ":scope > [class*='accordion' i][class*='drawer' i]",
      ]) {
        try {
          const candidate = context.querySelector(selector);
          if (meaningfulPanel(candidate, element)) return candidate;
        } catch {
          // Ignore unsupported third-party selector combinations.
        }
      }
      return null;
    }

    function stateBindingFor(element) {
      const targetResolution = targetEntriesFor(element);
      if (targetResolution.declared > 0 &&
        (targetResolution.unresolved > 0 || !targetResolution.entries.length)) return null;
      const details = element.closest("details");
      if (details instanceof HTMLElement) {
        const stateSelector = selectorFor(details);
        const panels = detailsPanelsFor(details, element);
        const boundPanels = panels.length ? panels : [details];
        return {
          kind: "details",
          key: `details:${stateSelector}`,
          state_selectors: [stateSelector],
          panel_selectors: boundPanels.map(selectorFor),
          structural_fingerprint: structuralFingerprintFor("details", element, [details]),
        };
      }

      if (targetResolution.declared > 0) {
        const targets = targetResolution.entries.filter((entry) => targetEntryLooksStateful(element, entry));
        if (targets.length !== targetResolution.entries.length) return null;
        const panels = targets.map((entry) => targetPanelFor(element, entry.element));
        if (panels.some((panel) => !(panel instanceof HTMLElement))) return null;
        const stateSelectors = targets.map((entry) => entry.selector).sort();
        const panelSelectors = [...new Set(panels.map(selectorFor))];
        if (!panelSelectors.length) return null;
        return {
          kind: "targets",
          key: `targets:${stateSelectors.join("|")}`,
          state_selectors: stateSelectors,
          panel_selectors: panelSelectors,
          structural_fingerprint: structuralFingerprintFor(
            "targets",
            element,
            targets.map((entry) => entry.element),
          ),
        };
      }

      const adjacentPanel = adjacentPanelFor(element);
      if (adjacentPanel) {
        const panelSelector = selectorFor(adjacentPanel);
        const context = semanticAccordionContext(element);
        return {
          kind: "adjacent-panel",
          key: `adjacent-panel:${panelSelector}`,
          state_selectors: context instanceof HTMLElement ? [selectorFor(context)] : [],
          panel_selectors: [panelSelector],
          structural_fingerprint: structuralFingerprintFor("adjacent-panel", element, [adjacentPanel]),
        };
      }
      return null;
    }

    function controlLabel(element) {
      return normalizedText(element).slice(0, 120) ||
        (element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 120);
    }

    function controlSignalFor(element) {
      return [
        element.id,
        classText(element),
        element.getAttribute("aria-label"),
        element.getAttribute("aria-controls"),
        element.getAttribute("data-target"),
        element.getAttribute("data-bs-target"),
        element.getAttribute("data-toggle"),
        element.getAttribute("data-bs-toggle"),
        element.getAttribute("href"),
        normalizedText(element),
      ].filter(Boolean).join(" ").toLowerCase();
    }

    function boundTextFor(binding) {
      return [...binding.state_selectors, ...binding.panel_selectors]
        .flatMap((selector) => {
          try {
            return [...document.querySelectorAll(selector)].map((element) =>
              binding.kind === "details"
                ? (element.textContent || "").replace(/\s+/g, " ").trim()
                : normalizedText(element));
          } catch {
            return [];
          }
        })
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    }

    function isCandidate(element) {
      if (!(element instanceof HTMLElement) || !visible(element)) return null;
      if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return null;
      if (element.closest("nav, header, [role='navigation']")) return null;

      const tag = element.tagName.toLowerCase();
      const role = (element.getAttribute("role") || "").toLowerCase();
      const href = element.getAttribute("href") || "";
      if (tag === "a" && href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:")) {
        return null;
      }
      const toggleClass = /accordion[^\s]*(?:toggle|title|button|header)|(?:toggle|title|button|header)[^\s]*accordion|elementor-tab-title|e-n-accordion-item-title/i
        .test(classText(element));
      const recognizedCustomToggle = toggleClass &&
        (["div", "span"].includes(tag) || element.hasAttribute("tabindex"));
      const actionable = ["button", "summary"].includes(tag) ||
        (tag === "a" && (href.startsWith("#") || href.toLowerCase().startsWith("javascript:"))) ||
        ["button", "tab"].includes(role) ||
        element.hasAttribute("onclick") ||
        element.getAttribute("aria-expanded") !== null ||
        element.hasAttribute("aria-controls") ||
        element.hasAttribute("data-target") ||
        element.hasAttribute("data-bs-target") ||
        element.hasAttribute("data-toggle") ||
        element.hasAttribute("data-bs-toggle") ||
        recognizedCustomToggle;
      if (!actionable) return null;

      const binding = stateBindingFor(element);
      if (!binding) return null;
      const controlSignal = controlSignalFor(element);
      if (/\b(menu|nav|navbar|search|login|subscribe|newsletter|share|print|donate|cart|next|previous|prev|facebook|twitter|linkedin|instagram|feedback|survey|accessibility|carousel|slider|slideshow|slick)\b|log in|sign in|skip to|improve this site|slide control/i.test(controlSignal)) {
        return null;
      }
      const contentPattern = relevanceModeValue === "award-content"
        ? /\b(faq|questions?|answers?|eligib(?:le|ility)?|requirements?|criteria|nominations?|applications?|process|apply|deadlines?|guidelines?|instructions?|documents?|pdf|forms?|awards?|grants?|materials?|amount|tuition|stipend)\b/i
        : /\b(faq|questions?|answers?|expand|show|more|details|eligib(?:le|ility)?|requirements?|criteria|nominations?|applications?|process|apply|deadlines?|guidelines?|instructions?|documents?|pdf|forms?|awards?|grants?|materials?|amount|tuition|stipend)\b/i;
      return contentPattern.test(`${controlSignal} ${boundTextFor(binding)}`) ? binding : null;
    }

    const selector = [
      "summary",
      "details > :first-child",
      "button",
      "[role='button']",
      "[role='tab']",
      "a[href^='#']",
      "a[data-toggle]",
      "a[data-bs-toggle]",
      "button[data-toggle]",
      "button[data-bs-toggle]",
      "[aria-expanded]",
      "[aria-controls]",
      "[data-target]",
      "[data-bs-target]",
      "[onclick]",
      "[class*='accordion' i]",
      "[class*='toggle' i]",
      "[class*='elementor-tab-title' i]",
      "[class*='e-n-accordion-item-title' i]",
    ].join(", ");
    const seenControls = new Set();
    const seenStates = new Set();
    const controls = [];
    const controlLimit = Math.max(0, Number(maxControlsValue) || 0);
    let candidateCount = 0;
    if (controlLimit > 0) {
      for (const control of document.querySelectorAll(selector)) {
        const binding = isCandidate(control);
        if (!binding) continue;
        const selectorValue = selectorFor(control);
        if (seenControls.has(selectorValue) || seenStates.has(binding.key)) continue;
        seenControls.add(selectorValue);
        seenStates.add(binding.key);
        candidateCount += 1;
        if (controls.length < controlLimit) controls.push({ control, binding });
      }
    }
    const truncatedCount = Math.max(0, candidateCount - controls.length);

    return {
      candidates: candidateCount,
      capture_limit: controlLimit,
      descriptor_set_complete: truncatedCount === 0,
      truncated: truncatedCount > 0,
      truncated_count: truncatedCount,
      descriptors: controls.map(({ control, binding }, index) => ({
        index,
        selector: selectorFor(control),
        structural_selector: structuralSelectorFor(control),
        tag: control.tagName,
        id: control.id || null,
        role: control.getAttribute("role") || null,
        label: controlLabel(control) || `Section ${index + 1}`,
        aria_controls: control.getAttribute("aria-controls") || null,
        data_target: control.getAttribute("data-target") || control.getAttribute("data-bs-target") || null,
        href: control.getAttribute("href") || null,
        state_kind: binding.kind,
        state_key: binding.key,
        structural_fingerprint: binding.structural_fingerprint,
        state_selectors: binding.state_selectors,
        panel_selectors: binding.panel_selectors,
      })),
      base_text: document.body?.innerText || "",
    };
  }, {
    maxControlsValue: maxControls,
    relevanceModeValue: relevanceMode,
  });
}

async function evaluateExpansionStateIsolation({ targetDescriptor, allDescriptors, openTarget }, visibilityApi) {
  if (!visibilityApi) throw new Error("AwardPing isolated visible-text semantics were not constructed.");
  const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  const normalizedText = (element) =>
    (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  const classText = (element) => typeof element?.className === "string" ? element.className : "";

  const selectorFor = (element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    return structuralSelectorFor(element);
  };

  const structuralSelectorFor = (element) => {
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName)
        : [];
      const position = siblings.indexOf(current) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${position})` : tag);
      current = current.parentElement;
    }
    return `html>${parts.join(">")}`;
  };

  const selectorFromTargetToken = (token, { idref = false } = {}) => {
    const raw = idref
      ? /^[^\s#]+$/.test(token) ? token : ""
      : /^#[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(token) ? token.slice(1) : "";
    return raw ? { id: raw, selector: `#${CSS.escape(raw)}` } : null;
  };

  const isPlaceholderHref = (value) => {
    const compact = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
    return ["", "#", "javascript:", "javascript:;", "javascript:void(0)", "javascript:void(0);"].includes(compact);
  };

  const targetEntriesFor = (element) => {
    const entries = [];
    const seen = new Set();
    let declared = 0;
    let unresolved = 0;
    const addEntry = (attr, token, idref) => {
      declared += 1;
      const parsed = selectorFromTargetToken(token, { idref });
      if (!parsed) {
        unresolved += 1;
        return;
      }
      const target = document.getElementById(parsed.id);
      if (!(target instanceof HTMLElement)) {
        unresolved += 1;
        return;
      }
      if (seen.has(parsed.selector)) return;
      seen.add(parsed.selector);
      entries.push({ attr, selector: parsed.selector, element: target });
    };

    if (element.hasAttribute("aria-controls")) {
      const ariaControls = element.getAttribute("aria-controls")?.trim() || "";
      const tokens = ariaControls.split(/\s+/).filter(Boolean);
      if (!tokens.length) {
        declared += 1;
        unresolved += 1;
      }
      for (const token of tokens) addEntry("aria-controls", token, true);
    }
    for (const attr of ["data-target", "data-bs-target", "href"]) {
      if (!element.hasAttribute(attr)) continue;
      const value = element.getAttribute(attr)?.trim() || "";
      if (attr === "href" && isPlaceholderHref(value)) continue;
      if (!value) {
        declared += 1;
        unresolved += 1;
        continue;
      }
      addEntry(attr, value.trim(), false);
    }
    return { declared, entries, unresolved };
  };

  const semanticAccordionContext = (element) => {
    const selector = [
      "li.accordion",
      ".accordion__item",
      "[class*='accordion-item' i]",
      "[class*='accordion_item' i]",
      "[class*='accordion' i]",
      "[class*='faq' i]",
      "[id*='faq' i]",
    ].join(", ");
    const context = element.closest(selector);
    return context === element ? element.parentElement?.closest(selector) || null : context;
  };

  const meaningfulPanel = (element, control) => element instanceof HTMLElement && element !== control &&
    !element.contains(control) && normalizedText(element).length > 0;

  const visiblePanel = (element) => {
    if (!(element instanceof HTMLElement) || element.hidden || element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 1 && style.display !== "none" &&
      style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
  };

  const readablePanelEvidence = (panel, control) => {
    if (!visiblePanel(panel)) return { readable: false, runCount: 0, text: "" };
    const documentElement = document.documentElement;
    const body = document.body;
    const documentWidth = Math.max(documentElement.scrollWidth, body?.scrollWidth || 0, window.innerWidth);
    const documentHeight = Math.max(documentElement.scrollHeight, body?.scrollHeight || 0, window.innerHeight);
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    const readableText = [];
    let runCount = 0;
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      const rawText = node.nodeValue || "";
      if (
        parent instanceof HTMLElement &&
        /\S/u.test(rawText) &&
        !(control instanceof HTMLElement && control.contains(parent)) &&
        !parent.closest("[hidden], [aria-hidden='true'], script, style, noscript, template, canvas")
      ) {
        const context = visibilityApi.elementContext(parent);
        if (context) {
          const range = document.createRange();
          range.selectNodeContents(node);
          if (visibilityApi.rectsForRange(range, context, { documentHeight, documentWidth }).length > 0) {
            runCount += 1;
            readableText.push(rawText.replace(/\s+/g, " ").trim());
          }
        }
      }
      node = walker.nextNode();
    }
    return {
      readable: runCount > 0,
      runCount,
      text: readableText.filter(Boolean).join(" ").slice(0, 1_000),
    };
  };

  const uniqueCollapsedDescendant = (target, control) => {
    const candidates = new Set();
    const add = (candidate) => {
      if (meaningfulPanel(candidate, control) && !visiblePanel(candidate)) candidates.add(candidate);
    };
    for (const child of target.children) add(child);
    for (const selector of [
      "[hidden]",
      "[aria-hidden='true']",
      ".collapse:not(.show)",
      ".accordion__item-drawer",
      ".accordion__content",
      ".accordion-content",
      "[class*='accordion' i][class*='content' i]",
      "[class*='accordion' i][class*='drawer' i]",
      "[role='tabpanel']",
    ]) {
      for (const candidate of target.querySelectorAll(selector)) add(candidate);
    }
    return candidates.size === 1 ? [...candidates][0] : null;
  };

  const structuralFingerprintFor = (kind, control, stateElements) => JSON.stringify({
    kind,
    control: structuralSelectorFor(control),
    states: stateElements
      .map((element) => ({
        selector: structuralSelectorFor(element),
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1_000),
      }))
      .sort((left, right) => left.selector.localeCompare(right.selector)),
  });

  const targetPanelFor = (control, target) => {
    if (!target.contains(control)) {
      if (visiblePanel(target)) {
        const collapsedDescendant = uniqueCollapsedDescendant(target, control);
        if (collapsedDescendant) return collapsedDescendant;
      }
      return meaningfulPanel(target, control) ? target : null;
    }
    const commonPanel = target.querySelector([
      ".vc_tta-panel-body",
      ".accordion__item-drawer",
      ".accordion__content",
      ".accordion-content",
      "[class*='accordion' i][class*='content' i]",
      "[class*='accordion' i][class*='drawer' i]",
      "[role='tabpanel']",
    ].join(", "));
    if (meaningfulPanel(commonPanel, control)) return commonPanel;
    return [...target.children].find((child) => meaningfulPanel(child, control)) || null;
  };

  const detailsPanelsFor = (details, control) => [...details.children]
    .filter((child) => child.tagName !== "SUMMARY" && meaningfulPanel(child, control));

  const targetLooksStateful = (control, target) => {
    const classTokens = `${classText(control)} ${classText(target)}`.split(/\s+/).filter(Boolean);
    const knownStateClass = classTokens.some((token) =>
      /(?:^|[_-])(?:accordion|collapse|drawer|tab|tabpanel|toggle)(?:$|[_-])/i.test(token) ||
      /^vc[_-]tta[_-]panel(?:$|[_-])/i.test(token));
    return knownStateClass || target.getAttribute("role") === "tabpanel" ||
      (target.contains(control) && Boolean(targetPanelFor(control, target)));
  };

  const targetEntryLooksStateful = (element, entry) => {
    const role = (element.getAttribute("role") || "").toLowerCase();
    const toggle = (element.getAttribute("data-toggle") || element.getAttribute("data-bs-toggle") || "")
      .toLowerCase();
    if (entry.attr === "aria-controls" && element.getAttribute("aria-expanded") !== null) return true;
    if (role === "tab" || ["accordion", "collapse", "tab"].includes(toggle)) return true;
    return targetLooksStateful(element, entry.element);
  };

  const adjacentPanelFor = (element) => {
    const context = semanticAccordionContext(element);
    if (!(context instanceof HTMLElement)) return null;
    const directCandidates = [
      element.nextElementSibling,
      element.parentElement && element.parentElement !== context
        ? element.parentElement.nextElementSibling
        : null,
    ];
    for (const candidate of directCandidates) {
      if (meaningfulPanel(candidate, element) && context.contains(candidate)) return candidate;
    }
    for (const selector of [
      ":scope > article",
      ":scope > .accordion__item-drawer",
      ":scope > .accordion__content",
      ":scope > .accordion-content",
      ":scope > [class*='accordion' i][class*='content' i]",
      ":scope > [class*='accordion' i][class*='drawer' i]",
    ]) {
      try {
        const candidate = context.querySelector(selector);
        if (meaningfulPanel(candidate, element)) return candidate;
      } catch {
        // Ignore unsupported third-party selector combinations.
      }
    }
    return null;
  };

  const stateBindingFor = (element) => {
    const targetResolution = targetEntriesFor(element);
    if (targetResolution.declared > 0 &&
      (targetResolution.unresolved > 0 || !targetResolution.entries.length)) return null;
    const details = element.closest("details");
    if (details instanceof HTMLElement) {
      const stateSelector = selectorFor(details);
      const panels = detailsPanelsFor(details, element);
      const boundPanels = panels.length ? panels : [details];
      return {
        kind: "details",
        key: `details:${stateSelector}`,
        stateElements: [details],
        panels: boundPanels,
        structuralFingerprint: structuralFingerprintFor("details", element, [details]),
      };
    }
    if (targetResolution.declared > 0) {
      const targets = targetResolution.entries.filter((entry) => targetEntryLooksStateful(element, entry));
      if (targets.length !== targetResolution.entries.length) return null;
      const panels = targets.map((entry) => targetPanelFor(element, entry.element));
      if (panels.some((panel) => !(panel instanceof HTMLElement))) return null;
      const targetSelectors = targets.map((entry) => entry.selector).sort();
      return {
        kind: "targets",
        key: `targets:${targetSelectors.join("|")}`,
        stateElements: targets.map((entry) => entry.element),
        panels: [...new Set(panels)],
        structuralFingerprint: structuralFingerprintFor(
          "targets",
          element,
          targets.map((entry) => entry.element),
        ),
      };
    }
    const panel = adjacentPanelFor(element);
    if (panel) {
      const context = semanticAccordionContext(element);
      return {
        kind: "adjacent-panel",
        key: `adjacent-panel:${selectorFor(panel)}`,
        stateElements: context instanceof HTMLElement ? [context] : [],
        panels: [panel],
        structuralFingerprint: structuralFingerprintFor("adjacent-panel", element, [panel]),
      };
    }
    return null;
  };

  const controlLabel = (element) => normalizedText(element).slice(0, 120) ||
    (element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 120);

  const descriptorMatches = (element, value, { mode = "semantic" } = {}) => {
    if (!(element instanceof HTMLElement) || element.closest("nav, header, [role='navigation']")) return false;
    if (value.tag && element.tagName !== value.tag) return false;
    if (value.role && element.getAttribute("role") !== value.role) return false;
    const binding = stateBindingFor(element);
    if (!binding) return false;
    if (value.state_kind && binding.kind !== value.state_kind) return false;
    const exactStateMatch = Boolean(value.state_key) && binding.key === value.state_key;
    const structuralMatch = Boolean(value.structural_fingerprint) &&
      binding.structuralFingerprint === value.structural_fingerprint;
    if ((value.state_key || value.structural_fingerprint) && !exactStateMatch && !structuralMatch) return false;

    if (mode === "structural") return structuralMatch;
    if (mode === "semantic") {
      return exactStateMatch || structuralMatch || !value.label || controlLabel(element) === value.label;
    }

    if (value.id && element.id !== value.id) return false;
    // Target attributes are allowed to regenerate only when the deterministic
    // structural fingerprint still binds this exact control and panel content.
    if (exactStateMatch) {
      if (value.aria_controls && element.getAttribute("aria-controls") !== value.aria_controls) return false;
      if (value.data_target) {
        const actual = element.getAttribute("data-target") || element.getAttribute("data-bs-target");
        if (actual !== value.data_target) return false;
      }
      if (value.href && element.getAttribute("href") !== value.href) return false;
    }
    return true;
  };

  const resolveDescriptor = (value) => {
    try {
      const exact = document.querySelector(value.selector);
      if (descriptorMatches(exact, value, { mode: "exact" })) return exact;
    } catch {
      // Continue to deterministic structural resolution.
    }
    if (value.structural_selector) {
      try {
        const structural = document.querySelector(value.structural_selector);
        if (descriptorMatches(structural, value, { mode: "structural" })) return structural;
      } catch {
        // Continue to the unique binding fallback.
      }
    }
    const selector = [
      "summary",
      "button",
      "[role='button']",
      "[role='tab']",
      "a[href^='#']",
      "[aria-expanded]",
      "[aria-controls]",
      "[data-target]",
      "[data-bs-target]",
      "[onclick]",
    ].join(", ");
    const matches = [...document.querySelectorAll(selector)]
      .filter((element) => descriptorMatches(element, value, { mode: "semantic" }));
    return matches.length === 1 ? matches[0] : null;
  };

  const isOpen = ({ element, binding }) => {
    const panelsReadable = binding.panels.length > 0 &&
      binding.panels.every((panel) => readablePanelEvidence(panel, element).readable);
    if (!panelsReadable) return false;
    if (binding.kind === "details") return Boolean(binding.stateElements[0]?.open) && panelsReadable;
    const expanded = element.getAttribute("aria-expanded");
    if (expanded !== null) return expanded === "true" && panelsReadable;
    return panelsReadable;
  };

  const boundContentSnapshot = (binding) => ({
    panels_visible: binding.panels.length > 0 && binding.panels.every(visiblePanel),
    panels_readable: binding.panels.length > 0 &&
      binding.panels.every((panel) => readablePanelEvidence(panel, target).readable),
    signature: JSON.stringify(binding.panels.map((panel) => {
      const rect = panel.getBoundingClientRect();
      const readable = readablePanelEvidence(panel, target);
      return {
        visible: visiblePanel(panel),
        readable: readable.readable,
        readable_runs: readable.runCount,
        readable_text: readable.text,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      };
    })),
  });

  const click = async (element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    await delay(50);
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.click();
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    await delay(220);
  };

  const target = resolveDescriptor(targetDescriptor);
  if (!target) return { verified: false, reason: "stable_target_descriptor_not_resolved" };
  const targetBinding = stateBindingFor(target);
  if (!targetBinding) return { verified: false, reason: "stable_target_state_not_resolved" };

  const resolved = [];
  for (const value of allDescriptors) {
    const element = resolveDescriptor(value);
    if (!element) return { verified: false, reason: `descriptor_not_resolved:${value.selector}` };
    const binding = stateBindingFor(element);
    if (!binding) return { verified: false, reason: `descriptor_state_not_resolved:${value.selector}` };
    resolved.push({ descriptor: value, element, binding });
  }

  let transitionRequired = false;
  let transitionVerified = true;
  if (openTarget) {
    for (const item of resolved) {
      if (item.binding.key !== targetBinding.key && isOpen(item)) await click(item.element);
    }
    const beforeTarget = boundContentSnapshot(targetBinding);
    const expandedBefore = target.getAttribute("aria-expanded");
    const targetInitiallyOpen = isOpen({ element: target, binding: targetBinding });
    if (!targetInitiallyOpen) await click(target);
    const afterTarget = boundContentSnapshot(targetBinding);
    const noAriaState = expandedBefore === null && targetBinding.kind !== "details";
    transitionRequired = noAriaState || expandedBefore === "false";
    transitionVerified = !transitionRequired || (
      !targetInitiallyOpen &&
      afterTarget.panels_readable &&
      beforeTarget.signature !== afterTarget.signature
    );
    for (const item of resolved) {
      if (item.binding.key !== targetBinding.key && isOpen(item)) await click(item.element);
    }
  }

  const targetOpen = isOpen({ element: target, binding: targetBinding }) && transitionVerified;
  const otherOpen = resolved
    .filter((item) => item.binding.key !== targetBinding.key && isOpen(item))
    .map((item) => item.descriptor.selector);
  return {
    verified: targetOpen && otherOpen.length === 0,
    reason: !transitionVerified
      ? "bound_content_did_not_transition"
      : !targetOpen
        ? "target_not_open"
        : otherOpen.length
          ? "other_controls_remain_open"
          : "target_only_verified",
    target_selector: targetDescriptor.selector,
    target_label: targetDescriptor.label || null,
    target_open: targetOpen,
    target_state_key: targetBinding.key,
    bound_content_transition_required: transitionRequired,
    bound_content_transition_verified: transitionVerified,
    other_open_selectors: otherOpen,
    fresh_page: true,
  };
}

export async function withIsolatedExpansionStatePage({
  context,
  url,
  descriptor,
  descriptors,
  timeoutMs = 45_000,
  preparePage = null,
  capture,
} = {}) {
  if (!context || !url || !descriptor || typeof capture !== "function") {
    throw new Error("Expansion state isolation requires a context, URL, descriptor, and capture callback.");
  }
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (response && response.status() >= 400) {
      throw new Error(`Expansion state navigation failed with HTTP ${response.status()} ${response.statusText()}`);
    }
    await page.waitForLoadState("networkidle", { timeout: Math.min(15_000, timeoutMs) }).catch(() => null);
    await page.evaluate(() => document.fonts?.ready).catch(() => null);
    if (typeof preparePage === "function") await preparePage(page);
    const opened = await openExpansionStateControl(page, { descriptor, descriptors });
    if (!opened.verified) {
      throw new Error(`Expansion state isolation failed for ${descriptor.selector}: ${opened.reason}`);
    }
    return await capture(page, opened);
  } finally {
    await page.close().catch(() => null);
  }
}

export async function openExpansionStateControl(page, { descriptor, descriptors = [] } = {}) {
  return evaluateWithVisibleTextVisibilitySemantics(page, evaluateExpansionStateIsolation, {
    targetDescriptor: descriptor,
    allDescriptors: Array.isArray(descriptors) && descriptors.length ? descriptors : [descriptor],
    openTarget: true,
  });
}

export async function verifyExpansionStateIsolation(page, { descriptor, descriptors = [] } = {}) {
  return evaluateWithVisibleTextVisibilitySemantics(page, evaluateExpansionStateIsolation, {
    targetDescriptor: descriptor,
    allDescriptors: Array.isArray(descriptors) && descriptors.length ? descriptors : [descriptor],
    openTarget: false,
  });
}
