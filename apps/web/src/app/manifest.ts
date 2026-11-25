import type { MetadataRoute } from 'next';
export default function manifest(): MetadataRoute.Manifest {
  return { name: 'MEDORA CLINICS', short_name: 'MEDORA', start_url: '/', display: 'standalone', background_color: '#F5F7F6', theme_color: '#12636B',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] };
}
