// Firebase AI Logic hybrid inference.
//
// Two paths, chosen by the user's consent rather than by an automatic fallback:
//   on device  InferenceMode.ONLY_ON_DEVICE  Gemini Nano in Chrome; no network
//   in cloud   InferenceMode.ONLY_IN_CLOUD   Gemini through Firebase, only
//                                            after the user asks for it
// There is no automatic fallback from device to cloud: the cloud is only ever
// used after the user presses the button.

import { initializeApp } from 'firebase/app';
import { GoogleAIBackend, InferenceMode, Schema, getAI, getGenerativeModel } from 'firebase/ai';
// Both come from the build: the extension and the hosted demo prove themselves
// to App Check in different ways (see appcheck.ext.js and appcheck.web.js).
import { cloudReady, startAppCheck } from 'guardian-appcheck';
import { firebaseConfig } from 'guardian-config';

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

const ON_DEVICE_PARAMS = {
  createOptions: {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  },
};

/** 'available' | 'downloadable' | 'downloading' | 'unavailable' */
export async function deviceModelStatus() {
  if (!('LanguageModel' in self)) return 'unavailable';
  try {
    return await self.LanguageModel.availability(ON_DEVICE_PARAMS.createOptions);
  } catch {
    return 'unavailable';
  }
}

/** Starts the one-time model download. Needs a user gesture. */
export async function downloadDeviceModel(onProgress) {
  const model = getGenerativeModel(onDevice(), {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: ON_DEVICE_PARAMS,
  });
  await model.initializeDeviceModel((fraction) => onProgress(Math.round(fraction * 100)));
}

/**
 * Streams a short explanation from the on-device model.
 * @returns {{text: string, ms: number, source: string}}
 */
export async function explainOnDevice(prompt, onText) {
  const model = getGenerativeModel(onDevice(), {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: ON_DEVICE_PARAMS,
  });
  const started = performance.now();
  const result = await model.generateContentStream(prompt);
  let text = '';
  for await (const chunk of result.stream) {
    text += chunk.text();
    onText(text);
  }
  const response = await result.response;
  return {
    text: text.trim(),
    ms: Math.round(performance.now() - started),
    source: response.inferenceSource || 'on_device',
  };
}

const DEEP_SCHEMA = Schema.object({
  properties: {
    summary: Schema.string(),
    ifYouConfirm: Schema.string(),
    pattern: Schema.string(),
    checks: Schema.array({ items: Schema.string() }),
  },
});

/**
 * Deeper, structured analysis from the cloud model. Call only after consent.
 * @returns {{data: object, ms: number, source: string}}
 */
export async function analyzeInCloud(prompt) {
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
  const result = await model.generateContent(prompt);
  const data = JSON.parse(result.response.text());
  return {
    data,
    ms: Math.round(performance.now() - started),
    source: result.response.inferenceSource || 'in_cloud',
  };
}
