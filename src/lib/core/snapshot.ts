/**
 * DOM snapshot engine — orchestrates the capture pipeline.
 */

import { getSourceAnnotations, getInspectorSelectedId } from '../react/fiber.js';
import { TypefaceProbe, resolveFonts } from '../typography/probe.js';
import { ResourceResolver, CaptureError, resolveResources, canvasToBlob } from '../media/resolver.js';
import { bakeSvgStyles } from '../media/svg.js';
import { resolveTransform, multiplyMatrices, getElementRect } from '../transform/matrix.js';
import { extractComponentTree, findParentComponent } from '../react/tree.js';
import { inferLayoutSizing } from './layout.js';
import { NODE_TYPES, isNodeVisible, shouldPruneNode, iterateChildNodes, getTextRect, getElementAttributes, matrixToSimple, INPUT_TYPES_WITH_PLACEHOLDER } from './walker.js';
import { diffStyles, ensureFlexProps, ensureGridProps, ensureFlexItemProps, BASELINE_STYLES } from './styles.js';
import { prepareForCapture, decodeImages, assertLayoutValid, resetScrollbarState, cleanupScrollbar } from './prepare.js';
import { getDeclaredLayoutStyles } from './declared.js';
import type {
  CaptureTree,
  SnapshotNode,
  ElementSnapshot,
  TextSnapshot,
  CaptureOptions,
  CaptureContext,
  SimpleMatrix,
  SourceAnnotation,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CAPTURE_TIMEOUT = 10000;

export const DEFAULT_CONFIG: Required<Omit<CaptureOptions, 'timeoutSignal'>> = {
  assertLayoutValid: true,
  skipRemoteAssetSerialization: false,
  includeReactFiberTree: false,
  captureDeclaredStyles: false,
};

// ---------------------------------------------------------------------------
// Node ID tracking
// ---------------------------------------------------------------------------

let nodeIdCounter = 0;
const nodeIdMap = new WeakMap<Node, string>();

/**
 * Generate or retrieve a unique h2d node ID for a DOM node.
 */
function generateNodeId(node: Node | null): string {
  if (node !== null) {
    const existing = nodeIdMap.get(node);
    if (existing) return existing;
  }
  const id = `h2d-node-${++nodeIdCounter}`;
  if (node !== null) nodeIdMap.set(node, id);
  return id;
}

/**
 * Retrieve the h2d node ID for an element without generating a new one.
 */
export function getNodeId(element: Node): string | undefined {
  return nodeIdMap.get(element);
}

// ---------------------------------------------------------------------------
// requestAnimationFrame helper
// ---------------------------------------------------------------------------

/**
 * Schedule a callback in a requestAnimationFrame, honouring an AbortSignal.
 */
function safeRequestAnimationFrame(callback: (timestamp: number) => void, signal: AbortSignal): void {
  if (signal.aborted) return;

  const frameId = requestAnimationFrame((timestamp) => {
    if (!signal.aborted) callback(timestamp);
  });

  signal.addEventListener("abort", () => cancelAnimationFrame(frameId), {
    once: true,
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Serialize a DOM element or document into a capture tree.
 */
export async function captureDOM(elementOrDocument: Element | Document, options?: CaptureOptions): Promise<CaptureTree> {
  const mergedOptions = { ...DEFAULT_CONFIG, ...options };
  const ctx: CaptureContext = {
    captureDeclaredStyles: mergedOptions.captureDeclaredStyles === true,
    declaredStylesCache: mergedOptions.captureDeclaredStyles ? new Map() : undefined,
  };

  assertLayoutValid(mergedOptions);
  nodeIdCounter = 0;
  resetScrollbarState();

  const assetCollector = new ResourceResolver(mergedOptions);
  const fontCollector = new TypefaceProbe();

  try {
    return await captureDOMInner(elementOrDocument, mergedOptions, ctx, assetCollector, fontCollector);
  } finally {
    cleanupScrollbar();
  }
}

async function captureDOMInner(
  elementOrDocument: Element | Document,
  mergedOptions: Required<Omit<CaptureOptions, 'timeoutSignal'>> & CaptureOptions,
  ctx: CaptureContext,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
): Promise<CaptureTree> {

  if (elementOrDocument instanceof Element) {
    // Scroll through the page to trigger lazy-loaded images
    await prepareForCapture(elementOrDocument);
    await decodeImages(Array.from(elementOrDocument.querySelectorAll("img")));

    const serialized = await snapshotInAnimationFrame(
      elementOrDocument,
      assetCollector,
      fontCollector,
      mergedOptions,
      ctx,
    );

    const blobMap = await assetCollector.getBlobMap();
    const fonts = fontCollector.getFonts();
    const { width, height } = elementOrDocument.getBoundingClientRect();

    if (!serialized || serialized.nodeType !== NODE_TYPES.ELEMENT_NODE) {
      throw new Error("Container node could not be serialized");
    }

    const experimental = mergedOptions.includeReactFiberTree
      ? { reactFiberTree: extractComponentTree(elementOrDocument, getNodeId) }
      : undefined;

    return {
      root: serialized as ElementSnapshot,
      documentTitle: document.title || undefined,
      experimental,
      documentRect: {
        x: 0,
        y: 0,
        width: elementOrDocument.scrollWidth,
        height: elementOrDocument.scrollHeight,
      },
      viewportRect: {
        x: elementOrDocument.scrollLeft,
        y: elementOrDocument.scrollTop,
        width,
        height,
      },
      devicePixelRatio: window.devicePixelRatio,
      assets: blobMap,
      fonts,
    };
  } else if (elementOrDocument instanceof Document) {
    await prepareForCapture(elementOrDocument.documentElement);
    await decodeImages(Array.from(elementOrDocument.images));

    const serialized = await snapshotInAnimationFrame(
      elementOrDocument.documentElement,
      assetCollector,
      fontCollector,
      mergedOptions,
      ctx,
    );

    const blobMap = await assetCollector.getBlobMap();
    const fonts = fontCollector.getFonts();

    if (!serialized || serialized.nodeType !== NODE_TYPES.ELEMENT_NODE) {
      throw new Error("Container node must have a body element");
    }

    const experimental = mergedOptions.includeReactFiberTree
      ? { reactFiberTree: extractComponentTree(elementOrDocument.documentElement, getNodeId) }
      : undefined;

    return {
      documentTitle: elementOrDocument.title || undefined,
      root: serialized as ElementSnapshot,
      experimental,
      documentRect: {
        x: 0,
        y: 0,
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      viewportRect: {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      },
      devicePixelRatio: window.devicePixelRatio,
      assets: blobMap,
      fonts,
    };
  }

  throw new Error("Container node must be an Element or Document");
}

// ---------------------------------------------------------------------------
// Animation-frame serialization
// ---------------------------------------------------------------------------

/**
 * Schedule the DOM tree walk inside a requestAnimationFrame and apply a
 * timeout via an AbortSignal.
 */
function snapshotInAnimationFrame(
  element: Element,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  options: CaptureOptions,
  ctx: CaptureContext,
): Promise<SnapshotNode | null> {
  assertLayoutValid(options);

  const signal = options.timeoutSignal ?? AbortSignal.timeout(CAPTURE_TIMEOUT);

  return new Promise((resolve, reject) => {
    safeRequestAnimationFrame(
      () => resolve(snapshotNode(element, assetCollector, fontCollector, undefined, ctx)),
      signal,
    );

    signal.addEventListener(
      "abort",
      () => reject(new CaptureError("requestAnimationFrame timed out", "PAGE_NOT_RESPONDING")),
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// Node dispatcher
// ---------------------------------------------------------------------------

/**
 * Serialize a single DOM node, dispatching to element or text serializers.
 */
function snapshotNode(
  node: Node | Node[],
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  parentTransform: DOMMatrix | undefined,
  ctx: CaptureContext,
): SnapshotNode | null {
  if (Array.isArray(node) || node.nodeType === Node.TEXT_NODE) {
    return snapshotTextNode(node);
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    return snapshotElement(node as Element, assetCollector, fontCollector, parentTransform, ctx);
  }

  if (node.nodeType !== Node.COMMENT_NODE) {
    console.warn(`Unsupported node type: ${node.nodeType}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Element serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a single DOM element into the capture node format.
 */
function snapshotElement(
  element: Element,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  parentTransform: DOMMatrix | undefined,
  ctx: CaptureContext,
): ElementSnapshot | null {
  const childNodes: SnapshotNode[] = [];
  let svgContent: string | undefined;
  let placeholderUrl: string | undefined;
  let selectionSourceId: string | undefined;

  if (!isNodeVisible(element)) return null;

  const tag = element.tagName.toUpperCase();

  // Skip non-visual elements entirely.
  if (tag === "HEAD" || tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
    return null;
  }

  // Source annotations from React/Figma instrumentation.
  const sources = getSourceAnnotations(element);
  if (sources && sources.length > 0) {
    // If there is exactly one text child with a source annotation, wrap it.
    if (sources[0]?.type === "text" && element.childNodes.length === 1) {
      const textNode = snapshotTextNode(element.childNodes[0]);
      (textNode as TextSnapshot & { sources?: SourceAnnotation[] }).sources = sources;
      return textNode as unknown as ElementSnapshot;
    }
    selectionSourceId = getInspectorSelectedId(element);
  }

  // Computed style diff vs defaults.
  const computedStyles = diffStyles(element);

  // Browser propagates body background to the viewport when html has no background.
  // Replicate this so Figma shows the correct background on the root frame.
  if (tag === "HTML" && !computedStyles.backgroundColor && !computedStyles.backgroundImage) {
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    if (bodyBg && bodyBg !== "rgba(0, 0, 0, 0)") {
      computedStyles.backgroundColor = bodyBg;
    }
  }

  // For flex/grid containers, always include layout properties even if they
  // match browser defaults — Figma needs them to reconstruct the layout.
  const displayValue = computedStyles.display;
  if (displayValue === "flex" || displayValue === "inline-flex") {
    ensureFlexProps(element, computedStyles);
  } else if (displayValue === "grid" || displayValue === "inline-grid") {
    ensureGridProps(element, computedStyles);
  }

  // For flex/grid children, always include item-level properties.
  const parentDisplay = element.parentElement
    ? window.getComputedStyle(element.parentElement).display
    : "";
  if (
    parentDisplay === "flex" || parentDisplay === "inline-flex" ||
    parentDisplay === "grid" || parentDisplay === "inline-grid"
  ) {
    ensureFlexItemProps(element, computedStyles);
  }

  // Declared grid styles (if enabled).
  const declaredStyles =
    ctx?.captureDeclaredStyles === true && ctx.declaredStylesCache
      ? getDeclaredLayoutStyles(element, ctx.declaredStylesCache)
      : {};

  // Transform matrix.
  const elementTransform = resolveTransform(computedStyles as unknown as CSSStyleDeclaration);
  const combinedTransform = multiplyMatrices(parentTransform, elementTransform);

  // SVG: serialize inline; Canvas: rasterize; otherwise: recurse children.
  if (element instanceof SVGElement) {
    svgContent = bakeSvgStyles(element);
  } else if (element instanceof HTMLCanvasElement) {
    placeholderUrl = assetCollector.addCanvas(element);
  } else {
    const root = element.shadowRoot ?? element;
    for (const childOrGroup of iterateChildNodes(root)) {
      const serialized = snapshotNode(childOrGroup, assetCollector, fontCollector, combinedTransform, ctx);
      if (serialized != null) childNodes.push(serialized);
    }
  }

  // Pseudo-element styles (::before, ::after, ::placeholder).
  let pseudoElementStyles: Record<string, Record<string, string>> | undefined;

  // ::before / ::after — capture when they have visible content
  for (const pseudo of ["::before", "::after"] as const) {
    const pseudoComputed = window.getComputedStyle(element, pseudo);
    const contentValue = pseudoComputed.content;
    if (contentValue && contentValue !== "none" && contentValue !== "normal") {
      if (!pseudoElementStyles) pseudoElementStyles = {};
      const styles = diffStyles(element, pseudo);
      styles.content = contentValue;
      pseudoElementStyles[pseudo === "::before" ? "before" : "after"] = styles;
    }
  }

  // ::placeholder for inputs/textareas
  if (
    (element instanceof HTMLInputElement && INPUT_TYPES_WITH_PLACEHOLDER.has(element.type)) ||
    element instanceof HTMLTextAreaElement
  ) {
    if (element.placeholder) {
      if (!pseudoElementStyles) pseudoElementStyles = {};
      pseudoElementStyles.placeholder = diffStyles(element, "::placeholder");
    }
  }

  // Collect images/videos/backgrounds and font usage.
  resolveResources(element, computedStyles as unknown as CSSStyleDeclaration, assetCollector);
  resolveFonts(element, computedStyles as unknown as CSSStyleDeclaration, fontCollector);

  // Element bounding rect (may include rotated quad).
  const rect = getElementRect(element, computedStyles as unknown as CSSStyleDeclaration, combinedTransform);

  // Prune invisible nodes (zero-size without children, offscreen, etc.)
  if (shouldPruneNode(element, rect, childNodes)) {
    return null;
  }

  // Infer layout sizing hints for Figma Auto Layout.
  const sizing = inferLayoutSizing(element, computedStyles, element.parentElement);

  const node: ElementSnapshot = {
    nodeType: Node.ELEMENT_NODE as 1,
    id: generateNodeId(element),
    tag,
    attributes: getElementAttributes(element),
    styles: computedStyles,
    rect,
    childNodes,
    content: svgContent,
    placeholderUrl,
    pseudoElementStyles,
    owningReactComponent: findParentComponent(element),
    sources,
    selectionSourceId,
    relativeTransform: elementTransform ? matrixToSimple(elementTransform) : undefined,
    layoutSizingHorizontal: sizing.horizontal,
    layoutSizingVertical: sizing.vertical,
  };

  if (Object.keys(declaredStyles).length > 0) {
    node.declaredStyles = declaredStyles;
  }

  return node;
}

// ---------------------------------------------------------------------------
// Text node serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a text node (or group of adjacent text nodes).
 */
function snapshotTextNode(nodeOrNodes: Node | Node[]): TextSnapshot {
  const { lineCount, ...rectWithoutLineCount } = getTextRect(nodeOrNodes);

  const text = Array.isArray(nodeOrNodes)
    ? nodeOrNodes.map((n) => n.textContent || "").join("")
    : nodeOrNodes.textContent || "";

  const identityNode = Array.isArray(nodeOrNodes)
    ? nodeOrNodes.length === 1
      ? nodeOrNodes[0]
      : null
    : nodeOrNodes;

  return {
    nodeType: Node.TEXT_NODE as 3,
    id: generateNodeId(identityNode),
    text,
    rect: rectWithoutLineCount,
    lineCount,
  };
}
