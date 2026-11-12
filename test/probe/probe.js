import { initializeApp } from 'firebase/app';
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
import { GoogleAIBackend, InferenceMode, getAI, getGenerativeModel } from 'firebase/ai';
import { appCheckDebugToken, firebaseConfig } from '../../src/config.js';

self.FIREBASE_APPCHECK_DEBUG_TOKEN = appCheckDebugToken;
const app = initializeApp(firebaseConfig);
initializeAppCheck(app, { provider: new CustomProvider({ getToken: async () => { throw new Error('debug only'); } }), isTokenAutoRefreshEnabled: false });
const ai = getAI(app, { backend: new GoogleAIBackend() });
const out = (window.__probe = {});
const models = new URLSearchParams(location.search).get('models').split(',');
for (const name of models) {
  try {
    const params = name === 'default' ? { mode: InferenceMode.ONLY_IN_CLOUD } : { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model: name } };
    const r = await getGenerativeModel(ai, params).generateContent('Reply with the single word: ok');
    out[name] = `OK ${r.response.text().trim().slice(0, 40)}`;
  } catch (e) {
    out[name] = `ERR ${String(e.message).replace(/^.*?\[(\d+) \]/, '[$1]').slice(0, 170)}`;
  }
}
out.done = true;
