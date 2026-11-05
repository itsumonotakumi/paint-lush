import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/paint-lush/',
  build: { target: 'es2022', sourcemap: false },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
