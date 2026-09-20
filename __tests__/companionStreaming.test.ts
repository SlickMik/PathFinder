// Verifies the client half of the streaming wiring: companionSay must (a) put
// `stream: true` in the POST body when onDelta is given, (b) POST to the
// derived /companion URL, and (c) surface every SSE delta to onDelta and
// resolve with the concatenated reply — and omit stream:true on the buffered
// path. This is the wiring that has been clobbered twice by bad edits, and the
// server e2e cannot see it (it builds its own payloads). companion.ts is
// jest-safe: expo-lidar-vision is an optional native module (null under jest)
// and withFrame defaults to false, so no native capture runs.

// Type-only import is erased at compile time, so it does not evaluate the
// module — the env var set below controls when companion.ts actually loads.
import type { companionSay as CompanionSay } from '../features/speech/companion';

// Must be set before companion.ts is evaluated, since it reads the env var at
// module load to derive COMPANION_URL.
process.env.EXPO_PUBLIC_SCENE_DESCRIBE_URL = 'http://test.local/describe-scene';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { companionSay } = require('../features/speech/companion') as {
  companionSay: typeof CompanionSay;
};

type EventHandler = ((ev: unknown) => void) | null;

class FakeXHR {
  static last: FakeXHR;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  sentBody: string | undefined;
  responseType = '';
  responseText = '';
  status = 200;
  readyState = 0;
  onprogress: EventHandler = null;
  onload: EventHandler = null;
  onerror: EventHandler = null;
  onabort: EventHandler = null;
  ontimeout: EventHandler = null;
  onreadystatechange: EventHandler = null;

  constructor() {
    FakeXHR.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  send(body: string) {
    this.sentBody = body;
    this.readyState = 3;
    // Two deltas across two progress events, then the [DONE] terminator.
    this.responseText = 'data: {"delta":"Hello"}\n\n';
    this.onprogress?.(null);
    this.responseText += 'data: {"delta":" world"}\n\ndata: [DONE]\n\n';
    this.onprogress?.(null);
    this.readyState = 4;
    this.onreadystatechange?.(null);
    this.onload?.(null);
  }
  abort() {
    this.onabort?.(null);
  }
}

// Named const for the unchecked cast of globalThis's slots — assigned once,
// then read/written, so the cast is not inlined with member access.
const globals = globalThis as unknown as {
  XMLHttpRequest?: unknown;
  fetch?: unknown;
};

let lastFetchBody: string | undefined;

describe('companionSay streaming wiring', () => {
  const originalXHR = globals.XMLHttpRequest;
  const originalFetch = globals.fetch;

  beforeEach(() => {
    FakeXHR.last = undefined as unknown as FakeXHR;
    lastFetchBody = undefined;
    globals.XMLHttpRequest = FakeXHR;
    // The buffered (no-onDelta) path uses fetch, not XHR.
    globals.fetch = async (_url: string, init: { body?: string }) => {
      lastFetchBody = init.body;
      return { ok: true, status: 200, json: async () => ({ reply: 'Hello world' }) };
    };
  });
  afterEach(() => {
    globals.XMLHttpRequest = originalXHR;
    globals.fetch = originalFetch;
  });

  it('sends stream:true, POSTs to /companion, and surfaces every delta', async () => {
    const deltas: string[] = [];
    const reply = await companionSay('hi', {
      withFrame: false,
      onDelta: (delta) => deltas.push(delta),
    });

    const xhr = FakeXHR.last;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('http://test.local/companion');
    const sent = JSON.parse(xhr.sentBody ?? '{}');
    expect(sent.stream).toBe(true);
    expect(sent.text).toBe('hi');
    expect(deltas).toEqual(['Hello', ' world']);
    expect(reply).toBe('Hello world');
  });

  it('omits stream:true on the buffered (no-onDelta) path', async () => {
    const reply = await companionSay('hi', { withFrame: false });
    const sent = JSON.parse(lastFetchBody ?? '{}');
    expect(sent.stream).toBeUndefined();
    expect(sent.text).toBe('hi');
    expect(reply).toBe('Hello world');
  });
});
