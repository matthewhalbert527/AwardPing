export async function discoverExpansionStateDescriptors(page, {
  maxControls = 8,
  relevanceMode = "award-content",
} = {}) {
  return page.evaluate(({ maxControlsValue, relevanceModeValue }) => {
    function normalizedText(element) {
      return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    }

    function visible(element) {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
        style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
    }

    function targetsFor(element) {
      const targets = [];
      for (const attr of ["aria-controls", "data-target", "data-bs-target", "href"]) {
        const value = element.getAttribute(attr);
        if (!value) continue;
        for (const token of value.split(/\s+/).filter(Boolean)) {
          const selector = token.startsWith("#")
            ? token
            : /^[A-Za-z][\w:-]*$/.test(token)
              ? `#${CSS.escape(token)}`
              : null;
          if (!selector) continue;
          try {
            for (const target of document.querySelectorAll(selector)) targets.push(target);
          } catch {
            // Ignore malformed third-party selectors.
          }
        }
      }
      return [...new Set(targets)];
    }

    function signalFor(element) {
      return [
        element.id,
        element.className,
        element.getAttribute("aria-label"),
        element.getAttribute("aria-controls"),
        element.getAttribute("data-target"),
        element.getAttribute("data-bs-target"),
        element.getAttribute("data-toggle"),
        element.getAttribute("data-bs-toggle"),
        element.getAttribute("href"),
        normalizedText(element),
        ...targetsFor(element).map(normalizedText),
      ].filter(Boolean).join(" ").toLowerCase();
    }

    function isCandidate(element) {
      if (!(element instanceof HTMLElement) || !visible(element)) return false;
      if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
      const tag = element.tagName.toLowerCase();
      const href = element.getAttribute("href") || "";
      if (tag === "a" && href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:")) {
        return false;
      }
      const interactive = ["button", "summary", "a"].includes(tag) ||
        ["button", "tab"].includes(element.getAttribute("role")) ||
        element.hasAttribute("onclick") || element.hasAttribute("tabindex") ||
        element.hasAttribute("aria-expanded") || element.hasAttribute("aria-controls") ||
        element.hasAttribute("data-target") || element.hasAttribute("data-bs-target") ||
        element.hasAttribute("data-toggle") || element.hasAttribute("data-bs-toggle");
      if (!interactive) return false;
      const signal = signalFor(element);
      if (/(menu|nav|navbar|search|login|log in|sign in|subscribe|newsletter|share|print|donate|cart|next|previous|prev|facebook|twitter|linkedin|instagram)/i.test(signal)) {
        return false;
      }
      const explicit =
        tag === "summary" ||
        element.getAttribute("aria-expanded") !== null ||
        element.getAttribute("aria-controls") ||
        element.getAttribute("data-target") ||
        element.getAttribute("data-bs-target") ||
        element.getAttribute("data-toggle") ||
        element.getAttribute("data-bs-toggle") ||
        element.closest("details, .accordion, [class*='accordion' i], [class*='faq' i], [id*='faq' i], [role='tablist']");
      const contentPattern = relevanceModeValue === "award-content"
        ? /\b(faq|questions?|answers?|eligib(?:le|ility)?|requirements?|criteria|nominations?|applications?|process|apply|guidelines?|instructions?|documents?|pdf|forms?|materials?|amount|tuition|stipend)\b/i
        : /\b(faq|questions?|answers?|expand|show|more|details|eligib(?:le|ility)?|requirements?|criteria|nominations?|applications?|process|apply|deadlines?|guidelines?|instructions?|documents?|pdf|forms?|awards?|grants?|materials?|amount|tuition|stipend)\b/i;
      return Boolean(explicit && contentPattern.test(signal));
    }

    function selectorFor(element) {
      if (element.id) return `#${CSS.escape(element.id)}`;
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
      "[onclick]",
      "[tabindex]",
      "[class*='accordion' i]",
      "[class*='toggle' i]",
      "[class*='elementor-tab-title' i]",
      "[class*='e-n-accordion-item-title' i]",
    ].join(", ");
    const seen = new Set();
    const controls = [...document.querySelectorAll(selector)].filter((control) => {
      if (!isCandidate(control)) return false;
      const selectorValue = selectorFor(control);
      if (seen.has(selectorValue)) return false;
      seen.add(selectorValue);
      return true;
    }).slice(0, Math.max(0, Number(maxControlsValue) || 0));

    return {
      candidates: controls.length,
      descriptors: controls.map((control, index) => ({
        index,
        selector: selectorFor(control),
        tag: control.tagName,
        id: control.id || null,
        label: normalizedText(control).slice(0, 120) || control.getAttribute("aria-label") || `Section ${index + 1}`,
        aria_controls: control.getAttribute("aria-controls") || null,
        data_target: control.getAttribute("data-target") || control.getAttribute("data-bs-target") || null,
        href: control.getAttribute("href") || null,
      })),
      base_text: document.body?.innerText || "",
    };
  }, {
    maxControlsValue: maxControls,
    relevanceModeValue: relevanceMode,
  });
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
  return page.evaluate(async ({ targetDescriptor, allDescriptors }) => {
    const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
    const normalizedText = (element) =>
      (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    const resolveDescriptor = (value) => {
      let element = null;
      try {
        element = document.querySelector(value.selector);
      } catch {
        return null;
      }
      if (!(element instanceof HTMLElement)) return null;
      if (value.tag && element.tagName !== value.tag) return null;
      if (value.id && element.id !== value.id) return null;
      if (value.aria_controls && element.getAttribute("aria-controls") !== value.aria_controls) return null;
      if (value.data_target) {
        const actual = element.getAttribute("data-target") || element.getAttribute("data-bs-target");
        if (actual !== value.data_target) return null;
      }
      if (value.href && element.getAttribute("href") !== value.href) return null;
      if (value.label && normalizedText(element).slice(0, 120) !== value.label) return null;
      return element;
    };
    const targetsFor = (element) => {
      const targets = [];
      for (const attr of ["aria-controls", "data-target", "data-bs-target", "href"]) {
        const value = element.getAttribute(attr);
        if (!value) continue;
        for (const token of value.split(/\s+/).filter(Boolean)) {
          const selector = token.startsWith("#")
            ? token
            : /^[A-Za-z][\w:-]*$/.test(token)
              ? `#${CSS.escape(token)}`
              : null;
          if (!selector) continue;
          try {
            for (const target of document.querySelectorAll(selector)) targets.push(target);
          } catch {
            // Ignore malformed third-party selectors.
          }
        }
      }
      return [...new Set(targets)];
    };
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return !element.hidden && element.getAttribute("aria-hidden") !== "true" && rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
    };
    const isOpen = (element) => {
      const details = element.closest("details");
      if (details) return details.open;
      const expanded = element.getAttribute("aria-expanded");
      if (expanded !== null) return expanded === "true";
      const targets = targetsFor(element);
      return targets.length > 0 && targets.some(visible);
    };
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
    const resolved = [];
    for (const value of allDescriptors) {
      const element = resolveDescriptor(value);
      if (!element) return { verified: false, reason: `descriptor_not_resolved:${value.selector}` };
      resolved.push({ descriptor: value, element });
    }

    for (const item of resolved) {
      if (item.element !== target && isOpen(item.element)) await click(item.element);
    }
    if (!isOpen(target)) await click(target);
    for (const item of resolved) {
      if (item.element !== target && isOpen(item.element)) await click(item.element);
    }

    const targetOpen = isOpen(target);
    const otherOpen = resolved
      .filter((item) => item.element !== target && isOpen(item.element))
      .map((item) => item.descriptor.selector);
    return {
      verified: targetOpen && otherOpen.length === 0,
      reason: !targetOpen ? "target_not_open" : otherOpen.length ? "other_controls_remain_open" : "target_only_verified",
      target_selector: targetDescriptor.selector,
      target_label: targetDescriptor.label || null,
      target_open: targetOpen,
      other_open_selectors: otherOpen,
      fresh_page: true,
    };
  }, {
    targetDescriptor: descriptor,
    allDescriptors: Array.isArray(descriptors) && descriptors.length ? descriptors : [descriptor],
  });
}

