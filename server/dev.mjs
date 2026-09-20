#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'start';
const forwardedArgs = process.argv.slice(3);
const expoBinary = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'expo.cmd' : 'expo',
);

if (!['start', 'ios'].includes(mode)) {
  console.error('Usage: node server/dev.mjs <start|ios> [Expo arguments]');
  process.exit(1);
}

function readEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
}

function lanAddress() {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(
        (address) =>
          address.family === 'IPv4' &&
          !address.internal &&
          !address.address.startsWith('169.254.'),
      )
      .map((address) => ({ name, address: address.address })),
  );
  const preferred = candidates.find(({ name }) => name === 'en0' || name === 'en1');
  return preferred?.address ?? candidates[0]?.address ?? '127.0.0.1';
}

const rootEnv = readEnv(path.join(root, '.env'));
const serverEnv = readEnv(path.join(root, 'server', '.env'));
const proxyPort = Number(process.env.PORT ?? serverEnv.PORT ?? 8787);
const proxyHost = process.env.PATHFINDER_PROXY_HOST ?? lanAddress();
const proxyBaseUrl = `http://${proxyHost}:${proxyPort}`;
const proxyHealthUrl = `http://127.0.0.1:${proxyPort}/health`;
const sceneUrl =
  process.env.EXPO_PUBLIC_SCENE_DESCRIBE_URL ??
  rootEnv.EXPO_PUBLIC_SCENE_DESCRIBE_URL ??
  `${proxyBaseUrl}/describe-scene`;
const cloudAiEnabled = /^(1|true|yes|on)$/i.test(
  process.env.EXPO_PUBLIC_CLOUD_AI_ENABLED ??
    rootEnv.EXPO_PUBLIC_CLOUD_AI_ENABLED ??
    serverEnv.CLOUD_AI_ENABLED ??
    'false',
);

if (cloudAiEnabled && !(process.env.GEMINI_API_KEY ?? serverEnv.GEMINI_API_KEY)) {
  console.warn(
    '\n[dev] GEMINI_API_KEY is missing. Expo will still start with local navigation and ElevenLabs, but cloud descriptions will be unavailable.\n',
  );
}

if (!existsSync(expoBinary)) {
  console.error('[dev] Expo is not installed. Run npm install first.');
  process.exit(1);
}

const childEnvironment = {
  ...process.env,
  EXPO_PUBLIC_SCENE_DESCRIBE_URL: sceneUrl,
  EXPO_PUBLIC_CLOUD_AI_ENABLED: cloudAiEnabled ? 'true' : 'false',
  // Keep the proxy and Expo client on the same explicit mode even when the
  // flag came from the root .env rather than server/.env.
  CLOUD_AI_ENABLED: cloudAiEnabled ? 'true' : 'false',
};

let backend = null;
let expo = null;
let shuttingDown = false;

function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  expo?.kill('SIGTERM');
  backend?.kill('SIGTERM');
  if (!expo && !backend) {
    process.exitCode = exitCode;
    return;
  }
  setTimeout(() => process.exit(exitCode), 100).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

async function proxyState() {
  try {
    const response = await fetch(proxyHealthUrl, {
      signal: AbortSignal.timeout(700),
    });
    const health = await response.json().catch(() => ({}));
    return {
      healthy: response.ok,
      compatible: response.ok && health.provider === 'gemini',
    };
  } catch {
    return { healthy: false, compatible: false };
  }
}

async function waitForProxy() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await proxyState()).compatible) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function main() {
  console.log(`[dev] App backend: ${proxyBaseUrl}`);
  console.log(`[dev] Expo scene URL: ${sceneUrl}`);
  console.log(`[dev] Cloud AI: ${cloudAiEnabled ? 'enabled' : 'disabled (local-only mode)'}`);

  const existingProxy = await proxyState();
  if (existingProxy.compatible) {
    console.log('[dev] Reusing the healthy PathFinder proxy already running.');
  } else if (existingProxy.healthy) {
    console.error(
      '[dev] Port 8787 is occupied by an older PathFinder proxy. Stop that Expo process, then run this command again.',
    );
    stop(1);
    return;
  } else {
    backend = spawn(process.execPath, ['server/index.mjs'], {
      cwd: root,
      env: childEnvironment,
      stdio: 'inherit',
    });
    backend.once('exit', (code) => {
      if (!shuttingDown) {
        console.error(`[dev] PathFinder proxy stopped unexpectedly (${code ?? 'signal'}).`);
        stop(code ?? 1);
      }
    });
    if (!(await waitForProxy())) {
      console.error('[dev] PathFinder proxy did not become healthy.');
      stop(1);
      return;
    }
    console.log('[dev] PathFinder proxy is ready.');
  }

  const expoArgs = mode === 'ios' ? ['run:ios', ...forwardedArgs] : ['start', '--dev-client', ...forwardedArgs];
  expo = spawn(expoBinary, expoArgs, {
    cwd: root,
    env: childEnvironment,
    stdio: 'inherit',
  });
  expo.once('exit', (code) => stop(code ?? 0));
}

void main().catch((error) => {
  console.error('[dev] Unable to start PathFinder:', error);
  stop(1);
});
