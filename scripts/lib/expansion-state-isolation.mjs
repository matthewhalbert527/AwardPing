import {
  evaluateWithVisibleTextVisibilitySemantics,
} from "./visible-text-geometry.mjs";
import {
  canonicalizeExpansionStateDescriptors,
  MAX_RAW_EXPANSION_STATE_DESCRIPTORS,
} from "./expansion-state-descriptor-canonicalization.mjs";

export async function discoverExpansionStateDescriptors(page, {
  maxControls = 8,
  relevanceMode = "award-content",
} = {}) {
  if (!(Number(maxControls) > 0)) {
    return canonicalizeExpansionStateDescriptors({
      descriptors: [],
      raw_candidates: 0,
      raw_descriptor_set_complete: true,
      base_text: "",
    }, { maxControls: 0 });
  }
  const rawDiscovery = await page.evaluate(({ rawDescriptorLimitValue, relevanceModeValue }) => {
    function normalizedText(element) {
      return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    }

    function classText(element) {
      return typeof element?.className === "string" ? element.className : "";
    }

    function rawText(element) {
      return (element?.textContent || "").replace(/\s+/g, " ").trim();
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

    function expandableControlSurface(element) {
      if (!(element instanceof HTMLElement)) return false;
      const tag = element.tagName.toLowerCase();
      const role = (element.getAttribute("role") || "").toLowerCase();
      const signal = classText(element);
      return ["button", "summary"].includes(tag) || ["button", "tab"].includes(role) ||
        element.hasAttribute("aria-controls") || element.hasAttribute("aria-expanded") ||
        /accordion[^\s]*(?:toggle|title|button|header)|(?:toggle|title|button|header)[^\s]*accordion|elementor-tab-title|e-n-accordion-item-title/i
          .test(signal);
    }

    // Like expandableControlSurface, but for a control's DECLARED target:
    // Bootstrap 3 collapse stamps aria-expanded on the panel itself when it
    // opens, so a bare aria-expanded is state mirroring there, never a
    // control surface.
    function declaredTargetPanelSurface(element) {
      if (!(element instanceof HTMLElement)) return false;
      const tag = element.tagName.toLowerCase();
      const role = (element.getAttribute("role") || "").toLowerCase();
      const signal = classText(element);
      return ["button", "summary"].includes(tag) || ["button", "tab"].includes(role) ||
        element.hasAttribute("aria-controls") ||
        /accordion[^\s]*(?:toggle|title|button|header)|(?:toggle|title|button|header)[^\s]*accordion|elementor-tab-title|e-n-accordion-item-title/i
          .test(signal);
    }

    function logicalStateKeyFor(panelSelectors) {
      const selectors = [...new Set(panelSelectors.filter(Boolean))].sort();
      return selectors.length ? `logical-panels:${JSON.stringify(selectors)}` : "";
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
      // Carousel navigation (Bootstrap data-bs-slide/-to) cycles slides inside
      // an always-visible region; it is never an expansion control.
      if (element.hasAttribute("data-bs-slide-to") || element.hasAttribute("data-slide-to") ||
          element.hasAttribute("data-bs-slide") || element.hasAttribute("data-slide")) {
        return false;
      }
      const role = (element.getAttribute("role") || "").toLowerCase();
      const toggle = (element.getAttribute("data-toggle") || element.getAttribute("data-bs-toggle") || "")
        .toLowerCase();
      if (entry.attr === "aria-controls" && element.getAttribute("aria-expanded") !== null) return true;
      if (role === "tab" || ["accordion", "collapse", "tab"].includes(toggle)) return true;
      // A fragment link with no expansion semantics of its own whose target is
      // already visible and holds no unique collapsed drawer is in-page
      // navigation (a scroll target), never an expansion control.
      if (entry.attr === "href" && element.getAttribute("aria-expanded") === null &&
          !element.hasAttribute("aria-controls") && visiblePanel(entry.element) &&
          !uniqueCollapsedDescendant(entry.element, element)) {
        return false;
      }
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
        const panelSelectors = boundPanels.map(selectorFor);
        return {
          kind: "details",
          key: `details:${stateSelector}`,
          state_selectors: [stateSelector],
          panel_selectors: panelSelectors,
          logical_state_key: logicalStateKeyFor(panelSelectors),
          logical_panel_valid: true,
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
          // A DECLARED target may carry aria-expanded as pure state mirroring
          // (Bootstrap 3 collapse stamps it on the panel when opened), so a
          // bare aria-expanded never invalidates a declared-target panel; the
          // control-surface signals that do are unchanged.
          logical_state_key: logicalStateKeyFor(panelSelectors),
          logical_panel_valid: panels.every((panel) => !declaredTargetPanelSurface(panel)),
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
          logical_state_key: logicalStateKeyFor([panelSelector]),
          logical_panel_valid: !expandableControlSurface(adjacentPanel),
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
              rawText(element));
          } catch {
            return [];
          }
        })
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    }

    function accordionGroupTextFor(element) {
      const group = element.closest([
        ".elementor-widget-accordion",
        ".elementor-accordion",
        "[data-accordion]",
        "[role='tablist']",
        ".accordions-container",
      ].join(", "));
      return rawText(group).toLowerCase();
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
      return contentPattern.test(
        `${controlSignal} ${boundTextFor(binding)} ${accordionGroupTextFor(element)}`,
      ) ? binding : null;
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
    const rawDescriptorLimit = Math.max(1, Number(rawDescriptorLimitValue) || 1);
    let candidateCount = 0;
    for (const control of document.querySelectorAll(selector)) {
      const binding = isCandidate(control);
      if (!binding) continue;
      const selectorValue = selectorFor(control);
      if (seenControls.has(selectorValue) || seenStates.has(binding.key)) continue;
      seenControls.add(selectorValue);
      seenStates.add(binding.key);
      candidateCount += 1;
      if (controls.length < rawDescriptorLimit) controls.push({ control, binding });
    }

    return {
      raw_candidates: candidateCount,
      raw_descriptor_set_complete: candidateCount === controls.length,
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
        logical_state_key: binding.logical_state_key,
        logical_panel_valid: binding.logical_panel_valid,
      })),
      base_text: document.body?.innerText || "",
    };
  }, {
    rawDescriptorLimitValue: MAX_RAW_EXPANSION_STATE_DESCRIPTORS,
    relevanceModeValue: relevanceMode,
  });
  return canonicalizeExpansionStateDescriptors(rawDiscovery, { maxControls });
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

  const expandableControlSurface = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();
    return ["button", "summary"].includes(tag) || ["button", "tab"].includes(role) ||
      element.hasAttribute("aria-controls") || element.hasAttribute("aria-expanded") ||
      /accordion[^\s]*(?:toggle|title|button|header)|(?:toggle|title|button|header)[^\s]*accordion|elementor-tab-title|e-n-accordion-item-title/i
        .test(classText(element));
  };

  // Declared-target variant: Bootstrap 3 collapse stamps aria-expanded on the
  // open panel itself, so a bare aria-expanded on a control's declared target
  // is state mirroring, never a control surface.
  const declaredTargetPanelSurface = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();
    return ["button", "summary"].includes(tag) || ["button", "tab"].includes(role) ||
      element.hasAttribute("aria-controls") ||
      /accordion[^\s]*(?:toggle|title|button|header)|(?:toggle|title|button|header)[^\s]*accordion|elementor-tab-title|e-n-accordion-item-title/i
        .test(classText(element));
  };

  const logicalBindingKey = (binding) => {
    const selectors = [...new Set((binding?.panels || []).map(selectorFor))].sort();
    return selectors.length ? `logical-panels:${JSON.stringify(selectors)}` : "";
  };

  const visiblePanel = (element) => {
    if (!(element instanceof HTMLElement) || element.hidden || element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const closedDetails = element.closest("details:not([open])");
    if (closedDetails && !element.closest("summary")) return false;
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
        logicalPanelValid: true,
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
        logicalPanelValid: panels.every((panel) => !declaredTargetPanelSurface(panel)),
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
        logicalPanelValid: !expandableControlSurface(panel),
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
    if (!binding.logicalPanelValid) return false;
    if (value.state_kind && binding.kind !== value.state_kind) return false;
    const exactStateMatch = Boolean(value.state_key) && binding.key === value.state_key;
    const structuralMatch = Boolean(value.structural_fingerprint) &&
      binding.structuralFingerprint === value.structural_fingerprint;
    // Stable-identity recovery: SPA frameworks (ServiceNow) re-render with
    // drifting DOM shapes between loads, so the content-derived state key and
    // structural fingerprint both fail while the control's own identity — its
    // aria-controls id plus its label — is byte-exact. Binding validity was
    // already required above and the isolation still proves the panel actually
    // transitions after binding, so an exact aria-controls + label pair may
    // stand in for the drifted fingerprints.
    const stableIdentityMatch = Boolean(value.aria_controls) &&
      element.getAttribute("aria-controls") === value.aria_controls &&
      Boolean(value.label) && controlLabel(element) === value.label;
    const expectedLogicalKey = typeof value.logical_state_key === "string"
      ? value.logical_state_key
      : "";
    if (
      expectedLogicalKey &&
      logicalBindingKey(binding) !== expectedLogicalKey &&
      !exactStateMatch &&
      !structuralMatch &&
      !stableIdentityMatch
    ) return false;
    if ((value.state_key || value.structural_fingerprint) && !exactStateMatch && !structuralMatch && !stableIdentityMatch) return false;

    if (mode === "structural") return structuralMatch;
    if (mode === "semantic") {
      return exactStateMatch || structuralMatch || stableIdentityMatch ||
        !value.label || controlLabel(element) === value.label;
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

  const boundContentSnapshot = (binding, control) => ({
    panels_visible: binding.panels.length > 0 && binding.panels.every(visiblePanel),
    panels_readable: binding.panels.length > 0 &&
      binding.panels.every((panel) => readablePanelEvidence(panel, control).readable),
    signature: JSON.stringify(binding.panels.map((panel) => {
      const rect = panel.getBoundingClientRect();
      const readable = readablePanelEvidence(panel, control);
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

  // jQuery-animated accordions (WPBakery slideUp/slideDown and kin) ignore the
  // capture CSS that freezes CSS transitions, so a click landing mid-animation
  // gets queued or swallowed and the binding never reaches the expected state
  // inside the verification window. Wait for the bound panels to stop moving
  // before acting; the proof requirements themselves are unchanged.
  const waitForBindingQuiescence = async (binding, maxMs = 2_000) => {
    if (!binding?.panels?.length) return;
    const startedAt = Date.now();
    let last = binding.panels.map((panel) => Math.round(panel.getBoundingClientRect().height)).join("|");
    let stableSince = Date.now();
    while (Date.now() - startedAt < maxMs) {
      await delay(80);
      const current = binding.panels.map((panel) => Math.round(panel.getBoundingClientRect().height)).join("|");
      if (current !== last) { last = current; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= 240) return;
    }
  };

  const click = async (element, binding = null) => {
    if (binding) await waitForBindingQuiescence(binding);
    element.scrollIntoView({ block: "center", inline: "nearest" });
    await delay(50);
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.click();
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    await delay(40);
  };

  const waitForBindingState = async ({
    element,
    binding,
    expectedOpen,
    previousSignature = null,
    timeoutMs = 2_000,
  }) => {
    const deadline = Date.now() + timeoutMs;
    let previousStableSignature = null;
    let stableSamples = 0;
    let latest = boundContentSnapshot(binding, element);
    while (Date.now() <= deadline) {
      latest = boundContentSnapshot(binding, element);
      const open = isOpen({ element, binding });
      const desiredState = expectedOpen
        ? open && latest.panels_readable
        : !open && !latest.panels_readable;
      const transitioned = previousSignature === null || latest.signature !== previousSignature;
      if (desiredState && transitioned) {
        if (latest.signature === previousStableSignature) stableSamples += 1;
        else stableSamples = 1;
        previousStableSignature = latest.signature;
        if (stableSamples >= 2) {
          return { verified: true, open, snapshot: latest };
        }
      } else {
        stableSamples = 0;
        previousStableSignature = null;
      }
      await delay(60);
    }
    return {
      verified: false,
      open: isOpen({ element, binding }),
      snapshot: latest,
    };
  };

  // Accordion families whose exact DOM contract we can verify end to end: the
  // control, its single bound panel, the per-item wrapper, and the exclusive
  // container. For these we run a deterministic close-peers -> close-target ->
  // open-target transition instead of the generic heuristics, which cannot
  // prove a transition for a panel the page opens by default.
  const exactAccordionFamilies = [
    {
      family: "elementor",
      controlSelector: ".elementor-tab-title[role='button'][aria-controls]",
      itemSelector: ".elementor-accordion-item",
      containerSelector: ".elementor-accordion",
      // Elementor controls carry aria-expanded, so a peer in another widget can
      // be closed and that close can be verified from its own ARIA state.
      peerScope: "document",
      panelValid: (element, panel, item) => {
        const panelId = element.getAttribute("aria-controls") || "";
        return Boolean(panelId) && panel.id === panelId &&
          panel.classList.contains("elementor-tab-content") &&
          panel.closest(".elementor-accordion-item") === item;
      },
    },
    {
      // WPBakery/Visual Composer accordions carry no ARIA at all: the open
      // state is the panel wrapper's vc_active class plus a displayed body.
      // The heading anchor's href points at the wrapper, so the bound panel
      // must be the body -- the wrapper also holds the always-visible heading.
      family: "vc_tta",
      controlSelector: ".vc_tta-panel-heading a[href^='#']",
      itemSelector: ".vc_tta-panel",
      containerSelector: ".vc_tta",
      // Only same-container exclusivity is observable without ARIA, so peers
      // are discovered within the target's own accordion. Controls outside it
      // are still handled through the caller's descriptor set, exactly as
      // before this family existed.
      peerScope: "container",
      panelValid: (element, panel, item) =>
        panel.classList.contains("vc_tta-panel-body") &&
        panel.closest(".vc_tta-panel") === item &&
        element.closest(".vc_tta-panel") === item,
    },
  ];

  const exactAccordionBinding = (element, binding) => {
    if (!(element instanceof HTMLElement) || binding.panels.length !== 1) return null;
    for (const spec of exactAccordionFamilies) {
      if (!element.matches(spec.controlSelector)) continue;
      const item = element.closest(spec.itemSelector);
      if (!(item instanceof HTMLElement)) continue;
      if (!(element.closest(spec.containerSelector) instanceof HTMLElement)) continue;
      if (!spec.panelValid(element, binding.panels[0], item)) continue;
      return spec;
    }
    return null;
  };

  const closeNonTargetBinding = async (item) => {
    const beforeClose = boundContentSnapshot(item.binding, item.element);
    if (!beforeClose.panels_readable && !isOpen(item)) {
      return { verified: true, snapshot: beforeClose };
    }
    if (item.element.getAttribute("aria-expanded") === "false" && beforeClose.panels_readable) {
      return {
        verified: false,
        reason: "other_control_aria_false_but_content_readable",
        snapshot: beforeClose,
      };
    }
    await click(item.element, item.binding);
    const closed = await waitForBindingState({
      element: item.element,
      binding: item.binding,
      expectedOpen: false,
      previousSignature: beforeClose.signature,
    });
    return closed.verified
      ? closed
      : { ...closed, reason: "other_control_content_did_not_close" };
  };

  const explicitExclusiveGroupKey = (element, binding) => {
    if (!(element instanceof HTMLElement) || !binding?.panels?.length) return "";

    if (
      element.getAttribute("role") === "tab" &&
      element.hasAttribute("aria-controls") &&
      binding.panels.every((panel) => panel.getAttribute("role") === "tabpanel")
    ) {
      const tablist = element.closest("[role='tablist']");
      if (tablist instanceof HTMLElement) return `aria-tablist:${selectorFor(tablist)}`;
    }

    if (binding.kind === "details") {
      const details = binding.stateElements[0];
      const name = details instanceof HTMLElement ? details.getAttribute("name")?.trim() : "";
      if (name) {
        const peers = [...document.querySelectorAll("details[name]")]
          .filter((candidate) => candidate.getAttribute("name") === name);
        if (peers.length > 1) return `details-name:${JSON.stringify(name)}`;
      }
    }

    const parentTokens = [...new Set(binding.panels
      .map((panel) => panel.getAttribute("data-bs-parent") || panel.getAttribute("data-parent") || "")
      .map((value) => value.trim())
      .filter(Boolean))];
    if (parentTokens.length === 1) {
      try {
        const parent = document.querySelector(parentTokens[0]);
        if (parent instanceof HTMLElement) return `collapse-parent:${selectorFor(parent)}`;
      } catch {
        // An invalid selector cannot prove mutual exclusion.
      }
    }
    return "";
  };

  const target = resolveDescriptor(targetDescriptor);
  if (!target) return { verified: false, reason: "stable_target_descriptor_not_resolved" };
  const targetBinding = stateBindingFor(target);
  if (!targetBinding || !targetBinding.logicalPanelValid) {
    return { verified: false, reason: "stable_target_state_not_resolved" };
  }
  const targetLogicalKey = logicalBindingKey(targetBinding);
  if (!targetLogicalKey) {
    return { verified: false, reason: "stable_target_logical_panel_not_resolved" };
  }

  const resolvedByLogicalKey = new Map();
  for (const value of allDescriptors) {
    const element = resolveDescriptor(value);
    if (!element) return { verified: false, reason: `descriptor_not_resolved:${value.selector}` };
    const binding = stateBindingFor(element);
    if (!binding || !binding.logicalPanelValid) {
      return { verified: false, reason: `descriptor_state_not_resolved:${value.selector}` };
    }
    const logicalKey = logicalBindingKey(binding);
    if (!logicalKey) {
      return { verified: false, reason: `descriptor_logical_panel_not_resolved:${value.selector}` };
    }
    if (!resolvedByLogicalKey.has(logicalKey)) {
      resolvedByLogicalKey.set(logicalKey, { descriptor: value, element, binding, logicalKey });
    }
  }

  const targetExactAccordion = exactAccordionBinding(target, targetBinding);
  if (targetExactAccordion) {
    const peerRoot = targetExactAccordion.peerScope === "container"
      ? (target.closest(targetExactAccordion.containerSelector) || document)
      : document;
    for (const element of peerRoot.querySelectorAll(targetExactAccordion.controlSelector)) {
      const binding = stateBindingFor(element);
      if (!binding || !binding.logicalPanelValid) continue;
      if (exactAccordionBinding(element, binding) !== targetExactAccordion) continue;
      const logicalKey = logicalBindingKey(binding);
      if (!logicalKey || resolvedByLogicalKey.has(logicalKey)) continue;
      resolvedByLogicalKey.set(logicalKey, {
        descriptor: {
          selector: selectorFor(element),
          label: controlLabel(element),
          logical_state_key: logicalKey,
        },
        element,
        binding,
        logicalKey,
      });
    }
  }
  const targetExplicitExclusiveGroupKey = explicitExclusiveGroupKey(target, targetBinding);
  if (!targetExactAccordion && targetExplicitExclusiveGroupKey) {
    const exclusiveControlSelector = [
      "summary",
      "button",
      "[role='button']",
      "[role='tab']",
      "a[href^='#']",
      "[aria-controls]",
      "[data-target]",
      "[data-bs-target]",
    ].join(", ");
    let groupPeerCount = 0;
    for (const element of document.querySelectorAll(exclusiveControlSelector)) {
      const binding = stateBindingFor(element);
      if (!binding || !binding.logicalPanelValid) continue;
      if (explicitExclusiveGroupKey(element, binding) !== targetExplicitExclusiveGroupKey) continue;
      groupPeerCount += 1;
      if (groupPeerCount > 512) {
        return { verified: false, reason: "exclusive_group_peer_limit_exceeded" };
      }
      const logicalKey = logicalBindingKey(binding);
      if (!logicalKey || resolvedByLogicalKey.has(logicalKey)) continue;
      resolvedByLogicalKey.set(logicalKey, {
        descriptor: {
          selector: selectorFor(element),
          label: controlLabel(element),
          logical_state_key: logicalKey,
        },
        element,
        binding,
        logicalKey,
      });
    }
  }
  const resolved = [...resolvedByLogicalKey.values()];

  let transitionRequired = false;
  let transitionVerified = true;
  if (openTarget) {
    if (targetExactAccordion) {
      const targetAccordion = target.closest(targetExactAccordion.containerSelector);
      const sameAccordionOpen = [];
      for (const item of resolved) {
        if (item.logicalKey === targetLogicalKey || !isOpen(item)) continue;
        if (item.element.closest(targetExactAccordion.containerSelector) === targetAccordion) {
          sameAccordionOpen.push(item);
          continue;
        }
        const beforeClose = boundContentSnapshot(item.binding, item.element);
        await click(item.element, item.binding);
        const closed = await waitForBindingState({
          element: item.element,
          binding: item.binding,
          expectedOpen: false,
          previousSignature: beforeClose.signature,
        });
        if (!closed.verified) {
          return {
            verified: false,
            reason: "other_control_could_not_close",
            target_selector: targetDescriptor.selector,
            target_label: targetDescriptor.label || null,
            target_open: false,
            target_state_key: targetBinding.key,
            bound_content_transition_required: true,
            bound_content_transition_verified: false,
            other_open_selectors: [item.descriptor.selector],
            fresh_page: true,
          };
        }
      }

      if (isOpen({ element: target, binding: targetBinding })) {
        const beforeClose = boundContentSnapshot(targetBinding, target);
        await click(target, targetBinding);
        let closed = await waitForBindingState({
          element: target,
          binding: targetBinding,
          expectedOpen: false,
          previousSignature: beforeClose.signature,
        });
        if (!closed.verified) {
          // A configured-active section in an exclusive accordion ignores
          // self-clicks (WPBakery collapsible off), but opening any closed
          // peer still closes it. Prove the transition by cycling through a
          // peer, exactly as the ARIA-tab path does; every proof below - the
          // target must then open with a signature change and every sibling
          // must end closed - still runs unchanged.
          const cyclePeer = resolved.find((item) =>
            item.logicalKey !== targetLogicalKey &&
            item.element.closest(targetExactAccordion.containerSelector) === targetAccordion &&
            !isOpen(item));
          if (!cyclePeer) {
            return { verified: false, reason: "target_could_not_close_for_transition" };
          }
          await click(cyclePeer.element, cyclePeer.binding);
          closed = await waitForBindingState({
            element: target,
            binding: targetBinding,
            expectedOpen: false,
            previousSignature: beforeClose.signature,
          });
          if (!closed.verified) {
            return { verified: false, reason: "target_could_not_close_for_transition" };
          }
        }
      }

      const beforeTarget = boundContentSnapshot(targetBinding, target);
      transitionRequired = true;
      await click(target, targetBinding);
      const opened = await waitForBindingState({
        element: target,
        binding: targetBinding,
        expectedOpen: true,
        previousSignature: beforeTarget.signature,
      });
      transitionVerified = opened.verified && opened.snapshot.panels_readable &&
        opened.snapshot.signature !== beforeTarget.signature;
      for (const item of sameAccordionOpen) {
        const closed = await waitForBindingState({
          element: item.element,
          binding: item.binding,
          expectedOpen: false,
        });
        if (!closed.verified) transitionVerified = false;
      }
    } else {
      const targetExclusiveGroupKey = explicitExclusiveGroupKey(target, targetBinding);
      const exclusivePeers = [];
      for (const item of resolved) {
        if (item.logicalKey === targetLogicalKey) continue;
        const peerExclusiveGroupKey = explicitExclusiveGroupKey(item.element, item.binding);
        if (targetExclusiveGroupKey && peerExclusiveGroupKey === targetExclusiveGroupKey) {
          exclusivePeers.push({
            ...item,
            beforeTarget: boundContentSnapshot(item.binding, item.element),
            openBeforeTarget: isOpen(item),
          });
          continue;
        }
        const closed = await closeNonTargetBinding(item);
        if (!closed.verified) {
          return {
            verified: false,
            reason: closed.reason,
            target_selector: targetDescriptor.selector,
            target_label: targetDescriptor.label || null,
            target_open: false,
            target_state_key: targetBinding.key,
            bound_content_transition_required: false,
            bound_content_transition_verified: false,
            other_open_selectors: [item.descriptor.selector],
            fresh_page: true,
          };
        }
      }
      const targetInitiallyOpen = isOpen({ element: target, binding: targetBinding });
      let forcedExclusiveTransition = false;
      if (targetInitiallyOpen && targetExclusiveGroupKey) {
        const switchPeer = exclusivePeers.find((item) =>
          !item.openBeforeTarget && !item.beforeTarget.panels_readable);
        if (!switchPeer) {
          return {
            verified: false,
            reason: "exclusive_transition_peer_unavailable",
            target_selector: targetDescriptor.selector,
            target_label: targetDescriptor.label || null,
            target_open: true,
            target_state_key: targetBinding.key,
            bound_content_transition_required: true,
            bound_content_transition_verified: false,
            other_open_selectors: [],
            fresh_page: true,
          };
        }
        const targetBeforeSwitch = boundContentSnapshot(targetBinding, target);
        const peerBeforeSwitch = switchPeer.beforeTarget;
        await click(switchPeer.element);
        const peerOpened = await waitForBindingState({
          element: switchPeer.element,
          binding: switchPeer.binding,
          expectedOpen: true,
          previousSignature: peerBeforeSwitch.signature,
        });
        const targetClosed = await waitForBindingState({
          element: target,
          binding: targetBinding,
          expectedOpen: false,
          previousSignature: targetBeforeSwitch.signature,
        });
        if (!peerOpened.verified || !targetClosed.verified) {
          return {
            verified: false,
            reason: "exclusive_transition_peer_did_not_replace_target",
            target_selector: targetDescriptor.selector,
            target_label: targetDescriptor.label || null,
            target_open: isOpen({ element: target, binding: targetBinding }),
            target_state_key: targetBinding.key,
            bound_content_transition_required: true,
            bound_content_transition_verified: false,
            other_open_selectors: [switchPeer.descriptor.selector],
            fresh_page: true,
          };
        }
        switchPeer.beforeTarget = peerOpened.snapshot;
        switchPeer.openBeforeTarget = true;
        forcedExclusiveTransition = true;
      }

      const beforeTarget = boundContentSnapshot(targetBinding, target);
      const expandedBefore = target.getAttribute("aria-expanded");
      const targetOpenBeforeActivation = isOpen({ element: target, binding: targetBinding });
      if (!targetOpenBeforeActivation) await click(target, targetBinding);
      const opened = targetOpenBeforeActivation
        ? { verified: true, snapshot: boundContentSnapshot(targetBinding, target) }
        : await waitForBindingState({
            element: target,
            binding: targetBinding,
            expectedOpen: true,
            previousSignature: beforeTarget.signature,
          });
      const afterTarget = opened.snapshot;
      const noAriaState = expandedBefore === null && targetBinding.kind !== "details";
      transitionRequired = forcedExclusiveTransition || noAriaState || expandedBefore === "false";
      transitionVerified = !transitionRequired || (
        !targetOpenBeforeActivation &&
        opened.verified &&
        afterTarget.panels_readable &&
        beforeTarget.signature !== afterTarget.signature
      );
      for (const item of exclusivePeers) {
        if (!item.openBeforeTarget && !item.beforeTarget.panels_readable) continue;
        const closed = await waitForBindingState({
          element: item.element,
          binding: item.binding,
          expectedOpen: false,
          previousSignature: item.beforeTarget.signature,
        });
        if (!closed.verified) transitionVerified = false;
      }
      for (const item of resolved) {
        if (item.logicalKey === targetLogicalKey) continue;
        if (targetExclusiveGroupKey &&
          explicitExclusiveGroupKey(item.element, item.binding) === targetExclusiveGroupKey) continue;
        const closed = await closeNonTargetBinding(item);
        if (!closed.verified) transitionVerified = false;
      }
    }
  }

  const targetOpen = isOpen({ element: target, binding: targetBinding }) && transitionVerified;
  const otherOpen = resolved
    .filter((item) => item.logicalKey !== targetLogicalKey && (
      isOpen(item) || boundContentSnapshot(item.binding, item.element).panels_readable
    ))
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
    exact_elementor_binding: targetExactAccordion?.family === "elementor",
    exact_accordion_family: targetExactAccordion ? targetExactAccordion.family : null,
    other_open_selectors: otherOpen,
    // The provably-inert proof signal (docs/stage1-inert-expansion-candidates
    // option C): a control that claims the open state while its bound content
    // never became visible responded to the interaction - the page simply has
    // nothing to reveal. A control that never responds must stay a failure.
    control_claims_open: target.getAttribute("aria-expanded") === "true",
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
      // Name what the settled page actually was when resolution fails — a SPA
      // that re-routed or a hidden region reads identically to a missing
      // control without this.
      const pageState = await page.evaluate(() => ({
        url: location.href.slice(0, 120),
        title: (document.title || "").slice(0, 80),
        aria_controls: [...document.querySelectorAll("[aria-controls]")]
          .map((el) => el.getAttribute("aria-controls")).slice(0, 12),
        text_length: (document.body?.innerText || "").length,
      })).catch(() => null);
      throw new Error(`Expansion state isolation failed for ${descriptor.selector}: ${opened.reason} control_claims_open=${opened.control_claims_open === true} page_state=${JSON.stringify(pageState)}`);
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
