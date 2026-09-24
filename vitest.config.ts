import { defineConfig } from "vitest/config";

export default defineConfig({
  // Also transform `.cts` sources, such as the bundler loader.
  oxc: { include: /\.[cm]?tsx?$/ },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: { 100: true },
    },
  },
});
