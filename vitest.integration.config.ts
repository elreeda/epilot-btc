import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["server/test/**/*.integration.test.ts"],
    fileParallelism: false,
  },
});
