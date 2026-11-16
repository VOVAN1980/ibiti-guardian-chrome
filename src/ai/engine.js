// Firebase AI Logic hybrid inference.
//
// The short explanation in Guardian's window:
//   InferenceMode.ONLY_ON_DEVICE    the default. Gemini Nano in Chrome, no
//                                   network. Without Nano there is no
//                                   explanation; the facts never need one.
//   InferenceMode.PREFER_ON_DEVICE  once the user has allowed the cloud. The
//                                   SDK runs Gemini Nano when it is ready on
//                                   this computer and falls back to Gemini in
//                                   the cloud when it is not.
// The deeper analysis:
//   InferenceMode.ONLY_IN_CLOUD     only when the user presses its button.
//
// The SDK falls back only when no on-device model is ready. If Gemini Nano is
// there but fails while answering, the explanation is simply missing.

import { initializeApp } from 'firebase/app';
import { GoogleAIBackend, InferenceMode, Schema, getAI, getGenerativeModel } from 'firebase/ai';
// Both come from the build: the extension and the hosted demo prove themselves
// to App Check in different ways (see appcheck.ext.js and appcheck.web.js).
import { cloudReady, startAppCheck } from 'guardian-appcheck';
import { firebaseConfig } from 'guardian-config';
import { ON_DEVICE_PARAMS, deviceModelStatus } from './device.js';

/** False when this build has no way to pass App Check, so cloud is off. */
export { cloudReady };

/** Cloud model for the deeper analysis (the SDK's default hybrid cloud model). */
const CLOUD_MODEL = 'gemini-3.5-flash-lite';

// Two Firebase apps with the same settings. The on-device one never starts
// App Check, so explaining on this computer contacts no server at all (on the
// hosted demo App Check would load reCAPTCHA). The cloud one is created on the
// first cloud request, after the user has asked for it.
let deviceAi = null;
let cloudAi = null;

function onDevice() {
  if (!deviceAi) deviceAi = getAI(initializeApp(firebaseConfig, 'guardian-device'), { backend: new GoogleAIBackend() });
  return deviceAi;
}

function inCloud() {
  if (!cloudAi) {
    const app = initializeApp(firebaseConfig, 'guardian-cloud');
    startAppCheck(app); // Firebase AI Logic requires App Check for cloud calls
    cloudAi = getAI(app, { backend: new GoogleAIBackend() });
  }
  return cloudAi;
}

export { deviceModelStatus };

/** Starts the one-time model download. Needs a user gesture. */
export async function downloadDeviceModel(onProgress) {
  const model = getGenerativeModel(onDevice(), {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: ON_DEVICE_PARAMS,
  });
  await model.initializeDeviceModel((fraction) => onProgress(Math.round(fraction * 100)));
}

/**
 * Reads a streamed answer. `onText` gets the whole text so far (the window
 * checks it before showing anything) and returns false to stop reading: once
 * a sentence fails the checks, the rest is not wanted. `firstMs` is when the
 * first words came.
 */
async function readStream(model, prompt, onText, options) {
  const started = performance.now();
  const result = await model.generateContentStream(prompt, options);
  let text = '';
  let firstMs = null;
  let source = null;
  let stopped = false;
  for await (const chunk of result.stream) {
    // Where the SDK actually ran it, as the SDK reports it on every chunk.
    source = source || chunk.inferenceSource || null;
    text += chunk.text();
    if (firstMs === null && text.trim()) firstMs = Math.round(performance.now() - started);
    if (onText(text) === false) {
      stopped = true;
      break;
    }
  }
  if (stopped) {
    result.response.catch(() => {}); // the rest is not read
  } else {
    const response = await result.response;
    source = response.inferenceSource || source;
  }
  return {
    text: text.trim(),
    firstMs,
    ms: Math.round(performance.now() - started),
    source: source || 'unknown',
    stopped,
  };
}

/**
 * Streams a short explanation from the on-device model.
 * @returns {{text: string, firstMs: number, ms: number, source: string}}
 */
export async function explainOnDevice(prompt, onText) {
  const model = getGenerativeModel(onDevice(), {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: ON_DEVICE_PARAMS,
  });
  return readStream(model, prompt, onText);
}

/**
 * The same short explanation through the SDK's hybrid mode: Gemini Nano when
 * it is ready on this computer, otherwise Gemini in the cloud. Call only after
 * the user has allowed the cloud.
 *
 * The SDK decides where to run at the moment of the call. So `prompt` must
 * always be the text that may go to the cloud (no own address, no balance),
 * even when Gemini Nano looked ready a moment ago.
 *
 * `deviceReady` is Chrome's answer just before the call. When Gemini Nano is
 * ready, the model is built on the app without App Check: the SDK answers on
 * the device, and nothing (not even reCAPTCHA on the hosted demo) is loaded.
 * Should the model vanish in between, the SDK turns to the cloud, as the
 * user allowed; Firebase then refuses that request for lack of App Check,
 * but the (cloud-safe) prompt has been sent.
 *
 * `signal` stops a cloud request that has not gone out yet (the user turned
 * the permission off): the SDK checks it right before sending.
 * @returns {{text: string, firstMs: number, ms: number, source: string}}
 */
export async function explainHybrid(prompt, onText, { deviceReady = false, signal } = {}) {
  const model = getGenerativeModel(deviceReady ? onDevice() : inCloud(), {
    mode: InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: ON_DEVICE_PARAMS,
    inCloudParams: { model: CLOUD_MODEL, generationConfig: { temperature: 0.2 } },
  });
  return readStream(model, prompt, onText, signal ? { signal } : undefined);
}

const PATTERN_KINDS = ['known_scam_pattern', 'no_known_pattern', 'cannot_determine'];

const DEEP_SCHEMA = Schema.object({
  properties: {
    summary: Schema.string(),
    ifYouConfirm: Schema.string(),
    patternKind: Schema.enumString({ enum: PATTERN_KINDS }),
    patternName: Schema.string(),
    checks: Schema.array({ items: Schema.string() }),
  },
  optionalProperties: ['patternName'],
});

/**
 * Deeper, structured analysis from the cloud model. Call only after consent.
 * @returns {{data: object, ms: number, source: string}}
 */
export async function analyzeInCloud(prompt, { signal } = {}) {
  const model = getGenerativeModel(inCloud(), {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: DEEP_SCHEMA,
        temperature: 0.2,
      },
    },
  });
  const started = performance.now();
  const result = await model.generateContent(prompt, signal ? { signal } : undefined);
  const data = JSON.parse(result.response.text());
  return {
    data,
    ms: Math.round(performance.now() - started),
    source: result.response.inferenceSource || 'in_cloud',
  };
}
