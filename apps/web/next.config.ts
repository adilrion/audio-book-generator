import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @app/types is a workspace package compiled to CommonJS (dist/); let Next transpile/bundle it.
  transpilePackages: ['@app/types'],
  // Monorepo root, so output tracing and workspace resolution use the pnpm workspace.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  // This app has no ESLint setup; type-checking still runs during `next build`.
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
};

export default nextConfig;
