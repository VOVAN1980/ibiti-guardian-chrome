// Copy this file to src/config.js and fill it in.
//
// firebaseConfig: Firebase console → Project settings → Your apps → Web app.
// It is public by design (it ships in every web client).
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// App Check debug token, used by the extension build only: generate any UUID
// and register it in Firebase console → App Check → Apps → Manage debug tokens.
// It is never written into the hosted demo (build.mjs checks).
export const appCheckDebugToken = '';

// App Check for the hosted demo: the reCAPTCHA site key registered for the web
// app in Firebase console → App Check. `enterprise: false` for reCAPTCHA v3.
// Leave empty to build the demo without cloud analysis.
export const recaptcha = { siteKey: '', enterprise: true };
