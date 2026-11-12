// Builds the unpacked extension into dist/extension.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

// GUARDIAN_OUT lets tests build elsewhere, so a copy loaded in Chrome from
// dist/extension is not replaced in the middle of someone's session.
const out = process.env.GUARDIAN_OUT || 'dist/extension';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp('extension', out, { recursive: true });

const common = { bundle: true, target: 'chrome139', logLevel: 'info', legalComments: 'none' };

// Content scripts are classic scripts: one self-contained file each.
await build({ ...common, entryPoints: ['src/inpage.js', 'src/bridge.js'], format: 'iife', outdir: out });
// The service worker and extension pages are ES modules.
await build({ ...common, entryPoints: ['src/background.js', 'src/review.js'], format: 'esm', outdir: out });
