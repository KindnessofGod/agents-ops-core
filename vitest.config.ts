import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/tests/**/*.test.ts"],
    environment: "node",
    // Tests are hermetic. The structural guarantee is dependency injection:
    // no module constructs its own model client, clock, or database handle.
    // See docs/TESTING.md once modules land.
    restoreMocks: true,
  },
});
