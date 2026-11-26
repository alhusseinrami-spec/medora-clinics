import type { MetadataRoute } from 'next';
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'MEDORA CLINICS', short_name: 'MEDORA', description: 'Smart healthcare. Simplified.', id: '/', start_url: '/', scope: '/',
    display: 'standalone', orientation: 'portrait', background_color: '#F5F7F6', theme_color: '#115D62',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
    shortcuts: [{ name: 'My appointments', url: '/portal/appointments' }, { name: 'Dashboard', url: '/' }],
  };
}
