import type { NextConfig } from "next";
import { withContentNegotiation } from "nextjs-content-negotiation";

const nextConfig: NextConfig = {
  skipProxyUrlNormalize: true,
  // CI also builds this app with these options (see smoke-test.sh).
  basePath: process.env.BASE_PATH || undefined,
  trailingSlash: process.env.TRAILING_SLASH === "1",
};

export default withContentNegotiation(nextConfig, {
  patchVary: process.env.PATCH_VARY !== "0",
});
