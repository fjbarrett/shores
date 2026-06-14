import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // /cdns redirects to the canonical /cdn page
      { source: "/cdns", destination: "/cdn", permanent: true },
    ];
  },
};

export default nextConfig;
