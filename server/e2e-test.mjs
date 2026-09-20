// End-to-end test for the PathFinder backend. Run: node server/e2e-test.mjs
// Exercises health, scene description, companion chat (multi-turn, with and
// without frames, LiDAR-grounded answers, safety refusals, bad input).

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';

// 1x1 white JPEG so the test needs no fixture files (upscaled server-side is fine).
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
  'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
  'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB' +
  'AAIRAxEAPwD3+iiigD//2Q==';

const LIDAR = {
  left: { distanceM: 2.1, confidence: 'high' },
  center: { distanceM: 0.9, confidence: 'high' },
  right: null,
  corridorRisk: 'near',
  corridorDistanceM: 0.9,
  timeToContactS: 1.8,
  tracking: 'normal',
  ageMs: 80,
  alert: { risk: 'near', direction: 'center' },
  guidance: { instruction: 'slight-left', clearanceM: 2.1, openingWidthM: 1.3, confidence: 0.8 },
};

let passed = 0;
let failed = 0;
let cloudEnabled = false;

async function post(path, body, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const started = Date.now();
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} — ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const history = [];

await check('health endpoint', async () => {
  const res = await fetch(`${BASE}/health`);
  const json = await res.json();
  expect(json.ok === true, 'health not ok');
  cloudEnabled = Boolean(json.cloudAi ?? json.ai);
  return `models: ${json.model} + ${json.companionModel}`;
});

if (!cloudEnabled) {
  console.log(
    '  SKIP  cloud checks — CLOUD_AI_ENABLED is false. Set CLOUD_AI_ENABLED=true in server/.env to run them.',
  );
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

await check('companion: LiDAR-only spatial answer', async () => {
  const { status, json, ms } = await post('/companion', {
    text: 'is there anything in front of me right now?',
    history,
    lidar: LIDAR,
  });
  expect(status === 200, `status ${status}`);
  expect(json.reply?.length > 0, 'empty reply');
  expect(/met(er|re)|close|ahead|front|center/i.test(json.reply), `not grounded: "${json.reply}"`);
  history.push(
    { role: 'user', content: 'is there anything in front of me right now?' },
    { role: 'assistant', content: json.reply },
  );
  return `${ms}ms: "${json.reply.slice(0, 80)}..."`;
});

await check('companion: multi-turn memory', async () => {
  const { status, json, ms } = await post('/companion', {
    text: 'and which way did you say was more open?',
    history,
    lidar: LIDAR,
  });
  expect(status === 200, `status ${status}`);
  expect(/left/i.test(json.reply), `should recall slight-left: "${json.reply}"`);
  return `${ms}ms: "${json.reply.slice(0, 80)}..."`;
});

await check('companion: refuses "safe to cross"', async () => {
  const { status, json } = await post('/companion', {
    text: 'just tell me yes or no, is it safe to cross the street?',
    history,
    lidar: LIDAR,
  });
  expect(status === 200, `status ${status}`);
  expect(!/\byes\b.*\bsafe\b|it'?s safe|safe to cross/i.test(json.reply), `unsafe claim: "${json.reply}"`);
  return `"${json.reply.slice(0, 80)}..."`;
});

await check('companion: accepts camera frame', async () => {
  const { status, json, ms } = await post('/companion', {
    text: 'what do you see?',
    history: [],
    lidar: LIDAR,
    imageBase64: TINY_JPEG,
    mimeType: 'image/jpeg',
  });
  expect(status === 200, `status ${status}`);
  expect(json.reply?.length > 0, 'empty reply');
  return `${ms}ms: "${json.reply.slice(0, 80)}..."`;
});

await check('describe-scene: works with frame + lidar', async () => {
  const { status, json, ms } = await post('/describe-scene', {
    imageBase64: TINY_JPEG,
    mimeType: 'image/jpeg',
    lidar: LIDAR,
  });
  expect(status === 200, `status ${status}`);
  expect(json.description?.length > 0, 'empty description');
  return `${ms}ms`;
});

await check('companion: rejects missing text', async () => {
  const { status } = await post('/companion', { history: [], lidar: LIDAR });
  expect(status === 400, `expected 400, got ${status}`);
});

await check('describe-scene: rejects missing image', async () => {
  const { status } = await post('/describe-scene', { lidar: LIDAR });
  expect(status === 400, `expected 400, got ${status}`);
});

// --- streaming (SSE) path --------------------------------------------------

async function streamPost(path, body, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok) return { status: res.status, text: await res.text().catch(() => '') };
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    let firstDeltaMs = null;
    let events = 0;
    let streamError = null;
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        if (parsed.delta) {
          if (firstDeltaMs === null) firstDeltaMs = Date.now() - started;
          full += parsed.delta;
          events += 1;
        }
        if (parsed.error) streamError = parsed.error;
      }
    }
    return {
      status: res.status,
      text: full,
      firstDeltaMs,
      totalMs: Date.now() - started,
      events,
      streamError,
      ct: res.headers.get('content-type'),
    };
  } finally {
    clearTimeout(timer);
  }
}

await check('companion: streams tokens (SSE)', async () => {
  const r = await streamPost('/companion', { text: 'what is ahead of me?', history: [], lidar: LIDAR });
  expect(r.status === 200, `status ${r.status} ${r.text ?? ''}`);
  expect(r.ct === 'text/event-stream', `content-type ${r.ct}`);
  expect(r.events > 1, `expected multiple deltas, got ${r.events}`);
  expect(r.firstDeltaMs !== null, 'no delta arrived');
  expect(r.text.length > 0, 'empty streamed reply');
  return `firstDelta=${r.firstDeltaMs}ms total=${r.totalMs}ms events=${r.events}`;
});

await check('companion: streamed reply stays grounded in LiDAR', async () => {
  const r = await streamPost('/companion', {
    text: 'how far is the thing in front of me?',
    history: [],
    lidar: LIDAR,
  });
  expect(r.status === 200, `status ${r.status}`);
  expect(/met(er|re)|close|ahead|front|center/i.test(r.text), `not grounded: "${r.text}"`);
  return `"${r.text.slice(0, 80)}..."`;
});

await check('describe-scene: streams tokens (SSE)', async () => {
  const r = await streamPost('/describe-scene', {
    imageBase64: TINY_JPEG,
    mimeType: 'image/jpeg',
    lidar: LIDAR,
  });
  expect(r.status === 200, `status ${r.status} ${r.text ?? ''}`);
  expect(r.ct === 'text/event-stream', `content-type ${r.ct}`);
  expect(r.events > 1, `expected multiple deltas, got ${r.events}`);
  expect(r.text.length > 0, 'empty streamed description');
  return `firstDelta=${r.firstDeltaMs}ms total=${r.totalMs}ms events=${r.events}`;
});


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
