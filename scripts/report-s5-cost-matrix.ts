import {projectS5Matrix} from '../src/ops/scale-s5-cost-envelope.js';
process.stdout.write(JSON.stringify({generatedAt:new Date().toISOString(),
  source:'assumptions NOT actual Cloudflare bill or production throughput',
  pricesAsOf:'2026-10-18',scenarios:projectS5Matrix()},null,2)+'\n');
