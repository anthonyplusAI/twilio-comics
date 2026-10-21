/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  async redirects() {
    return [
      {
        source: '/editor/:slug*',
        destination: '/story/:slug*',
        permanent: true,
      },
    ]
  },
}

export default nextConfig
