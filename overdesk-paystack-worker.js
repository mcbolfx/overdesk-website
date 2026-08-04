/* ============================================================
   Overdesk — Paystack Webhook Handler (Cloudflare Worker)
   ============================================================
   What this does now (v2 — Gumroad shadow-purchase flow):
   1. Receives a webhook POST from Paystack every time a payment event happens.
   2. Verifies the request is genuinely from Paystack (signature check).
   3. If it's a real successful charge:
        a. Calls the Gumroad API to create a single-use, 100%-off discount
           code scoped to the product that was bought.
        b. Emails the buyer a Gumroad checkout link with that code applied.
        c. The buyer clicks it, completes a genuine $0 Gumroad "purchase"
           (no card needed since it's fully discounted), and Gumroad
           AUTOMATICALLY issues them a real, valid license key + delivers
           the download — exactly like any normal Gumroad sale.

   Why this approach: the Overdesk app validates license keys by calling
   Gumroad's own verify API directly. Gumroad has no way to generate a
   "real" key without an actual Gumroad sale happening — so instead of
   trying to fake one, this makes a genuine (free) one. No app code changes
   needed anywhere; Gumroad does the licensing and delivery exactly as it
   already does for normal customers.

   ============================================================
   DEPLOYMENT — Cloudflare Dashboard steps:
   ============================================================
   1. Go to Cloudflare Dashboard → Workers & Pages → Create → Create Worker.
   2. Name it (e.g. "overdesk-paystack-webhook"), deploy the default
      template, then click "Edit code" and replace everything with this file.
   3. Click Deploy.
   4. Go to Settings → Variables and Secrets on this Worker, and add:
        PAYSTACK_SECRET_KEY   = your Paystack SECRET key (sk_live_... or sk_test_...)
        RESEND_API_KEY        = your Resend API key
        FROM_EMAIL            = a verified sender, e.g. support@overdesk.store
        GUMROAD_ACCESS_TOKEN  = your Gumroad API access token
                                 (Gumroad → Settings → Advanced → Applications)
      Mark PAYSTACK_SECRET_KEY, RESEND_API_KEY, and GUMROAD_ACCESS_TOKEN as
      "Encrypt" / secret.
   5. Copy the Worker's URL (looks like https://overdesk-paystack-webhook.YOURNAME.workers.dev)
   6. In your Paystack Dashboard → Settings → API Keys & Webhooks, set
      "Webhook URL" to that Worker URL, and save.
   7. Fill in the bundle's Gumroad product ID + permalink below once you
      have it (marked TODO) — everything else is already filled in from
      the IDs you provided.
   ============================================================ */

// ---- CONFIG: Paystack product key → Gumroad product info ----
const GUMROAD_PRODUCTS = {
  app:      { id: 'P3VOJBoRd4rVh2dHSSv1bg==', permalink: 'app' },       // Overdesk
  app2:     { id: 'ILe-vFDDL-fYyDeKroOQXw==', permalink: 'app2' },      // Overdesk Nexus
  app3:     { id: 'IuGRgU5DfICDDM1w7-eY7Q==', permalink: 'app3' },      // Overdesk Checklist
  everyone: { id: 'njBrop7enJxgaZWr4Y7-dQ==', permalink: 'everyone' },  // Overdesk — Everyone Edition
  // TODO: add the bundle's Gumroad product ID + permalink once available
  // bundle: { id: 'REPLACE-ME', permalink: 'suite' },
};

const PRODUCT_NAMES = {
  app: 'Overdesk',
  app2: 'Overdesk Nexus',
  app3: 'Overdesk Checklist',
  bundle: 'Overdesk Full Suite (Bundle)',
  everyone: 'Overdesk Checklist — Everyone Edition'
};

