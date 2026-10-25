import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { pointPickerScript, type PointPickerOptions } from './index';

/**
 * The generated picker, evaluated in a real DOM (jsdom). The Remix cases that
 * must stay byte-for-byte in behaviour live in `remix-compat.test.ts` on the
 * Worker's own harness; these cover what both hosts share in a browser-like
 * DOM and what only the console's multi mode adds.
 */

const PARENT = 'https://www.codeagent-mobile.com';
const ATTACKER = 'https://evil.example.com';

const REMIX: PointPickerOptions = {
  channel: 'remix-point',
  channelField: 'channel',
  allowedParents: [PARENT],
  mode: 'single',
};

const CONSOLE: PointPickerOptions = {
  channel: 'codeam-inspector',
  channelField: 'source',
  allowedParents: [PARENT],
  mode: 'multi',
  maxMarks: 4,
  accent: '#a855f7',
  agentHighlights: true,
  reactSource: true,
  globalName: '__codeamInspector',
};

interface Sent {
  msg: Record<string, unknown>;
  origin: string;
}

interface MountOpts {
  html?: string;
  reduced?: boolean;
  /** Top-level document inside a React Native WebView. */
  rn?: boolean;
  /** Leave `document.elementFromPoint` out, like an old WebView. */
  noHitTest?: boolean;
  css?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function mount(options: PointPickerOptions, o: MountOpts = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head>${o.css ? `<style>${o.css}</style>` : ''}</head><body>${o.html ?? ''}</body></html>`,
    { runScripts: 'dangerously', url: 'https://preview-abc.codeagent-mobile.com/' },
  );
  const win = dom.window;
  const doc = win.document;
  const sent: Sent[] = [];
  const parent = {
    postMessage: (msg: Record<string, unknown>, origin: string) => sent.push({ msg, origin }),
  };
  if (o.rn) {
    win.ReactNativeWebView = {
      postMessage: (raw: string) => sent.push({ msg: JSON.parse(raw), origin: 'rn' }),
    };
  } else {
    Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  }
  if (o.reduced) Object.defineProperty(win, 'matchMedia', { value: () => ({ matches: true }) });

  // The picker draws in CLOSED shadow roots (the page's CSS can't reach it);
  // the test keeps a handle on each one to look inside.
  const roots: ShadowRoot[] = [];
  const attach = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attach.call(this, init);
    roots.push(root);
    return root;
  };

  // jsdom has no layout: every element measures `data-box` (default 0).
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const n = Number(this.getAttribute('data-box') ?? 0);
    const r = {
      left: n,
      top: n,
      width: n + 10,
      height: n + 5,
      right: 2 * n + 10,
      bottom: 2 * n + 5,
      x: n,
      y: n,
    };
    return { ...r, toJSON: () => r };
  };

  let hit: Element | null = null;
  if (!o.noHitTest) Object.defineProperty(doc, 'elementFromPoint', { value: () => hit });

  win.eval(pointPickerScript(options));

  const field = options.channelField;
  const message = (data: Record<string, unknown>, origin = PARENT, source: unknown = parent) => {
    const ev = new win.MessageEvent('message', { data: { [field]: options.channel, ...data } });
    Object.defineProperty(ev, 'origin', { value: origin });
    Object.defineProperty(ev, 'source', { value: o.rn ? null : source });
    win.dispatchEvent(ev);
  };
  /** The page's element (must exist). */
  const q = (sel: string): HTMLElement => {
    const el = doc.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`no ${sel}`);
    return el;
  };
  const has = (sel: string) => doc.querySelector(sel) !== null;
  /** Every node of ours on the page matching `sel`, light DOM and (attached) shadow roots alike. */
  const ours = (sel: string): HTMLElement[] => [
    ...doc.querySelectorAll<HTMLElement>(sel),
    ...roots
      .filter((r) => r.host.isConnected)
      .flatMap((r) => [...r.querySelectorAll<HTMLElement>(sel)]),
  ];
  /** A tap the way a browser fires it: pointerdown, pointerup, then click. */
  const tap = (el: Element, id = 1) => {
    hit = el;
    const init = { bubbles: true, cancelable: true, pointerId: id };
    el.dispatchEvent(new win.PointerEvent('pointerdown', init));
    el.dispatchEvent(new win.PointerEvent('pointerup', init));
    const click = new win.MouseEvent('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    return click;
  };
  const move = (el: Element) => {
    hit = el;
    el.dispatchEvent(
      new win.PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }),
    );
  };
  const types = () => sent.map((s) => s.msg.type);
  const picks = () =>
    sent
      .filter((s) => s.msg.type === 'pick')
      .map((s) => (isRecord(s.msg.element) ? s.msg.element : {}));
  return { dom, win, doc, sent, parent, message, q, has, ours, tap, move, types, picks, roots };
}

const enable = (h: ReturnType<typeof mount>, extra: Record<string, unknown> = {}) =>
  h.message({ type: 'enable', ...extra });

describe('pointPickerScript — single mode (Remix)', () => {
  it('acks `on`, then sends one pick with the Remix payload and turns itself off', () => {
    const h = mount(REMIX, {
      html: '<div id="card"><h2>Timer</h2><button class="btn primary" type="button" data-box="10"><span>Start</span></button></div>',
    });
    enable(h, { accent: '#FF5A1F' });
    expect(h.sent[0]).toEqual({ msg: { channel: 'remix-point', type: 'on' }, origin: PARENT });
    h.tap(h.q('button span'));
    expect(h.picks()).toEqual([
      {
        tag: 'button',
        id: null,
        classes: 'btn primary',
        selector: 'div#card > button.btn.primary',
        text: 'Start',
        html: '<button class="btn primary" type="button" data-box="10"><span>Start</span></button>',
        rect: { x: 10, y: 10, w: 20, h: 15 },
      },
    ]);
    expect(h.doc.documentElement.hasAttribute('data-remix-pointing')).toBe(false);
    expect(h.win.__remixPoint.active()).toBe(false);
  });

  it('exposes no control API, even inside a React Native WebView', () => {
    const h = mount({ ...REMIX, globalName: undefined }, { rn: true });
    expect(h.win.__codeamInspector).toBeUndefined();
    expect(Object.isFrozen(h.win.__remixPoint)).toBe(true);
  });
});

describe('pointPickerScript — the shared look', () => {
  it('the magnetic climb: a <span> inside a <button> picks the button', () => {
    const h = mount(CONSOLE, { html: '<button id="go"><span id="inner">Start</span></button>' });
    enable(h);
    h.tap(h.q('#inner'));
    expect(h.picks()[0]).toMatchObject({ tag: 'button', id: 'go' });
  });

  it('labels the element like Remix: “Start” button, in the serif chip', () => {
    const h = mount(CONSOLE, { html: '<button id="go" data-box="40"><span>Start</span></button>' });
    enable(h);
    h.move(h.q('#go span'));
    const [chip] = h.ours('[data-codeam="chip"]');
    expect(chip.textContent).toBe('“Start” button');
    expect(chip.style.font).toContain('Georgia');
    // Above the element when it fits (40 >= 34): top = 40 - 32.
    expect(chip.style.transform).toBe('translate(40px,8px)');
  });

  it('the ring: 2 px accent border, radius 12, 5 px glow, 4 px outset', () => {
    const h = mount(CONSOLE, { html: '<button id="go" data-box="12">x</button>' });
    enable(h);
    h.move(h.q('#go'));
    const [ring] = h.ours('[data-codeam="ring"]');
    expect(ring.style.transform).toBe('translate(8px,8px)');
    expect(ring.style.width).toBe('30px');
    expect(ring.style.height).toBe('25px');
    expect(ring.style.borderRadius).toBe('12px');
    expect(ring.style.border).toContain('2px solid');
    expect(ring.style.transition).toContain('cubic-bezier(.2,.8,.2,1)');
  });

  it('the accent: the option by default, `enable` may override it with a valid hex', () => {
    const h = mount(CONSOLE, { html: '<button id="go">x</button>' });
    enable(h);
    h.move(h.q('#go'));
    expect(h.ours('[data-codeam="ring"]')[0].style.border).toMatch(/#a855f7|rgb\(168, 85, 247\)/);
    h.message({ type: 'disable' });
    enable(h, { accent: '#00AA88' });
    h.move(h.q('#go'));
    expect(h.ours('[data-codeam="ring"]')[0].style.border).toMatch(/#00AA88|rgb\(0, 170, 136\)/i);
    h.message({ type: 'disable' });
    enable(h, { accent: 'red;background:url(x)' });
    h.move(h.q('#go'));
    expect(h.ours('[data-codeam="ring"]')[0].style.border).toMatch(/#a855f7|rgb\(168, 85, 247\)/);
  });

  it('reduced motion: no movement transition and no pinned scale', () => {
    const h = mount(REMIX, { reduced: true, html: '<button id="go">x</button>' });
    enable(h);
    h.move(h.q('#go'));
    const [ring] = h.ours('[data-codeam="ring"]');
    expect(ring.style.transition).toBe('none');
    h.tap(h.q('#go'));
    // No "pinned" beat: the overlay is gone at once, never scaled.
    expect(ring.style.transform).not.toContain('scale');
    expect(h.has('[data-codeam="point"]')).toBe(false);
  });

  it('without reduced motion the pick leaves a short pinned beat (scale 1.04, fade)', () => {
    const h = mount(REMIX, { html: '<button id="go">x</button>' });
    enable(h);
    h.tap(h.q('#go'));
    const [ring] = h.ours('[data-codeam="ring"]');
    expect(ring.style.transform).toContain('scale(1.04)');
    expect(ring.style.opacity).toBe('0');
  });

  it('an SVG child resolves to its outer <svg>, a same-origin <iframe> to the frame; neither throws', () => {
    const h = mount(CONSOLE, {
      html: '<div><svg id="icon" viewBox="0 0 24 24"><g><path id="p" d="M0 0"/></g></svg></div><iframe id="f"></iframe>',
    });
    enable(h);
    expect(() => h.tap(h.q('#p'))).not.toThrow();
    expect(() => h.tap(h.q('#f'))).not.toThrow();
    expect(h.picks().map((p) => p.tag)).toEqual(['svg', 'iframe']);
  });

  it('stays on top of a page with its own max z-index and `* { cursor }` rules', () => {
    const h = mount(CONSOLE, {
      html: '<div id="modal" style="position:fixed;z-index:2147483647">m</div><button id="go">x</button>',
      css: '* { cursor: pointer !important; }',
    });
    enable(h);
    const host = h.q('[data-codeam="point"]');
    expect(host.style.position).toBe('fixed');
    expect(host.style.zIndex).toBe('2147483647');
    // Last child of <html>, after <body>: at equal z-index, later paints on top.
    expect(h.doc.documentElement.lastElementChild).toBe(host);
    // Our cursor rule outranks the page's `*` rule (more specific, also !important).
    expect(h.win.getComputedStyle(h.q('#go')).cursor).toContain('data:image/svg+xml');
  });

  it('swallows the app’s click while pointing, so a link never navigates', () => {
    const h = mount(CONSOLE, { html: '<a id="link" href="/elsewhere">Go</a>' });
    enable(h);
    expect(h.tap(h.q('#link')).defaultPrevented).toBe(true);
  });
});

describe('pointPickerScript — allow-list', () => {
  it('ignores messages from an origin that is not allowed, or not from the parent window', () => {
    const h = mount(CONSOLE, { html: '<button id="go">x</button>' });
    h.message({ type: 'enable' }, ATTACKER);
    h.message({ type: 'enable' }, PARENT, {});
    h.message({ type: 'agent-highlight', selector: '#go' }, ATTACKER);
    expect(h.sent).toEqual([]);
    expect(h.has('[data-codeam]')).toBe(false);
  });

  it('serializes origins so a quote or a </script> cannot break out of the tag', () => {
    const src = pointPickerScript({ ...CONSOLE, allowedParents: [`https://x.com/'"</script><b>`] });
    expect(src).not.toContain('</script>');
    const h = mount({ ...CONSOLE, allowedParents: [`https://x.com/'"</script><b>`] });
    h.message({ type: 'enable' }, `https://x.com/'"</script><b>`);
    expect(h.types()).toEqual(['ready']);
  });

  it('rejects options that would produce a broken script', () => {
    expect(() => pointPickerScript({ ...CONSOLE, globalName: 'a b' })).toThrow();
    expect(() => pointPickerScript({ ...CONSOLE, accent: 'red' })).toThrow();
    expect(() => pointPickerScript({ ...CONSOLE, maxMarks: 0 })).toThrow();
  });

  it('the generated script run twice installs once', () => {
    const h = mount(CONSOLE, { html: '<button id="go">x</button>' });
    h.win.eval(pointPickerScript(CONSOLE));
    enable(h);
    expect(h.types()).toEqual(['ready']);
    h.tap(h.q('#go'));
    expect(h.picks()).toHaveLength(1);
  });
});

