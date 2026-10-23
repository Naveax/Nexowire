// #27 hosted CI discovery for the existing source-only QA matrix.
// npm test uses test/**/*.test.ts; root test/*.test.ts can be omitted.
// Import existing suite once; DO NOT duplicate #23 web/app.js UI tests.
import '../qa27-local-os-core-external-authority-negatives.test.js';
