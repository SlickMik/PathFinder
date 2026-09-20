// PathFinder scene-description proxy.
//
// Holds the Baseten API key server-side (never ship it in the Expo bundle),
// accepts a single deliberately captured camera frame plus compact LiDAR
// context, and returns a short, uncertainty-aware description.
//
// Zero dependencies — runs on Node 18+ (built-in fetch).
//
//   node server/index.mjs
//
// Env (server/.env or process env):
//   BASETEN_API_KEY    required
//   BASETEN_MODEL      default: zai-org/GLM-5.3-Flash
//   APP_SHARED_SECRET  optional; if set, requests must send x-app-secret
//   PORT               default: 8787

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- tiny .env loader (no dotenv dependency) -------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(path.join(here, '.env'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {
  // no .env file; rely on process env
}

const PORT = Number(process.env.PORT ?? 8787);
const BASETEN_API_KEY = process.env.BASETEN_API_KEY;
const MODEL = process.env.BASETEN_MODEL ?? 'zai-org/GLM-5.3-Flash';
// Conversational companion model — Moonshot AI's Kimi is chatty AND accepts
// images, so one model can both banter and see.
const COMPANION_MODEL = process.env.BASETEN_COMPANION_MODEL ?? 'moonshotai/Kimi-K2.6';
// Fastest vision-capable GPU model on Baseten — used for any turn that
// carries a camera frame so replies come back quicker.
const FAST_VISION_MODEL = process.env.BASETEN_FAST_VISION_MODEL ?? 'zai-org/GLM-5.3-Flash';
const SHARED_SECRET = process.env.APP_SHARED_SECRET || null;
const BASETEN_URL = 'https://inference.baseten.co/v1/chat/completions';

const MAX_BODY_BYTES = 8 * 1024 * 1024; // one compressed 768px JPEG fits easily
const UPSTREAM_TIMEOUT_MS = 25_000;
const RATE_LIMIT = { windowMs: 60_000, max: 12 }; // per client IP

if (!BASETEN_API_KEY) {
  console.error('BASETEN_API_KEY is not set. Create server/.env (see .env.example).');
  process.exit(1);
}

// Encodes the description policy from PLAN.md §8. Kept server-side so the
// client can never weaken it.
const SYSTEM_PROMPT = `You describe a single camera frame for a blind or low-vision pedestrian.

Rules:
- Lead with immediate, visually apparent hazards, then layout, then useful landmarks.
- Use left / center / right directions consistently (from the camera's point of view).
- LiDAR context may be provided. Use approximate distances ONLY when they are supported by that LiDAR context; otherwise use relative terms like "close" or "farther away".
- Distinguish observation from inference. Say "I see a red octagonal sign" rather than asserting its meaning if text is unreadable.
- State uncertainty briefly: "possibly a glass door", "I can't confirm".
- NEVER say a path, road, stairway, or crossing is "safe" or "clear to proceed". You may say a direction "appears more open" at most.
- Do not identify people or infer sensitive personal traits (age, ethnicity, disability, etc.). "A person standing near the doorway" is enough.
- Keep it short: 1-3 plain sentences the first time. No markdown, no lists, no preamble.`;

const COMPANION_PROMPT = `You are "Path", a friendly companion walking alongside a blind or low-vision person through their everyday journey — leaving the house, walking to the car or bus stop, commuting to work, heading home. You talk like a warm, easygoing friend keeping them company, not like an assistant or a robot.

Style:
- VERY short, spoken-style replies: one or two brief sentences, under 30 words total, with contractions. No markdown, no lists, no emoji. Never monologue — this is a back-and-forth chat while walking.
- Acknowledge journey moments casually ("Alright, out the door — feels like a good morning for it.").
- Remember and refer back to earlier parts of the conversation and journey.
- If a camera frame is attached, weave what you actually see into the conversation naturally; mention hazards first.
- Direction suggestions may come from an on-device walkable-path segmentation model or the LiDAR route planner — you can mention where a suggestion comes from casually ("the path model likes the left side").
- You always receive live LiDAR context. When asked what's ahead, around, or how far something is — answer directly from the LiDAR sector distances, corridor reading, and alert state, even with no image. Convert meters to natural speech ("about a meter and a half ahead on your left").
- If LiDAR shows a sector as unknown, say you can't read that side rather than guessing.
- Use approximate distances only when the provided LiDAR context supports them.

Hard safety rules (never break these, even if asked):
- Never say a path, road, stairway, or crossing is "safe", "clear", or "good to go". At most, a direction "looks more open".
- Never make traffic or street-crossing decisions — gently remind them that's their call with their cane, dog, or own judgment.
- Never identify people or guess sensitive traits (age, ethnicity, disability, etc.).
- You are supplemental. Deterministic obstacle alerts run separately — don't repeat, downplay, or contradict them.`;

// --- naive per-IP rate limiter ---------------------------------------------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT.max;
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function lidarContextText(lidar) {
  if (!lidar || typeof lidar !== 'object') return 'No LiDAR context provided.';
  // Only pass through the compact, expected fields — never trust extra data.
  const sector = (s) =>
    s && typeof s.distanceM === 'number'
      ? `${s.distanceM.toFixed(1)} m (confidence ${s.confidence ?? 'unknown'})`
      : 'unknown';
  const lines = [
    `Live LiDAR context (device depth sensor, right now):`,
    `- nearest obstacle left: ${sector(lidar.left)}`,
    `- nearest obstacle center: ${sector(lidar.center)}`,
    `- nearest obstacle right: ${sector(lidar.right)}`,
    `- walking-corridor risk: ${lidar.corridorRisk ?? 'unknown'}`,
    `- tracking quality: ${lidar.tracking ?? 'unknown'}`,
  ];
  if (typeof lidar.corridorDistanceM === 'number') {
    lines.push(`- nearest obstacle in walking corridor: ${lidar.corridorDistanceM.toFixed(1)} m`);
  }
  if (typeof lidar.timeToContactS === 'number') {
    lines.push(`- estimated time to contact: ${lidar.timeToContactS.toFixed(1)} s`);
  }
  if (lidar.alert && typeof lidar.alert.risk === 'string') {
    lines.push(
      `- current alert state: ${lidar.alert.risk}${lidar.alert.direction ? `, direction ${lidar.alert.direction}` : ''}`,
    );
  }
  if (lidar.guidance && typeof lidar.guidance.instruction === 'string') {
    const g = lidar.guidance;
    const sourceLabel =
      {
        'segmented-path': 'on-device walkable-path segmentation (camera ML)',
        'lidar-route': 'LiDAR route planner',
        'reactive-sectors': 'sector fallback',
      }[g.source] ?? 'route planner';
    const extras = [
      typeof g.clearanceM === 'number' ? `clearance ${g.clearanceM.toFixed(1)} m` : null,
      typeof g.openingWidthM === 'number' ? `opening ${g.openingWidthM.toFixed(1)} m wide` : null,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`- suggested direction from ${sourceLabel}: ${g.instruction}${extras ? ` (${extras})` : ''}`);
  }
  return lines.join('\n');
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (turn) =>
        turn &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string',
    )
    .slice(-16)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 600) }));
}

