import type { NextConfig } from "next";

// A conservative Content-Security-Policy. Next injects inline styles and (in
// dev) inline/eval scripts, so scripts and styles allow 'unsafe-inline'.
// `frame-ancestors` allows the app to run as a Telegram Mini App (embedded by
// Telegram Web) while still blocking every other site — clickjacking stays shut.
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
  "object-src 'none'",
  // blob: covers the local preview of a photo the user just picked and the
  // playback of a voice note still in the recorder — neither has a URL on this
  // origin until the upload lands.
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  // telegram.org hosts the Mini App SDK (telegram-web-app.js) loaded in <head>.
  `script-src 'self' 'unsafe-inline' https://telegram.org${process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""}`,
  "connect-src 'self'",
].join("; ");

// No X-Frame-Options: it only speaks DENY/SAMEORIGIN and would override the CSP
// allow-list above, breaking the Telegram Mini App embed. `frame-ancestors`
// carries the framing policy instead.
const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// node:sqlite is a Node built-in — it must NOT be listed in serverExternalPackages,
// or the bundler tries to require() it from an ESM chunk and fails at runtime.
const nextConfig: NextConfig = {
  output: "standalone",
  // In dev, Next blocks cross-site requests to /_next/* and answers
  // "Unauthorized" (see server/lib/router-utils/block-cross-site-dev). The
  // Mini App is served through a cloudflared tunnel, so its host is cross-site
  // to the dev server and HMR/devtools were being rejected on every poll.
  // Dev-only; the production build ignores this list.
  allowedDevOrigins: ["*.trycloudflare.com"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // User-uploaded bytes get their own, far stricter policy. A config entry
      // is the only way to set it: headers declared here override whatever a
      // route handler returns, so the app-wide CSP above would otherwise win
      // on these responses too.
      {
        source: "/api/files/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
        ],
      },
    ];
  },
};

export default nextConfig;
