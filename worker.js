// Cloudflare Worker for ChromaPrint.
//   POST /checkout        -> creates a Stripe Checkout Session (prices are set HERE, not in the browser) and returns its URL
//   POST /stripe-webhook  -> Stripe tells us a payment succeeded; we save the paid order to Airtable
//   POST /unsubscribe     -> saves an unsubscribe request to Airtable
//
// Settings (Worker -> Settings -> Variables and Secrets):
//   STRIPE_SECRET_KEY      (secret) sk_test_... while testing, sk_live_... when you go live
//   STRIPE_WEBHOOK_SECRET  (secret) whsec_... from the Stripe webhook you create (see README steps in chat)
//   AIRTABLE_TOKEN         (secret) Airtable personal access token (data.records:write on your base)
//   AIRTABLE_BASE          (text)   appYaRAaQw8pS3ve4
//   ALLOWED_ORIGIN         (text)   your site's origin, e.g. https://chroma-print.com  (no trailing slash, no path)

const PRODUCTS = {
  "leaf-spinner":     { name: "Leaf Spinner Fidget",             color: "White", price: 8,  weight: 40 },
  "flex-coasters":    { name: "Flexible Grid Coasters — 1 Pack", color: "White", price: 19, weight: 60 },
  "flex-coasters-4":  { name: "Flexible Grid Coasters — 4 Pack", color: "White", price: 26, weight: 200 },
  "keyboard-clicker": { name: "Keyboard Clicker Fidget",         color: "White", price: 5,  weight: 25 },
  "infinity-cube":    { name: "Infinity Fidget Cube",            color: "White", price: 8,  weight: 50 },
  "gyro-rings":       { name: "Gyro Rotating Rings",             color: "White", price: 5,  weight: 60 },
};
// Must match SHIPPING_TIERS / PACKAGING_G in index.html. Each row: [max ounces, price].
const PACKAGING_G = 30;
const SHIPPING_TIERS = [[4, 6.5], [8, 7.5], [12, 8.5], [16, 9.5], [32, 13], [Infinity, 16]];
function shippingFor(items) {
  const grams = items.reduce((n, i) => n + PRODUCTS[i.id].weight * i.qty, 0) + PACKAGING_G;
  return SHIPPING_TIERS.find((t) => grams / 28.35 <= t[0])[1];
}
const money = (n) => "$" + n.toFixed(2);
const cents = (n) => Math.round(n * 100);
const clip = (v, max) => String(v ?? "").trim().slice(0, max);

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;

    // Stripe calls this directly (no browser Origin), so it is checked by signature instead.
    if (path === "/stripe-webhook") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleWebhook(req, env);
    }

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

    try {
      if (path === "/checkout") {
        const raw = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
        const items = raw
          .map((i) => ({ p: PRODUCTS[i.id], id: i.id, qty: Math.floor(Number(i.qty)) }))
          .filter((i) => i.p && i.qty >= 1 && i.qty <= 20)
          .map((i) => ({ id: i.id, name: i.p.name, color: i.p.color, price: i.p.price, qty: i.qty }));
        if (!items.length) return reply({ error: "Your cart is empty." }, 400);

        // Where Stripe sends the customer back to (must be on your own site).
        const ret = clip(body.returnUrl, 300);
        if (!ret.startsWith(env.ALLOWED_ORIGIN)) return reply({ error: "Invalid return address." }, 400);
        const base = ret.split("#")[0];

        const subtotal = items.reduce((n, i) => n + i.price * i.qty, 0);
        const shipping = shippingFor(items);
        const total = subtotal + shipping;
        const number = "CP-" + Date.now().toString(36).toUpperCase().slice(-6);

        const f = new URLSearchParams();
        f.set("mode", "payment");
        f.set("ui_mode", "hosted_page");
        f.set("success_url", `${base}#/success?session_id={CHECKOUT_SESSION_ID}`);
        f.set("cancel_url", `${base}#/checkout`);
        items.forEach((i, n) => {
          f.set(`line_items[${n}][quantity]`, String(i.qty));
          f.set(`line_items[${n}][price_data][currency]`, "usd");
          f.set(`line_items[${n}][price_data][unit_amount]`, String(cents(i.price)));
          f.set(`line_items[${n}][price_data][product_data][name]`, `${i.name} (${i.color})`);
        });
        f.set("shipping_address_collection[allowed_countries][0]", "US");
        f.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
        f.set("shipping_options[0][shipping_rate_data][display_name]", "Shipping (tracked, 2-4 day print time)");
        f.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(cents(shipping)));
        f.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
        f.set("billing_address_collection", "auto");
        f.set("phone_number_collection[enabled]", "true");
        f.set("allow_promotion_codes", "true");
        f.set("consent_collection[promotions]", "auto");
        f.set("submit_type", "auto");
        f.set("origin_context", "web");
        f.set("client_reference_id", number);
        f.set("metadata[order_number]", number);
        f.set("metadata[notes]", clip(body.notes, 450));

        const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Stripe-Version": "2026-10-28.endive",
          },
          body: f,
        });
        const session = await res.json();
        if (!res.ok || !session.url) {
          console.error("Stripe error", JSON.stringify(session.error || session));
          return reply({ error: "Couldn't start checkout. Please try again." }, 502);
        }
        return reply({ ok: true, url: session.url, order: { number, items, subtotal, shipping, total } });
      }

      if (path === "/unsubscribe") {
        const email = clip(body.email, 150);
        if (!/^[^@\s]{1,100}@[^@\s]{1,100}\.[^@\s]{2,}$/.test(email)) return reply({ error: "Please enter a valid email." }, 400);
        await airtable(env, "Unsubscribes", {
          "Email": email, "Reason": clip(body.reason, 1000), "Requested At": new Date().toISOString(),
        });
        return reply({ ok: true });
      }

      return reply({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return reply({ error: "Couldn't complete your request. Please try again." }, 502);
    }
  },
};

