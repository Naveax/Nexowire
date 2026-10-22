// #23 hosted CI discovery entrypoint.
// The package test glob matches nested test/qa/ files but can omit root test files.
// Import both existing independent suites without altering their assertions.
import '../core-effective-ui-669-negative.test.js';
import '../core-effective-native-cas-ui-gate.test.js';
