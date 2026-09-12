import js from '@eslint/js';
import tseslint from 'typescript-eslint';
// TNA Client Control Center & Assurance UI v0.1 (Volume 13): the web frontend (`apps/tna-control-center
// -web`) is a separate Vite/React/browser TypeScript project with its own `tsconfig.json` (DOM lib, JSX,
// bundler resolution) — it is not part of this repo's single Node-targeted `tsc` project, and linting it
// here would need a browser/React-aware config this pass does not add. It is checked instead via its own
// `npm run typecheck`/`npm run build` (wired into `smoke:control-center:v01`). Documented gap, not silent.
export default tseslint.config({ignores: ['dist/**', 'node_modules/**', '.npm-cache/**', 'data/**', 'apps/tna-control-center-web/**']}, js.configs.recommended, ...tseslint.configs.recommended);
