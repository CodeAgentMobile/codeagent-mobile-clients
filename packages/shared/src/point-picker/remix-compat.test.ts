import { describe, expect, it } from 'vitest';
import { POINT_HTML_MAX, POINT_TEXT_MAX, pointPickerScript } from './index';
import { FakeEvent, el, fakeWindow } from './fake-dom.test-helper';

/**
 * Single mode IS the Remix picker. The cases below are the Remix Worker's own
 * picker tests (codeagent-mobile apps/remix-worker/test/point.test.ts), copied
 * verbatim but run against the shared generator with the options the Worker
 * passes. If one of them needs editing, the Worker's served picker changed.
 */
const pointSource = (origins: string[]) =>
  pointPickerScript({
    channel: 'remix-point',
    channelField: 'channel',
    allowedParents: origins,
    mode: 'single',
  });

const LANDING = 'https://www.codeagent-mobile.com';

function setup() {
  const dom = fakeWindow();
  dom.run(pointSource([LANDING]));
  const start = el('button', { class: 'btn primary', type: 'button' }, el('span', {}, 'Start'));
  const card = el('div', { id: 'card' }, el('h2', {}, 'Timer'), start);
  dom.body.appendChild(card);
  return { ...dom, start, card };
}

const on = (d: ReturnType<typeof setup>) =>
  d.message(LANDING, { channel: 'remix-point', type: 'enable', accent: '#FF5A1F' });
const appListeners = (d: ReturnType<typeof setup>) =>
  d.listeners.filter((l) => l.type !== 'message');

