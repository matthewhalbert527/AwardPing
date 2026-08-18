import { randomUUID } from "node:crypto";

export const MIN_VISIBLE_TEXT_PAINT_ALPHA = 0.01;
export const MIN_VISIBLE_TEXT_CONTRAST_RATIO = 1.05;
// Retained only so older diagnostics can prove that the former page-visible
// helper is absent. Production capture never reads or writes this key.
export const VISIBLE_TEXT_VISIBILITY_API_KEY = "__awardPingVisibleTextVisibilityV4";

function createVisibleTextVisibilitySemantics({ minContrastRatioValue, minPaintAlphaValue }) {
    const nativeGetComputedStyle = globalThis.getComputedStyle;
    const protectedGetComputedStyle = (element, pseudo = null) =>
      Reflect.apply(nativeGetComputedStyle, window, [element, pseudo]);
    const epsilon = 1e-9;
    const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));

    const parseUnitAlpha = (token, fallback = 1) => {
      const normalized = String(token || "").trim();
      if (!normalized) return fallback;
      const parsed = Number.parseFloat(normalized);
      if (!Number.isFinite(parsed)) return fallback;
      return clamp(normalized.endsWith("%") ? parsed / 100 : parsed);
    };

    const parseColorChannel = (token) => {
      const normalized = String(token || "").trim();
      const parsed = Number.parseFloat(normalized);
      if (!Number.isFinite(parsed)) return null;
      return clamp(normalized.endsWith("%") ? parsed * 2.55 : parsed, 0, 255);
    };

    const parseCssColor = (value) => {
      const normalized = String(value || "").trim().toLowerCase();
      if (!normalized) return null;
      if (normalized === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
      const hex = normalized.match(/^#([0-9a-f]{3,8})$/i)?.[1] || "";
      if (hex) {
        const expanded = hex.length === 3 || hex.length === 4
          ? [...hex].map((character) => `${character}${character}`).join("")
          : hex;
        if (expanded.length === 6 || expanded.length === 8) {
          return {
            r: Number.parseInt(expanded.slice(0, 2), 16),
            g: Number.parseInt(expanded.slice(2, 4), 16),
            b: Number.parseInt(expanded.slice(4, 6), 16),
            a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
          };
        }
      }
      const rgb = normalized.match(/^rgba?\((.*)\)$/i)?.[1] || null;
      if (rgb !== null) {
        const [channelsPart, slashAlpha] = rgb.split(/\s*\/\s*/, 2);
        const channels = channelsPart.replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
        let alphaToken = slashAlpha || null;
        if (!alphaToken && channels.length === 4) alphaToken = channels.pop();
        if (channels.length !== 3) return null;
        const parsedChannels = channels.map(parseColorChannel);
        if (parsedChannels.some((channel) => channel === null)) return null;
        return {
          r: parsedChannels[0],
          g: parsedChannels[1],
          b: parsedChannels[2],
          a: parseUnitAlpha(alphaToken, 1),
        };
      }
      const srgb = normalized.match(/^color\(srgb\s+(.+)\)$/i)?.[1] || null;
      if (srgb !== null) {
        const [channelsPart, slashAlpha] = srgb.split(/\s*\/\s*/, 2);
        const channels = channelsPart.trim().split(/\s+/).filter(Boolean).map(Number);
        if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
        return {
          r: clamp(channels[0]) * 255,
          g: clamp(channels[1]) * 255,
          b: clamp(channels[2]) * 255,
          a: parseUnitAlpha(slashAlpha, 1),
        };
      }
      return null;
    };

    const filterOpacity = (value) => {
      let alpha = 1;
      for (const match of String(value || "").matchAll(/opacity\(\s*([+-]?(?:\d+\.?\d*|\.\d+)%?)\s*\)/gi)) {
        alpha *= parseUnitAlpha(match[1], 1);
      }
      return alpha;
    };

    const hasUnresolvedColorFilter = (value) => {
      const remaining = String(value || "")
        .replace(/opacity\([^)]*\)/gi, "")
        .replace(/\bnone\b/gi, "")
        .trim();
      return remaining.length > 0;
    };

    const hasUnresolvedMask = (style) => [
      style.maskImage,
      style.webkitMaskImage,
      style.webkitMaskBoxImageSource,
    ].some((value) => {
      const normalized = String(value || "none").trim().toLowerCase();
      return normalized && normalized !== "none";
    });

    const compositeOver = (foreground, background) => {
      const alpha = clamp(foreground.a);
      return {
        r: foreground.r * alpha + background.r * (1 - alpha),
        g: foreground.g * alpha + background.g * (1 - alpha),
        b: foreground.b * alpha + background.b * (1 - alpha),
        a: 1,
      };
    };

    const relativeLuminance = (color) => {
      const linear = [color.r, color.g, color.b].map((channel) => {
        const srgb = clamp(channel, 0, 255) / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };

    const contrastRatio = (first, second) => {
      const firstLuminance = relativeLuminance(first);
      const secondLuminance = relativeLuminance(second);
      return (Math.max(firstLuminance, secondLuminance) + 0.05) /
        (Math.min(firstLuminance, secondLuminance) + 0.05);
    };

    const boxLength = (value, referenceLength) => {
      const normalized = String(value || "0").trim().toLowerCase();
      const parsed = Number.parseFloat(normalized);
      if (!Number.isFinite(parsed)) return null;
      if (normalized.endsWith("%")) return referenceLength * parsed / 100;
      if (normalized.endsWith("px") || /^[-+]?\d*\.?\d+$/.test(normalized)) return parsed;
      return null;
    };

    const backgroundPaintCoverageShapes = (element, style) => {
      if (style.display === "contents") return null;
      const backgroundClips = String(style.backgroundClip || "border-box")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      const backgroundClip = backgroundClips.at(-1) || "border-box";
      if (!["border-box", "padding-box", "content-box"].includes(backgroundClip)) return null;
      const border = {
        top: boxLength(style.borderTopWidth, 0),
        right: boxLength(style.borderRightWidth, 0),
        bottom: boxLength(style.borderBottomWidth, 0),
        left: boxLength(style.borderLeftWidth, 0),
      };
      const padding = {
        top: boxLength(style.paddingTop, 0),
        right: boxLength(style.paddingRight, 0),
        bottom: boxLength(style.paddingBottom, 0),
        left: boxLength(style.paddingLeft, 0),
      };
      if ([...Object.values(border), ...Object.values(padding)].some((value) => value === null)) return null;
      // Even when the color extends through the border box, use the padding
      // box as the proven subset so a painted border cannot be mistaken for
      // the card's solid background beneath absolutely positioned text.
      const insets = {
        top: border.top + (backgroundClip === "content-box" ? padding.top : 0),
        right: border.right + (backgroundClip === "content-box" ? padding.right : 0),
        bottom: border.bottom + (backgroundClip === "content-box" ? padding.bottom : 0),
        left: border.left + (backgroundClip === "content-box" ? padding.left : 0),
      };
      const radiusValue = (value, width, height) => {
        const tokens = String(value || "0").trim().split(/\s+/).filter(Boolean);
        if (!tokens.length || tokens.length > 2) return null;
        const x = boxLength(tokens[0], width);
        const y = boxLength(tokens[1] || tokens[0], height);
        return x === null || y === null ? null : { x: Math.max(0, x), y: Math.max(0, y) };
      };
      return [...element.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => {
          const outerRadii = {
            topLeft: radiusValue(style.borderTopLeftRadius, rect.width, rect.height),
            topRight: radiusValue(style.borderTopRightRadius, rect.width, rect.height),
            bottomRight: radiusValue(style.borderBottomRightRadius, rect.width, rect.height),
            bottomLeft: radiusValue(style.borderBottomLeftRadius, rect.width, rect.height),
          };
          if (Object.values(outerRadii).some((radius) => !radius)) return null;
          const left = rect.left + insets.left;
          const top = rect.top + insets.top;
          const right = rect.right - insets.right;
          const bottom = rect.bottom - insets.bottom;
          if (right <= left || bottom <= top) return null;
          const radii = {
            topLeft: {
              x: Math.max(0, outerRadii.topLeft.x - insets.left),
              y: Math.max(0, outerRadii.topLeft.y - insets.top),
            },
            topRight: {
              x: Math.max(0, outerRadii.topRight.x - insets.right),
              y: Math.max(0, outerRadii.topRight.y - insets.top),
            },
            bottomRight: {
              x: Math.max(0, outerRadii.bottomRight.x - insets.right),
              y: Math.max(0, outerRadii.bottomRight.y - insets.bottom),
            },
            bottomLeft: {
              x: Math.max(0, outerRadii.bottomLeft.x - insets.left),
              y: Math.max(0, outerRadii.bottomLeft.y - insets.bottom),
            },
          };
          const width = right - left;
          const height = bottom - top;
          const scale = Math.min(
            1,
            width / Math.max(width, radii.topLeft.x + radii.topRight.x),
            width / Math.max(width, radii.bottomLeft.x + radii.bottomRight.x),
            height / Math.max(height, radii.topLeft.y + radii.bottomLeft.y),
            height / Math.max(height, radii.topRight.y + radii.bottomRight.y),
          );
          for (const radius of Object.values(radii)) {
            radius.x *= scale;
            radius.y *= scale;
          }
          return { left, top, right, bottom, radii };
        })
        .filter(Boolean);
    };

    const backgroundEvidence = (element) => {
      const chain = [];
      let current = element;
      while (current instanceof HTMLElement) {
        const style = protectedGetComputedStyle(current);
        const backgroundColor = parseCssColor(style.backgroundColor);
        const coverageShapes = backgroundColor?.a >= 1 - epsilon
          ? backgroundPaintCoverageShapes(current, style)
          : null;
        chain.push({ backgroundColor, coverageShapes, style });
        current = current.parentElement;
      }

      const isNone = (value) => String(value || "none").trim().toLowerCase() === "none";
      const isNormal = (value) => String(value || "normal").trim().toLowerCase() === "normal";
      const hasBackgroundImage = (style) => !isNone(style.backgroundImage);
      const hasBackdropFilter = (style) =>
        !isNone(style.backdropFilter) || !isNone(style.webkitBackdropFilter);
      const hasTextOnlyBackgroundClip = (style) => String(style.backgroundClip || "")
        .split(",")
        .some((value) => value.trim().toLowerCase() === "text");
      const hasNeutralEnclosingGroup = (style) => {
        const opacity = Number(style.opacity || 1);
        return Number.isFinite(opacity) && opacity >= 1 - epsilon &&
          filterOpacity(style.filter) >= 1 - epsilon &&
          !hasUnresolvedColorFilter(style.filter) &&
          !hasUnresolvedMask(style) &&
          isNormal(style.mixBlendMode) &&
          isNormal(style.backgroundBlendMode) &&
          !hasBackdropFilter(style);
      };
      const isOpaqueSolidBackground = ({ backgroundColor, coverageShapes, style }) => Boolean(
        backgroundColor &&
        backgroundColor.a >= 1 - epsilon &&
        coverageShapes?.length &&
        !hasBackgroundImage(style) &&
        isNormal(style.backgroundBlendMode) &&
        !hasTextOnlyBackgroundClip(style),
      );

      // A nearer opaque solid background can prove that lower ancestor paint
      // does not reach the glyphs, but only while every enclosing group keeps
      // that layer opaque and normally composited. An ancestor opacity,
      // filter, mask, blend, or backdrop therefore disables this shortcut.
      let occludingLayerIndex = -1;
      for (let index = 0; index < chain.length; index += 1) {
        if (!isOpaqueSolidBackground(chain[index])) continue;
        if (!chain.slice(index).every(({ style }) => hasNeutralEnclosingGroup(style))) continue;
        occludingLayerIndex = index;
        break;
      }
      const visibleChain = occludingLayerIndex >= 0
        ? chain.slice(0, occludingLayerIndex + 1)
        : chain;
      const layers = [];
      let resolved = true;
      for (const { backgroundColor, style } of visibleChain) {
        if (backgroundColor) layers.push(backgroundColor);
        else resolved = false;
        if (hasBackgroundImage(style)) resolved = false;
        if (!isNormal(style.backgroundBlendMode)) resolved = false;
        if (!isNormal(style.mixBlendMode)) resolved = false;
        if (hasBackdropFilter(style)) resolved = false;
        if (hasUnresolvedColorFilter(style.filter)) resolved = false;
        if (hasUnresolvedMask(style)) resolved = false;
      }
      let color = { r: 255, g: 255, b: 255, a: 1 };
      for (const layer of layers.reverse()) color = compositeOver(layer, color);
      return {
        color,
        occluder: occludingLayerIndex >= 0
          ? { coverageShapes: chain[occludingLayerIndex].coverageShapes }
          : null,
        resolved,
      };
    };

    const textPaintEvidence = (element) => {
      if (!(element instanceof HTMLElement)) {
        return { visible: false, effectiveAlpha: 0, contrast: 1, backgroundResolved: false };
      }
      const textStyle = protectedGetComputedStyle(element);
      const color = parseCssColor(textStyle.color);
      const fillValue = textStyle.webkitTextFillColor || textStyle.getPropertyValue("-webkit-text-fill-color");
      const fill = fillValue ? parseCssColor(fillValue) : null;
      const foreground = fill || color;
      if (!foreground) {
        return { visible: false, effectiveAlpha: 0, contrast: 1, backgroundResolved: false };
      }
      let cumulativeAlpha = 1;
      let foregroundResolved = true;
      let current = element;
      while (current instanceof HTMLElement) {
        const style = protectedGetComputedStyle(current);
        const opacity = Number(style.opacity || 1);
        if (!Number.isFinite(opacity)) {
          return { visible: false, effectiveAlpha: 0, contrast: 1, backgroundResolved: false };
        }
        cumulativeAlpha *= clamp(opacity);
        cumulativeAlpha *= filterOpacity(style.filter);
        if (hasUnresolvedColorFilter(style.filter)) foregroundResolved = false;
        if (String(style.mixBlendMode || "normal").toLowerCase() !== "normal") foregroundResolved = false;
        if (hasUnresolvedMask(style)) foregroundResolved = false;
        current = current.parentElement;
      }
      const effectiveAlpha = foreground.a * cumulativeAlpha;
      const background = backgroundEvidence(element);
      const paintedForeground = compositeOver({ ...foreground, a: effectiveAlpha }, background.color);
      const effectiveContrast = contrastRatio(paintedForeground, background.color);
      const suspiciousZeroContrast = effectiveContrast <= minContrastRatioValue + epsilon;
      // A computed fallback color cannot prove what an image, gradient, blend,
      // mask, backdrop, or non-opacity filter actually painted behind/over the
      // glyphs. Until screenshot pixels are sampled and bound to this exact
      // Range, unresolved paint must be localization-unavailable rather than a
      // guessed visible rectangle.
      const resolved = foregroundResolved && background.resolved;
      const visible = resolved &&
        effectiveAlpha > minPaintAlphaValue + epsilon &&
        !suspiciousZeroContrast;
      return {
        visible,
        resolved,
        effectiveAlpha,
        contrast: effectiveContrast,
        backgroundResolved: background.resolved,
        foregroundResolved,
        occluder: background.occluder,
      };
    };

    const cssLength = (token, referenceLength) => {
      const normalized = String(token || "").trim().toLowerCase();
      if (normalized === "0") return 0;
      const parsed = Number.parseFloat(normalized);
      if (!Number.isFinite(parsed)) return null;
      if (normalized.endsWith("%")) return referenceLength * parsed / 100;
      if (normalized.endsWith("px") || /^[-+]?\d*\.?\d+$/.test(normalized)) return parsed;
      return null;
    };

    const expandFourSides = (tokens) => {
      if (tokens.length === 1) return [tokens[0], tokens[0], tokens[0], tokens[0]];
      if (tokens.length === 2) return [tokens[0], tokens[1], tokens[0], tokens[1]];
      if (tokens.length === 3) return [tokens[0], tokens[1], tokens[2], tokens[1]];
      return tokens.length === 4 ? tokens : null;
    };

    const rectShape = (left, top, right, bottom) => ({
      type: "rect",
      left,
      top,
      right,
      bottom,
    });

    const positionCoordinate = (token, start, length, axis) => {
      const normalized = String(token || "50%").trim().toLowerCase();
      if (normalized === "center") return start + length / 2;
      if ((axis === "x" && normalized === "left") || (axis === "y" && normalized === "top")) return start;
      if ((axis === "x" && normalized === "right") || (axis === "y" && normalized === "bottom")) {
        return start + length;
      }
      const offset = cssLength(normalized, length);
      return offset === null ? null : start + offset;
    };

    const clipPathShape = (value, rect) => {
      const normalized = String(value || "none").trim().toLowerCase();
      if (!normalized || normalized === "none") return { present: false, resolved: true, shape: null };
      const inset = normalized.match(/^inset\((.*)\)$/i)?.[1] || null;
      if (inset !== null) {
        const sideTokens = inset.split(/\s+round\s+/i, 1)[0].trim().split(/\s+/).filter(Boolean);
        const sides = expandFourSides(sideTokens);
        if (!sides) return { present: true, resolved: false, shape: null };
        const top = cssLength(sides[0], rect.height);
        const right = cssLength(sides[1], rect.width);
        const bottom = cssLength(sides[2], rect.height);
        const left = cssLength(sides[3], rect.width);
        if ([top, right, bottom, left].some((part) => part === null)) {
          return { present: true, resolved: false, shape: null };
        }
        return {
          present: true,
          resolved: true,
          shape: rectShape(rect.left + left, rect.top + top, rect.right - right, rect.bottom - bottom),
        };
      }
      const circle = normalized.match(/^circle\((.*)\)$/i)?.[1] || null;
      if (circle !== null) {
        const [radiusPart, positionPart = "50% 50%"] = circle.split(/\s+at\s+/i, 2);
        const position = positionPart.trim().split(/\s+/).filter(Boolean);
        const centerX = positionCoordinate(position[0], rect.left, rect.width, "x");
        const centerY = positionCoordinate(position[1] || "50%", rect.top, rect.height, "y");
        let radius = cssLength(radiusPart.trim() || "50%", Math.min(rect.width, rect.height));
        if (radiusPart.trim() === "closest-side") {
          radius = Math.min(centerX - rect.left, rect.right - centerX, centerY - rect.top, rect.bottom - centerY);
        } else if (radiusPart.trim() === "farthest-side") {
          radius = Math.max(centerX - rect.left, rect.right - centerX, centerY - rect.top, rect.bottom - centerY);
        }
        if ([centerX, centerY, radius].some((part) => part === null || !Number.isFinite(part))) {
          return { present: true, resolved: false, shape: null };
        }
        return {
          present: true,
          resolved: true,
          shape: {
            type: "ellipse",
            centerX,
            centerY,
            radiusX: Math.max(0, radius),
            radiusY: Math.max(0, radius),
            left: centerX - radius,
            top: centerY - radius,
            right: centerX + radius,
            bottom: centerY + radius,
          },
        };
      }
      const ellipse = normalized.match(/^ellipse\((.*)\)$/i)?.[1] || null;
      if (ellipse !== null) {
        const [radiusPart, positionPart = "50% 50%"] = ellipse.split(/\s+at\s+/i, 2);
        const radii = radiusPart.trim().split(/\s+/).filter(Boolean);
        const position = positionPart.trim().split(/\s+/).filter(Boolean);
        const centerX = positionCoordinate(position[0], rect.left, rect.width, "x");
        const centerY = positionCoordinate(position[1] || "50%", rect.top, rect.height, "y");
        const radiusX = cssLength(radii[0] || "50%", rect.width);
        const radiusY = cssLength(radii[1] || radii[0] || "50%", rect.height);
        if ([centerX, centerY, radiusX, radiusY].some((part) => part === null || !Number.isFinite(part))) {
          return { present: true, resolved: false, shape: null };
        }
        return {
          present: true,
          resolved: true,
          shape: {
            type: "ellipse",
            centerX,
            centerY,
            radiusX: Math.max(0, radiusX),
            radiusY: Math.max(0, radiusY),
            left: centerX - radiusX,
            top: centerY - radiusY,
            right: centerX + radiusX,
            bottom: centerY + radiusY,
          },
        };
      }
      const polygon = normalized.match(/^polygon\((.*)\)$/i)?.[1] || null;
      if (polygon !== null) {
        const pointTokens = polygon.replace(/^\s*(?:evenodd|nonzero)\s*,/i, "").split(",");
        const points = [];
        for (const pointToken of pointTokens) {
          const coordinates = pointToken.trim().split(/\s+/).filter(Boolean);
          if (coordinates.length !== 2) return { present: true, resolved: false, shape: null };
          const x = positionCoordinate(coordinates[0], rect.left, rect.width, "x");
          const y = positionCoordinate(coordinates[1], rect.top, rect.height, "y");
          if (x === null || y === null) return { present: true, resolved: false, shape: null };
          points.push({ x, y });
        }
        if (points.length < 3) return { present: true, resolved: true, shape: rectShape(0, 0, 0, 0) };
        return {
          present: true,
          resolved: true,
          shape: {
            type: "polygon",
            points,
            left: Math.min(...points.map((point) => point.x)),
            top: Math.min(...points.map((point) => point.y)),
            right: Math.max(...points.map((point) => point.x)),
            bottom: Math.max(...points.map((point) => point.y)),
          },
        };
      }
      return { present: true, resolved: false, shape: null };
    };

    const legacyClipShape = (value, rect, position) => {
      const normalized = String(value || "auto").trim().toLowerCase();
      if (!normalized || normalized === "auto" || !["absolute", "fixed"].includes(position)) {
        return { present: false, resolved: true, shape: null };
      }
      const contents = normalized.match(/^rect\((.*)\)$/i)?.[1] || null;
      if (contents === null) return { present: true, resolved: false, shape: null };
      const tokens = contents.replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
      if (tokens.length !== 4) return { present: true, resolved: false, shape: null };
      const lengths = tokens.map((token, index) => token === "auto"
        ? index === 0 || index === 3 ? 0 : index === 1 ? rect.width : rect.height
        : cssLength(token, index === 0 || index === 2 ? rect.height : rect.width));
      if (lengths.some((part) => part === null)) return { present: true, resolved: false, shape: null };
      return {
        present: true,
        resolved: true,
        shape: rectShape(
          rect.left + lengths[3],
          rect.top + lengths[0],
          rect.left + lengths[1],
          rect.top + lengths[2],
        ),
      };
    };

    const pointInPolygon = (point, points) => {
      let inside = false;
      for (let first = 0, second = points.length - 1; first < points.length; second = first++) {
        const a = points[first];
        const b = points[second];
        const crosses = (a.y > point.y) !== (b.y > point.y) &&
          point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x;
        if (crosses) inside = !inside;
      }
      return inside;
    };

    const orientation = (a, b, c) => Math.sign((b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y));
    const segmentsIntersect = (a, b, c, d) => orientation(a, b, c) !== orientation(a, b, d) &&
      orientation(c, d, a) !== orientation(c, d, b);

    const shapeIntersectsRect = (shape, rect) => {
      if (shape.right <= shape.left || shape.bottom <= shape.top ||
        rect.right <= shape.left || rect.left >= shape.right ||
        rect.bottom <= shape.top || rect.top >= shape.bottom) {
        return false;
      }
      if (shape.type === "rect") return true;
      if (shape.type === "ellipse") {
        if (shape.radiusX <= 0 || shape.radiusY <= 0) return false;
        const nearestX = clamp(shape.centerX, rect.left, rect.right);
        const nearestY = clamp(shape.centerY, rect.top, rect.bottom);
        return ((nearestX - shape.centerX) / shape.radiusX) ** 2 +
          ((nearestY - shape.centerY) / shape.radiusY) ** 2 <= 1;
      }
      if (shape.type === "polygon") {
        const rectanglePoints = [
          { x: rect.left, y: rect.top },
          { x: rect.right, y: rect.top },
          { x: rect.right, y: rect.bottom },
          { x: rect.left, y: rect.bottom },
        ];
        if (rectanglePoints.some((point) => pointInPolygon(point, shape.points))) return true;
        if (shape.points.some((point) => point.x >= rect.left && point.x <= rect.right &&
          point.y >= rect.top && point.y <= rect.bottom)) return true;
        for (let pointIndex = 0; pointIndex < shape.points.length; pointIndex += 1) {
          const shapeStart = shape.points[pointIndex];
          const shapeEnd = shape.points[(pointIndex + 1) % shape.points.length];
          for (let rectIndex = 0; rectIndex < rectanglePoints.length; rectIndex += 1) {
            if (segmentsIntersect(
              shapeStart,
              shapeEnd,
              rectanglePoints[rectIndex],
              rectanglePoints[(rectIndex + 1) % rectanglePoints.length],
            )) return true;
          }
        }
      }
      return false;
    };

    const pointInShape = (point, shape) => {
      if (
        point.x < shape.left || point.x > shape.right ||
        point.y < shape.top || point.y > shape.bottom
      ) return false;
      if (shape.type === "rect") return true;
      if (shape.type === "ellipse") {
        if (shape.radiusX <= 0 || shape.radiusY <= 0) return false;
        return ((point.x - shape.centerX) / shape.radiusX) ** 2 +
          ((point.y - shape.centerY) / shape.radiusY) ** 2 <= 1;
      }
      return shape.type === "polygon" && pointInPolygon(point, shape.points);
    };

    const pointInBackgroundCoverageShape = (point, shape) => {
      if (
        point.x < shape.left - epsilon || point.x > shape.right + epsilon ||
        point.y < shape.top - epsilon || point.y > shape.bottom + epsilon
      ) return false;
      const cornerContains = (radius, centerX, centerY) => {
        if (radius.x <= epsilon || radius.y <= epsilon) return true;
        return ((point.x - centerX) / radius.x) ** 2 +
          ((point.y - centerY) / radius.y) ** 2 <= 1 + epsilon;
      };
      if (
        point.x < shape.left + shape.radii.topLeft.x &&
        point.y < shape.top + shape.radii.topLeft.y
      ) {
        return cornerContains(
          shape.radii.topLeft,
          shape.left + shape.radii.topLeft.x,
          shape.top + shape.radii.topLeft.y,
        );
      }
      if (
        point.x > shape.right - shape.radii.topRight.x &&
        point.y < shape.top + shape.radii.topRight.y
      ) {
        return cornerContains(
          shape.radii.topRight,
          shape.right - shape.radii.topRight.x,
          shape.top + shape.radii.topRight.y,
        );
      }
      if (
        point.x > shape.right - shape.radii.bottomRight.x &&
        point.y > shape.bottom - shape.radii.bottomRight.y
      ) {
        return cornerContains(
          shape.radii.bottomRight,
          shape.right - shape.radii.bottomRight.x,
          shape.bottom - shape.radii.bottomRight.y,
        );
      }
      if (
        point.x < shape.left + shape.radii.bottomLeft.x &&
        point.y > shape.bottom - shape.radii.bottomLeft.y
      ) {
        return cornerContains(
          shape.radii.bottomLeft,
          shape.left + shape.radii.bottomLeft.x,
          shape.bottom - shape.radii.bottomLeft.y,
        );
      }
      return true;
    };

    const rangeRectCoveredByPaintOccluder = (rect, occluder) =>
      occluder.coverageShapes.some((shape) => [
        { x: rect.left, y: rect.top },
        { x: rect.right, y: rect.top },
        { x: rect.right, y: rect.bottom },
        { x: rect.left, y: rect.bottom },
      ].every((point) => pointInBackgroundCoverageShape(point, shape)));

    const resolvedPixelLength = (value) => {
      const normalized = String(value || "").trim().toLowerCase();
      if (normalized === "0") return 0;
      const match = normalized.match(/^(-?(?:\d+\.?\d*|\.\d+))px$/);
      if (!match) return null;
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const pseudoBoxPainted = (style) => {
      const opacity = Number(style.opacity || 1);
      if (!Number.isFinite(opacity) || opacity <= minPaintAlphaValue) return false;
      const background = parseCssColor(style.backgroundColor);
      if (background && background.a * opacity > minPaintAlphaValue) return true;
      if (String(style.backgroundImage || "none").toLowerCase() !== "none") return true;
      if (String(style.boxShadow || "none").toLowerCase() !== "none") return true;
      return ["Top", "Right", "Bottom", "Left"].some((side) => {
        const width = resolvedPixelLength(style[`border${side}Width`]);
        const color = parseCssColor(style[`border${side}Color`]);
        const borderStyle = String(style[`border${side}Style`] || "none").toLowerCase();
        return width !== null && width > 0 && borderStyle !== "none" &&
          color && color.a * opacity > minPaintAlphaValue;
      });
    };

    const containingBlockRect = (element, pseudoStyle) => {
      if (pseudoStyle.position === "fixed") {
        return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
          width: window.innerWidth, height: window.innerHeight };
      }
      let current = element;
      while (current instanceof HTMLElement) {
        const style = protectedGetComputedStyle(current);
        if (
          style.position !== "static" ||
          String(style.transform || "none").toLowerCase() !== "none" ||
          String(style.perspective || "none").toLowerCase() !== "none" ||
          String(style.filter || "none").toLowerCase() !== "none"
        ) return current.getBoundingClientRect();
        current = current.parentElement;
      }
      return document.documentElement.getBoundingClientRect();
    };

    const resolvedPseudoRect = (element, style) => {
      if (!['absolute', 'fixed', 'sticky'].includes(style.position)) return null;
      const basis = containingBlockRect(element, style);
      const leftInset = resolvedPixelLength(style.left);
      const rightInset = resolvedPixelLength(style.right);
      const topInset = resolvedPixelLength(style.top);
      const bottomInset = resolvedPixelLength(style.bottom);
      let width = resolvedPixelLength(style.width);
      let height = resolvedPixelLength(style.height);
      if (width === null && leftInset !== null && rightInset !== null) {
        width = Math.max(0, basis.width - leftInset - rightInset);
      }
      if (height === null && topInset !== null && bottomInset !== null) {
        height = Math.max(0, basis.height - topInset - bottomInset);
      }
      if (width === null || height === null) return null;
      const left = leftInset !== null
        ? basis.left + leftInset
        : rightInset !== null
          ? basis.right - rightInset - width
          : null;
      const top = topInset !== null
        ? basis.top + topInset
        : bottomInset !== null
          ? basis.bottom - bottomInset - height
          : null;
      if (left === null || top === null) return null;
      return { left, top, right: left + width, bottom: top + height, width, height };
    };

    const pseudoMayOccludeElement = (element, pseudoName) => {
      let style;
      try {
        style = protectedGetComputedStyle(element, pseudoName);
      } catch {
        return false;
      }
      const content = String(style.content || "none").trim().toLowerCase();
      if (!content || content === "none" || content === "normal" ||
        style.display === "none" || style.visibility === "hidden" ||
        style.visibility === "collapse") return false;
      const generatedText = content !== '""' && content !== "''";
      const boxPainted = pseudoBoxPainted(style);
      if (!generatedText && !boxPainted) return false;
      const transformed = String(style.transform || "none").toLowerCase() !== "none";
      const positioned = ['absolute', 'fixed', 'sticky'].includes(style.position);
      if (!positioned && !transformed) return false;

      const zIndex = Number.parseFloat(String(style.zIndex || "auto"));
      const explicitlyAbove = Number.isFinite(zIndex) && zIndex >= 0;
      const paintedAfterText = pseudoName === "::after" &&
        (!Number.isFinite(zIndex) || zIndex >= 0);
      if (!explicitlyAbove && !paintedAfterText && !transformed) return false;

      const pseudoRect = resolvedPseudoRect(element, style);
      if (!pseudoRect) return true;
      const elementRect = element.getBoundingClientRect();
      const overlapWidth = Math.max(
        0,
        Math.min(pseudoRect.right, elementRect.right) -
          Math.max(pseudoRect.left, elementRect.left),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(pseudoRect.bottom, elementRect.bottom) -
          Math.max(pseudoRect.top, elementRect.top),
      );
      const elementArea = Math.max(1, elementRect.width * elementRect.height);
      return overlapWidth * overlapHeight / elementArea >= 0.1;
    };

    const pseudoPaintOcclusionPotential = (element) => {
      let current = element;
      while (current instanceof HTMLElement) {
        if (
          pseudoMayOccludeElement(current, "::before") ||
          pseudoMayOccludeElement(current, "::after")
        ) return true;
        current = current.parentElement;
      }
      return false;
    };

    const conservativeVisibleShapeCoverage = (rect, clips, { documentHeight, documentWidth }) => {
      const nonRectClips = clips.filter((clip) => clip.type !== "rect");
      if (!nonRectClips.length) return { sufficient: true, ratio: 1, area: rect.width * rect.height };

      // Sampling is only needed for non-rectangular clips. Cell centers avoid
      // treating a zero-area edge/corner touch as readable. The threshold is
      // deliberately conservative: a thin diagonal ribbon can span the whole
      // bounding box while exposing too little glyph area to substantiate an
      // exact wording crop.
      const columns = 24;
      const rows = 24;
      let visibleSamples = 0;
      const totalSamples = columns * rows;
      for (let row = 0; row < rows; row += 1) {
        const y = rect.top + rect.height * (row + 0.5) / rows;
        for (let column = 0; column < columns; column += 1) {
          const x = rect.left + rect.width * (column + 0.5) / columns;
          const documentX = x + window.scrollX;
          const documentY = y + window.scrollY;
          if (
            documentX < 0 || documentX > documentWidth ||
            documentY < 0 || documentY > documentHeight
          ) continue;
          if (clips.every((clip) => pointInShape({ x, y }, clip))) visibleSamples += 1;
        }
      }
      const ratio = visibleSamples / totalSamples;
      const area = ratio * rect.width * rect.height;
      return {
        sufficient: ratio >= 0.1 && area >= 8,
        ratio,
        area,
      };
    };

    const elementContext = (element) => {
      const paint = textPaintEvidence(element);
      if (!paint.visible) return null;
      const clips = [];
      let current = element;
      while (current instanceof HTMLElement) {
        const style = protectedGetComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.contentVisibility === "hidden"
        ) return null;
        const rect = current.getBoundingClientRect();
        if (style.display !== "contents" && (rect.width <= 0 || rect.height <= 0)) return null;
        if (style.display !== "contents") {
          const clipPath = clipPathShape(style.clipPath || style.webkitClipPath, rect);
          if (!clipPath.resolved) return null;
          if (clipPath.present) clips.push(clipPath.shape);
          const legacyClip = legacyClipShape(style.clip, rect, style.position);
          if (!legacyClip.resolved) return null;
          if (legacyClip.present) clips.push(legacyClip.shape);
          const overflowX = String(style.overflowX || style.overflow || "visible").toLowerCase();
          const overflowY = String(style.overflowY || style.overflow || "visible").toLowerCase();
          const clipX = ["hidden", "clip", "scroll", "auto"].includes(overflowX);
          const clipY = ["hidden", "clip", "scroll", "auto"].includes(overflowY);
          const rootScroller = current === document.body || current === document.documentElement;
          if (!rootScroller && (clipX || clipY)) {
            clips.push({
              type: "rect",
              left: clipX ? rect.left + current.clientLeft : Number.NEGATIVE_INFINITY,
              top: clipY ? rect.top + current.clientTop : Number.NEGATIVE_INFINITY,
              right: clipX ? rect.left + current.clientLeft + current.clientWidth : Number.POSITIVE_INFINITY,
              bottom: clipY ? rect.top + current.clientTop + current.clientHeight : Number.POSITIVE_INFINITY,
            });
          }
        }
        current = current.parentElement;
      }
      return { clips, paint };
    };

    const rectsForRange = (range, context, { documentHeight, documentWidth }) => {
      const rangeRects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      if (
        context.paint.occluder &&
        rangeRects.some((rect) => !rangeRectCoveredByPaintOccluder(rect, context.paint.occluder))
      ) return [];
      return rangeRects.map((rect) => {
        let candidate = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        for (const clip of context.clips) {
          if (!shapeIntersectsRect(clip, candidate)) return null;
          candidate = {
            left: Math.max(candidate.left, clip.left),
            top: Math.max(candidate.top, clip.top),
            right: Math.min(candidate.right, clip.right),
            bottom: Math.min(candidate.bottom, clip.bottom),
          };
          if (candidate.right <= candidate.left || candidate.bottom <= candidate.top) return null;
        }
        const left = Math.max(0, candidate.left + window.scrollX);
        const right = Math.min(documentWidth, candidate.right + window.scrollX);
        const top = Math.max(0, candidate.top + window.scrollY);
        const bottom = Math.min(documentHeight, candidate.bottom + window.scrollY);
        const visibleWidth = Math.max(0, right - left);
        const visibleHeight = Math.max(0, bottom - top);
        if (visibleWidth < Math.max(2, rect.width * 0.1) ||
          visibleHeight < Math.max(4, rect.height * 0.6)) return null;
        const coverage = conservativeVisibleShapeCoverage(rect, context.clips, {
          documentHeight,
          documentWidth,
        });
        if (!coverage.sufficient) return null;
        return { left, top, right, bottom, width: visibleWidth, height: visibleHeight };
      }).filter(Boolean);
    };

    return Object.freeze({
      elementContext,
      pseudoPaintOcclusionPotential,
      rectsForRange,
      textPaintEvidence,
    });
}

async function collectVisibleTextGeometry({ capturedAtValue, stateIdValue }, visibilityApi) {
    const nativeCreateRange = Document.prototype.createRange;
    const nativeCreateTreeWalker = Document.prototype.createTreeWalker;
    const nativeElementsFromPoint = Document.prototype.elementsFromPoint;
    const nativeQuerySelector = Document.prototype.querySelector;
    const nativeQuerySelectorAll = Document.prototype.querySelectorAll;
    const nativeGetComputedStyle = globalThis.getComputedStyle;
    const nativeRequestAnimationFrame = globalThis.requestAnimationFrame;
    const nativeScrollTo = globalThis.scrollTo;
    const protectedCreateRange = () => nativeCreateRange.call(document);
    const protectedCreateTreeWalker = (root, whatToShow) =>
      nativeCreateTreeWalker.call(document, root, whatToShow);
    const protectedElementsFromPoint = (x, y) =>
      nativeElementsFromPoint.call(document, x, y);
    const protectedQuerySelector = (selector) => nativeQuerySelector.call(document, selector);
    const protectedQuerySelectorAll = (selector) => nativeQuerySelectorAll.call(document, selector);
    const protectedGetComputedStyle = (element, pseudo = null) =>
      Reflect.apply(nativeGetComputedStyle, window, [element, pseudo]);
    const protectedRequestAnimationFrame = (callback) =>
      Reflect.apply(nativeRequestAnimationFrame, window, [callback]);
    const protectedScrollTo = (x, y) => Reflect.apply(nativeScrollTo, window, [x, y]);
    const body = document.body;
    const documentElement = document.documentElement;
    const documentWidth = Math.max(documentElement.scrollWidth, body?.scrollWidth || 0, window.innerWidth);
    const documentHeight = Math.max(documentElement.scrollHeight, body?.scrollHeight || 0, window.innerHeight);
    if (!visibilityApi) throw new Error("AwardPing isolated visible-text semantics were not constructed.");
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

    function rectsForRange(range, context) {
      return visibilityApi.rectsForRange(range, context, { documentHeight, documentWidth }).map((rect) => ({
        x: round(rect.left),
        y: round(rect.top),
        width: round(rect.width),
        height: round(rect.height),
        right: round(rect.right),
        bottom: round(rect.bottom),
      }));
    }

    function visibleTextContext(node) {
      const parent = node.parentElement;
      if (!(parent instanceof HTMLElement)) return null;
      if (!node.nodeValue || !/\S/u.test(node.nodeValue)) return null;
      if (parent.closest("[data-awardping-hidden-noise], [hidden], [aria-hidden='true']")) return null;
      if (parent.closest("script, style, noscript, template, canvas")) return null;
      const context = visibilityApi.elementContext(parent);
      if (!context) return null;
      const range = protectedCreateRange();
      range.selectNodeContents(node);
      return rectsForRange(range, context).length > 0 ? { context, parent } : null;
    }

    function nearestBlock(element) {
      let current = element;
      while (current && current !== body) {
        if (blockDisplays.has(protectedGetComputedStyle(current).display)) return current;
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
          return parts.join(">");
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

    async function retainPaintStackVerifiedRuns(candidateNodes) {
      const originalScroll = { x: window.scrollX, y: window.scrollY };
      const viewportWidth = Math.max(1, window.innerWidth);
      const viewportHeight = Math.max(1, window.innerHeight);
      const maximumScrollX = Math.max(0, documentWidth - viewportWidth);
      const maximumScrollY = Math.max(0, documentHeight - viewportHeight);
      const horizontalBand = Math.max(1, viewportWidth * 0.5);
      const verticalBand = Math.max(1, viewportHeight * 0.5);
      const batches = new Map();
      const rectResults = new Map();
      const targetCache = new Map();
      const pointerEventOverrides = [];
      let sampledRectCount = 0;

      const clampScroll = (value, maximum) => Math.max(0, Math.min(maximum, value));
      // A text node is painted by its direct parent. A descendant returned by
      // elementsFromPoint is an intervening painted layer, not proof that the
      // parent's wording reached the screenshot (for example, an absolutely
      // positioned white child covering the text). Fail closed unless the
      // exact text parent owns the top paint hit.
      const relatedToTarget = (candidate, target) => Boolean(
        candidate && target && candidate === target
      );
      const renderedHitTestTarget = (target) => {
        let current = target;
        while (
          current instanceof HTMLElement &&
          protectedGetComputedStyle(current).display === "contents"
        ) current = current.parentElement;
        return current instanceof HTMLElement ? current : null;
      };
      const frame = () => new Promise((resolveFrame) =>
        protectedRequestAnimationFrame(() => protectedRequestAnimationFrame(resolveFrame))
      );

      for (const [nodeIndex, node] of candidateNodes.entries()) {
        for (const [runIndex, run] of node.runs.entries()) {
          for (const [rectIndex, rect] of run.rects.entries()) {
            const key = `${nodeIndex}:${runIndex}:${rectIndex}`;
            const centerX = rect.x + rect.width / 2;
            const centerY = rect.y + rect.height / 2;
            const horizontalIndex = Math.floor(centerX / horizontalBand);
            const verticalIndex = Math.floor(centerY / verticalBand);
            const anchorX = horizontalIndex * horizontalBand + horizontalBand / 2;
            const anchorY = verticalIndex * verticalBand + verticalBand / 2;
            const scrollX = clampScroll(anchorX - viewportWidth / 2, maximumScrollX);
            const scrollY = clampScroll(anchorY - viewportHeight / 2, maximumScrollY);
            const batchKey = `${round(scrollX)}:${round(scrollY)}`;
            if (!batches.has(batchKey)) batches.set(batchKey, { scrollX, scrollY, items: [] });
            batches.get(batchKey).items.push({
              key,
              path: node.path,
              points: [0.2, 0.5, 0.8].map((ratio) => ({
                x: rect.x + rect.width * ratio,
                y: centerY,
              })),
            });
            sampledRectCount += 1;
          }
        }
      }

      try {
        // CSS hit testing normally omits `pointer-events:none` even when that
        // element is visibly painted above the wording. Temporarily make only
        // hit testing explicit, without changing layout or paint, so an opaque
        // click-through sibling cannot masquerade as visible text. Every inline
        // value and priority is restored before the screenshot is taken.
        for (const element of protectedQuerySelectorAll("*")) {
          if (!(element instanceof HTMLElement)) continue;
          if (protectedGetComputedStyle(element).pointerEvents !== "none") continue;
          pointerEventOverrides.push({
            element,
            value: element.style.getPropertyValue("pointer-events"),
            priority: element.style.getPropertyPriority("pointer-events"),
          });
          element.style.setProperty("pointer-events", "auto", "important");
        }
        for (const batch of batches.values()) {
          protectedScrollTo(batch.scrollX, batch.scrollY);
          await frame();
          for (const item of batch.items) {
            let targetEvidence = targetCache.get(item.path);
            if (targetEvidence === undefined) {
              let textParent;
              try {
                textParent = protectedQuerySelector(item.path);
              } catch {
                textParent = null;
              }
              targetEvidence = textParent instanceof HTMLElement
                ? {
                    hitTarget: renderedHitTestTarget(textParent),
                    pseudoOccluded:
                      visibilityApi.pseudoPaintOcclusionPotential(textParent),
                  }
                : { hitTarget: null, pseudoOccluded: true };
              targetCache.set(item.path, targetEvidence);
            }
            if (
              !(targetEvidence.hitTarget instanceof HTMLElement) ||
              targetEvidence.pseudoOccluded
            ) {
              rectResults.set(item.key, false);
              continue;
            }
            let verifiedPoints = 0;
            for (const point of item.points) {
              const viewportX = point.x - window.scrollX;
              const viewportY = point.y - window.scrollY;
              if (
                viewportX <= 0 || viewportX >= window.innerWidth ||
                viewportY <= 0 || viewportY >= window.innerHeight
              ) continue;
              const topPaintedElement = protectedElementsFromPoint(viewportX, viewportY)[0] || null;
              if (relatedToTarget(topPaintedElement, targetEvidence.hitTarget)) {
                verifiedPoints += 1;
              }
            }
            // Three points across each token rectangle make a fully covering
            // sibling/fixed overlay fail closed while avoiding a single-pixel
            // edge hit being treated as proof that the wording was painted.
            rectResults.set(item.key, verifiedPoints === item.points.length);
          }
        }
      } finally {
        for (const override of pointerEventOverrides) {
          if (override.value) {
            override.element.style.setProperty(
              "pointer-events",
              override.value,
              override.priority,
            );
          } else {
            override.element.style.removeProperty("pointer-events");
          }
        }
        protectedScrollTo(originalScroll.x, originalScroll.y);
        await frame();
      }

      let rejectedRectCount = 0;
      const nodes = candidateNodes.map((node, nodeIndex) => {
        const runs = node.runs.filter((run, runIndex) => run.rects.every((_, rectIndex) => {
          const verified = rectResults.get(`${nodeIndex}:${runIndex}:${rectIndex}`) === true;
          if (!verified) rejectedRectCount += 1;
          return verified;
        }));
        return { ...node, runs };
      }).filter((node) => node.runs.length > 0);

      return {
        nodes,
        evidence: {
          contract: "browser-paint-stack-v1",
          status: "verified",
          sample_points_per_rect: 3,
          sampled_rect_count: sampledRectCount,
          rejected_rect_count: rejectedRectCount,
          original_scroll: originalScroll,
          restored_scroll: { x: window.scrollX, y: window.scrollY },
        },
      };
    }

    const walker = protectedCreateTreeWalker(body || documentElement, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let currentNode = walker.nextNode();
    let previousRawText = "";
    let previousBlock = null;
    while (currentNode) {
      const visibility = visibleTextContext(currentNode);
      if (visibility) {
        const rawText = currentNode.nodeValue || "";
        const parent = visibility.parent;
        const fullRange = protectedCreateRange();
        fullRange.selectNodeContents(currentNode);
        const nodeRects = rectsForRange(fullRange, visibility.context);
        const runs = [];
        for (const match of rawText.matchAll(tokenPattern)) {
          const start = match.index || 0;
          const end = start + match[0].length;
          const range = protectedCreateRange();
          try {
            range.setStart(currentNode, start);
            range.setEnd(currentNode, end);
          } catch {
            continue;
          }
          const rects = rectsForRange(range, visibility.context);
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
            flow_path: selectorPath(currentBlock),
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

    let paintStack;
    try {
      paintStack = await retainPaintStackVerifiedRuns(nodes);
    } catch (error) {
      paintStack = {
        nodes: [],
        evidence: {
          contract: "browser-paint-stack-v1",
          status: "unavailable",
          unavailable_reason: String(error?.message || error || "paint_stack_verification_failed").slice(0, 500),
        },
      };
    }

    return {
      version: 1,
      state_id: stateIdValue,
      captured_at: capturedAtValue,
      coordinate_space: "document-css-pixels",
      ...(paintStack.evidence.status === "unavailable"
        ? {
            availability_status: "unavailable_paint_stack_verification",
            unavailable_reason: paintStack.evidence.unavailable_reason,
          }
        : {}),
      document: { width: documentWidth, height: documentHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      device_pixel_ratio: window.devicePixelRatio || 1,
      scroll: { x: window.scrollX, y: window.scrollY },
      paint_stack: paintStack.evidence,
      nodes: paintStack.nodes,
    };
}

function unavailableIsolatedGeometry({ capturedAt, stateId, page, error }) {
  const viewport = typeof page?.viewportSize === "function" ? page.viewportSize() : null;
  const reason = `isolated_world_unavailable:${String(error?.message || error || "unknown_error").slice(0, 400)}`;
  return {
    version: 1,
    state_id: stateId,
    captured_at: capturedAt,
    coordinate_space: "document-css-pixels",
    availability_status: "unavailable_isolated_world",
    unavailable_reason: reason,
    document: {
      width: Number(viewport?.width) || 0,
      height: Number(viewport?.height) || 0,
    },
    viewport: {
      width: Number(viewport?.width) || 0,
      height: Number(viewport?.height) || 0,
    },
    device_pixel_ratio: 1,
    paint_stack: {
      contract: "browser-paint-stack-v1",
      status: "unavailable",
      unavailable_reason: reason,
    },
    nodes: [],
  };
}

export async function evaluateWithVisibleTextVisibilitySemantics(page, task, args = {}) {
  if (!page || typeof page.context !== "function" || typeof task !== "function") {
    throw new Error("Visible-text isolation requires a Playwright page and task function.");
  }
  const context = page.context();
  if (!context || typeof context.newCDPSession !== "function") {
    throw new Error("Chromium CDP isolated worlds are unavailable for this page.");
  }
  const session = await context.newCDPSession(page);
  try {
    await session.send("Page.enable");
    const { frameTree } = await session.send("Page.getFrameTree");
    const frameId = frameTree?.frame?.id;
    if (!frameId) throw new Error("Chromium did not expose the main-frame identifier.");
    const world = await session.send("Page.createIsolatedWorld", {
      frameId,
      worldName: `awardping-visible-text-${randomUUID()}`,
      grantUniveralAccess: false,
    });
    if (!Number.isInteger(world?.executionContextId)) {
      throw new Error("Chromium did not create an isolated execution context.");
    }
    const expression = `(async () => {
      const createVisibilityApi = ${createVisibleTextVisibilitySemantics.toString()};
      const runTask = ${task.toString()};
      const visibilityApi = createVisibilityApi(${JSON.stringify({
        minContrastRatioValue: MIN_VISIBLE_TEXT_CONTRAST_RATIO,
        minPaintAlphaValue: MIN_VISIBLE_TEXT_PAINT_ALPHA,
      })});
      return await runTask(${JSON.stringify(args)}, visibilityApi);
    })()`;
    const result = await session.send("Runtime.evaluate", {
      expression,
      contextId: world.executionContextId,
      awaitPromise: true,
      returnByValue: true,
      silent: false,
    });
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "isolated visible-text evaluation failed";
      throw new Error(description);
    }
    if (!result?.result || !("value" in result.result)) {
      throw new Error("Chromium isolated visible-text evaluation returned no serializable value.");
    }
    return result.result.value;
  } finally {
    await session.detach().catch(() => null);
  }
}

export async function captureVisibleTextGeometry(page, { capturedAt = null, stateId = "main" } = {}) {
  try {
    return await evaluateWithVisibleTextVisibilitySemantics(page, collectVisibleTextGeometry, {
      capturedAtValue: capturedAt,
      stateIdValue: stateId,
    });
  } catch (error) {
    return unavailableIsolatedGeometry({ capturedAt, stateId, page, error });
  }
}
