// A tiny DOM, just enough for the picker in single mode — a verbatim copy of
// codeagent-mobile apps/remix-worker/test/fake-dom.ts, the harness the Remix
// Worker's own picker tests run on (its test pool has no browser). Keeping the
// same harness here is what proves single mode is the Remix picker unchanged.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export class FakeText {
  readonly nodeType = 3;
  parentElement: FakeElement | null = null;
  constructor(public nodeValue: string) {}
  get textContent(): string {
    return this.nodeValue;
  }
}

export class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  attributes: { name: string; value: string }[] = [];
  childNodes: (FakeElement | FakeText)[] = [];
  parentElement: FakeElement | null = null;
  ownerSVGElement: FakeElement | null = null;
  style: Record<string, string> = {};
  textOverride: string | null = null;
  rect: Rect = { left: 10, top: 40, width: 100, height: 30 };
  shadow: FakeElement | null = null;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get parentNode(): FakeElement | null {
    return this.parentElement;
  }
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  get textContent(): string {
    return this.textOverride ?? this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v: string) {
    this.textOverride = v;
  }

  getAttribute(name: string): string | null {
    return this.attributes.find((a) => a.name === name)?.value ?? null;
  }
  setAttribute(name: string, value: string): void {
    const a = this.attributes.find((x) => x.name === name);
    if (a) a.value = value;
    else this.attributes.push({ name, value });
  }
  removeAttribute(name: string): void {
    this.attributes = this.attributes.filter((a) => a.name !== name);
  }
  appendChild<T extends FakeElement | FakeText>(child: T): T {
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild<T extends FakeElement | FakeText>(child: T): T {
    this.childNodes = this.childNodes.filter((c) => c !== child);
    child.parentElement = null;
    return child;
  }
  attachShadow(): FakeElement {
    this.shadow = new FakeElement('#shadow');
    return this.shadow;
  }
  getBoundingClientRect(): Rect {
    return this.rect;
  }
}

export function el(
  tag: string,
  attrs: Record<string, string> = {},
  ...kids: (FakeElement | string)[]
): FakeElement {
  const e = new FakeElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.appendChild(typeof k === 'string' ? new FakeText(k) : k);
  return e;
}

type Listener = { type: string; fn: (e: FakeEvent) => void; capture: boolean };

export class FakeEvent {
  defaultPrevented = false;
  stopped = false;
  cancelable = true;
  clientX = 0;
  clientY = 0;
  pointerId = 1;
  pointerType = 'mouse';
  button = 0;
  key = '';
  origin = '';
  source: unknown = null;
  data: unknown = null;
  constructor(
    public type: string,
    init: Partial<FakeEvent> = {},
  ) {
    Object.assign(this, init);
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopImmediatePropagation(): void {
    this.stopped = true;
  }
}

export interface Posted {
  msg: Record<string, unknown>;
  origin: string;
}

export function fakeWindow() {
  const listeners: Listener[] = [];
  const posted: Posted[] = [];
  const html = el('html');
  const head = html.appendChild(el('head'));
  const body = html.appendChild(el('body'));
  let hit: FakeElement | null = null;
  const parent = {
    postMessage(msg: Record<string, unknown>, origin: string) {
      posted.push({ msg, origin });
    },
  };
  const doc = {
    documentElement: html,
    head,
    body,
    createElement: (tag: string) => new FakeElement(tag),
    elementFromPoint: () => hit,
  };
  const win: Record<string, unknown> = {
    parent,
    innerWidth: 400,
    innerHeight: 800,
    CSS: { supports: () => true },
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    addEventListener(
      type: string,
      fn: (e: FakeEvent) => void,
      opts?: boolean | { capture?: boolean },
    ) {
      const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
      listeners.push({ type, fn, capture });
    },
    removeEventListener(
      type: string,
      fn: (e: FakeEvent) => void,
      opts?: boolean | { capture?: boolean },
    ) {
      const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  /** Dispatches like the window's capture phase: the picker's listeners run first. */
  function dispatch(e: FakeEvent): FakeEvent {
    for (const l of listeners.filter((x) => x.type === e.type)) {
      l.fn(e);
      if (e.stopped) break;
    }
    return e;
  }

  return {
    win,
    doc,
    html,
    head,
    body,
    posted,
    listeners,
    parent,
    dispatch,
    setHit: (e: FakeElement | null) => {
      hit = e;
    },
    run(source: string) {
      new Function('window', 'document', source)(win, doc);
    },
    message(origin: string, data: unknown, source: unknown = parent) {
      return dispatch(new FakeEvent('message', { origin, data, source }));
    },
  };
}
