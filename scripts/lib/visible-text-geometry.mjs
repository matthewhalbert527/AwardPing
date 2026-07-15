export async function captureVisibleTextGeometry(page, { capturedAt = null, stateId = "main" } = {}) {
  return page.evaluate(({ capturedAtValue, stateIdValue }) => {
    const body = document.body;
    const documentElement = document.documentElement;
    const documentWidth = Math.max(documentElement.scrollWidth, body?.scrollWidth || 0, window.innerWidth);
    const documentHeight = Math.max(documentElement.scrollHeight, body?.scrollHeight || 0, window.innerHeight);
    const tokenPattern = /[\p{L}\p{N}]+(?:[.,:/-](?=[\p{L}\p{N}])[\p{L}\p{N}]+)*|[^\s]/gu;
    const blockDisplays = new Set([
      "block",
      "flex",
      "grid",
      "list-item",
      "table",
      "table-row",
      "table-cell",
      "flow-root",
    ]);

    const round = (value) => Math.round(Number(value) * 100) / 100;

    function rectsForRange(range, clips = []) {
      return [...range.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => {
          let left = rect.left;
          let top = rect.top;
          let right = rect.right;
          let bottom = rect.bottom;
          for (const clip of clips) {
            if (clip.clip_x) {
              left = Math.max(left, clip.left);
              right = Math.min(right, clip.right);
            }
            if (clip.clip_y) {
              top = Math.max(top, clip.top);
              bottom = Math.min(bottom, clip.bottom);
            }
          }
          if (right <= left || bottom <= top) return null;
          return {
            x: round(left + window.scrollX),
            y: round(top + window.scrollY),
            width: round(right - left),
            height: round(bottom - top),
            right: round(right + window.scrollX),
            bottom: round(bottom + window.scrollY),
          };
        })
        .filter(Boolean)
        .filter((rect) =>
          rect.right > 0 && rect.bottom > 0 && rect.x < documentWidth && rect.y < documentHeight,
        );
    }

    function visibleTextContext(node) {
      const parent = node.parentElement;
      if (!(parent instanceof HTMLElement)) return null;
      if (!node.nodeValue || !/\S/u.test(node.nodeValue)) return null;
      if (parent.closest("[data-awardping-hidden-noise], [hidden], [aria-hidden='true']")) return null;
      if (parent.closest("script, style, noscript, template, canvas")) return null;
      const clips = [];
      let current = parent;
      while (current instanceof HTMLElement) {
        const style = window.getComputedStyle(current);
        const opacity = Number(style.opacity || 1);
        const filter = String(style.filter || "").replace(/\s+/g, "").toLowerCase();
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.contentVisibility === "hidden" ||
          !Number.isFinite(opacity) ||
          opacity <= 0 ||
          /opacity\((?:0|0\.0+|0%)\)/.test(filter)
        ) {
          return null;
        }
        const rect = current.getBoundingClientRect();
        if (style.display !== "contents" && (rect.width <= 0 || rect.height <= 0)) return null;
        const overflowX = String(style.overflowX || style.overflow || "visible").toLowerCase();
        const overflowY = String(style.overflowY || style.overflow || "visible").toLowerCase();
        const clipX = ["hidden", "clip", "scroll", "auto"].includes(overflowX);
        const clipY = ["hidden", "clip", "scroll", "auto"].includes(overflowY);
        const rootScroller = current === body || current === documentElement;
        if (!rootScroller && (clipX || clipY) && rect.width > 0 && rect.height > 0) {
          clips.push({
            left: rect.left + current.clientLeft,
            top: rect.top + current.clientTop,
            right: rect.left + current.clientLeft + current.clientWidth,
            bottom: rect.top + current.clientTop + current.clientHeight,
            clip_x: clipX,
            clip_y: clipY,
          });
        }
        current = current.parentElement;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      return rectsForRange(range, clips).length > 0 ? { parent, clips } : null;
    }

    function nearestBlock(element) {
      let current = element;
      while (current && current !== body) {
        if (blockDisplays.has(window.getComputedStyle(current).display)) return current;
        current = current.parentElement;
      }
      return body;
    }

    function selectorPath(element) {
      const parts = [];
      let current = element;
      while (current && current !== body && parts.length < 8) {
        const tag = current.tagName.toLowerCase();
        if (current.id) {
          parts.unshift(`${tag}#${CSS.escape(current.id)}`);
          break;
        }
        const siblings = current.parentElement
          ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName)
          : [];
        const position = siblings.indexOf(current) + 1;
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${position})` : tag);
        current = current.parentElement;
      }
      return ["body", ...parts].join(">");
    }

    const walker = document.createTreeWalker(body || documentElement, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let currentNode = walker.nextNode();
    let previousRawText = "";
    let previousBlock = null;
    while (currentNode) {
      const visibility = visibleTextContext(currentNode);
      if (visibility) {
        const rawText = currentNode.nodeValue || "";
        const parent = visibility.parent;
        const fullRange = document.createRange();
        fullRange.selectNodeContents(currentNode);
        const nodeRects = rectsForRange(fullRange, visibility.clips);
        const runs = [];
        for (const match of rawText.matchAll(tokenPattern)) {
          const start = match.index || 0;
          const end = start + match[0].length;
          const range = document.createRange();
          try {
            range.setStart(currentNode, start);
            range.setEnd(currentNode, end);
          } catch {
            continue;
          }
          const rects = rectsForRange(range, visibility.clips);
          if (!rects.length) continue;
          runs.push({ start, end, text: match[0], rects });
        }
        if (runs.length) {
          const currentBlock = nearestBlock(parent);
          const separatorBefore = nodes.length === 0
            ? ""
            : /\s$/u.test(previousRawText) || /^\s/u.test(rawText) || currentBlock !== previousBlock
              ? " "
              : "";
          nodes.push({
            order: nodes.length,
            path: selectorPath(parent),
            text: rawText,
            separator_before: separatorBefore,
            rects: nodeRects,
            runs,
          });
          previousRawText = rawText;
          previousBlock = currentBlock;
        }
      }
      currentNode = walker.nextNode();
    }

    return {
      version: 1,
      state_id: stateIdValue,
      captured_at: capturedAtValue,
      coordinate_space: "document-css-pixels",
      document: { width: documentWidth, height: documentHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      device_pixel_ratio: window.devicePixelRatio || 1,
      nodes,
    };
  }, {
    capturedAtValue: capturedAt,
    stateIdValue: stateId,
  });
}