// --- request body builders (shared by streaming + non-streaming paths) ----

function companionRequestBody({ text, history, events, imageBase64, mimeType, lidar }) {
  const eventsText =
    Array.isArray(events) && events.length > 0
      ? `\nRecent journey moments (you may reference these naturally):\n${events
          .slice(-6)
          .map((event) => `- ${String(event).slice(0, 120)}`)
          .join('\n')}`
      : '';
  const userContent = [
    { type: 'text', text: `${lidarContextText(lidar)}${eventsText}\n\n${text}` },
  ];
  if (imageBase64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${imageBase64}` },
    });
  }
  return {
    // Vision turns go to the fastest GPU model; text-only chat keeps the
    // more conversational model.
    model: imageBase64 ? FAST_VISION_MODEL : COMPANION_MODEL,
    temperature: 0.7,
    max_tokens: 90,
    messages: [
      { role: 'system', content: COMPANION_PROMPT },
      ...sanitizeHistory(history),
      { role: 'user', content: userContent },
    ],
  };
}

function describeRequestBody({ imageBase64, mimeType, lidar }) {
  return {
    model: MODEL,
    temperature: 0.2,
    max_tokens: 160,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${lidarContextText(lidar)}\n\nDescribe this scene for the pedestrian now.`,
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
        ],
      },
    ],
  };
}

