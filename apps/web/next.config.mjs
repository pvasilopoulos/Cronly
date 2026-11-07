/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Bundle shared workspace packages (cron engine, handler catalog) for the browser.
  transpilePackages: ['@cronapp/cron', '@cronapp/handlers'],
  // The API runs as a separate service; proxy /api to it in dev so the browser
  // talks to one origin and avoids CORS during local development.
  async rewrites() {
    const api = process.env.API_PROXY_TARGET ?? 'http://localhost:3001';
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};
export default nextConfig;
