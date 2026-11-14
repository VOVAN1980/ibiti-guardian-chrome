// Gemini Nano, as Chrome exposes it. Shared by the review window (through
// engine.js) and the toolbar panel, so both ask Chrome the same question.

export const ON_DEVICE_PARAMS = {
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
