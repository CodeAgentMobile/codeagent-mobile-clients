/**
 * "Point at it": the ONE in-page element picker, for both hosts.
 *
 * - Remix (the Worker injects it into every WEB app): `mode: 'single'` — one
 *   pick, then off. Channel `'remix-point'` on field `channel`.
 * - The console Preview (the CLI's preview proxy injects it): `mode: 'multi'`
 *   — up to `maxMarks` picks, each leaving a numbered mark, plus the agent's
 *   highlights and the React source. Channel `'codeam-inspector'` on field
 *   `source`.
 *
 * Single mode is the Remix picker as it shipped in
 * `codeagent-mobile/apps/remix-worker/src/point.ts`, behaviour for behaviour
 * (its tests run unchanged in `remix-compat.test.ts`). Multi mode keeps the
 * console inspector's wire protocol and replaces only its drawing.
 *
 * It runs inside somebody else's app, so:
 *
 *  1. Inert by default. At load it only listens for `message`; it observes,
 *     paints and blocks nothing until the parent turns it on.
 *  2. Allow-listed parents. Only `allowedParents`, and only from the parent
 *     window, can drive it. (The React Native door, below, is the host app
 *     calling into its OWN WebView — there is no third party to filter.)
 *  3. Describes, never extracts. It reports the element the person pointed
 *     at (bounded text and markup), never form values or storage.
 *  4. Fully reversible. Turning it off removes every listener and node; the
 *     console's pinned marks and agent highlights go when the parent clears
 *     them (`marks([])`, `agent-clear`).
 *
 * It is TEXT, not a module: its destination is the <head> of a user app. It
 * runs both as a classic script and as a `new Function('window', 'document',
 * src)` body (the Worker's tests), so it only names `window` and `document`.
 */

export interface PointPickerOptions {
  /** `'remix-point'` (Remix) | `'codeam-inspector'` (console). */
  channel: string;
  /** The message field that carries the channel: `channel` (Remix) | `source` (console). */
  channelField: 'channel' | 'source';
  /** Origins allowed to drive the picker (the pages that frame the app). */
  allowedParents: readonly string[];
  /**
   * `single`: off after one pick, acks `on`, Escape sends `cancel` (Remix).
   * `multi`: stays on, acks `ready`, reports `hover`, each pick leaves a
   * numbered mark kept in sync by `marks(ids)` (console).
   */
  mode: 'single' | 'multi';
  /** Multi mode: how many marks the page keeps (default 4, the apps' `MAX_MARKS`). */
  maxMarks?: number;
  /** Default ring accent, `#RRGGBB`; an `enable` message may override it. */
  accent?: string;
  /** Console: `agent-highlight` / `agent-clear` (the agent's cyan marks). */
  agentHighlights?: boolean;
  /** Console: React `_debugSource` (`{ file, line }`) on every described element. */
  reactSource?: boolean;
  /**
   * Console: the control API (`enable`, `disable`, `marks`, `highlight`,
   * `clear`) exposed as `window[globalName]` — only inside a React Native
   * WebView, whose host drives it with `injectJavaScript` — and messages are
   * then published over `ReactNativeWebView.postMessage` as JSON strings.
   */
  globalName?: string;
}

/** What a `pick` (and, in multi mode, a `hover`) carries as `element`. */
export interface PointPick {
  tag: string;
  id: string | null;
  /** The `class` attribute, squashed — a string on the wire, as both apps read it. */
  classes: string;
  selector: string;
  text: string;
  html: string;
  rect: { x: number; y: number; w: number; h: number };
  /** Multi mode: the page's id for the mark this pick left (absent past `maxMarks`). */
  markId?: string;
  /** Multi mode: the page viewport the rect is measured against. */
  viewport?: { w: number; h: number };
  /** `reactSource`: the component's file and line, `null` without a dev React. */
  source?: { file: string; line: number | null } | null;
}

export const POINT_TEXT_MAX = 120;
export const POINT_HTML_MAX = 600;

const DEFAULT_ACCENT = '#7C5CFF';
const HEX = /^#[0-9A-Fa-f]{6}$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * JSON for embedding in a <script>: `<` escaped so no value (an origin with
 * `</script>` in it) can close the tag early. Same value once parsed.
 */
