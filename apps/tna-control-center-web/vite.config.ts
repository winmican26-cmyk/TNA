import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// TNA Client Control Center & Assurance UI v0.1 (Volume 13). `server.proxy` exists only for local `vite
// dev` convenience (talking to the real BFF on its own port without a CORS dance during development) —
// production serving is a static build behind the Control Center's own reverse proxy.
//
// Build-order item 13 (source-map policy — decided and documented, not left implicit): DISABLED for the
// packaged production build. This is not because a source map could leak a secret — `secret-audit.test.ts`
// already proves no token/password/session-shaped value exists anywhere in this frontend's source or
// bundle, and that guarantee holds regardless of source-map policy. Disabling is a minor, honestly-labeled
// reconnaissance-reduction step (unminified original source layout is otherwise trivially reconstructable
// from a public map), not a claim that maps themselves are a security boundary.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:4719' } },
  build: { outDir: 'dist', sourcemap: false },
});
