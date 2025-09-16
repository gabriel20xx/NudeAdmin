// Delegates to single source of truth at ../NudeShared/vitest.config.mjs
// Kept for DX so running `vitest` inside NudeAdmin still works via dynamic import.
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharedPath = path.resolve(__dirname, '../NudeShared/vitest.config.mjs');
// Re-export the actual config by importing it (ESM safest approach for flat config tooling & parsers)
const sharedConfig = await import(sharedPath);
export default sharedConfig.default || sharedConfig;