function js(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

/** The picker as a self-contained IIFE. Idempotent per channel (a window flag). */
export function pointPickerScript(opts: PointPickerOptions): string {
  const multi = opts.mode === 'multi';
  const maxMarks = opts.maxMarks ?? 4;
  const accent = opts.accent ?? DEFAULT_ACCENT;
  if (opts.channelField !== 'channel' && opts.channelField !== 'source') {
    throw new Error(`pointPickerScript: bad channelField ${String(opts.channelField)}`);
  }
  if (!HEX.test(accent))
    throw new Error(`pointPickerScript: accent must be #RRGGBB, got ${accent}`);
  if (!Number.isInteger(maxMarks) || maxMarks < 1) {
    throw new Error(`pointPickerScript: maxMarks must be a positive integer, got ${maxMarks}`);
  }
  if (opts.globalName !== undefined && !IDENT.test(opts.globalName)) {
    throw new Error(`pointPickerScript: globalName must be an identifier, got ${opts.globalName}`);
  }

  return `(function () {
  'use strict';
  var W = window, D = document;
  var CH = ${js(opts.channel)};
  var FIELD = ${js(opts.channelField)};
  var ALLOWED = ${js(opts.allowedParents)};
  var MULTI = ${multi}, MAX_MARKS = ${maxMarks}, AGENT = ${!!opts.agentHighlights}, REACT_SOURCE = ${!!opts.reactSource};
  var GLOBAL = ${js(opts.globalName ?? null)};
  var DEFAULT_ACCENT = ${js(accent)};
  var GUARD = '__pointPicker:' + CH;
  if (W[GUARD]) return;
  try { Object.defineProperty(W, GUARD, { value: true }); } catch (e) { return; }
  try {
  var TEXT_MAX = ${POINT_TEXT_MAX}, HTML_MAX = ${POINT_HTML_MAX}, ATTR_MAX = 60;
  var ACCENT_RE = /^#[0-9A-Fa-f]{6}$/;
  var AGENT_ACCENT = '#22d3ee';
  var EASE = 'cubic-bezier(.2,.8,.2,1)';
  var CHIP_FONT = 'italic 500 13px/1.3 Georgia,"Times New Roman",serif';
  var CONTROLS = { BUTTON: 1, A: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, LABEL: 1, SUMMARY: 1 };
  var ROLES = { button: 1, link: 1, tab: 1, checkbox: 1, switch: 1, menuitem: 1, option: 1, radio: 1, slider: 1 };
  var VOID = { AREA: 1, BR: 1, COL: 1, EMBED: 1, HR: 1, IMG: 1, INPUT: 1, LINK: 1, META: 1, SOURCE: 1, TRACK: 1, WBR: 1 };
  var GRAIN = "url(\\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .08 0 0 0 0 .08 0 0 0 0 .09 0 0 0 .12 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\\")";

  var on = false, driver = null, accent = DEFAULT_ACCENT;
  var host = null, veil = null, ring = null, chip = null, style = null, leaving = null;
  var current = null, down = null, tapped = false, bound = [], swallow = null;
  // Multi mode: the pinned marks, drawn in the page and anchored to the document.
  // Mark ids carry a per-load prefix: after a reload \`seq\` restarts, and the
  // app may still hold the previous page's p…-1.
  var picked = [], seq = 0, marksHost = null, marksRoot = null;
  var LOAD = (Math.random().toString(36).slice(2) + '0000').slice(0, 4);
  // The agent's highlights: separate from the person's marks, never numbered.
  var agentMarks = [], agentHost = null, agentRoot = null, agentLayer = null, agentCursor = null, agentListening = false;

  // Inside a React Native WebView the document is TOP-LEVEL (window.parent ===
  // window), so the only way out is the bridge RN injects. It carries STRINGS.
  function rnBridge() {
    if (!GLOBAL) return null;
    var rn = W.ReactNativeWebView;
    return rn && typeof rn.postMessage === 'function' ? rn : null;
  }

  function send(type, extra) {
    if (!driver) return;
    var msg = {};
    msg[FIELD] = CH;
    msg.type = type;
    if (extra) for (var k in extra) msg[k] = extra[k];
    var rn = rnBridge();
    if (rn) {
      try { rn.postMessage(JSON.stringify(msg)); } catch (e) {}
      return;
    }
    if (W.parent === W) return;
    try { W.parent.postMessage(msg, driver); } catch (e) {}
  }

  function clip(s, max) { return s.length > max ? s.slice(0, max - 1) + '\\u2026' : s; }
  function squash(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); }
  function attr(el, n) { var v = el.getAttribute ? el.getAttribute(n) : null; return v == null ? '' : String(v); }
  function tagOf(el) { return String(el.tagName || '').toLowerCase(); }
  function reduced() {
    try { return !!(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }
  function drop(node) { if (node && node.parentNode) node.parentNode.removeChild(node); }
  function shadowOf(el) { return el.attachShadow ? el.attachShadow({ mode: 'closed' }) : el; }
  function clear(node) { while (node && node.childNodes && node.childNodes.length) node.removeChild(node.childNodes[0]); }

  // A tap lands on the innermost node (the <span> in a button, the <path> in
  // an icon); the person means the control around it.
  function target(el) {
    var n = el;
    for (var depth = 0; n && n !== D.body && n !== D.documentElement && depth < 6; depth++) {
      if (CONTROLS[String(n.tagName).toUpperCase()] || ROLES[attr(n, 'role')]) return n;
      n = n.parentElement;
    }
    n = el;
    while (n.ownerSVGElement) n = n.ownerSVGElement;
    return n;
  }

  function pickable(el) {
    return !!el && el.nodeType === 1 && el !== D.documentElement && el !== D.body &&
      el !== host && el !== marksHost && el !== agentHost;
  }

  // CSS.escape where the browser has it; else the same algorithm (CSSOM).
  // Without it a Tailwind class (\`md:flex\`, \`w-1/2\`) makes an invalid selector.
  function cssEsc(v) {
    v = String(v);
    try { if (W.CSS && typeof W.CSS.escape === 'function') return W.CSS.escape(v); } catch (e) {}
    var out = '';
    for (var i = 0; i < v.length; i++) {
      var ch = v.charAt(i), code = v.charCodeAt(i);
      if (code === 0) out += '\\uFFFD';
      else if ((code >= 1 && code <= 31) || code === 127 || (i === 0 && code >= 48 && code <= 57) ||
        (i === 1 && code >= 48 && code <= 57 && v.charAt(0) === '-')) out += '\\\\' + code.toString(16) + ' ';
      else if (i === 0 && ch === '-' && v.length === 1) out += '\\\\-';
      else if (code >= 128 || ch === '-' || ch === '_' || /[0-9A-Za-z]/.test(ch)) out += ch;
      else out += '\\\\' + ch;
    }
    return out;
  }

  // One step of the path. \`lean\` (tag + position only) is the fallback for
  // a step that alone would not fit the budget.
  function step(el, lean) {
    var t = tagOf(el);
    if (el.id && !lean) return t + '#' + cssEsc(el.id);
    var c = lean ? [] : squash(attr(el, 'class')).split(' ').filter(Boolean).slice(0, 2);
    var s = t;
    for (var k = 0; k < c.length; k++) s += '.' + cssEsc(c[k]);
    var p = el.parentElement;
    if (p && p.children) {
      var same = 0, index = 0;
      for (var i = 0; i < p.children.length; i++) {
        if (p.children[i].tagName === el.tagName) {
          same++;
          if (p.children[i] === el) index = same;
        }
      }
      if (same > 1) s += ':nth-of-type(' + index + ')';
    }
    return s;
  }

  // Never cut with an ellipsis (that would be no selector at all): drop the
  // outermost ancestors until the path fits, so it always matches the element.
  function selectorFor(el) {
    var parts = [], n = el;
    while (n && n.nodeType === 1 && n !== D.body && n !== D.documentElement && parts.length < 4) {
      parts.unshift(step(n));
      if (n.id) break;
      n = n.parentElement;
    }
    while (parts.length > 1 && parts.join(' > ').length > 200) parts.shift();
    if (parts[0].length > 200) parts[0] = step(el, true);
    return parts.join(' > ');
  }

  function textOf(el) {
    return clip(squash(attr(el, 'aria-label') || el.textContent || attr(el, 'placeholder') || attr(el, 'alt') || attr(el, 'title')), TEXT_MAX);
  }

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  // The element's markup within a budget: attributes trimmed, never more than
  // HTML_MAX characters walked, so a huge container costs nothing.
  function htmlOf(el) {
    var out = [], left = HTML_MAX + 1;
    function put(s) {
      if (left <= 0) return;
      out.push(s.length > left ? s.slice(0, left) : s);
      left -= s.length;
    }
    function walk(n, depth) {
      if (left <= 0) return;
      if (n.nodeType === 3) {
        var text = String(n.nodeValue == null ? '' : n.nodeValue).replace(/\\s+/g, ' ');
        if (text.trim()) put(esc(text));
        return;
      }
      if (n.nodeType !== 1) return;
      var t = tagOf(n);
      put('<' + t);
      var a = n.attributes || [];
      for (var i = 0; i < a.length; i++) put(' ' + a[i].name + '="' + esc(clip(String(a[i].value), ATTR_MAX)) + '"');
      put('>');
      if (VOID[t.toUpperCase()]) return;
      if (t === 'script' || t === 'style') put('\\u2026');
      else if (depth >= 4) { if (n.childNodes && n.childNodes.length) put('\\u2026'); }
      else for (var c = 0; n.childNodes && c < n.childNodes.length && left > 0; c++) walk(n.childNodes[c], depth + 1);
      put('</' + t + '>');
    }
    walk(el, 0);
    var s = out.join('');
    return s.length > HTML_MAX ? s.slice(0, HTML_MAX - 1) + '\\u2026' : s;
  }

  // The React component's file and line, when a dev build exposes them: the
  // agent gets "components/buy-button.tsx:42" instead of a CSS path.
  function reactSourceOf(el) {
    try {
      for (var key in el) {
        if (key.indexOf('__reactFiber$') !== 0) continue;
        var fiber = el[key];
        while (fiber) {
          var src = fiber._debugSource;
          if (src && src.fileName) return { file: String(src.fileName), line: Number(src.lineNumber) || null };
          fiber = fiber.return;
        }
      }
    } catch (e) {}
    return null;
  }

  function describe(el) {
    var r = el.getBoundingClientRect();
    var out = {
      tag: tagOf(el),
      id: el.id ? clip(String(el.id), 100) : null,
      classes: clip(squash(attr(el, 'class')), 200),
      selector: selectorFor(el),
      text: textOf(el),
      html: htmlOf(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    };
    if (MULTI) out.viewport = { w: W.innerWidth, h: W.innerHeight };
    if (REACT_SOURCE) out.source = reactSourceOf(el);
    return out;
  }

  function kindOf(el) {
    var t = tagOf(el), role = attr(el, 'role'), type = attr(el, 'type');
    if (t === 'button' || role === 'button' || (t === 'input' && /^(button|submit|reset)$/.test(type))) return 'button';
    if (t === 'a' || role === 'link') return 'link';
    if (t === 'input' || t === 'textarea' || t === 'select') return 'field';
    if (t === 'img' || t === 'svg' || t === 'picture' || t === 'canvas') return 'image';
    if (/^h[1-6]$/.test(t)) return 'heading';
    return t;
  }

  function label(el) {
    var text = squash(textOf(el));
    var kind = kindOf(el);
    return text ? '\\u201c' + clip(text, 28) + '\\u201d ' + kind : kind;
  }

  function cursor() {
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><circle cx='16' cy='16' r='9.5' fill='" + accent + "' fill-opacity='.14' stroke='" + accent + "' stroke-width='2'/><path d='M16 1v7M16 24v7M1 16h7M24 16h7' stroke='" + accent + "' stroke-width='1.6' stroke-linecap='round'/><circle cx='16' cy='16' r='1.6' fill='" + accent + "'/></svg>";
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '") 16 16, crosshair';
  }

  function canHole() {
    try { return !!(W.CSS && W.CSS.supports && W.CSS.supports('clip-path', 'path(evenodd, "M0 0H1V1Z")')); } catch (e) { return false; }
  }

  // The veil covers the app except a rounded window around the element.
  function holePath(r) {
    var w = Math.round(W.innerWidth), h = Math.round(W.innerHeight), p = 6;
    var x = Math.round(r.left - p), y = Math.round(r.top - p);
    var rw = Math.round(r.width + 2 * p), rh = Math.round(r.height + 2 * p);
    var k = Math.max(0, Math.min(12, Math.floor(rw / 2), Math.floor(rh / 2)));
    var arc = 'A' + k + ' ' + k + ' 0 0 1 ';
    return 'path(evenodd, "M0 0H' + w + 'V' + h + 'H0Z' +
      'M' + (x + k) + ' ' + y + 'H' + (x + rw - k) + arc + (x + rw) + ' ' + (y + k) +
      'V' + (y + rh - k) + arc + (x + rw - k) + ' ' + (y + rh) +
      'H' + (x + k) + arc + x + ' ' + (y + rh - k) +
      'V' + (y + k) + arc + (x + k) + ' ' + y + 'Z")';
  }

  // The Remix ring and chip, shared by the pointer, the marks and the agent.
  function ringCss(color) {
    return 'box-sizing:border-box;border:2px solid ' + color + ';border-radius:12px;box-shadow:0 0 0 5px ' + color + '29';
  }
  function chipCss(color) {
    return 'white-space:nowrap;padding:4px 10px;border-radius:999px;background:#141416;color:#f6f3ee;font:' + CHIP_FONT +
      ';box-shadow:0 0 0 1px ' + color;
  }

  // A host for our nodes: a custom element, max z-index, its own closed
  // shadow root so the page's CSS can't restyle (or hide) what we draw. Last
  // child of <html>, so at an equal z-index it still paints on top.
  function makeHost(role, position) {
    var el = D.createElement('remix-point');
    if (role === 'point') el.setAttribute('data-remix-point', '');
    el.setAttribute('data-codeam', role);
    el.style.cssText = 'all:initial;position:' + position + ';top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647';
    return el;
  }

  function build() {
    if (leaving && leaving.parentNode) leaving.parentNode.removeChild(leaving);
    leaving = null;
    var motion = reduced() ? 'none' : 'transform .16s ' + EASE + ', width .16s ' + EASE + ', height .16s ' + EASE + ', opacity .16s';
    host = makeHost('point', 'fixed');
    var root = shadowOf(host);
    veil = D.createElement('div');
    veil.setAttribute('data-codeam', 'veil');
    veil.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;opacity:0;' +
      'background:rgba(246,243,238,.46) ' + GRAIN + ';-webkit-backdrop-filter:grayscale(.7);backdrop-filter:grayscale(.7);' +
      'transition:' + (reduced() ? 'none' : 'opacity .2s');
    ring = D.createElement('div');
    ring.setAttribute('data-codeam', 'ring');
    ring.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;opacity:0;' +
      ringCss(accent) + ';transition:' + motion;
    chip = D.createElement('div');
    chip.setAttribute('data-codeam', 'chip');
    chip.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;opacity:0;' + chipCss(accent) + ';transition:' + motion;
    root.appendChild(veil);
    root.appendChild(ring);
    root.appendChild(chip);
    D.documentElement.appendChild(host);
    style = D.createElement('style');
    style.textContent = 'html[data-remix-pointing],html[data-remix-pointing] *{cursor:' + cursor() + ' !important;' +
      'user-select:none !important;-webkit-user-select:none !important;-webkit-touch-callout:none !important}';
    (D.head || D.documentElement).appendChild(style);
    D.documentElement.setAttribute('data-remix-pointing', '');
  }

  function paint(el) {
    current = el;
    var r = el.getBoundingClientRect();
    ring.style.transform = 'translate(' + Math.round(r.left - 4) + 'px,' + Math.round(r.top - 4) + 'px)';
    ring.style.width = Math.round(r.width + 8) + 'px';
    ring.style.height = Math.round(r.height + 8) + 'px';
    ring.style.opacity = '1';
    if (canHole()) {
      veil.style.clipPath = holePath(r);
      veil.style.opacity = '1';
    }
    chip.textContent = label(el);
    var top = r.top >= 34 ? r.top - 32 : r.top + r.height + 8;
    var left = Math.max(8, Math.min(r.left, W.innerWidth - 200));
    chip.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
    chip.style.opacity = '1';
  }

  // Paint, and in multi mode tell the parent what is under the finger.
  function hoverTo(el) {
    var changed = el !== current;
    paint(el);
    if (changed && MULTI) send('hover', { element: describe(el) });
  }

  // While pointing, the app never sees the gesture: no click, no focus, no
  // drag. Touch scrolling still works (its default is left alone).
  function block(e) {
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.cancelable && e.type !== 'touchstart' && e.type !== 'touchmove') e.preventDefault();
  }

  // What is under the pointer. Hit-testing first (a touch keeps targeting
  // the element it went down on); the event target where there is none.
  function at(e) {
    var el = null;
    if (D.elementFromPoint) {
      try { el = D.elementFromPoint(e.clientX, e.clientY); } catch (x) { el = null; }
    }
    if (!el && e.target && e.target.nodeType === 1) el = e.target;
    return pickable(el) ? target(el) : null;
  }

  function onDown(e) {
    block(e);
    down = { id: e.pointerId };
    tapped = true;
    var el = at(e);
    if (el) hoverTo(el);
  }

  function onMove(e) {
    block(e);
    var el = at(e);
    if (el && el !== current) hoverTo(el);
  }

  // Browsers without pointer events (old WebViews) only send mouse events.
  // Never blocked: the app keeps its own mousemove, as it always did.
  function onMouseMove(e) {
    var el = at(e);
    if (el && el !== current) hoverTo(el);
  }

  function onUp(e) {
    block(e);
    var d = down;
    down = null;
    if (!d || d.id !== e.pointerId || e.button > 0) return;
    var el = at(e) || current;
    if (el) {
      pick(el);
      armClickSwallow();
    }
  }

  // The click that follows a tap was already picked on pointerup; a click
  // with no pointer gesture before it (an old WebView) is the pick itself.
  function onClick(e) {
    block(e);
    if (tapped) { tapped = false; return; }
    var el = at(e);
    if (el) pick(el);
  }

  // The browser fires a click after the pointerup that picked. Once pointing
  // is off (single mode, or the parent turned it off in between) nothing of
  // ours would catch it, and a pointed-at link would navigate. One shot:
  // gone on the next click, or after 400 ms when no click comes.
  function armClickSwallow() {
    disarmClickSwallow();
    var fn = function (e) {
      block(e);
      disarmClickSwallow();
    };
    swallow = fn;
    W.addEventListener('click', fn, { capture: true, passive: false });
    W.setTimeout(function () { if (swallow === fn) disarmClickSwallow(); }, 400);
  }

  function disarmClickSwallow() {
    if (!swallow) return;
    W.removeEventListener('click', swallow, { capture: true });
    swallow = null;
  }

  // The browser took the touch over to scroll: that was not a tap.
  function onCancel(e) {
    block(e);
    down = null;
    tapped = false;
  }

  function onKey(e) {
    block(e);
    // In multi mode the parent owns the toggle: Escape ends nothing it can't see.
    if (!MULTI && e.type === 'keydown' && (e.key === 'Escape' || e.key === 'Esc')) {
      send('cancel');
      off(false);
    }
  }

  function onScroll() {
    if (current) paint(current);
    if (picked.length) drawMarks();
  }

  var HANDLERS = [
    ['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onCancel],
    ['mousedown', block], ['mouseup', block], ['mousemove', onMouseMove], ['click', onClick], ['dblclick', block], ['auxclick', block],
    ['contextmenu', block], ['touchstart', block], ['touchmove', block], ['touchend', block],
    ['submit', block], ['keydown', onKey], ['keyup', block], ['keypress', block]
  ];

  function pick(el) {
    var element = describe(el);
    if (!MULTI) {
      off(true);
      send('pick', { element: element });
      return;
    }
    // Past the cap the pick still goes up (the app says "4 marks max") but
    // leaves nothing in the page the app would never be able to remove.
    if (picked.length < MAX_MARKS) {
      var id = 'p' + LOAD + '-' + (++seq);
      picked.push({ id: id, el: el });
      element.markId = id;
      drawMarks(id);
    }
    send('pick', { element: element });
  }

  // The pinned marks: Remix rings with a numbered chip, anchored to the
  // DOCUMENT (absolute + scroll) so they travel with the content.
  function drawMarks(fresh) {
    if (!picked.length) {
      drop(marksHost);
      marksHost = marksRoot = null;
      return;
    }
    if (!marksHost || !marksHost.parentNode) {
      marksHost = makeHost('marks', 'absolute');
      marksRoot = shadowOf(marksHost);
      D.documentElement.appendChild(marksHost);
    }
    clear(marksRoot);
    var calm = reduced();
    if (!calm) {
      var keys = D.createElement('style');
      keys.textContent = '@keyframes pp-pin{from{opacity:0;transform:scale(1.04)}to{opacity:1;transform:scale(1)}}';
      marksRoot.appendChild(keys);
    }
    var sx = W.scrollX || W.pageXOffset || 0, sy = W.scrollY || W.pageYOffset || 0;
    for (var i = 0; i < picked.length; i++) {
      var r = picked[i].el.getBoundingClientRect();
      var box = D.createElement('div');
      box.setAttribute('data-codeam', 'mark');
      box.style.cssText = 'position:absolute;pointer-events:none;' + ringCss(accent) +
        ';left:' + Math.round(r.left + sx - 4) + 'px;top:' + Math.round(r.top + sy - 4) + 'px' +
        ';width:' + Math.round(r.width + 8) + 'px;height:' + Math.round(r.height + 8) + 'px' +
        (!calm && picked[i].id === fresh ? ';animation:pp-pin .32s ' + EASE : '');
      var badge = D.createElement('div');
      badge.setAttribute('data-codeam', 'mark-badge');
      badge.style.cssText = 'position:absolute;left:-11px;top:-11px;width:22px;height:22px;border-radius:11px;' +
        'background:#141416;color:#f6f3ee;font:italic 600 12px/22px Georgia,"Times New Roman",serif;text-align:center;' +
        'box-shadow:0 0 0 1px ' + accent + ';pointer-events:none';
      badge.textContent = String(i + 1);
      box.appendChild(badge);
      marksRoot.appendChild(box);
    }
  }

  // The parent sends the ids still alive, in order: a removed chip removes
  // its mark, and the rest renumber (what the person writes, "1 is off",
  // refers to these numbers).
  function syncMarks(ids) {
    var byId = {};
    for (var i = 0; i < picked.length; i++) byId[picked[i].id] = picked[i];
    var next = [];
    for (var j = 0; j < ids.length; j++) if (byId[ids[j]]) next.push(byId[ids[j]]);
    picked = next;
    drawMarks();
  }

  // The agent pointing (highlight_element): a cursor travels to the element,
  // centres it, and leaves a cyan Remix ring with its label. Independent of
  // pointing mode, anchored to the document like the marks.
  function ensureAgent() {
    if (agentHost && agentHost.parentNode) return;
    agentHost = makeHost('agent', 'absolute');
    agentRoot = shadowOf(agentHost);
    var keys = D.createElement('style');
    keys.textContent =
      '@keyframes pp-agent-pulse{0%{box-shadow:0 0 0 0 rgba(34,211,238,.55)}70%{box-shadow:0 0 0 10px rgba(34,211,238,0)}100%{box-shadow:0 0 0 5px rgba(34,211,238,.16)}}' +
      '@keyframes pp-agent-in{from{opacity:0;transform:scale(1.04)}to{opacity:1;transform:scale(1)}}';
    agentRoot.appendChild(keys);
    agentLayer = D.createElement('div');
    agentRoot.appendChild(agentLayer);
    D.documentElement.appendChild(agentHost);
  }

  function ensureAgentCursor() {
    if (agentCursor && agentCursor.parentNode) return agentCursor;
    agentCursor = D.createElement('div');
    agentCursor.setAttribute('data-codeam', 'agent-cursor');
    agentCursor.style.cssText = 'position:fixed;pointer-events:none;opacity:0;' +
      'left:' + Math.round(W.innerWidth / 2) + 'px;top:' + Math.round(W.innerHeight - 40) + 'px;' +
      'transition:' + (reduced() ? 'none' : 'left .6s cubic-bezier(.22,1,.36,1),top .6s cubic-bezier(.22,1,.36,1),opacity .3s');
    agentCursor.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">' +
      '<path d="M4 2l15 8.5-6.6 1.6L9 18.5z" fill="' + AGENT_ACCENT + '" stroke="#141416" stroke-width="1.2"/></svg>' +
      '<div style="margin:2px 0 0 14px;display:inline-block;' + chipCss(AGENT_ACCENT) + ';padding:2px 8px;font-size:11px">Agent</div>';
    agentRoot.appendChild(agentCursor);
    return agentCursor;
  }

  function drawAgentMarks() {
    if (!agentLayer) return;
    clear(agentLayer);
    var calm = reduced();
    var sx = W.scrollX || W.pageXOffset || 0, sy = W.scrollY || W.pageYOffset || 0;
    for (var i = 0; i < agentMarks.length; i++) {
      var m = agentMarks[i];
      if (m.el.isConnected === false) continue;
      var r = m.el.getBoundingClientRect();
      var box = D.createElement('div');
      box.setAttribute('data-codeam', 'agent-mark');
      box.style.cssText = 'position:absolute;pointer-events:none;' + ringCss(AGENT_ACCENT) +
        ';left:' + Math.round(r.left + sx - 4) + 'px;top:' + Math.round(r.top + sy - 4) + 'px' +
        ';width:' + Math.round(r.width + 8) + 'px;height:' + Math.round(r.height + 8) + 'px' +
        (calm ? '' : ';animation:pp-agent-in .25s ' + EASE + ',pp-agent-pulse 1.6s ease-out 3');
      if (m.label) {
        var tag = D.createElement('div');
        tag.setAttribute('data-codeam', 'agent-mark-label');
        // Above the element when it fits, else below — same rule as the chip.
        tag.style.cssText = 'position:absolute;left:0;' + (r.top >= 34 ? 'top:-30px' : 'top:' + Math.round(r.height + 12) + 'px') +
          ';pointer-events:none;' + chipCss(AGENT_ACCENT) + ';max-width:260px;overflow:hidden;text-overflow:ellipsis';
        tag.textContent = m.label;
        box.appendChild(tag);
      }
      agentLayer.appendChild(box);
    }
  }

  function listenAgentLayout() {
    if (agentListening) return;
    agentListening = true;
    W.addEventListener('scroll', drawAgentMarks, true);
    W.addEventListener('resize', drawAgentMarks);
  }

  function agentHighlight(selector, text) {
    var el = null;
    try { el = D.querySelector(String(selector)); } catch (e) { el = null; }
    if (!el || !el.getBoundingClientRect) return false;
    ensureAgent();
    listenAgentLayout();
    var calm = reduced();
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: calm ? 'auto' : 'smooth' }); } catch (e) {}
    var pointer = ensureAgentCursor();
    var owner = agentHost;
    // After the smooth scroll the cursor travels to the element and, on
    // arrival, the ring appears: read as "the agent is pointing at this".
    W.setTimeout(function () {
      if (agentHost !== owner) return;
      var r = el.getBoundingClientRect();
      pointer.style.opacity = '1';
      pointer.style.left = Math.round(r.left + Math.min(r.width / 2, 40)) + 'px';
      pointer.style.top = Math.round(r.top + Math.min(r.height / 2, 24)) + 'px';
      W.setTimeout(function () {
        if (agentHost !== owner) return;
        agentMarks.push({ el: el, label: text ? String(text).slice(0, 80) : '' });
        drawAgentMarks();
      }, 620);
    }, 380);
    return true;
  }

  function agentClear() {
    agentMarks = [];
    drop(agentHost);
    agentHost = agentRoot = agentLayer = agentCursor = null;
    if (agentListening) {
      W.removeEventListener('scroll', drawAgentMarks, true);
      W.removeEventListener('resize', drawAgentMarks);
      agentListening = false;
    }
  }

  function enable(origin, a) {
    driver = origin;
    accent = typeof a === 'string' && ACCENT_RE.test(a) ? a : DEFAULT_ACCENT;
    if (!on) {
      on = true;
      build();
      for (var i = 0; i < HANDLERS.length; i++) {
        W.addEventListener(HANDLERS[i][0], HANDLERS[i][1], { capture: true, passive: false });
        bound.push(HANDLERS[i]);
      }
      W.addEventListener('scroll', onScroll, true);
      W.addEventListener('resize', onScroll, true);
    }
    send(MULTI ? 'ready' : 'on');
  }

  function off(pinned) {
    if (!on) return;
    on = false;
    while (bound.length) {
      var h = bound.pop();
      W.removeEventListener(h[0], h[1], { capture: true });
    }
    W.removeEventListener('scroll', onScroll, true);
    W.removeEventListener('resize', onScroll, true);
    D.documentElement.removeAttribute('data-remix-pointing');
    if (style && style.parentNode) style.parentNode.removeChild(style);
    var node = host;
    if (pinned && node && !reduced()) {
      // A short "pinned" beat before the ring goes, so the tap feels taken.
      ring.style.transition = 'transform .32s ' + EASE + ', opacity .32s';
      ring.style.transform += ' scale(1.04)';
      ring.style.opacity = '0';
      veil.style.opacity = '0';
      chip.style.opacity = '0';
      leaving = node;
      W.setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
        if (leaving === node) leaving = null;
      }, 320);
    } else if (node && node.parentNode) {
      node.parentNode.removeChild(node);
    }
    host = veil = ring = chip = style = null;
    current = null;
    down = null;
    tapped = false;
  }

  W.addEventListener('message', function (e) {
    if (ALLOWED.indexOf(e.origin) === -1 || e.source !== W.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d[FIELD] !== CH) return;
    if (d.type === 'enable') enable(e.origin, d.accent);
    else if (d.type === 'disable' && e.origin === driver) off(false);
    else if (MULTI && d.type === 'marks' && d.ids && d.ids.length !== undefined) syncMarks(d.ids);
    else if (AGENT && d.type === 'agent-highlight' && d.selector) agentHighlight(d.selector, d.label);
    else if (AGENT && d.type === 'agent-clear') agentClear();
  });

  if (!MULTI) {
    try {
      Object.defineProperty(W, '__remixPoint', {
        value: Object.freeze({ version: 1, active: function () { return on; } })
      });
    } catch (e) {}
  }

  // The React Native door. Only where the bridge exists: on a normal page it
  // would be a global that turns the picker on with nobody's permission.
  if (GLOBAL && rnBridge()) {
    W[GLOBAL] = {
      enable: function () { enable('react-native'); },
      disable: function () { off(false); },
      marks: function (ids) { if (MULTI && ids && ids.length !== undefined) syncMarks(ids); },
      highlight: function (selector, text) { return AGENT ? agentHighlight(selector, text) : false; },
      clear: function () { if (AGENT) agentClear(); }
    };
  }
  } catch (e) {
    // Whatever happens, the person's app keeps working.
  }
})();`;
}
