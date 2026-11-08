// Cloudflare Worker: receives orders / unsubscribes from the ChromaPrint site and writes them to Airtable.
// The Airtable token lives here as a secret — it never appears in the website or on GitHub.
//
// Required settings (Worker → Settings → Variables and Secrets):
//   AIRTABLE_TOKEN  (secret)  your Airtable personal access token (data.records:write on your base)
//   AIRTABLE_BASE   (text)    appYaRAaQw8pS3ve4
//   ALLOWED_ORIGIN  (text)    your site's origin, e.g. https://yourname.github.io  (no trailing slash, no path)

// Prices are enforced HERE so a visitor can't tamper with them in the browser.
const PRODUCTS = {
  "leaf-spinner":     { name: "Leaf Spinner Fidget",                  color: "White", price: 8,  weight: 40 },
  "flex-coasters":    { name: "Flexible Grid Coasters — 1 Pack",      color: "White", price: 19, weight: 60 },
  "flex-coasters-4":  { name: "Flexible Grid Coasters — 4 Pack",      color: "White", price: 26, weight: 200 },
  "keyboard-clicker": { name: "Keyboard Clicker Fidget",              color: "White", price: 5,  weight: 25 },
  "infinity-cube":    { name: "Infinity Fidget Cube",                 color: "White", price: 8,  weight: 50 },
  "gyro-rings":       { name: "Gyro Rotating Rings",                  color: "White", price: 5,  weight: 60 },
};
// Must match SHIPPING_TIERS / PACKAGING_G in index.html. Each row: [max ounces, price].
const PACKAGING_G = 30;
const SHIPPING_TIERS = [[4, 6.5], [8, 7.5], [12, 8.5], [16, 9.5], [32, 13], [Infinity, 16]];
function shippingFor(items) {
  const grams = items.reduce((n, i) => n + PRODUCTS[i.id].weight * i.qty, 0) + PACKAGING_G;
  return SHIPPING_TIERS.find((t) => grams / 28.35 <= t[0])[1];
}
const money = (n) => "$" + n.toFixed(2);
const clip = (v, max) => String(v ?? "").trim().slice(0, max);

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
    if (req.headers.get("Origin") !== env.ALLOWED_ORIGIN) return reply({ error: "Forbidden" }, 403);

    let body;
    try { body = await req.json(); } catch { return reply({ error: "Invalid request." }, 400); }

    const path = new URL(req.url).pathname;
    const emailOk = (e) => /^[^@\s]{1,100}@[^@\s]{1,100}\.[^@\s]{2,}$/.test(e);

    try {
      if (path === "/order") {
        const c = body.customer || {};
        const customer = {
          name: clip(c.name, 100), email: clip(c.email, 150), address: clip(c.address, 200),
          apt: clip(c.apt, 100), city: clip(c.city, 100), state: clip(c.state, 50),
          zip: clip(c.zip, 20), notes: clip(c.notes, 1000), country: "United States",
        };
        if (!customer.name || !customer.address || !customer.city || !customer.state || !customer.zip || !emailOk(customer.email))
          return reply({ error: "Please complete all required fields with a valid email." }, 400);

        const raw = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
        const items = raw
          .map((i) => ({ p: PRODUCTS[i.id], id: i.id, qty: Math.floor(Number(i.qty)) }))
          .filter((i) => i.p && i.qty >= 1 && i.qty <= 20)
          .map((i) => ({ id: i.id, name: i.p.name, color: i.p.color, price: i.p.price, qty: i.qty }));
        if (!items.length) return reply({ error: "Your cart is empty." }, 400);

        const subtotal = items.reduce((n, i) => n + i.price * i.qty, 0);
        const shipping = shippingFor(items);
        const total = subtotal + shipping;
        const number = "CP-" + Date.now().toString(36).toUpperCase().slice(-6);
        const lines = items.map((i) => `${i.qty} × ${i.name} (${i.color}) — ${money(i.price * i.qty)}`).join("\n");

        await airtable(env, "Orders", {
          "Order Number": number,
          "Placed At": new Date().toISOString(),
          "Name": customer.name, "Email": customer.email, "Address": customer.address,
          "Apartment": customer.apt, "City": customer.city, "State": customer.state, "ZIP": customer.zip,
          "Items": lines, "Subtotal": subtotal, "Shipping": shipping, "Total": total,
          "Notes": customer.notes, "Status": "New - awaiting payment",
        });
        return reply({ ok: true, order: { number, customer, items, subtotal, shipping, total } });
      }

      if (path === "/unsubscribe") {
        const email = clip(body.email, 150);
        if (!emailOk(email)) return reply({ error: "Please enter a valid email." }, 400);
        await airtable(env, "Unsubscribes", {
          "Email": email, "Reason": clip(body.reason, 1000), "Requested At": new Date().toISOString(),
        });
        return reply({ ok: true });
      }

      return reply({ error: "Not found" }, 404);
    } catch (err) {
      return reply({ error: "Couldn't save your request. Please try again." }, 502);
    }
  },
};

async function airtable(env, table, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) throw new Error("Airtable " + res.status);
}