export async function verifyExpansionStateIsolation(page, { descriptor, descriptors = [] } = {}) {
  return page.evaluate(({ targetDescriptor, allDescriptors }) => {
    const resolveDescriptor = (value) => {
      try {
        const element = document.querySelector(value.selector);
        if (!(element instanceof HTMLElement)) return null;
        if (value.tag && element.tagName !== value.tag) return null;
        if (value.id && element.id !== value.id) return null;
        if (value.aria_controls && element.getAttribute("aria-controls") !== value.aria_controls) return null;
        return element;
      } catch {
        return null;
      }
    };
    const targetsFor = (element) => {
      const targets = [];
      for (const attr of ["aria-controls", "data-target", "data-bs-target", "href"]) {
        const value = element.getAttribute(attr);
        if (!value) continue;
        for (const token of value.split(/\s+/).filter(Boolean)) {
          const selector = token.startsWith("#")
            ? token
            : /^[A-Za-z][\w:-]*$/.test(token)
              ? `#${CSS.escape(token)}`
              : null;
          if (!selector) continue;
          try {
            for (const target of document.querySelectorAll(selector)) targets.push(target);
          } catch {
            // Ignore malformed third-party selectors.
          }
        }
      }
      return [...new Set(targets)];
    };
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return !element.hidden && element.getAttribute("aria-hidden") !== "true" && rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
    };
    const isOpen = (element) => {
      const details = element.closest("details");
      if (details) return details.open;
      const expanded = element.getAttribute("aria-expanded");
      if (expanded !== null) return expanded === "true";
      const targets = targetsFor(element);
      return targets.length > 0 && targets.some(visible);
    };
    const target = resolveDescriptor(targetDescriptor);
    if (!target) return { verified: false, reason: "stable_target_descriptor_not_resolved" };
    const otherOpen = [];
    for (const value of allDescriptors) {
      const element = resolveDescriptor(value);
      if (!element) return { verified: false, reason: `descriptor_not_resolved:${value.selector}` };
      if (element !== target && isOpen(element)) otherOpen.push(value.selector);
    }
    const targetOpen = isOpen(target);
    return {
      verified: targetOpen && otherOpen.length === 0,
      reason: !targetOpen ? "target_not_open" : otherOpen.length ? "other_controls_remain_open" : "target_only_verified",
      target_selector: targetDescriptor.selector,
      target_label: targetDescriptor.label || null,
      target_open: targetOpen,
      other_open_selectors: otherOpen,
      fresh_page: true,
    };
  }, {
    targetDescriptor: descriptor,
    allDescriptors: Array.isArray(descriptors) && descriptors.length ? descriptors : [descriptor],
  });
}