describe('the "Point at it" picker', () => {
  it('is inert until the parent turns it on: only a message listener, nothing painted', () => {
    const d = setup();
    expect(d.listeners.map((l) => l.type)).toEqual(['message']);
    expect(d.html.childNodes).toHaveLength(2);
    expect(d.posted).toHaveLength(0);
    const g = d.win.__remixPoint as { version: number; active: () => boolean };
    expect(Object.isFrozen(g)).toBe(true);
    expect(g.active()).toBe(false);
  });

  it('ignores other origins, other windows and other channels', () => {
    const d = setup();
    d.message('https://evil.example', { channel: 'remix-point', type: 'enable' });
    d.message(LANDING, { channel: 'remix-point', type: 'enable' }, {});
    d.message(LANDING, { channel: 'codeam-inspector', type: 'enable' });
    d.message(LANDING, 'enable');
    expect(appListeners(d)).toHaveLength(0);
    expect(d.posted).toHaveLength(0);
  });

  it('turns on for an allowed parent: acks, adds the overlay and the lens cursor', () => {
    const d = setup();
    on(d);
    expect(d.posted).toEqual([{ msg: { channel: 'remix-point', type: 'on' }, origin: LANDING }]);
    expect(d.html.getAttribute('data-remix-pointing')).toBe('');
    expect(d.html.children.some((c) => c.tagName === 'REMIX-POINT')).toBe(true);
    const style = d.head.children.find((c) => c.tagName === 'STYLE');
    expect(style?.textContent).toContain('cursor:url("data:image/svg+xml,');
    expect(style?.textContent).toContain(encodeURIComponent('#FF5A1F'));
    expect((d.win.__remixPoint as { active: () => boolean }).active()).toBe(true);
  });

  it('picks the control around the tapped node and swallows the app’s own click', () => {
    const d = setup();
    on(d);
    const span = d.start.children[0];
    d.setHit(span);
    const down = d.dispatch(new FakeEvent('pointerdown', { pointerId: 7, pointerType: 'touch' }));
    expect(down.stopped).toBe(true);
    const up = d.dispatch(new FakeEvent('pointerup', { pointerId: 7, pointerType: 'touch' }));
    expect(up.defaultPrevented).toBe(true);
    const pick = d.posted.find((p) => p.msg.type === 'pick');
    expect(pick?.origin).toBe(LANDING);
    expect(pick?.msg.element).toEqual({
      tag: 'button',
      id: null,
      classes: 'btn primary',
      selector: 'div#card > button.btn.primary',
      text: 'Start',
      html: '<button class="btn primary" type="button"><span>Start</span></button>',
      rect: { x: 10, y: 40, w: 100, h: 30 },
    });
    // Picking turns it off: every listener and node is gone.
    expect(appListeners(d)).toHaveLength(0);
    expect(d.html.getAttribute('data-remix-pointing')).toBeNull();
    expect(d.html.children.some((c) => c.tagName === 'REMIX-POINT')).toBe(false);
    expect(d.head.children.some((c) => c.tagName === 'STYLE')).toBe(false);
    // The click the browser fires after the tap now reaches the app untouched.
    expect(d.dispatch(new FakeEvent('click')).stopped).toBe(false);
  });

  it('blocks the app’s click, focus and keys while pointing, but leaves touch scrolling alone', () => {
    const d = setup();
    on(d);
    const click = d.dispatch(new FakeEvent('click'));
    expect(click.stopped && click.defaultPrevented).toBe(true);
    const mouse = d.dispatch(new FakeEvent('mousedown'));
    expect(mouse.defaultPrevented).toBe(true);
    const touch = d.dispatch(new FakeEvent('touchstart'));
    expect(touch.stopped).toBe(true);
    expect(touch.defaultPrevented).toBe(false);
    const key = d.dispatch(new FakeEvent('keydown', { key: 'a' }));
    expect(key.defaultPrevented).toBe(true);
  });

  it('a touch the browser turns into a scroll is not a pick', () => {
    const d = setup();
    on(d);
    d.setHit(d.start);
    d.dispatch(new FakeEvent('pointerdown', { pointerId: 3, pointerType: 'touch' }));
    d.dispatch(new FakeEvent('pointercancel', { pointerId: 3, pointerType: 'touch' }));
    d.dispatch(new FakeEvent('pointerup', { pointerId: 3, pointerType: 'touch' }));
    expect(d.posted.some((p) => p.msg.type === 'pick')).toBe(false);
    expect(appListeners(d).length).toBeGreaterThan(0);
  });

  it('never picks the page itself', () => {
    const d = setup();
    on(d);
    d.setHit(d.body);
    d.dispatch(new FakeEvent('pointerdown'));
    d.dispatch(new FakeEvent('pointerup'));
    expect(d.posted.some((p) => p.msg.type === 'pick')).toBe(false);
  });

  it('Escape cancels and tells the parent', () => {
    const d = setup();
    on(d);
    d.dispatch(new FakeEvent('keydown', { key: 'Escape' }));
    expect(d.posted.at(-1)?.msg).toEqual({ channel: 'remix-point', type: 'cancel' });
    expect(appListeners(d)).toHaveLength(0);
  });

  it('disable from the parent removes everything; enable twice adds listeners once', () => {
    const d = setup();
    on(d);
    on(d);
    const types = appListeners(d).map((l) => l.type);
    expect(types.filter((t) => t === 'click')).toHaveLength(1);
    d.message(LANDING, { channel: 'remix-point', type: 'disable' });
    expect(appListeners(d)).toHaveLength(0);
    expect(d.html.children.some((c) => c.tagName === 'REMIX-POINT')).toBe(false);
  });

  it('bounds text and markup, and trims long attributes', () => {
    const d = setup();
    on(d);
    const long = 'word '.repeat(200);
    const big = el(
      'section',
      { style: 'x'.repeat(300) },
      ...Array.from({ length: 40 }, (_, i) => el('p', { class: `row-${i}` }, long)),
    );
    d.body.appendChild(big);
    d.setHit(big);
    d.dispatch(new FakeEvent('pointerdown'));
    d.dispatch(new FakeEvent('pointerup'));
    const element = d.posted.find((p) => p.msg.type === 'pick')?.msg.element as {
      text: string;
      html: string;
    };
    expect(element.text.length).toBeLessThanOrEqual(POINT_TEXT_MAX);
    expect(element.text.endsWith('…')).toBe(true);
    expect(element.html.length).toBeLessThanOrEqual(POINT_HTML_MAX);
    expect(element.html).toContain(`style="${'x'.repeat(59)}…"`);
  });

  it('an icon inside an SVG picks the whole icon', () => {
    const d = setup();
    on(d);
    const svg = el('svg', { viewBox: '0 0 24 24' });
    const path = svg.appendChild(el('path', { d: 'M0 0' }));
    path.ownerSVGElement = svg;
    d.body.appendChild(el('div', {}, svg));
    d.setHit(path);
    d.dispatch(new FakeEvent('pointerdown'));
    d.dispatch(new FakeEvent('pointerup'));
    const element = d.posted.find((p) => p.msg.type === 'pick')?.msg.element as { tag: string };
    expect(element.tag).toBe('svg');
  });
});

describe('the source the Worker serves', () => {
  // The Worker's serve test looks for these exact declarations in the page head.
  it('declares the channel and the framing origins as the Worker expects', () => {
    const origins = ['https://dev.codeagent-mobile.com', 'https://www.codeagent-mobile.com'];
    const src = pointSource(origins);
    expect(src).toContain('var CH = "remix-point"');
    expect(src).toContain(`var ALLOWED = ${JSON.stringify(origins)}`);
  });

  it('runs as a function body with window/document parameters (how the Worker tests run it)', () => {
    expect(() => new Function('window', 'document', pointSource([]))).not.toThrow();
  });
});
