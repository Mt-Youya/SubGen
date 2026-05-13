import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@subgen/shared"],
};

export default nextConfig;
