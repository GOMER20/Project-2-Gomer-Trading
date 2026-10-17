import path from 'node:path';
import type { NextConfig } from 'next';

// DESKTOP_BUILD=1 produces a static export (./out) that the API serves itself
// inside the Gomer desktop app. See desktop/scripts/stage.mjs.
const desktop = process.env.DESKTOP_BUILD === '1';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The lockfile lives at the monorepo root, one level up.
  turbopack: { root: path.join(__dirname, '..') },
  ...(desktop
    ? { output: 'export' as const }
    : {
        async headers() {
          return [
            {
              source: '/:path*',
              headers: [
                { key: 'X-Frame-Options', value: 'DENY' },
                { key: 'X-Content-Type-Options', value: 'nosniff' },
                { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
