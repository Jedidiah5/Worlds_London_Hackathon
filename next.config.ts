import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev overlay badge sits bottom-left, on top of the key indicator.
  // This is demoed from `next dev`, so it has to go. Compile and runtime
  // errors are still surfaced.
  devIndicators: false,
};

export default nextConfig;