// One Baseten call. When onDelta is given, streams SSE token deltas to it as
// they arrive (Baseten supports `stream: true` on /v1/chat/completions); the
// returned `content` is the full concatenated reply either way. onDelta lets
// the proxy forward tokens to the client the moment they're generated, so the
// pedestrian hears the first sentence ~1s in instead of waiting for the whole
// reply.
async function callBaseten(body, onDelta) {
  const streaming = typeof onDelta === 'function';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const upstreamStart = Date.now();
  try {
    const response = await fetch(BASETEN_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${BASETEN_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, stream: streaming }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`Baseten error ${response.status}: ${detail.slice(0, 300)}`),
        { status: 502 },
      );
    }

    if (!streaming) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw Object.assign(new Error('Empty model response.'), { status: 502 });
      return { content, usage: data.usage ?? null, upstreamMs: Date.now() - upstreamStart };
    }

    // Parse the SSE stream: `data: {json}\n\n`, terminated by `data: [DONE]`.
    // Chunks are Uint8Arrays whose .toString() yields comma-joined bytes, so
    // decode with TextDecoder and split on newlines ourselves.
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let usage = null;
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      }
    }
    const content = full.trim();
    if (!content) throw Object.assign(new Error('Empty model response.'), { status: 502 });
    return { content, usage, upstreamMs: Date.now() - upstreamStart };
  } finally {
    clearTimeout(timer);
  }
}

async function companionChat(opts) {
  const { content, usage, upstreamMs } = await callBaseten(companionRequestBody(opts), null);
  return { reply: content, usage, upstreamMs };
}

// Structured hazard extraction — GLM-5.3-Flash with a strict JSON schema so
// the app receives machine-readable hazards, not prose.
const HAZARD_PROMPT = `You extract pedestrian hazards from one camera frame for a blind walker.
Report only visually confirmable physical hazards in the walking space: obstacles, people, poles, steps, curbs, vehicles, hanging or low objects. Use the LiDAR context to set proximity when it corroborates. Do not report signs, colors, or scenery. Fewer, higher-confidence hazards beat many guesses. An empty list is a valid answer.`;

function hazardsRequestBody({ imageBase64, mimeType, lidar }) {
  return {
    model: FAST_VISION_MODEL,
    temperature: 0,
    max_tokens: 300,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'hazard_report',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hazards: {
              type: 'array',
              maxItems: 5,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string' },
                  direction: { type: 'string', enum: ['left', 'center', 'right'] },
                  proximity: { type: 'string', enum: ['immediate', 'near', 'far', 'unknown'] },
                  confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
                },
                required: ['label', 'direction', 'proximity', 'confidence'],
              },
            },
          },
          required: ['hazards'],
        },
      },
    },
    messages: [
      { role: 'system', content: HAZARD_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: lidarContextText(lidar) },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      },
    ],
  };
}

async function extractHazards(opts) {
  const { content, usage, upstreamMs } = await callBaseten(hazardsRequestBody(opts), null);
  let hazards = [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.hazards)) hazards = parsed.hazards.slice(0, 5);
  } catch {
    // strict schema should prevent this; fail closed with no hazards
  }
  return { hazards, usage, upstreamMs };
}

async function describeScene(opts) {
  const { content, usage, upstreamMs } = await callBaseten(describeRequestBody(opts), null);
  return { description: content, usage, upstreamMs };
}

