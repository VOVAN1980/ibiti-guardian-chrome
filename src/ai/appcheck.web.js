// App Check for the hosted demo.
//
// A public web page must not carry a debug token, so the site proves itself
// with reCAPTCHA (set `recaptcha.siteKey` in src/config.js). A debug token is
// used only when the build is told to include one, for local testing.

import {
  CustomProvider,
  ReCaptchaEnterpriseProvider,
  ReCaptchaV3Provider,
  initializeAppCheck,
} from 'firebase/app-check';
import * as config from 'guardian-config';

const recaptcha = config.recaptcha && config.recaptcha.siteKey ? config.recaptcha : null;

/** True when cloud requests can be attested. */
export const cloudReady = Boolean(config.appCheckDebugToken || recaptcha);

export function startAppCheck(app) {
  if (config.appCheckDebugToken) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = config.appCheckDebugToken;
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          throw new Error('App Check: debug token only');
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });
    return;
  }
  if (!recaptcha) return;
  initializeAppCheck(app, {
    provider:
      recaptcha.enterprise === false
        ? new ReCaptchaV3Provider(recaptcha.siteKey)
        : new ReCaptchaEnterpriseProvider(recaptcha.siteKey),
    isTokenAutoRefreshEnabled: true,
  });
}
