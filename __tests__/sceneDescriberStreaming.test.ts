// Verifies sceneDescriber's streaming request wiring: describeCurrentScene
// must put `stream: true` in the POST body when onDelta is given, POST to the
// configured /describe-scene URL, surface every SSE delta, and resolve with the
// concatenated description. The server e2e cannot see this — its streamPost
// builds its own payload — and this spread was clobbered once by a bad edit.
// jest-safe: ExpoLidarVision is an optional native module (null under jest), so
// captureFrame is stubbed before the call.

import type { CapturedFrame } from '../features/scanning/types';
import type { describeCurrentScene as DescribeScene } from '../features/speech/sceneDescriber';

// Must be set before sceneDescriber.ts is evaluated (it reads SCENE_URL at
// module load).
process.env.EXPO_PUBLIC_SCENE_DESCRIBE_URL = 'http://test.local/describe-scene';
process.env.EXPO_PUBLIC_CLOUD_AI_ENABLED = 'true';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lidarModule = require('../modules/expo-lidar-vision') as {
  ExpoLidarVision: {
    captureFrame: (maxDimension?: number, quality?: number) => Promise<CapturedFrame>;
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { describeCurrentScene } = require('../features/speech/sceneDescriber') as {
  describeCurrentScene: typeof DescribeScene;
};

// Stub the native capture so requestDescription can build the body offline.
lidarModule.ExpoLidarVision.captureFrame = async () =>
  ({ base64: 'xxx', width: 1, height: 1 }) as CapturedFrame;

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
    this.responseText = 'data: {"delta":"A sidewalk"}\n\n';
    this.onprogress?.(null);
    this.responseText += 'data: {"delta":" stretches ahead."}\n\ndata: [DONE]\n\n';
    this.onprogress?.(null);
    this.readyState = 4;
    this.onreadystatechange?.(null);
    this.onload?.(null);
  }
  abort() {
    this.onabort?.(null);
  }
}

const globals = globalThis as unknown as { XMLHttpRequest?: unknown };

describe('describeCurrentScene streaming wiring', () => {
  const originalXHR = globals.XMLHttpRequest;

  beforeEach(() => {
    FakeXHR.last = undefined as unknown as FakeXHR;
    globals.XMLHttpRequest = FakeXHR;
  });
  afterEach(() => {
    globals.XMLHttpRequest = originalXHR;
  });

  it('sends stream:true to /describe-scene and surfaces every delta', async () => {
    const deltas: string[] = [];
    const text = await describeCurrentScene(null, (delta) => deltas.push(delta));

    const xhr = FakeXHR.last;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('http://test.local/describe-scene');
    const sent = JSON.parse(xhr.sentBody ?? '{}');
    expect(sent.stream).toBe(true);
    expect(sent.imageBase64).toBe('xxx');
    expect(deltas).toEqual(['A sidewalk', ' stretches ahead.']);
    expect(text).toBe('A sidewalk stretches ahead.');
  });
});
