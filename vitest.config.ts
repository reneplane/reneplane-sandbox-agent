import { defineConfig } from 'vitest/config';

// The agent's own tests. templates/ holds codebank products with their own test suites (run by
// `codebank check` inside a generated codebank, and by .github/workflows/templates.yml), not these.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
