/**
 * #23 QA entrypoint under test/qa/ because package.json uses
 * node --test --import tsx test/**/*.test.ts.
 * In standard sh, that glob skips top-level test/*.test.ts.
 * This importer makes both source-only suites run in hosted npm test.
 * No production Access/Broker/CAS code is imported as authorization.
 */
import '../core-effective-ui-669-negative.test.js';
import '../core-effective-native-cas-ui-gate.test.js';
