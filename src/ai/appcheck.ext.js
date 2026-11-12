// App Check for the extension build.
//
// Firebase AI Logic requires App Check. An extension page cannot run
// reCAPTCHA (Manifest V3 allows no remote scripts), so the debug provider is
// used: the token from src/config.js is registered in the Firebase console.

import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
import * as config from 'guardian-config';

/** True when cloud requests can be attested. */
export const cloudReady = Boolean(config.appCheckDebugToken);

export function startAppCheck(app) {
  if (!cloudReady) return;
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = config.appCheckDebugToken;
  initializeAppCheck(app, {
    provider: new CustomProvider({
      getToken: async () => {
        throw new Error('App Check: debug token only');
      },
    }),
    isTokenAutoRefreshEnabled: false,
  });
}
