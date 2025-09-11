// Delegates to single source of truth at ../NudeShared/vitest.config.mjs
// Kept for DX so running `vitest` inside NudeAdmin still works via dynamic import.
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shared = path.resolve(__dirname, '../NudeShared/vitest.config.mjs');
export { default } from shared;
