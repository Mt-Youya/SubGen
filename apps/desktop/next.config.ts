import type { NextConfig } from "next";

const isTauriDev = process.env.TAURI_ENV_DEBUG === "true";

const nextConfig: NextConfig = {
  transpilePackages: ["@subgen/shared"],
  output: isTauriDev ? undefined : "export",
  images: { unoptimized: true },
};

export default nextConfig;