// Streams a Baseten completion to the client as SSE: one `data: {"delta":...}`
// event per token, terminated by `data: [DONE]`. The proxy never buffers the
// whole reply — each token is forwarded the instant Baseten emits it, which is
// what lets on-device TTS start speaking the first sentence before the model
// has finished generating the rest.
async function streamReply(res, requestBody, started, label) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  try {
    const { usage, upstreamMs } = await callBaseten(requestBody, (delta) => {
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    });
    res.write('data: [DONE]\n\n');
    res.end();
    const totalMs = Date.now() - started;
    console.log(
      `[${label}] stream ok total=${totalMs}ms upstream=${upstreamMs}ms overhead=${totalMs - upstreamMs}ms tokens=${usage?.prompt_tokens ?? '?'}/${usage?.completion_tokens ?? '?'}`,
    );
  } catch (error) {
    // Match the non-streaming path: send a generic message to the client and
    // keep the raw upstream detail server-side only (error.message can contain
    // the full Baseten response body, which we must not leak to the app).
    res.write(`data: ${JSON.stringify({ error: 'Request failed.' })}\n\n`);
    res.end();
    console.error(`[${label}] stream fail ${Date.now() - started}ms: ${error.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const ip = req.socket.remoteAddress ?? 'unknown';

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, model: MODEL, companionModel: COMPANION_MODEL });
  }
  if (req.method !== 'POST' || !['/describe-scene', '/companion', '/hazards'].includes(req.url)) {
    return send(res, 404, { error: 'Not found.' });
  }
  if (SHARED_SECRET && req.headers['x-app-secret'] !== SHARED_SECRET) {
    return send(res, 401, { error: 'Unauthorized.' });
  }
  if (rateLimited(ip)) {
    return send(res, 429, { error: 'Too many requests.' });
  }

  try {
    const body = JSON.parse(await readBody(req));
    const { imageBase64, mimeType = 'image/jpeg', lidar } = body ?? {};
    if (imageBase64 !== undefined && !['image/jpeg', 'image/png'].includes(mimeType)) {
      return send(res, 400, { error: 'Unsupported mimeType.' });
    }

    if (req.url === '/companion') {
      const { text, history, events } = body ?? {};
      if (typeof text !== 'string' || !text.trim()) {
        return send(res, 400, { error: 'text is required.' });
      }
      const opts = {
        text: text.slice(0, 1000),
        history,
        events,
        imageBase64: typeof imageBase64 === 'string' ? imageBase64 : null,
        mimeType,
        lidar,
      };
      if (body.stream) {
        return streamReply(res, companionRequestBody(opts), started, 'companion');
      }
      const { reply, usage, upstreamMs } = await companionChat(opts);
      const totalMs = Date.now() - started;
      res.setHeader('Server-Timing', `upstream;dur=${upstreamMs}, proxy;dur=${totalMs - upstreamMs}`);
      console.log(
        `[companion] ok total=${totalMs}ms upstream=${upstreamMs}ms overhead=${totalMs - upstreamMs}ms tokens=${usage?.prompt_tokens ?? '?'}/${usage?.completion_tokens ?? '?'}`,
      );
      return send(res, 200, { reply });
    }

    if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
      return send(res, 400, { error: 'imageBase64 is required.' });
    }

    if (req.url === '/hazards') {
      const { hazards, usage, upstreamMs } = await extractHazards({ imageBase64, mimeType, lidar });
      const totalMs = Date.now() - started;
      res.setHeader('Server-Timing', `upstream;dur=${upstreamMs}, proxy;dur=${totalMs - upstreamMs}`);
      console.log(
        `[hazards] ok total=${totalMs}ms upstream=${upstreamMs}ms count=${hazards.length} tokens=${usage?.prompt_tokens ?? '?'}/${usage?.completion_tokens ?? '?'}`,
      );
      return send(res, 200, { hazards });
    }

    if (body.stream) {
      return streamReply(res, describeRequestBody({ imageBase64, mimeType, lidar }), started, 'describe-scene');
    }
    const { description, usage, upstreamMs } = await describeScene({ imageBase64, mimeType, lidar });
    const totalMs = Date.now() - started;
    const overheadMs = totalMs - upstreamMs;
    res.setHeader('Server-Timing', `upstream;dur=${upstreamMs}, proxy;dur=${overheadMs}`);
    console.log(
      `[describe-scene] ok total=${totalMs}ms upstream=${upstreamMs}ms overhead=${overheadMs}ms tokens=${usage?.prompt_tokens ?? '?'}/${usage?.completion_tokens ?? '?'}`,
    );
    return send(res, 200, { description });
  } catch (error) {
    const status = error?.status ?? (error?.name === 'AbortError' ? 504 : 500);
    console.error(`[${req.url}] fail ${Date.now() - started}ms status=${status}: ${error.message}`);
    return send(res, status, { error: 'Request failed.' });
  }
});

// Pre-open the TLS connection to Baseten so the first real request skips the
// handshake (~300ms). Keep-alive in Node's fetch pool reuses it afterwards.
async function warmUpstream() {
  try {
    const started = Date.now();
    await fetch(BASETEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BASETEN_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: FAST_VISION_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    console.log(`[warmup] Baseten connection ready in ${Date.now() - started}ms`);
  } catch (error) {
    console.warn(`[warmup] failed (non-fatal): ${error.message}`);
  }
}

server.listen(PORT, () => {
  console.log(
    `PathFinder scene proxy listening on http://0.0.0.0:${PORT} (describe: ${MODEL}, chat: ${COMPANION_MODEL}, vision: ${FAST_VISION_MODEL})`,
  );
  void warmUpstream();
});
