/** @type {import('next').NextConfig} */
const API = process.env.API_URL || 'http://localhost:4000';
export default {
  reactStrictMode: true,
  // Same-origin API calls: the browser talks to /api on the web host; Next forwards to the API service.
  async rewrites() { return [{ source: '/api/:path*', destination: `${API}/api/:path*` }]; },
};
