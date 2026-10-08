/**
 * Test helpers: a local x402 merchant (v2, or v1 per route with `x402Version: 1`) (resource server + facilitator) that verifies signatures without any chain.
 * Routes can behave honestly or like an attacker, so integrations can be tested end to end offline.
 */
export { startMockServer, type MockServer, type Route } from "./mockMerchant.js";
