// Firebase AI Logic hybrid inference.
//
// The short explanation in Guardian's window (Gemini's reading of the
// request, as a form that code checks, and a short note):
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
import { GoogleAIBackend, InferenceMode, getAI, getGenerativeModel } from 'firebase/ai';
// Both come from the build: the extension and the hosted demo prove themselves
// to App Check in different ways (see appcheck.ext.js and appcheck.web.js).
import { cloudReady, startAppCheck } from 'guardian-appcheck';
import { firebaseConfig } from 'guardian-config';
import { ON_DEVICE_PARAMS, deviceModelStatus } from './device.js';
import { DEEP_SCHEMA, READING_SCHEMA } from './reading.js';

/** False when this build has no way to pass App Check, so cloud is off. */
export { cloudReady };

/** Cloud model (the SDK's default hybrid cloud model). */
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

// Gemini answers a form (src/ai/reading.js), the same JSON Schema on both
// paths: Chrome's Prompt API takes it as a response constraint for Gemini
// Nano, the cloud model as its response schema.
const deviceParams = () => ({
  ...ON_DEVICE_PARAMS,
  promptOptions: { responseConstraint: READING_SCHEMA },
});
const cloudParams = (schema) => ({
  model: CLOUD_MODEL,
  generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0.2 },
});

/** One answer, timed, with where the SDK ran it. */
async function answer(model, prompt, signal) {
  const started = performance.now();
  const result = await model.generateContent(prompt, signal ? { signal } : undefined);
  return {
    text: result.response.text().trim(),
    ms: Math.round(performance.now() - started),
    // Where the SDK actually ran it, as the SDK reports it.
    source: result.response.inferenceSource || 'unknown',
  };
}

/**
 * The short explanation from Gemini Nano on this computer.
 * @returns {{text: string, ms: number, source: string}}  text: the form, as JSON
 */
export async function readOnDevice(prompt) {
  const model = getGenerativeModel(onDevice(), {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: deviceParams(),
  });
  return answer(model, prompt);
}

/**
 * The same through the SDK's hybrid mode: Gemini Nano when it is ready on
 * this computer, otherwise Gemini in the cloud. Call only after the user has
 * allowed the cloud.
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
 * @returns {{text: string, ms: number, source: string}}
 */
export async function readHybrid(prompt, { deviceReady = false, signal } = {}) {
  const model = getGenerativeModel(deviceReady ? onDevice() : inCloud(), {
    mode: InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: deviceParams(),
    inCloudParams: cloudParams(READING_SCHEMA),
  });
  return answer(model, prompt, signal);
}

/**
 * The deeper analysis from the cloud model. Call only after the user asked.
 * @returns {{text: string, ms: number, source: string}}  text: the form, as JSON
 */
export async function analyzeInCloud(prompt, { signal } = {}) {
  const model = getGenerativeModel(inCloud(), {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: cloudParams(DEEP_SCHEMA),
  });
  return answer(model, prompt, signal);
}
