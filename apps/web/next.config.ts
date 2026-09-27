import path from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

export default function config(phase: string): NextConfig {
  return {
    reactStrictMode: true,
    // `next dev` and `next build` write to different folders, so a production build (or `pnpm test`
    // in CI) never overwrites the files of a running dev server ("Cannot find module './377.js'").
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
    // @app/types is a workspace package compiled to CommonJS (dist/); let Next transpile/bundle it.
    transpilePackages: ['@app/types'],
    // Monorepo root, so output tracing and workspace resolution use the pnpm workspace.
    outputFileTracingRoot: path.join(__dirname, '..', '..'),
    // This app has no ESLint setup; type-checking still runs during `next build`.
    eslint: { ignoreDuringBuilds: true },
    poweredByHeader: false,
    // The dev-tools badge sits bottom-left by default, on top of the sidebar's power widget.
    devIndicators: { position: 'bottom-right' },
  };
}
