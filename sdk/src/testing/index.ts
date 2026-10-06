/**
 * Test helpers: a local x402 v2 merchant (resource server + facilitator) that verifies signatures without any chain.
 * Routes can behave honestly or like an attacker, so integrations can be tested end to end offline.
 */
export { startMockServer, type MockServer, type Route } from "./mockMerchant.js";
