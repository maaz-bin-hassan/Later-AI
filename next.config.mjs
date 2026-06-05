/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Allow Server Actions to receive the file metadata payloads we send.
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
