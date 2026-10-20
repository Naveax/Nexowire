/**
 * Prints optional DO/WSS and noisy-neighbor hypothetical risk cases.
 * No network calls, no cloud credential use, no file writes.
 */
import {estimateS5DurableObject,S5_DO_EXAMPLES}
  from '../src/ops/scale-s5-durable-object-cost.js';
import {analyzeS5Fairness} from '../src/ops/scale-s5-fairness-analysis.js';
const scenarios=Object.entries(S5_DO_EXAMPLES).map(([name,assumptions])=>({
  name,projection:estimateS5DurableObject(assumptions),
}));
const fairness=analyzeS5Fairness([
  {attempted:600,reserved:600,transportDenied:0,quotaDenied:0},
  {attempted:20,reserved:0,transportDenied:20,quotaDenied:0},
]);
process.stdout.write(JSON.stringify({
  kind:'S5_SYNTHETIC_RISK_SCENARIOS_NOT_HOSTED_MEASUREMENTS',
  providerPricingChecked:'2026-10-18',
  actualCloudflareAccountMetered:false,
  actualCustomerFairnessMetered:false,
  actual24hSoak:false,
  sharedIngressStarvation:fairness,optionalDurableObject:scenarios,
},null,2)+'\n');
