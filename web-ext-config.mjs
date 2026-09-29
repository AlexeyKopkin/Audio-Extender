// Settings for `npx web-ext` (lint, run). The Firefox package is built into dist/firefox first:
//   npm run build:firefox && npx web-ext lint
export default {
  sourceDir: './dist/firefox',
  artifactsDir: './web-ext-artifacts',
};
