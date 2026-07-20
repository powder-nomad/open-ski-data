/**
 * Next.js config for Cloudflare Pages.
 *
 * `@cloudflare/next-on-pages` reads this; route handlers must opt
 * into the edge runtime (`export const runtime = "edge"`) to deploy
 * on Pages. App router pages can stay on the default node runtime
 * for build, since SSR happens at the edge worker layer.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_SHA:
      process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7) ?? "dev",
  },
  reactStrictMode: true,
  images: {
    // No image transforms needed — we render Google Maps tiles + a
    // few static assets only.
    unoptimized: true,
  },
  eslint: {
    // Editor.tsx is ported verbatim from ski-platform; lint warnings
    // there are out of scope for the editor extraction. Re-enable
    // once the editor is stabilized on this branch.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