/* ---------------- Stripe webhook ---------------- */
async function handleWebhook(req, env) {
  const raw = await req.text();
  if (!(await verifyStripe(raw, req.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET))) {
    return new Response("Bad signature", { status: 400 });
  }
  const event = JSON.parse(raw);
  if (event.type !== "checkout.session.completed") return new Response("ignored", { status: 200 });

  const id = event.data.object.id;
  // Re-fetch from Stripe so we get the line items and trust Stripe's data, not just the webhook body.
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}?expand[]=line_items`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": "2026-10-28.endive" },
  });
  if (!res.ok) return new Response("Stripe lookup failed", { status: 500 });
  const s = await res.json();
  if (s.payment_status !== "paid") return new Response("not paid yet", { status: 200 });

  const ship = s.collected_information?.shipping_details || s.shipping_details || {};
  const a = ship.address || s.customer_details?.address || {};
  const lines = (s.line_items?.data || []).map((l) => `${l.quantity} × ${l.description} — ${money(l.amount_subtotal / 100)}`).join("\n");

  await airtable(env, "Orders", {
    "Order Number": s.metadata?.order_number || s.client_reference_id || s.id,
    "Placed At": new Date().toISOString(),
    "Name": ship.name || s.customer_details?.name || "",
    "Email": s.customer_details?.email || "",
    "Phone": s.customer_details?.phone || "",
    "Address": a.line1 || "",
    "Apartment": a.line2 || "",
    "City": a.city || "",
    "State": a.state || "",
    "ZIP": a.postal_code || "",
    "Items": lines,
    "Subtotal": (s.amount_subtotal || 0) / 100,
    "Shipping": (s.total_details?.amount_shipping || 0) / 100,
    "Discount": (s.total_details?.amount_discount || 0) / 100,
    "Total": (s.amount_total || 0) / 100,
    "Notes": s.metadata?.notes || "",
    "Status": "Paid - ready to print",
    "Stripe Session": s.id,
  });
  return new Response("ok", { status: 200 });
}

async function verifyStripe(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${payload}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.length === parts.v1.length && hex.split("").reduce((d, c, i) => d | (c.charCodeAt(0) ^ parts.v1.charCodeAt(i)), 0) === 0;
}

async function airtable(env, table, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) throw new Error("Airtable " + res.status + " " + (await res.text()));
}
