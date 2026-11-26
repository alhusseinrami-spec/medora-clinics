/** @type {import('next').NextConfig} */
const API = process.env.API_URL || 'http://localhost:4000';
const dev = process.env.NODE_ENV !== 'production';

// Content Security Policy for every page. Next.js needs inline scripts for hydration; nothing is loaded from other sites.
// The WebSocket and the same-origin /api proxy are the only connections.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(dev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]),
];

export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // The Docker image runs the self-contained server (see deploy/).
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),
  // Same-origin API calls: the browser talks to /api on the web host; Next forwards to the API service.
  async rewrites() { return [{ source: '/api/:path*', destination: `${API}/api/:path*` }]; },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // The service worker must always be fetched fresh so updates reach installed apps.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }, { key: 'Service-Worker-Allowed', value: '/' }] },
    ];
  },
};
