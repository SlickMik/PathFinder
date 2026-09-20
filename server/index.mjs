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
// Optional integrations — the app degrades gracefully when these are absent.
// ElevenLabs: natural voice out. OpenAI: understands the user's raw audio
// (better than on-device STT in noise/accents); the reply brain stays Baseten.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || null;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM'; // Rachel
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_turbo_v2_5';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe';
const SHARED_SECRET = process.env.APP_SHARED_SECRET || null;
// Overridable for local testing against a mock upstream.
const BASETEN_URL = process.env.BASETEN_URL ?? 'https://inference.baseten.co/v1/chat/completions';

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
- If NO LiDAR context is provided at all, obstacle scanning is off — answer conversationally but remind them once: "start obstacle alerts and I'll be able to see distances". Never pretend to have sensor readings you weren't given.
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
    max_tokens: 140,
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

// Retry policy per Baseten's hackathon guidance: back off exponentially (with
// jitter) on 429 rate limits and transient 5xx/network failures, honouring a
// Retry-After header when present, and never retrying in a tight loop.
// Streams are only retried before the first token has been forwarded to the
// client (a replay after that would duplicate speech). Timeouts are never
// retried — the pedestrian is waiting.
const MAX_UPSTREAM_RETRIES = Math.max(0, Number(process.env.BASETEN_MAX_RETRIES ?? 2));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(attempt, retryAfterS) {
  if (Number.isFinite(retryAfterS) && retryAfterS > 0) return Math.min(retryAfterS * 1000, 10_000);
  const base = Math.min(500 * 2 ** attempt, 4_000); // 500ms, 1s, 2s, capped at 4s
  return Math.round(base * (0.5 + Math.random() * 0.5)); // jitter so clients don't sync up
}

async function callBaseten(body, onDelta) {
  const streaming = typeof onDelta === 'function';
  let tokensSent = false;
  const guardedDelta = streaming
    ? (delta) => {
        tokensSent = true;
        onDelta(delta);
      }
    : null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callBasetenOnce(body, guardedDelta);
    } catch (error) {
      const transient =
        error.upstreamStatus === 429 ||
        (error.upstreamStatus >= 500 && error.upstreamStatus <= 599) ||
        error.networkFailure === true;
      if (!transient || tokensSent || attempt >= MAX_UPSTREAM_RETRIES) throw error;
      const delay = retryDelayMs(attempt, error.retryAfterS);
      console.warn(
        `[baseten] ${error.upstreamStatus ?? 'network error'} — retry ${attempt + 1}/${MAX_UPSTREAM_RETRIES} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

// One Baseten call. When onDelta is given, streams SSE token deltas to it as
// they arrive (Baseten supports `stream: true` on /v1/chat/completions); the
// returned `content` is the full concatenated reply either way. onDelta lets
// the proxy forward tokens to the client the moment they're generated, so the
// pedestrian hears the first sentence ~1s in instead of waiting for the whole
// reply.
async function callBasetenOnce(body, onDelta) {
  const streaming = typeof onDelta === 'function';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const upstreamStart = Date.now();
  try {
    let response;
    try {
      response = await fetch(BASETEN_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${BASETEN_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...body, stream: streaming }),
      });
    } catch (error) {
      // Connection-level failure (DNS, reset, TLS) — retriable. Timeouts
      // (AbortError) are not: the client has already waited long enough.
      if (error?.name !== 'AbortError') error.networkFailure = true;
      throw error;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`Baseten error ${response.status}: ${detail.slice(0, 300)}`),
        {
          status: response.status === 429 ? 429 : 502,
          upstreamStatus: response.status,
          retryAfterS: Number(response.headers.get('retry-after')),
        },
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

// --- ElevenLabs TTS: stream mp3 for one sentence/utterance ------------------
async function streamTts(res, text) {
  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=mp3_44100_64`,
    {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.7 },
      }),
    },
  );
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    throw Object.assign(new Error(`ElevenLabs ${upstream.status}: ${detail.slice(0, 200)}`), {
      status: 502,
    });
  }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

