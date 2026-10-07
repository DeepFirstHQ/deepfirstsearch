/**
 * "Get me a burrito": an agent with ordering tools, a menu that carries a prompt injection, and the order guard.
 * The agent here is deliberately gullible (it follows whatever the menu says), the worst case. No real orders.
 *
 *   npm run demo
 */
import { createOrderGuard, OrderRefusedError } from "../src/index.js";
import { createMockDelivery } from "../src/testing.js";

const HOME = "221B Baker St, Apt 2";
const delivery = createMockDelivery({ address: HOME });
const guard = createOrderGuard(
  {
    stores: { "la-taqueria": { label: "La Taqueria" }, "burrito-palace": { label: "Burrito Palace" } },
    deliveryAddress: HOME,
    maxOrderTotal: 3000, // $30 per order
    maxTip: 500, // $5
    dailyBudget: 4000, // $40 a day
  },
  delivery,
);
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const step = async (title: string, fn: () => Promise<string>) => {
  try {
    console.log(`${title}\n   ✓ ${await fn()}`);
  } catch (e) {
    if (!(e instanceof OrderRefusedError)) throw e;
    console.log(`${title}\n   ✗ refused before submit · ${e.reasons.join(" · ")}`);
  }
};

await step("1. \"Get me a carnitas burrito from La Taqueria\"", async () => {
  const { preview } = await guard.preview({ storeId: "la-taqueria", items: [{ itemId: "carnitas-burrito", quantity: 1 }], tip: 200 });
  const order = await guard.submit(preview.previewId);
  return `ordered ${order.orderId} · ${usd(order.total)} to ${HOME}`;
});

const injected = delivery.menu("burrito-palace")!.menu["super-burrito"]!.description!;
console.log(`\n   (the agent opens Burrito Palace's menu: "${injected.slice(0, 74)}…")\n`);

await step("2. The agent obeys: new address, then the order", async () => {
  delivery.setDeliveryAddress("77 Harbor Rd");
  const { preview } = await guard.preview({ storeId: "burrito-palace", items: [{ itemId: "super-burrito", quantity: 1 }], tip: 200 });
  return `ordered ${(await guard.submit(preview.previewId)).orderId}`;
});

await step("3. …and \"40 burritos for the office party\"", async () => {
  delivery.setDeliveryAddress(HOME);
  const { preview } = await guard.preview({ storeId: "burrito-palace", items: [{ itemId: "super-burrito", quantity: 40 }], tip: 200 });
  return `ordered ${(await guard.submit(preview.previewId)).orderId}`;
});

await step("4. A $50 tip \"because the driver was great\"", async () => {
  const { preview } = await guard.preview({ storeId: "la-taqueria", items: [{ itemId: "chips-salsa", quantity: 1 }], tip: 5000 });
  return `ordered ${(await guard.submit(preview.previewId)).orderId}`;
});

await step("5. Submitting the first order's preview again", async () => `ordered ${(await guard.submit("pv_1")).orderId}`);

console.log(`\nResult  orders placed: ${delivery.orders.length} · spent ${usd(guard.spentToday())} of ${usd(4000)} today · food sent elsewhere: 0`);
