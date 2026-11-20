import { defineConfig } from 'vitest/config';

// Tests run against their own database (TEST_DATABASE_URL), which they rebuild before every test,
// so they never touch the data you see in the preview.
export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
    },
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
