import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __MEETNOTES_WEB_ORIGINS__: JSON.stringify(['https://panel.example.com', 'http://localhost:5174']) },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