describe('pointPickerScript — multi mode (console)', () => {
  const four =
    '<button id="a">A</button><button id="b">B</button><button id="c">C</button><button id="d">D</button><button id="e">E</button>';
  const rings = (h: ReturnType<typeof mount>) => h.ours('[data-codeam="mark"]');

  it('acks `ready`, stays on after a pick and numbers the marks p1, p2', () => {
    const h = mount(CONSOLE, { html: four });
    enable(h);
    expect(h.sent[0].msg).toEqual({ source: 'codeam-inspector', type: 'ready' });
    h.tap(h.q('#a'));
    h.tap(h.q('#b'));
    expect(h.picks().map((p) => p.markId)).toEqual(['p1', 'p2']);
    expect(h.doc.documentElement.hasAttribute('data-remix-pointing')).toBe(true);
    expect(rings(h).map((r) => r.querySelector('[data-codeam="mark-badge"]')?.textContent)).toEqual(
      ['1', '2'],
    );
  });

  it('caps at maxMarks: the next pick still reaches the app (it says “4 max”) but leaves no mark', () => {
    const h = mount(CONSOLE, { html: four });
    enable(h);
    for (const id of ['a', 'b', 'c', 'd', 'e']) h.tap(h.q(`#${id}`));
    expect(h.picks().map((p) => p.markId)).toEqual(['p1', 'p2', 'p3', 'p4', undefined]);
    expect(rings(h)).toHaveLength(4);
  });

  it('`marks([p1])` removes p2’s ring and renumbers; `marks([])` removes them all', () => {
    const h = mount(CONSOLE, { html: four });
    enable(h);
    h.tap(h.q('#a'));
    h.tap(h.q('#b'));
    h.message({ type: 'marks', ids: ['p2'] });
    expect(rings(h)).toHaveLength(1);
    expect(rings(h)[0].querySelector('[data-codeam="mark-badge"]')?.textContent).toBe('1');
    h.message({ type: 'marks', ids: [] });
    expect(rings(h)).toHaveLength(0);
    expect(h.has('[data-codeam="marks"]')).toBe(false);
  });

  it('marks are Remix rings anchored to the document, and survive turning the mode off', () => {
    const h = mount(CONSOLE, { html: '<button id="a" data-box="20">A</button>' });
    Object.defineProperty(h.win, 'scrollY', { value: 300 });
    enable(h);
    h.tap(h.q('#a'));
    h.message({ type: 'disable' });
    const [ring] = rings(h);
    expect(ring.style.position).toBe('absolute');
    expect(ring.style.top).toBe('316px');
    expect(ring.style.borderRadius).toBe('12px');
    expect(h.has('[data-codeam="point"]')).toBe(false);
  });

  it('the pick carries markId, the page viewport and the React source', () => {
    const h = mount(CONSOLE, { html: '<button id="go" data-box="5">Buy</button>' });
    const el = h.q('#go');
    Object.assign(el, {
      __reactFiber$x: { return: { _debugSource: { fileName: 'src/Buy.tsx', lineNumber: 9 } } },
    });
    enable(h);
    h.tap(el);
    expect(h.picks()[0]).toMatchObject({
      tag: 'button',
      markId: 'p1',
      viewport: { w: h.win.innerWidth, h: h.win.innerHeight },
      source: { file: 'src/Buy.tsx', line: 9 },
      rect: { x: 5, y: 5, w: 15, h: 10 },
    });
  });

  it('hover is reported once per element while pointing', () => {
    const h = mount(CONSOLE, { html: '<button id="a">A</button><button id="b">B</button>' });
    enable(h);
    h.move(h.q('#a'));
    h.move(h.q('#a'));
    h.move(h.q('#b'));
    expect(h.types()).toEqual(['ready', 'hover', 'hover']);
  });

  it('Escape does not end multi mode (the app owns the toggle)', () => {
    const h = mount(CONSOLE, { html: '<button id="a">A</button>' });
    enable(h);
    h.win.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(h.types()).toEqual(['ready']);
    expect(h.has('[data-codeam="point"]')).toBe(true);
  });

  it('an old WebView without hit-testing still picks from mousemove/click targets', () => {
    const h = mount(CONSOLE, {
      noHitTest: true,
      html: '<a id="l" href="/x"><span id="s">Go</span></a>',
    });
    enable(h);
    h.q('#s').dispatchEvent(new h.win.MouseEvent('mousemove', { bubbles: true }));
    h.q('#s').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(h.types()).toEqual(['ready', 'hover', 'pick']);
    expect(h.picks()[0]).toMatchObject({ tag: 'a', id: 'l', markId: 'p1' });
  });
});

