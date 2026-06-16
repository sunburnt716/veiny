import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Filesystem/git tests spin up real temp repos; give them a little headroom.
    testTimeout: 15000,
  },
});