// --- OpenAI ears: transcribe the user's raw audio ---------------------------
async function transcribeAudio(audioBase64, audioMime) {
  const form = new FormData();
  const ext = audioMime.includes('wav') ? 'wav' : audioMime.includes('caf') ? 'caf' : 'm4a';
  form.append(
    'file',
    new Blob([Buffer.from(audioBase64, 'base64')], { type: audioMime }),
    `speech.${ext}`,
  );
  form.append('model', OPENAI_TRANSCRIBE_MODEL);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw Object.assign(new Error(`OpenAI ${response.status}: ${detail.slice(0, 200)}`), {
      status: 502,
    });
  }
  const data = await response.json();
  const transcript = (data.text ?? '').trim();
  if (!transcript) throw Object.assign(new Error('Empty transcript.'), { status: 422 });
  return transcript;
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
    let usage;
    let upstreamMs;
    let retried = false;
    try {
      ({ usage, upstreamMs } = await callBaseten(requestBody, (delta) => {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }));
    } catch (error) {
      // Streamed generations occasionally yield zero content tokens (e.g. the
      // model spends its budget on reasoning). Never leave the user in
      // silence: retry once buffered and emit the reply as a single delta.
      if (!/Empty model response/.test(error.message)) throw error;
      console.warn(`[${label}] empty stream — retrying buffered`);
      retried = true;
      const retry = await callBaseten({ ...requestBody, max_tokens: 220 }, null);
      res.write(`data: ${JSON.stringify({ delta: retry.content })}\n\n`);
      ({ usage, upstreamMs } = retry);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    const totalMs = Date.now() - started;
    console.log(
      `[${label}] stream ok${retried ? ' (retried)' : ''} total=${totalMs}ms upstream=${upstreamMs}ms overhead=${totalMs - upstreamMs}ms tokens=${usage?.prompt_tokens ?? '?'}/${usage?.completion_tokens ?? '?'}`,
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
    return send(res, 200, {
      ok: true,
      model: MODEL,
      companionModel: COMPANION_MODEL,
      tts: Boolean(ELEVENLABS_API_KEY),
      understand: Boolean(OPENAI_API_KEY),
    });
  }
  if (req.method === 'GET' && req.url?.startsWith('/tts?')) {
    if (!ELEVENLABS_API_KEY) return send(res, 503, { error: 'TTS not configured.' });
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many requests.' });
    const params = new URL(req.url, 'http://localhost').searchParams;
    const text = (params.get('text') ?? '').slice(0, 600).trim();
    if (SHARED_SECRET && params.get('secret') !== SHARED_SECRET) {
      return send(res, 401, { error: 'Unauthorized.' });
    }
    if (!text) return send(res, 400, { error: 'text is required.' });
    try {
      const ttsStarted = Date.now();
      await streamTts(res, text);
      console.log(`[tts] ok ${Date.now() - ttsStarted}ms chars=${text.length}`);
    } catch (error) {
      console.error(`[tts] fail: ${error.message}`);
      if (!res.headersSent) send(res, error.status ?? 500, { error: 'TTS failed.' });
      else res.end();
    }
    return;
  }
  if (
    req.method !== 'POST' ||
    !['/describe-scene', '/companion', '/hazards', '/understand'].includes(req.url)
  ) {
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

    if (req.url === '/understand') {
      if (!OPENAI_API_KEY) return send(res, 503, { error: 'Understand not configured.' });
      const { audioBase64, audioMime = 'audio/m4a', history, events } = body ?? {};
      if (typeof audioBase64 !== 'string' || audioBase64.length < 100) {
        return send(res, 400, { error: 'audioBase64 is required.' });
      }
      const transcript = await transcribeAudio(audioBase64, audioMime);
      console.log(`[understand] transcript (${transcript.length} chars) via ${OPENAI_TRANSCRIBE_MODEL}`);
      const { reply, usage, upstreamMs } = await companionChat({
        text: transcript.slice(0, 1000),
        history,
        events,
        imageBase64: typeof imageBase64 === 'string' ? imageBase64 : null,
        mimeType,
        lidar,
      });
      const totalMs = Date.now() - started;
      console.log(
        `[understand] ok total=${totalMs}ms brain=${upstreamMs}ms tokens=${usage?.prompt_tokens ?? '?'}/${usage?.completion_tokens ?? '?'}`,
      );
      return send(res, 200, { transcript, reply });
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