describe('pointPickerScript — agent highlights', () => {
  const settle = () => new Promise((r) => setTimeout(r, 1_100));

  it('an agent-highlight before `enable` still draws a cyan Remix ring with its label', async () => {
    const h = mount(CONSOLE, { html: '<button id="cta" data-box="40">Buy</button>' });
    h.message({ type: 'agent-highlight', selector: '#cta', label: 'New CTA' });
    await settle();
    const [box] = h.ours('[data-codeam="agent-mark"]');
    expect(box).toBeDefined();
    expect(box.textContent).toBe('New CTA');
    expect(box.style.border).toMatch(/#22d3ee|rgb\(34, 211, 238\)/);
    expect(box.style.borderRadius).toBe('12px');
    expect(h.ours('[data-codeam="agent-cursor"]')[0].style.opacity).toBe('1');
    // The agent does not turn pointing on.
    expect(h.sent).toEqual([]);
  });

  it('agent-clear removes every node of ours', async () => {
    const h = mount(CONSOLE, { html: '<button id="cta">Buy</button>' });
    h.message({ type: 'agent-highlight', selector: '#cta' });
    await settle();
    h.message({ type: 'agent-clear' });
    expect(h.has('[data-codeam]')).toBe(false);
  });

  it('is off unless the option asks for it', async () => {
    const h = mount(
      { ...CONSOLE, agentHighlights: false },
      { html: '<button id="cta">Buy</button>' },
    );
    h.message({ type: 'agent-highlight', selector: '#cta' });
    await settle();
    expect(h.has('[data-codeam]')).toBe(false);
  });
});

describe('pointPickerScript — the React Native door', () => {
  it('exposes window[globalName] only inside a React Native WebView, and publishes JSON there', () => {
    const plain = mount(CONSOLE);
    expect(plain.win.__codeamInspector).toBeUndefined();

    const h = mount(CONSOLE, { rn: true, html: '<button id="go">x</button>' });
    const api = h.win.__codeamInspector;
    expect(Object.keys(api).sort()).toEqual(['clear', 'disable', 'enable', 'highlight', 'marks']);
    api.enable();
    h.tap(h.q('#go'));
    expect(h.types()).toEqual(['ready', 'hover', 'pick']);
    expect(api.highlight('#go', 'here')).toBe(true);
    expect(api.highlight('#missing')).toBe(false);
    expect(() => api.marks([])).not.toThrow();
    api.disable();
    expect(h.has('[data-codeam="point"]')).toBe(false);
  });
});
