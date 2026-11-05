import { defineConfig } from 'vitest/config';
import { swPlugin } from './src/sw/precache.ts';

export default defineConfig({
  base: '/paint-lush/',
  plugins: [swPlugin()],
  build: { target: 'es2022', sourcemap: false },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
