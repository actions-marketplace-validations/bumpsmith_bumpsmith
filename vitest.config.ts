import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/sandbox/**/*.test.ts", "test/action/**/*.test.ts"],
    exclude: ["test/fixtures/**", "runs/**", "bench/**", "node_modules/**"],
  },
});
