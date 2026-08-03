/* ============================================================
   Overdesk — Currency Detection + Paystack Checkout (Nigeria)
   ============================================================
   What this does:
   1. Detects if the visitor is in Nigeria (client-side geo-IP lookup, cached).
   2. If Nigerian: swaps displayed prices from USD to NGN (fixed rate below),
      and swaps "Purchase" buttons to open a currency-preview + checkout flow
      via Paystack, instead of linking straight to Gumroad.
   3. Everyone else: site behaves exactly as before (Gumroad links untouched).
   4. Paystack's own script is only loaded the moment someone actually clicks
      a purchase button — not proactively for every Nigerian visitor. This is
      both lighter/faster and avoids loading third-party cookies before the
      visitor has taken an action (works alongside cookie-consent.js).

   IMPORTANT — before this goes live, set your real Paystack PUBLIC key below.
   This is safe to expose in client-side code (it is NOT the secret key).
   Find it in: Paystack Dashboard → Settings → API Keys & Webhooks.
   ============================================================ */

(function () {
  'use strict';

  // ---- CONFIG: fill these in ----
  var PAYSTACK_PUBLIC_KEY = 'pk_test_7d99dac45a30695424e3263f06f5d3e3204743de'; // TEST key — swap to pk_live_... once you're ready to go live
  var USD_TO_NGN_RATE = 1000; // fixed rate: $1 = ₦1000

  var PRODUCT_NAMES = {
    app: 'Overdesk',
    app2: 'Overdesk Nexus',
    app3: 'Overdesk Checklist',
    bundle: 'Overdesk Full Suite (Bundle)',
    everyone: 'Overdesk Checklist — Everyone Edition'
  };

  function formatNgnFull(ngn) {
    return ngn.toLocaleString('en-NG');
  }
  function formatNgnK(ngn) {
    return (ngn % 1000 === 0) ? (ngn / 1000) + 'K' : (ngn / 1000).toFixed(1) + 'K';
  }

  // ---- 1. Detect country (cached in localStorage for 24h) ----
  function getCachedGeo() {
    try {
      var raw = localStorage.getItem('overdesk_geo');
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) return null; // expired
      return data;
    } catch (e) {
      return null;
    }
  }

  function setCachedGeo(countryCode) {
    try {
      localStorage.setItem('overdesk_geo', JSON.stringify({
        countryCode: countryCode,
        timestamp: Date.now()
      }));
    } catch (e) { /* localStorage unavailable, ignore */ }
  }

  function detectCountry(callback) {
    var cached = getCachedGeo();
    if (cached) {
      callback(cached.countryCode);
      return;
    }
    fetch('https://ipapi.co/json/')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var code = data && data.country_code ? data.country_code : null;
        setCachedGeo(code);
        callback(code);
      })
      .catch(function () {
        // If geo lookup fails, fail safe to non-Nigeria (default Gumroad/USD experience)
        callback(null);
      });
  }

  // ---- 2. Swap price displays + button behavior for Nigerian visitors ----
  function applyNigeriaPricing() {
    // Swap price text
    document.querySelectorAll('[data-usd]').forEach(function (el) {
      var usd = parseFloat(el.getAttribute('data-usd'));
      if (isNaN(usd)) return;
      var ngn = usd * USD_TO_NGN_RATE;
      var display = formatNgnK(ngn);
      // Only overwrite if this element is a price display (has data-usd and starts with $)
      if (el.textContent.trim().indexOf('$') === 0) {
        el.textContent = '\u20A6' + display;
      }
    });

    // Swap "Secure Payment via Gumroad" labels
    document.querySelectorAll('.js-secure-text').forEach(function (el) {
      el.textContent = 'Secure Payment via Paystack';
    });

    // Swap purchase button behavior
    document.querySelectorAll('.js-purchase-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var product = btn.getAttribute('data-product');
        var usd = parseFloat(btn.getAttribute('data-usd'));
        openConversionPreview(product, usd);
      });
      // Update button label so it's clear this is a different payment path
      var svg = btn.querySelector('svg');
      btn.innerHTML = '';
      if (svg) btn.appendChild(svg);
      btn.appendChild(document.createTextNode(' Pay with Paystack'));
    });
  }

  // ---- 3. Simple checkout modal: product, price, email, then Paystack ----
  function openConversionPreview(productKey, usdAmount) {
    var ngnAmount = Math.round(usdAmount * USD_TO_NGN_RATE);
    var productName = PRODUCT_NAMES[productKey] || 'Overdesk';

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(6,5,14,0.75);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:Inter,sans-serif;';

    overlay.innerHTML =
      '<div style="background:#141417;border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:1.8rem;max-width:380px;width:100%;box-shadow:0 30px 80px rgba(0,0,0,0.5);">' +
        '<h3 style="color:#fff;font-size:1.05rem;font-weight:800;margin:0 0 0.3rem;">' + productName + '</h3>' +
        '<p style="color:rgba(255,255,255,0.5);font-size:0.85rem;margin:0 0 1.3rem;">\u20A6' + formatNgnFull(ngnAmount) + ' \u2014 enter your email to continue to Paystack.</p>' +
        '<input type="email" id="opStackEmail" placeholder="you@example.com" required style="width:100%;box-sizing:border-box;padding:0.75rem 1rem;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#fff;font-size:0.9rem;margin-bottom:1rem;">' +
        '<button id="opStackContinue" style="width:100%;padding:0.85rem;border:none;border-radius:999px;background:linear-gradient(135deg,#7c3aed,#00d2ff);color:#fff;font-weight:700;font-size:0.9rem;cursor:pointer;">Continue to Payment</button>' +
        '<button id="opStackCancel" style="width:100%;padding:0.6rem;border:none;background:none;color:rgba(255,255,255,0.4);font-size:0.8rem;margin-top:0.6rem;cursor:pointer;">Cancel</button>' +
      '</div>';

    document.body.appendChild(overlay);

    var emailInput = overlay.querySelector('#opStackEmail');
    emailInput.focus();

    overlay.querySelector('#opStackCancel').addEventListener('click', function () {
      document.body.removeChild(overlay);
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) document.body.removeChild(overlay);
    });

    overlay.querySelector('#opStackContinue').addEventListener('click', function () {
      var email = emailInput.value.trim();
      if (!email || email.indexOf('@') === -1) {
        emailInput.style.borderColor = '#ef4444';
        return;
      }
      var continueBtn = overlay.querySelector('#opStackContinue');
      continueBtn.textContent = 'Loading secure payment…';
      continueBtn.disabled = true;

      loadPaystackScript(function () {
        document.body.removeChild(overlay);
        launchPaystackPopup(email, productKey, productName, ngnAmount);
      });
    });
  }

  function launchPaystackPopup(email, productKey, productName, ngnAmount) {
    if (typeof PaystackPop === 'undefined') {
      alert('Payment system is still loading — please try again in a moment.');
      return;
    }
    var handler = PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email: email,
      amount: ngnAmount * 100, // Paystack expects amount in kobo
      currency: 'NGN',
      ref: 'OD-' + productKey + '-' + Date.now(),
      metadata: {
        product: productKey,
        product_name: productName,
        custom_fields: [
          { display_name: 'Product', variable_name: 'product', value: productName }
        ]
      },
      callback: function (response) {
        // Client-side "success" — real delivery is triggered server-side by the
        // Paystack webhook (see the Cloudflare Worker), not from this callback.
        alert('Payment received! Check your email (' + email + ') shortly for your download link.');
      },
      onClose: function () {
        // user closed the popup — no action needed
      }
    });
    handler.openIframe();
  }

  // ---- 4. Load the Paystack Inline script only when someone actually clicks purchase ----
  var paystackScriptLoading = false;
  var paystackScriptCallbacks = [];
  function loadPaystackScript(callback) {
    if (typeof PaystackPop !== 'undefined') { callback(); return; }
    paystackScriptCallbacks.push(callback);
    if (paystackScriptLoading) return;
    paystackScriptLoading = true;
    var s = document.createElement('script');
    s.src = 'https://js.paystack.co/v1/inline.js';
    s.onload = function () {
      paystackScriptCallbacks.forEach(function (cb) { cb(); });
      paystackScriptCallbacks = [];
    };
    document.head.appendChild(s);
  }

  // ---- Boot ----
  detectCountry(function (countryCode) {
    if (countryCode === 'NG') {
      // Price/button swaps happen immediately — Paystack's own script only
      // loads later, at the moment of an actual purchase click.
      applyNigeriaPricing();
    }
    // Non-Nigerian visitors: do nothing, site behaves exactly as before.
  });
})();