const GUMROAD_STORE_BASE = 'https://overdesk.gumroad.com/l';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get('x-paystack-signature');

    // ---- 1. Verify the webhook is genuinely from Paystack ----
    const isValid = await verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY);
    if (!isValid) {
      return new Response('Invalid signature', { status: 401 });
    }

    const event = JSON.parse(rawBody);

    // ---- 2. Only act on genuinely successful charges ----
    if (event.event !== 'charge.success') {
      return new Response('OK (ignored)', { status: 200 });
    }

    const data = event.data;
    const email = data.customer && data.customer.email;
    const productKey = data.metadata && data.metadata.product;
    const productName = PRODUCT_NAMES[productKey] || 'Overdesk';
    const gumroadProduct = GUMROAD_PRODUCTS[productKey];

    if (!email || !gumroadProduct) {
      // Unknown product (e.g. bundle before its Gumroad ID is filled in) or
      // missing email. Still return 200 so Paystack doesn't keep retrying —
      // but this case is worth checking manually if it happens.
      return new Response('OK (missing product mapping or email)', { status: 200 });
    }

    // ---- 3. Create a single-use 100%-off Gumroad discount code ----
    let claimUrl;
    try {
      const code = await createGumroadOfferCode(env, gumroadProduct.id, data.reference);
      claimUrl = `${GUMROAD_STORE_BASE}/${gumroadProduct.permalink}/${code}`;
    } catch (err) {
      // If Gumroad's API call fails for any reason, we still acknowledge
      // the webhook (so Paystack doesn't retry forever) but this is worth
      // monitoring — the buyer paid but didn't get their claim link.
      return new Response('OK (Gumroad offer code creation failed: ' + err.message + ')', { status: 200 });
    }

    // ---- 4. Email the buyer their claim link ----
    await sendClaimEmail(env, email, productName, claimUrl);

    return new Response('OK', { status: 200 });
  }
};

async function verifyPaystackSignature(rawBody, signature, secretKey) {
  if (!signature || !secretKey) return false;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secretKey);
  const msgData = encoder.encode(rawBody);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const computedHex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return computedHex === signature;
}

async function createGumroadOfferCode(env, gumroadProductId, paystackReference) {
  // Build a short, unique, alphanumeric-only code (Gumroad requires letters/numbers only)
  const codeName = 'PS' + paystackReference.replace(/[^a-zA-Z0-9]/g, '').slice(-10).toUpperCase();

  const params = new URLSearchParams({
    access_token: env.GUMROAD_ACCESS_TOKEN,
    name: codeName,
    percent_off: '100',
    max_purchase_count: '1'
  });

  const res = await fetch(
    `https://api.gumroad.com/v2/products/${gumroadProductId}/offer_codes`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    }
  );

  const json = await res.json();
  if (!json.success) {
    throw new Error(json.message || 'Unknown Gumroad API error');
  }

  // NOTE: depending on Gumroad's current API response shape, the actual
  // code string may be at json.offer_code.name — double check this against
  // a live test call and adjust if needed.
  return (json.offer_code && json.offer_code.name) || codeName;
}

async function sendClaimEmail(env, toEmail, productName, claimUrl) {
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="color:#0c0c0c;">Thanks for your purchase!</h2>
      <p style="color:#333;line-height:1.6;">
        Your payment for <strong>${productName}</strong> was successful.
        Click below to claim your copy — it's already paid for, so this
        final step is free and takes a few seconds.
      </p>
      <p style="margin:24px 0;">
        <a href="${claimUrl}" style="background:#7c3aed;color:#fff;padding:12px 24px;
           border-radius:999px;text-decoration:none;font-weight:700;display:inline-block;">
          Claim ${productName}
        </a>
      </p>
      <p style="color:#888;font-size:13px;">
        This will take you to a free checkout page (your purchase already covers it) —
        complete it and you'll get your license key and download instantly.
      </p>
      <p style="color:#888;font-size:13px;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        ${claimUrl}
      </p>
      <p style="color:#888;font-size:13px;">
        Questions? Just reply to this email.
      </p>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: toEmail,
      subject: `Claim your ${productName}`,
      html: html
    })
  });
}
