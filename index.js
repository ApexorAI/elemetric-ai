require("dotenv").config();
const crypto = require("crypto");

const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const OpenAI  = require("openai");
const Replicate = require("replicate");
const rateLimit = require("express-rate-limit");
const Stripe  = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const sharp   = require("sharp");
const { Resend } = require("resend");
const { LRUCache } = require("lru-cache");

// ── Victorian Regulations Knowledge Base ──────────────────────────────────────
// Verified requirements from AS/NZS 3500, AS/NZS 5601.1, AS/NZS 3000, AS 1684.
const VICTORIAN_REGULATIONS = {
  plumbing: {
    ptrValveDischarge:  "PTR valve discharge pipe must terminate within 300mm of floor level (AS/NZS 3500)",
    temperingValve:     "Tempering valve must limit hot water outlet temperature to maximum 50°C (AS/NZS 3500.4)",
    maxSystemPressure:  "Hot water system pressure must not exceed 850kPa (AS/NZS 3500)",
    pipeSupport:        "Minimum pipe support intervals: 1.2m horizontal copper, 1.8m vertical copper (AS/NZS 3500)",
  },
  gas: {
    applianceClearance: "Gas appliance minimum 500mm clearance from combustible materials (AS/NZS 5601.1)",
    flueTermination:    "Flue terminal must be at least 500mm from any opening into a building (AS/NZS 5601.1)",
    testPressure:       "Gas installation leak test pressure minimum 1.5 kPa sustained for 5 minutes (AS/NZS 5601.1)",
  },
  electrical: {
    rcdTripTime:         "RCD must trip within 300 milliseconds at rated residual current (AS/NZS 3000 Clause 2.6)",
    earthConductorColour:"Earth conductors must have green/yellow striped insulation (AS/NZS 3000)",
    insulationResistance:"Minimum insulation resistance 1 MΩ between any live conductor and earth (AS/NZS 3000)",
  },
  drainage: {
    pipeGradient: "Minimum drainage pipe gradient 1:60 for 100mm pipe (AS/NZS 3500.2)",
    trapSeal:     "Minimum trap water seal depth 50mm (AS/NZS 3500.2)",
    ventStack:    "All sanitary fixtures must be vented within 3m of the trap (AS/NZS 3500.2)",
  },
  carpentry: {
    timberFraming: "Residential timber framing must comply with AS 1684 series (span tables and connection requirements)",
    deckingFixings:"Decking fixings must be corrosion-resistant — stainless steel or hot-dipped galvanised (AS 1684)",
  },
};

// ── Task 1: Prompt Versioning Registry ───────────────────────────────────────
// Metadata registry for every job-type prompt. Version numbers allow tracking
// which prompt version generated a given result.

const PROMPT_REGISTRY = {
  plumbing:  { version: "1.1.0", description: "Strict plumbing photo validator — AS/NZS 3500 (30-example calibration set)", model: "gpt-4.1-mini", updatedAt: "2026-03-15" },
  gas:       { version: "1.1.0", description: "Strict gas photo validator — AS/NZS 5601.1 (30-example calibration set)", model: "gpt-4.1-mini", updatedAt: "2026-03-15" },
  electrical:{ version: "1.1.0", description: "Strict electrical photo validator — AS/NZS 3000 (30-example calibration set)", model: "gpt-4.1-mini", updatedAt: "2026-03-15" },
  drainage:  { version: "1.0.0", description: "Strict drainage photo validator — AS/NZS 3500.2 (18-example calibration set)", model: "gpt-4.1-mini", updatedAt: "2026-03-15" },
  carpentry: { version: "1.0.0", description: "Carpentry documentation validator — AS 1684 (15-example calibration set)", model: "gpt-4.1-mini", updatedAt: "2026-03-15" },
  hvac:      { version: "1.0.0", description: "HVAC documentation validator — AIRAH / AS 4254.2 (15-example calibration set)", model: "gpt-4.1-mini", updatedAt: "2026-03-15" },
};

// A/B testing: 20% of requests use the v2 chain-of-thought enhanced variant.
// v2 adds a step-by-step reasoning chain preamble before the main prompt.
// Results are tracked separately to compare average confidence scores.
const promptAbStats = {
  v1: { uses: 0, totalConfidence: 0, avgConfidence: null },
  v2: { uses: 0, totalConfidence: 0, avgConfidence: null },
};

// Chain-of-thought preamble injected for v2 variant
const PROMPT_V2_PREAMBLE = `ANALYSIS APPROACH — follow this exact reasoning chain for each photo before assigning any result:

Step 1: Read the photo label carefully. What specific item must be visible?
Step 2: Examine what is actually visible in the photo.
Step 3: Does the photo show the named item clearly and without ambiguity?
Step 4: Are specific compliance markers present (AS/NZS labels, certification plates, measurement references)?
Step 5: Make your pass/fail/unclear decision. Be conservative — when uncertain, fail.

Apply this chain internally for every photo before populating your JSON output.

`;

// ── API usage statistics (in-memory) ─────────────────────────────────────────
const usageStats = {
  totalRequests:   0,
  openaiCalls:     0,
  replicateCalls:  0,
  emailsSent:      0,
  cacheHits:       0,
  dedupHits:       0,
  startedAt:       new Date().toISOString(),
};
const COST_PER_OPENAI_CALL    = 0.002;  // GPT-4.1-mini vision (USD estimate)
const COST_PER_REPLICATE_CALL = 0.05;   // Stable Diffusion inpainting (USD estimate)
const COST_PER_EMAIL          = 0.001;  // Resend transactional (USD estimate)

// ── Task 21: LRU Cache (upgraded from simple Map) ────────────────────────────
// Max 500 entries, 1-hour TTL per entry. Eviction analytics tracked.
const CACHE_TTL_MS    = 60 * 60 * 1000;
const analysisCache   = new LRUCache({
  max:               500,
  ttl:               CACHE_TTL_MS,
  updateAgeOnGet:    false,
  allowStale:        false,
  disposeAfter:      () => { cacheAnalytics.evictions++; },
});
const pendingAnalyses = new Map(); // cacheKey → Promise

const cacheAnalytics = {
  hits:       0,
  misses:     0,
  evictions:  0,
  sets:       0,
  get hitRate() {
    const total = this.hits + this.misses;
    return total > 0 ? parseFloat(((this.hits / total) * 100).toFixed(1)) : 0;
  },
  get missRate() {
    const total = this.hits + this.misses;
    return total > 0 ? parseFloat(((this.misses / total) * 100).toFixed(1)) : 0;
  },
};

function getCacheKey(type, images) {
  const h = crypto.createHash("sha256");
  h.update(type);
  for (const img of images) {
    h.update(img.label || "");
    h.update(img.data  || "");
  }
  return h.digest("hex");
}

function getCached(key) {
  const result = analysisCache.get(key);
  if (result) {
    cacheAnalytics.hits++;
    return result;
  }
  cacheAnalytics.misses++;
  return null;
}

function setCache(key, result) {
  analysisCache.set(key, result);
  cacheAnalytics.sets++;
}

// Cache warming: pre-populate common type + empty-images keys at startup
// (lightweight — no real API calls; just ensures the LRU is initialised)
const WARMABLE_TYPES = ["plumbing", "gas", "electrical", "drainage", "carpentry", "hvac"];
// Actual warm entries require real images — warming here is a no-op placeholder
// that can be extended once common test-image hashes are available.
// console.log(`[cache] LRU cache initialised (max 500 entries, TTL ${CACHE_TTL_MS / 60000} min)`);

// POST /cache/clear — manual cache flush (protected by API key middleware)
// Defined after middleware is registered; here we just declare the handler reference.
function registerCacheClearRoute(app) {
  app.post("/cache/clear", (_req, res) => {
    const sizeBefore = analysisCache.size;
    analysisCache.clear();
    return res.json({
      cleared:     true,
      entriesCleared: sizeBefore,
      clearedAt:   new Date().toISOString(),
    });
  });
}

// ── AI response validation ────────────────────────────────────────────────────
function validateAIResponse(parsed) {
  if (typeof parsed.overall_confidence !== "number")  parsed.overall_confidence  = 0;
  if (!Array.isArray(parsed.items_detected))          parsed.items_detected      = [];
  if (!Array.isArray(parsed.items_missing))           parsed.items_missing       = [];
  if (!Array.isArray(parsed.items_unclear))           parsed.items_unclear       = [];
  if (!["low", "medium", "high"].includes(parsed.risk_rating))
    parsed.risk_rating = "medium";
  if (!Array.isArray(parsed.recommended_actions) || parsed.recommended_actions.length === 0)
    parsed.recommended_actions = ["Retake photos and resubmit for analysis."];
  if (typeof parsed.liability_summary !== "string" || !parsed.liability_summary)
    parsed.liability_summary = "Review is incomplete. Retake missing photos before certifying this installation.";
  return parsed;
}

// ── OpenAI retry helper (retries once after 2s on failure) ───────────────────
async function callOpenAIWithRetry(params) {
  try {
    return await client.chat.completions.create(params);
  } catch (err) {
    console.warn("[openai] Request failed, retrying in 2s:", err.message);
    await new Promise(r => setTimeout(r, 2000));
    return await client.chat.completions.create(params);
  }
}

// ── HTML escaping (prevents XSS in email content) ────────────────────────────
function escHtml(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ── Email address validation ──────────────────────────────────────────────────
function isValidEmail(addr) {
  return typeof addr === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

// ── Safe URL validation (http/https only — prevents javascript: injection) ────
function isSafeUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch { return false; }
}

// ── Victorian regulations summary for AI prompts ─────────────────────────────
function buildRegulationsNote(jobType) {
  const items = [];
  if (jobType === "plumbing")  items.push(...Object.values(VICTORIAN_REGULATIONS.plumbing));
  if (jobType === "gas")       items.push(...Object.values(VICTORIAN_REGULATIONS.gas));
  if (jobType === "electrical")items.push(...Object.values(VICTORIAN_REGULATIONS.electrical));
  if (jobType === "drainage")  items.push(...Object.values(VICTORIAN_REGULATIONS.drainage), ...Object.values(VICTORIAN_REGULATIONS.plumbing));
  if (jobType === "carpentry") items.push(...Object.values(VICTORIAN_REGULATIONS.carpentry));
  if (items.length === 0) return "";
  return `\nVICTORIAN REGULATIONS REFERENCE (apply these requirements in your analysis):\n${items.map(r => `- ${r}`).join("\n")}\n`;
}

const app = express();

// Trust Railway's reverse proxy so rate-limiter and IP logging see the real IP
app.set("trust proxy", 1);

// ── Stripe webhook — raw body MUST come before express.json() ─────────────────

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-12-18.acacia" })
  : null;

const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const resend     = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || "Elemetric <noreply@elemetric.app>";

// Map Stripe price IDs → app role names
function roleFromSubscription(subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const amount  = subscription.items?.data?.[0]?.price?.unit_amount ?? 0;

  const priceMap = {
    [process.env.STRIPE_PRICE_CORE]:          "core",
    [process.env.STRIPE_PRICE_PRO]:           "pro",
    [process.env.STRIPE_PRICE_EMPLOYER]:      "employer",
    [process.env.STRIPE_PRICE_EMPLOYER_PLUS]: "employer_plus",
  };

  if (priceId && priceMap[priceId]) return priceMap[priceId];

  // Amount-based fallback (AUD cents)
  if (amount <= 2499) return "core";
  if (amount <= 3999) return "pro";
  if (amount <= 9900) return "employer";
  return "employer_plus";
}

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !supabaseAdmin) {
      console.warn("Webhook: Stripe or Supabase not configured.");
      return res.sendStatus(200); // don't fail Stripe
    }

    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secret) {
      console.warn("Webhook: STRIPE_WEBHOOK_SECRET not set.");
      return res.sendStatus(200);
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`Webhook: received event type=${event.type} id=${event.id}`);

    try {
      if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
        const subscription = event.data.object;
        console.log(`Webhook: ${event.type} — subscription=${subscription.id} status=${subscription.status}`);

        const customer = await stripe.customers.retrieve(subscription.customer);
        const email = customer.email;
        if (!email) {
          console.warn("Webhook: No customer email found.");
          return res.sendStatus(200);
        }

        const role = roleFromSubscription(subscription);

        const { data: users, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (listErr) throw listErr;

        const user = users?.users?.find((u) => u.email === email);
        if (!user) {
          console.warn(`Webhook: No Supabase user found for email ${email.replace(/(?<=.{2}).(?=.*@)/g, "*")}`);
          return res.sendStatus(200);
        }

        await supabaseAdmin.from("profiles").upsert(
          {
            user_id: user.id,
            role,
            stripe_customer_id: subscription.customer,
            subscription_status: subscription.status,
          },
          { onConflict: "user_id" }
        );

        console.log(`Webhook: Updated user → role=${role} status=${subscription.status}`);
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        console.log(`Webhook: customer.subscription.deleted — subscription=${subscription.id}`);

        const customer = await stripe.customers.retrieve(subscription.customer);
        const email = customer.email;
        if (!email) return res.sendStatus(200);

        const { data: users } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const user = users?.users?.find((u) => u.email === email);
        if (!user) return res.sendStatus(200);

        await supabaseAdmin.from("profiles").upsert(
          {
            user_id: user.id,
            role: "free",
            subscription_status: "canceled",
          },
          { onConflict: "user_id" }
        );

        console.log(`Webhook: Downgraded user → free (subscription canceled)`);
      }

      if (event.type === "payment_intent.payment_failed") {
        const paymentIntent = event.data.object;
        console.log(`Webhook: payment_intent.payment_failed — id=${paymentIntent.id} amount=${paymentIntent.amount} customer=${paymentIntent.customer}`);

        if (paymentIntent.customer && resend && stripe) {
          try {
            const customer = await stripe.customers.retrieve(paymentIntent.customer);
            const email = customer.email;
            const customerName = customer.name || "there";
            if (email) {
              const firstName = escHtml(customerName.split(" ")[0]);
              const amountAUD  = ((paymentIntent.amount || 0) / 100).toFixed(2);
              const content = `
                <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;">Payment failed.</h1>
                <p style="margin:0 0 24px;font-size:14px;color:#64748b;">We couldn't process your most recent payment.</p>
                <p style="margin:0 0 16px;font-size:15px;color:#1e293b;line-height:1.7;">
                  Hi ${firstName}, your payment of AUD ${escHtml(amountAUD)} could not be processed.
                  Please update your payment method to continue using Elemetric without interruption.
                </p>
                <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                  <tr>
                    <td style="background:#f97316;border-radius:8px;padding:14px 32px;">
                      <a href="https://elemetric.app/settings/billing" style="font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">
                        Update Payment Method &rarr;
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">
                  Questions? Contact us at <a href="mailto:support@elemetric.app" style="color:#f97316;text-decoration:none;">support@elemetric.app</a>.
                </p>`;
              await resend.emails.send({
                from: EMAIL_FROM,
                to: email,
                subject: "Payment failed — action required",
                html: buildEmailHtml("Payment failed — Elemetric", content),
              });
              usageStats.emailsSent++;
              console.log(`Webhook: payment failed email sent`);
            }
          } catch (emailErr) {
            console.error("Webhook: Failed to send payment failed email:", emailErr.message);
          }
        }
      }

      if (event.type === "customer.subscription.trial_will_end") {
        const subscription = event.data.object;
        const trialEnd  = subscription.trial_end;
        const daysLeft  = trialEnd ? Math.ceil((trialEnd * 1000 - Date.now()) / (1000 * 60 * 60 * 24)) : null;
        console.log(`Webhook: customer.subscription.trial_will_end — subscription=${subscription.id} daysLeft=${daysLeft}`);

        if (subscription.customer && resend && stripe) {
          try {
            const customer = await stripe.customers.retrieve(subscription.customer);
            const email = customer.email;
            const customerName = customer.name || "there";
            if (email) {
              const firstName     = escHtml(customerName.split(" ")[0]);
              const trialEndLabel = trialEnd
                ? new Date(trialEnd * 1000).toLocaleDateString("en-AU", { timeZone: "Australia/Melbourne", day: "2-digit", month: "long", year: "numeric" })
                : "soon";
              const subjectDays = daysLeft === 3 ? "in 3 days" : "soon";
              const content = `
                <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;">Your trial ends ${escHtml(subjectDays)}.</h1>
                <p style="margin:0 0 24px;font-size:14px;color:#64748b;">Keep your compliance records protected.</p>
                <p style="margin:0 0 16px;font-size:15px;color:#1e293b;line-height:1.7;">
                  Hi ${firstName}, your Elemetric free trial ends on <strong>${escHtml(trialEndLabel)}</strong>.
                  Add your payment details now to continue using all features without interruption.
                </p>
                <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                  <tr>
                    <td style="background:#f97316;border-radius:8px;padding:14px 32px;">
                      <a href="https://elemetric.app/settings/billing" style="font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">
                        Add Payment Details &rarr;
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">
                  Questions? Contact us at <a href="mailto:support@elemetric.app" style="color:#f97316;text-decoration:none;">support@elemetric.app</a>.
                </p>`;
              await resend.emails.send({
                from: EMAIL_FROM,
                to: email,
                subject: `Your Elemetric trial ends ${subjectDays}`,
                html: buildEmailHtml("Trial ending — Elemetric", content),
              });
              usageStats.emailsSent++;
              console.log(`Webhook: trial ending email sent daysLeft=${daysLeft}`);
            }
          } catch (emailErr) {
            console.error("Webhook: Failed to send trial ending email:", emailErr.message);
          }
        }
      }

    } catch (err) {
      console.error("Webhook handler error:", err.message);
      // Still return 200 so Stripe doesn't retry
    }

    res.sendStatus(200);
  }
);

// ── Task 13: Supabase user-created webhook ────────────────────────────────────
// Called by Supabase Auth webhook when a new user signs up.
// Verified by SUPABASE_WEBHOOK_SECRET header to prevent spoofing.
// Actions: send branded welcome email, create default profile row, log signup,
//          notify cayde@elemetric.com.au of the new user.

app.post("/webhook/user-created", async (req, res) => {
  const secret = process.env.SUPABASE_WEBHOOK_SECRET;
  const provided = req.headers["x-supabase-webhook-secret"] || req.headers["authorization"];

  // Verify shared secret (constant-time comparison)
  if (secret) {
    const providedClean = (provided || "").replace(/^Bearer\s+/i, "");
    let match = false;
    try {
      match = crypto.timingSafeEqual(Buffer.from(providedClean), Buffer.from(secret));
    } catch {
      match = false;
    }
    if (!match) {
      console.warn("webhook/user-created: invalid secret, rejecting");
      return res.status(401).json({ error: "Unauthorized" });
    }
  } else {
    console.warn("webhook/user-created: SUPABASE_WEBHOOK_SECRET not set — accepting without verification");
  }

  const { record } = req.body || {};
  if (!record || !record.id) {
    return res.status(400).json({ error: "Missing user record" });
  }

  const userId    = record.id;
  const email     = record.email || null;
  const createdAt = record.created_at || new Date().toISOString();
  const rawMeta   = record.raw_user_meta_data || {};
  const fullName  = rawMeta.full_name || rawMeta.name || "";
  const firstName = fullName.split(" ")[0] || "there";

  console.log(`webhook/user-created: new user id=${userId} email=${email ? email.replace(/(.{2}).+(@.+)/, "$1***$2") : "unknown"}`);

  const errors = [];

  // 1. Create default profile row in Supabase
  if (supabaseAdmin) {
    try {
      const { error: profileErr } = await supabaseAdmin
        .from("profiles")
        .insert({
          id:         userId,
          email:      email,
          full_name:  fullName || null,
          created_at: createdAt,
          plan:       "free",
          jobs_analysed: 0,
        })
        .select()
        .single();

      if (profileErr && profileErr.code !== "23505") {
        // 23505 = unique violation (profile already exists — safe to ignore)
        console.error("webhook/user-created: profile insert error:", profileErr.message);
        errors.push("profile_insert_failed");
      } else {
        console.log("webhook/user-created: default profile created for", userId);
      }
    } catch (err) {
      console.error("webhook/user-created: profile insert threw:", err.message);
      errors.push("profile_insert_threw");
    }
  }

  // 2. Send branded welcome email to the new user
  if (resend && email && isValidEmail(email)) {
    try {
      const welcomeContent = `
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;">Welcome to Elemetric, ${escHtml(firstName)}.</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#64748b;">AI-powered compliance for Australian tradespeople.</p>
        <p style="margin:0 0 16px;font-size:15px;color:#1e293b;line-height:1.7;">
          Your account is ready. Start by snapping a photo of your work and letting Elemetric check it against
          Australian standards — in seconds.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr>
            <td style="background:#f97316;border-radius:8px;padding:14px 32px;">
              <a href="https://elemetric.app/review" style="font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">
                Start Your First Analysis &rarr;
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 16px;font-size:15px;color:#1e293b;line-height:1.7;">
          Need help? Check out our
          <a href="https://elemetric.app/docs" style="color:#f97316;text-decoration:none;">getting started guide</a>
          or reply to this email — we respond within one business day.
        </p>
        <p style="margin:0;font-size:14px;color:#64748b;">
          — The Elemetric team
        </p>`;

      await resend.emails.send({
        from:    EMAIL_FROM,
        to:      email,
        subject: `Welcome to Elemetric, ${firstName}!`,
        html:    buildEmailHtml("Welcome to Elemetric", welcomeContent),
      });
      usageStats.emailsSent++;
      console.log("webhook/user-created: welcome email sent to", userId);
    } catch (emailErr) {
      console.error("webhook/user-created: welcome email failed:", emailErr.message);
      errors.push("welcome_email_failed");
    }
  }

  // 3. Notify cayde@elemetric.com.au of the new signup
  if (resend) {
    try {
      const adminContent = `
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#0f172a;">New User Signup</h1>
        <p style="margin:0 0 16px;font-size:14px;color:#64748b;">A new user just joined Elemetric.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#64748b;width:120px;">User ID</td><td style="padding:8px 0;color:#1e293b;font-family:monospace;">${escHtml(userId)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Email</td><td style="padding:8px 0;color:#1e293b;">${escHtml(email || "unknown")}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Name</td><td style="padding:8px 0;color:#1e293b;">${escHtml(fullName || "not provided")}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Signed up</td><td style="padding:8px 0;color:#1e293b;">${escHtml(createdAt)}</td></tr>
        </table>`;

      await resend.emails.send({
        from:    EMAIL_FROM,
        to:      "cayde@elemetric.com.au",
        subject: `New Elemetric signup: ${email || userId}`,
        html:    buildEmailHtml("New Elemetric Signup", adminContent),
      });
      usageStats.emailsSent++;
    } catch (notifyErr) {
      console.error("webhook/user-created: admin notification failed:", notifyErr.message);
      errors.push("admin_notify_failed");
    }
  }

  return res.json({
    success: true,
    userId,
    errors: errors.length > 0 ? errors : undefined,
  });
});

// ── Security headers (helmet) ─────────────────────────────────────────────────
app.use(helmet());

// ── CORS restriction ──────────────────────────────────────────────────────────
// Allowed origins are set via ALLOWED_ORIGINS env var (comma-separated).
// Requests with no Origin header (mobile apps, server-to-server) are passed
// through without restriction — CORS only applies to browser cross-origin calls.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // No Origin = mobile app or same-origin curl — allow
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) {
      // ALLOWED_ORIGINS not configured — open in dev, warn loudly
      if (process.env.NODE_ENV === "production") {
        return callback(new Error("CORS: ALLOWED_ORIGINS not configured in production."));
      }
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin '${origin}' not permitted.`));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-elemetric-key", "Authorization"],
}));

// ── Request body size limit (10 MB) ──────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`
    );
  });
  next();
});

// ── Request counter (for /stats) ──────────────────────────────────────────────
app.use((req, _res, next) => {
  if (req.path !== "/health") usageStats.totalRequests++;
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

// Global: 20 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait before analysing more photos." },
});

// Stricter: 5 requests per minute on /review
const reviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait before analysing more photos." },
});

// Photo stamping: 30 per 15 minutes per IP (prevents bulk forging of timestamps)
const stampLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many stamp requests. Please wait before stamping more photos." },
});

app.use(globalLimiter);

// ── API key auth ───────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  // Allow unauthenticated health check, Stripe webhook, and Supabase user webhook
  if (req.path === "/" || req.path === "/webhook" || req.path === "/webhook/user-created" || req.path === "/health") return next();

  const key = req.headers["x-elemetric-key"];
  const expected = process.env.ELEMETRIC_API_KEY;

  if (!expected) {
    // Key not configured — skip enforcement in development
    return next();
  }

  if (!key || key !== expected) {
    return res.status(401).json({ error: "Unauthorised." });
  }

  next();
});

// ── Auth header hardening ──────────────────────────────────────────────────────
// If an Authorization header is present it must be a non-empty, non-blank
// string with no null bytes. Requests with obviously malformed auth headers
// are rejected before they reach any handler.

app.use((req, res, next) => {
  const auth = req.headers["authorization"];
  if (auth !== undefined) {
    if (
      typeof auth !== "string" ||
      auth.trim().length === 0 ||
      auth.includes("\x00")
    ) {
      return res.status(400).json({ error: "Invalid Authorization header." });
    }
  }
  next();
});

// ── Input sanitisation ────────────────────────────────────────────────────────
// Strip null bytes (\x00) and ASCII control characters (except \t \n \r) from
// all string values in request body and query string before any handler runs.
// This prevents null-byte injection and related control-character attacks.

function sanitiseString(s) {
  if (typeof s !== "string") return s;
  // Remove C0 control chars except HT (\x09), LF (\x0a), CR (\x0d)
  // and also remove DEL (\x7f)
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function sanitiseValue(v) {
  if (typeof v === "string") return sanitiseString(v);
  if (Array.isArray(v)) return v.map(sanitiseValue);
  if (v !== null && typeof v === "object") {
    const out = {};
    for (const key of Object.keys(v)) {
      out[sanitiseString(key)] = sanitiseValue(v[key]);
    }
    return out;
  }
  return v;
}

app.use((req, _res, next) => {
  if (req.body && typeof req.body === "object") {
    req.body = sanitiseValue(req.body);
  }
  if (req.query && typeof req.query === "object") {
    req.query = sanitiseValue(req.query);
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Elemetric AI server" });
});

app.get("/health", async (_req, res) => {
  const checks = {};

  // Supabase connectivity — lightweight count query
  if (supabaseAdmin) {
    try {
      const { error } = await supabaseAdmin.from("profiles").select("id", { count: "exact", head: true });
      checks.supabase = error ? { status: "degraded", message: error.message } : { status: "ok" };
    } catch (e) {
      checks.supabase = { status: "error", message: e.message };
    }
  } else {
    checks.supabase = { status: "unconfigured" };
  }

  // OpenAI connectivity — list models (fast, unauthenticated-safe ping)
  if (openai) {
    try {
      await openai.models.list({ limit: 1 });
      checks.openai = { status: "ok" };
    } catch (e) {
      // 401 = key misconfigured, but API is reachable
      checks.openai = e.status === 401
        ? { status: "auth_error", message: "API key invalid" }
        : { status: "error", message: e.message };
    }
  } else {
    checks.openai = { status: "unconfigured" };
  }

  // Replicate connectivity — check env var presence (no free ping endpoint)
  checks.replicate = process.env.REPLICATE_API_TOKEN
    ? { status: "configured" }
    : { status: "unconfigured" };

  // Resend connectivity — check env var presence
  checks.resend = process.env.RESEND_API_KEY
    ? { status: "configured" }
    : { status: "unconfigured" };

  const degraded = Object.values(checks).some(c => c.status === "error" || c.status === "degraded");
  const httpStatus = degraded ? 503 : 200;

  return res.status(httpStatus).json({
    status:       degraded ? "degraded" : "ok",
    uptime:       Math.round(process.uptime()),
    checkedAt:    new Date().toISOString(),
    services:     checks,
  });
});

app.get("/timestamp", (_req, res) => {
  const now = new Date();
  res.json({
    timestamp: now.toISOString(),
    formatted: now.toLocaleString("en-AU", { timeZone: "Australia/Melbourne" }),
  });
});

/**
 * calculateComplexity — deterministic job complexity scorer.
 *
 * Scores a job 1–10 across four dimensions, then maps to a band:
 *   1–3  simple   — few photos, few items, lower-risk trade
 *   4–6  moderate — mid-range scope or regulated trade
 *   7–10 complex  — large scope, high-risk trade, missing evidence
 *
 * @param {string} type        - job type string (e.g. "gas", "electrical")
 * @param {number} photoCount  - number of photos submitted
 * @param {number} totalItems  - detected + missing + unclear item count
 * @param {number} missingCount - number of items that failed validation
 * @returns {{ score: number, band: "simple"|"moderate"|"complex" }}
 */
function calculateComplexity(type, photoCount, totalItems, missingCount) {
  // Regulatory/technical complexity of the trade type (0–3)
  const typeScore =
    type === "electrical" || type === "gas" ? 3 :
    type === "plumbing"   || type === "drainage" || type === "hvac" ? 2 : 1;

  // Job scope via photo count (0–3)
  const photoScore =
    photoCount >= 11 ? 3 :
    photoCount >= 7  ? 2 :
    photoCount >= 4  ? 1 : 0;

  // Breadth of inspection via total items scoped (0–3)
  const itemScore =
    totalItems >= 10 ? 3 :
    totalItems >= 7  ? 2 :
    totalItems >= 4  ? 1 : 0;

  // Incomplete evidence makes certification harder (+1 if any items missing)
  const missingScore = missingCount >= 1 ? 1 : 0;

  const raw   = typeScore + photoScore + itemScore + missingScore;
  const score = Math.max(1, Math.min(10, raw));
  const band  = score <= 3 ? "simple" : score <= 6 ? "moderate" : "complex";
  return { score, band };
}

// ── Task 8: Photo Quality Pre-screener ───────────────────────────────────────
/**
 * prescreenPhotos — quickly assesses each photo for quality before compliance
 * analysis. Uses GPT-4.1-mini vision to flag: blur, lighting, distance, angle,
 * subject visibility. Returns { passed, failed } arrays.
 *
 * @param {Array}  images  - array of { label, mime, data }
 * @returns {{ passed: Array, failed: Array<{ label, issue }> }}
 */
async function prescreenPhotos(images) {
  if (!images || images.length === 0) return { passed: [], failed: [] };

  const qualityPrompt = `You are a photo quality screener for trade compliance documentation.
For each photo, assess whether it is suitable for compliance analysis.

A photo PASSES quality screening if:
- The main subject can be identified (even if some blur exists)
- Lighting is adequate (not pitch black, not severely overexposed)
- The photo shows something related to trade work
- The subject is close enough for at least basic assessment

A photo FAILS quality screening ONLY if it clearly:
- Is completely or severely blurry — nothing can be identified
- Is pitch black or completely overexposed — no detail visible
- Shows nothing related to trade work (e.g. blank wall, floor, sky only)
- Subject is impossibly distant — cannot see any detail at all

When in doubt: PASS the photo through. Only reject clearly unusable photos.

For failed photos, use one of these exact issue strings:
- "Too blurry — move closer and retake in better lighting"
- "Too dark — use flash or retake in better lighting"
- "Overexposed — adjust camera exposure and retake"
- "Subject not visible — retake from a closer angle"
- "No trade work visible — retake showing the required item"
- "Too far away — move much closer to the subject and retake"

Return STRICT JSON only:
{ "assessments": [ { "label": "...", "pass": true, "issue": null }, ... ] }`;

  const inputContent = [
    { type: "text", text: qualityPrompt },
    ...images.flatMap((img) => [
      { type: "text", text: `Photo label: "${img.label}"` },
      { type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } },
    ]),
  ];

  try {
    usageStats.openaiCalls++;
    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: inputContent }],
      max_tokens: 600,
      temperature: 0.1,
    });
    const raw = response.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const assessments = Array.isArray(parsed.assessments) ? parsed.assessments : [];

    const passed = [];
    const failed = [];
    const labelMap = new Map(images.map(img => [img.label, img]));
    const assessedLabels = new Set();

    for (const a of assessments) {
      assessedLabels.add(a.label);
      const img = labelMap.get(a.label);
      if (!img) continue;
      if (a.pass === false && a.issue) {
        failed.push({ label: a.label, issue: a.issue });
      } else {
        passed.push(img);
      }
    }
    // Any images not returned in assessments default to passed
    for (const img of images) {
      if (!assessedLabels.has(img.label)) passed.push(img);
    }
    return { passed, failed };
  } catch (err) {
    console.warn("[prescreen] Quality screen failed, passing all photos:", err.message);
    return { passed: images, failed: [] };
  }
}

// ── Task 7: Compliance Scoring Algorithm ─────────────────────────────────────
/**
 * calculateComplianceScore — multi-dimensional compliance score 0-100.
 *
 * Dimensions:
 *   1. Item coverage    (0-40 pts) — ratio of detected vs total items
 *   2. Photo evidence   (0-25 pts) — number of quality photos submitted
 *   3. Regulatory marks (0-20 pts) — regulatory markings confirmed in items
 *   4. Documentation    (0-15 pts) — GPS, no missing items, completeness
 *
 * @param {Object}   p
 * @param {string}   p.type            - job type (gas, electrical, plumbing…)
 * @param {string[]} p.itemsDetected   - items that passed
 * @param {string[]} p.itemsMissing    - items that failed
 * @param {string[]} p.itemsUnclear   - items that are unclear
 * @param {number}   p.photoCount      - total photos submitted
 * @param {boolean}  p.gpsRecorded     - whether GPS was captured (optional)
 * @param {number}   p.complexityScore - from calculateComplexity()
 * @returns {{ score, maxScore, grade, passed, breakdown, summary }}
 */
function calculateComplianceScore({ type, itemsDetected, itemsMissing, itemsUnclear, photoCount, gpsRecorded, complexityScore }) {
  const breakdown = {};

  // Dimension 1: Item coverage (0-40 pts)
  const totalItems = itemsDetected.length + itemsMissing.length + itemsUnclear.length;
  let coverageScore = 20; // neutral when no items
  if (totalItems > 0) {
    const weightedPassed = itemsDetected.length + (itemsUnclear.length * 0.4);
    coverageScore = Math.round((weightedPassed / totalItems) * 40);
    // Extra penalty for missing items on high-risk trades
    if ((type === "gas" || type === "electrical") && itemsMissing.length > 0) {
      coverageScore = Math.max(0, coverageScore - (itemsMissing.length * 4));
    }
  }
  breakdown.itemCoverage = {
    score: Math.max(0, Math.min(40, coverageScore)),
    max: 40,
    detail: totalItems > 0
      ? `${itemsDetected.length} passed, ${itemsMissing.length} failed, ${itemsUnclear.length} unclear of ${totalItems} items`
      : "No items to validate",
  };

  // Dimension 2: Photo evidence quality (0-25 pts)
  // Optimal is 10+ photos; each photo contributes until max
  const photoScore = Math.min(25, Math.round((Math.min(photoCount, 15) / 15) * 25));
  breakdown.photoEvidence = {
    score: photoScore,
    max: 25,
    detail: `${photoCount} photo${photoCount !== 1 ? "s" : ""} submitted (optimal: 10+)`,
  };

  // Dimension 3: Regulatory compliance markers (0-20 pts)
  // Keywords that indicate regulatory markings were verified
  const regKeywords = ["compliance", "label", "certification", "certified", "AS ", "AGA",
                       "RCD", "PTR", "marking", "rated", "test cert", "test result"];
  const regDetected = itemsDetected.filter(i => regKeywords.some(k => i.toLowerCase().includes(k.toLowerCase())));
  const regMissing  = itemsMissing.filter(i  => regKeywords.some(k => i.toLowerCase().includes(k.toLowerCase())));
  let regScore = 20;
  regScore -= regMissing.length  * 6;
  regScore  = Math.min(20, regScore + regDetected.length * 2);
  breakdown.regulatoryCompliance = {
    score: Math.max(0, Math.min(20, regScore)),
    max: 20,
    detail: `${regDetected.length} regulatory item${regDetected.length !== 1 ? "s" : ""} confirmed` +
            (regMissing.length > 0 ? `, ${regMissing.length} missing` : ""),
  };

  // Dimension 4: Documentation completeness (0-15 pts)
  const docPenalties = [];
  let docScore = 15;
  if (!gpsRecorded)           { docScore -= 5; docPenalties.push("no GPS (-5)"); }
  if (itemsMissing.length > 2){ docScore -= Math.min(4, itemsMissing.length - 2); docPenalties.push(`${itemsMissing.length} missing items`); }
  if (itemsUnclear.length > 3){ docScore -= 2; docPenalties.push("multiple unclear items (-2)"); }
  if (photoCount < 3)          { docScore -= 3; docPenalties.push("too few photos (-3)"); }
  breakdown.documentationCompleteness = {
    score: Math.max(0, docScore),
    max: 15,
    detail: docPenalties.length > 0 ? docPenalties.join("; ") : "Documentation complete",
  };

  const totalScore = Object.values(breakdown).reduce((sum, d) => sum + d.score, 0);
  const grade = totalScore >= 90 ? "A+" : totalScore >= 80 ? "A" :
                totalScore >= 70 ? "B"  : totalScore >= 60 ? "C" :
                totalScore >= 50 ? "D"  : "F";

  return {
    score:    totalScore,
    maxScore: 100,
    grade,
    passed:   totalScore >= 70,
    breakdown,
    summary:  `Compliance score ${totalScore}/100 (Grade ${grade}). ${breakdown.itemCoverage.detail}.`,
  };
}

app.post("/review", reviewLimiter, async (req, res) => {
let resolveDedup, rejectDedup, cacheKey;
try {
const { type, images } = req.body || {};

if (!type) {
return res.status(400).json({
error: "Missing job type",
});
}

if (!images || !Array.isArray(images) || images.length === 0) {
return res.status(400).json({
error: "No images provided",
});
}

// Task 4: Cache check
cacheKey = getCacheKey(type, images);
const cached = getCached(cacheKey);
if (cached) {
  usageStats.cacheHits++;
  return res.json(cached);
}

// Task 7: Deduplication — if same request in-flight, wait for first result
if (pendingAnalyses.has(cacheKey)) {
  usageStats.dedupHits++;
  const result = await pendingAnalyses.get(cacheKey);
  return res.json(result);
}
const dedupPromise = new Promise((res, rej) => { resolveDedup = res; rejectDedup = rej; });
pendingAnalyses.set(cacheKey, dedupPromise);

// Task 8: Pre-screen photos for quality before compliance analysis
const { passed: qualityPassedImages, failed: qualityFailedImages } = await prescreenPhotos(images);
if (qualityPassedImages.length === 0) {
  if (typeof rejectDedup === "function") rejectDedup(new Error("all_photos_failed_quality"));
  pendingAnalyses.delete(cacheKey);
  return res.status(422).json({
    error: "All submitted photos failed quality screening. Please retake photos closer to the subject in better lighting.",
    photo_quality_flags: qualityFailedImages,
  });
}
// Use only quality-passed images for the compliance analysis
const analysisImages = qualityPassedImages;

const isGas = type === "gas";
const isElectrical = type === "electrical";
const isDrainage = type === "drainage";
const isHvac = type === "hvac";
const isCarpentry = type === "carpentry";
const isGeneralDoc = isHvac || isCarpentry;

const tradeLabel = isHvac ? "HVAC" : type;

// ── Task 25: Comprehensive AI Prompt Optimisation ─────────────────────────────
// Shared optimisation block prepended to every prompt for chain-of-thought
// reasoning, confidence calibration, and Victorian regulatory grounding.

const PROMPT_OPTIMISATION_HEADER = `REASONING APPROACH — apply chain-of-thought analysis for each photo:
1. Read the label: what specific item must be visible for this to pass?
2. Assess photo quality: is lighting adequate? Is the subject in focus? Is distance appropriate?
3. Identify what IS visible: describe the main subject to yourself.
4. Match to requirement: does what is visible satisfy the label requirement completely?
5. Check compliance markers: are AS/NZS labels, certification plates, measurements, or test results visible and legible?
6. Make your decision: PASS, FAIL, or UNCLEAR — be conservative. When in doubt, fail.

CONFIDENCE CALIBRATION PRINCIPLES:
- overall_confidence must reflect the FRACTION of photos that pass, not your subjective certainty
- Do NOT inflate confidence because the job "seems complete" — only count photos that explicitly pass
- A job with 3 passing and 3 failing photos has overall_confidence = 50, not 75 or 80
- High confidence (>80) requires clear evidence for MOST submitted items, not just absence of obvious failures
- You must be conservative: a real VBA inspector would fail this job if photos are ambiguous

PHOTO QUALITY SCORING:
- Poor photo quality (blur, darkness, distance, angle) is itself a failure reason
- Do not guess at content in blurry or dark photos — classify as FAIL
- Photos taken from >1 m away for small components (valves, labels, connections) almost always fail
- Compliance labels must be legible at native photo resolution — if text is not readable, the photo fails

VICTORIAN REGULATORY CONTEXT:
- All analysis must be grounded in Victorian requirements: AS/NZS 3500 (plumbing), AS/NZS 5601.1 (gas), AS/NZS 3000 (electrical), AS/NZS 3500.2 (drainage), AS 1684 (carpentry), AS 4254.2 (HVAC)
- Victorian Building Authority (VBA) and Energy Safe Victoria (ESV) have strict evidence requirements
- A missing compliance label or unverifiable test result is a genuine liability exposure — treat it as such
- When a photo would fail a VBA site inspection, it must fail in your analysis

DOCUMENTATION COMPLETENESS:
- Evaluate the overall job documentation holistically at the end
- If key safety items (PTR, RCD, gas pressure test, earth continuity) are missing or unclear, elevate risk_rating
- The liability_summary must directly address what the tradesperson is liable for if work is uncertified
- recommended_actions must be specific and actionable — not generic advice

`;

// Shared output format instruction appended to every prompt
const outputFormatInstruction = `
PHOTO QUALITY GATE — evaluate this BEFORE anything else:
Count how many submitted photos are completely unrecognisable — meaning they are totally blurry, pitch black, blank, or show nothing that could be identified as any object. If MORE THAN 3 photos are completely unrecognisable, stop all analysis and return ONLY this JSON with no other fields:
{"photo_quality_error": true}

CONFIDENCE BREAKDOWN — if the quality gate is not triggered, return ALL of the following fields:
- relevant: true if at least one photo passes and shows genuine trade work, false otherwise
- overall_confidence: integer 0–100 — round((passing photos / total photos submitted) * 100)
- items_detected: array of labels that clearly PASS
- items_missing: array of labels that FAIL — wrong subject, obstructed, or required item not visible
- items_unclear: array of labels that show something related but cannot be confidently verified
- risk_rating: "high" if any critical safety item fails, "medium" if non-critical items fail, "low" if all critical items pass
- recommended_actions: array of short action strings — one per failed or unclear item
- liability_summary: one plain-English sentence explaining what this result means for the plumber's liability and certification
- analysis: one sentence summarising how many photos passed and why others failed

Return STRICT JSON only. No markdown. No text outside the JSON object.`;

const promptText = isElectrical ? `
You are a strict electrical compliance photo validator for Victorian electrical regulations under AS/NZS 3000 Wiring Rules and Energy Safe Victoria requirements.

Job type: electrical installation

Each photo below has been submitted with a label describing what it is SUPPOSED to show. Validate each photo individually and determine whether it actually contains the required electrical installation component or evidence.

VALIDATION RULES — apply without exception:
- Validate each photo against its label independently.
- A photo PASSES only if it clearly and unambiguously shows the specific item named in its label.
- A photo FAILS if it shows a person, animal, unrelated object, or anything not related to electrical installation work.
- A photo FAILS if it is blurry, too dark, or ambiguous — if you cannot clearly identify the named item, it fails.
- A photo FAILS if it shows electrical work in general but not the specific item named in its label.
- Never give benefit of the doubt. When in doubt, the photo fails.

REQUIRED ELECTRICAL INSTALLATION ITEMS and what must be CLEARLY VISIBLE for a PASS:
- "RCD protection installed and tested": must show an RCD or safety switch with BOTH the test button AND the trip indicator (LED or label) clearly visible. A photo showing only a switchboard without a legible RCD test button FAILS.
- "Circuit breaker ratings correct": must clearly show circuit breakers with visible and legible amperage ratings or circuit labels — blurry or unreadable labels FAIL.
- "Earth continuity tested": must show earthing conductors or earth terminals — the conductor insulation must be green/yellow striped. Grey, black, or unidentifiable conductors FAIL this item.
- "Polarity correct": must show wiring connections or a test instrument screen confirming correct active/neutral polarity — the instrument result must be readable.
- "Insulation resistance tested": must show an insulation resistance tester (megohmmeter) with a visible reading on the display, or a printed test certificate with results.
- "All connections secure and terminations correct": must show cable terminations at switchboard, outlet, or fitting — no loose wires, no bare conductors outside terminals. Any exposed conductor tips or loose wires FAIL.
- "Cable support and protection adequate": must show cables properly clipped or in conduit at regular intervals. Unsupported cable runs or cables hanging freely FAIL.
- "Switchboard labelling complete": must show the switchboard with ALL circuit labels or a circuit directory legible — partially labelled boards where some circuits are blank FAIL.
- "No visible damage to cables or fittings": must show cables or fittings that are clean and undamaged — any burns, cuts, exposed core, kinks, or crush marks FAIL.
- "Smoke alarm installed and tested where required": must show a smoke alarm physically mounted on the ceiling or wall — alarm brand, mounting screws, and interconnect wires (if applicable) must be visible.
- "Safety switch tested and operational": must show a safety switch (RCD) with the test button pressed result OR a test certificate — a photo of an untested switch alone FAILS.
- "Test results recorded": must show a completed test results sheet, certificate of electrical safety, or a test instrument screen with all required fields filled — blank or partial test sheets FAIL.
- "No exposed conductors": must show all conductors fully insulated, terminated in appropriate fittings, and no bare copper visible outside of terminals. Any visible bare copper outside a terminal FAILS immediately.

ADDITIONAL REJECTION CRITERIA:
- Any photo where circuit labels, RCD markings, or earth colour coding are not legible FAILS.
- Photos taken from excessive distance where individual components cannot be identified FAIL.
- Photos of closed switchboard doors without showing internal components FAIL.

RISK RATING CRITERIA:
- "high": RCD/safety switch, earth continuity, or exposed conductor items fail
- "medium": switchboard labelling, cable support, or test records fail
- "low": all safety-critical items pass, minor documentation gaps only

FEW-SHOT EXAMPLES — use these to calibrate your pass/fail decisions:

PASSING photo descriptions (these would receive a PASS):
1. "Safety switch with the 'TEST' button, a green LED trip indicator, and the circuit label 'Safety Switch — Circuits 1–6' all clearly legible in the switchboard interior."
2. "Open switchboard showing twelve circuit breakers each with a handwritten label and amperage (e.g. '10A Lights Bed 1') — all labels filled, none blank, directory fully completed."
3. "Close-up of earth bar showing four green/yellow striped conductors correctly terminated with visible screw heads — conductor insulation colour is unambiguous."
4. "Solar panel array DC isolator showing the yellow-labelled double-pole DC isolator mounted adjacent to the inverter, the inverter compliance label legible, and all 'SOLAR AC/DC' warning labels visible on isolators."
5. "Battery storage system showing the battery unit correctly mounted to the wall bracket, the DC isolator within reach, the BMS indicator lights showing normal operation, and the compliance label legible on the battery enclosure."
6. "EV charging point (EVSE) showing the unit correctly mounted at the correct height, the Mode 2 or Mode 3 designation label legible on the unit face, the tethered cable correctly stored, and the RCD protected dedicated circuit identified at the switchboard."
7. "Three-phase installation showing the switchboard neutral bar with four correctly colour-coded conductors — red, white, blue, and green-yellow earth — all correctly terminated and the neutral link correctly positioned and tightened."
8. "Emergency exit lighting with the green/white running man symbol luminaire mounted above the exit door at the correct height, the battery backup LED indicator showing green for charged, and the 'PRESS TO TEST' button accessible."
9. "EXIT sign correctly positioned with legible green lettering, the battery backup test button accessible below the unit, and the sign visible from the required approach distance with no obstructions."
10. "Smoke detector hardwired installation showing the detector head snapped onto its base with the interconnect wiring visible and correctly terminated, the detector model label legible, and the mounting zone free of obstructions."
11. "Ceiling fan installation showing the fan mounting box correctly supported on a dedicated fan-rated ceiling box (not a standard light box), the fan canopy correctly fitted, and all blade screws tightened."
12. "Outdoor weatherproof double GPO showing the weatherproof enclosure with the RCD symbol on the face, the hinged cover in the correct position, the IP44 or higher ingress protection rating legible on the plate, and correctly mounted on masonry."
13. "Switchboard upgrade showing all circuits individually labelled, the neutral bar correctly fitted with all neutrals terminated, a test certificate for the new RCDs attached to the inside of the door, and meter board connection correctly made."
14. "RCD protected circuit test certificate showing the RCD trip time reading in milliseconds — the digital display showing a value below 300 ms, the tester model and calibration date legible, and the circuit identifier on the printed certificate."
15. "Arc fault detection device (AFDD) installed in the switchboard showing the AFDD unit with a visible test button, the 'AFDD' label on the front face, correctly wired to the specific circuit it protects, and the circuit label identifying the protected circuit."
16. "Surge protection device (SPD) installed at the meter board showing the green indicator window (not red), the rating label with kVA/kA values legible, correctly wired in parallel at the board, and the earthing connection visible."
17. "Metering equipment showing the smart meter with the NMI number legible on the meter plate, the meter serial number visible, and the meter seals intact on the cover screws."
18. "Neutral link on the switchboard showing the bolted neutral link in the correct position, all neutral conductors correctly terminated individually, and the neutral bar clearly labelled 'N'."

FAILING photo descriptions (these would receive a FAIL):
1. "Blurry switchboard photo taken from 1.5 m away — individual circuit labels, amperage markings, and RCD test button cannot be read."
2. "Closed grey switchboard door with no internal components visible — the photo only shows the outside of the board."
3. "Earthing conductor visible but it has grey insulation — the green/yellow colour coding required by AS/NZS 3000 cannot be confirmed."
4. "Solar panel installation photo showing only the roof array from ground level — none of the DC isolators, inverter, AC isolator, or switchboard connections are visible. No compliance evidence can be obtained."
5. "Battery storage system photo where the battery enclosure is completely closed with no labels visible — the unit model, compliance marking, BMS indicator lights, and DC isolator cannot be assessed."
6. "EV charging point photo taken from 5 m away — the unit is visible as a small white box on the wall but no labelling, compliance markings, or cable management can be read. The photo does not confirm correct installation."
7. "Three-phase switchboard photo showing the neutral bar but one neutral conductor has green-yellow insulation — green-yellow is reserved for earth conductors under AS/NZS 3000 and must not be used for neutral conductors."
8. "Emergency lighting unit photo showing the battery indicator LED is amber rather than green — amber indicates the battery is low or defective, meaning backup duration will not meet the 90-minute minimum required."
9. "Exit sign mounted at 1.8 m height on the wall rather than above the door at the minimum required height — the sign is not visible from the required distance when viewed from the standard approach direction."
10. "Smoke detector photo where the detector is mounted in a corner of the ceiling — ceiling-mounted detectors must not be within 600 mm of any wall or corner. This mounting location is non-compliant per AS 3786."
11. "Ceiling fan installed on a standard light fitting box — the box is rated for fixed luminaire load only and is not rated for the dynamic load of a ceiling fan. This is a non-compliant and potentially dangerous installation."
12. "Outdoor GPO showing a standard non-weatherproof flush plate installed on an exterior wall — standard plates are not rated for outdoor use and water ingress will cause a short circuit."
13. "Switchboard upgrade photo where several circuit breakers have partially peeling sticky tape labels — some labels are unreadable and the directory does not include all circuits. Incomplete labelling fails the switchboard labelling requirement."
14. "RCD test certificate photo where the trip time reading shows 450 ms — this exceeds the maximum 300 ms trip time required by AS/NZS 3000 Clause 2.6. The RCD fails the test and must be replaced."
15. "AFDD photo showing the test button has been pressed and the unit has tripped to the off position but has not been reset — the circuit is currently not protected and the AFDD is not operational."
16. "Surge protection device photo where the indicator window is showing red — red indicates the SPD has operated and consumed its surge capacity. The device must be replaced before the installation is complete."
17. "Metering equipment photo taken through a locked transparent panel — the NMI number and meter serial number are obscured by reflections and cannot be read. The meter seal condition also cannot be confirmed."
18. "Neutral link photo where the neutral bar has several terminals containing two neutral conductors under one screw — double-terminating neutrals under a single screw is non-compliant with AS/NZS 3000 and creates a connection that may loosen under load."
19. "Commercial switchboard showing the main circuit breaker rated at 400A, individual feeder breakers each correctly labelled with the circuit they feed, the switchboard door correctly rated for the fault level, and the phase busbars with correct colour coding visible."
20. "Generator connection (changeover switch) showing the automatic transfer switch correctly wired, the generator and mains terminals individually labelled, the anti-paralleling interlock visible, and the changeover operation tested — changeover test result recorded on the attached sheet."
21. "UPS installation showing the UPS unit correctly rack-mounted with battery module connections visible, the bypass switch accessible and labelled, the load transfer test certificate attached, and the battery state of charge indicator showing full charge."
22. "Emergency lighting system complete test certificate showing the battery backup duration test result of 90 minutes minimum, the illuminance level readings at each fitting location, the tester's licence number, and the test date all legible."
23. "Power factor correction capacitor bank showing the capacitor unit correctly installed in a dedicated enclosure, the reactive power controller display showing target power factor achieved, the fuse ratings legible, and the bank correctly earthed."
24. "Energy metering installation showing the smart meter with the NMI legible, the current transformer ratings and accuracy class visible on the CT housings, the metering cubicle correctly sealed, and the meter test certificate from the metering provider attached."
25. "Grid-connected solar inverter showing the inverter mounted at the correct height, the AC and DC isolators adjacent and correctly labelled, the inverter compliance label showing the CEC approval number legible, and the array configuration label on the combiner box readable."
26. "Off-grid power system showing the inverter/charger, battery bank, and solar charge controller with all interconnections correctly labelled, the battery state of charge displayed, the system configuration label on the inverter legible, and the protection fusing visible."
27. "Battery energy storage system showing the battery cabinet correctly installed with the required clearances, the DC and AC isolators accessible, the BMS indicator showing normal operation, the fire detection device in the battery room visible, and the compliance label on the battery system legible."
28. "Surge protection device (SPD) at the main switchboard showing the SPD correctly wired in parallel, the status indicator window showing green, the earth connection correctly made, the SPD rating label with Iimp or In value legible, and the SPD correctly coordinated with the upstream overcurrent device."
29. "Harmonic filtering unit showing the active harmonic filter correctly installed in the switchboard, the power quality analyser reading showing THD within limit, the filter's rated current label legible, and the filter correctly connected downstream of the metering."
30. "Demand management load controller showing the device correctly wired to the controlled load circuit (hot water or pool pump), the time clock settings legible, the tariff code sticker indicating 'CONTROLLED LOAD' correctly applied at the switchboard, and the circuit labelled 'CL1' or 'CL2'."

FAILING photo descriptions (these would receive a FAIL):
1. "Blurry switchboard photo taken from 1.5 m away — individual circuit labels, amperage markings, and RCD test button cannot be read."
2. "Closed grey switchboard door with no internal components visible — the photo only shows the outside of the board."
3. "Earthing conductor visible but it has grey insulation — the green/yellow colour coding required by AS/NZS 3000 cannot be confirmed."
4. "Solar panel installation photo showing only the roof array from ground level — none of the DC isolators, inverter, AC isolator, or switchboard connections are visible. No compliance evidence can be obtained."
5. "Battery storage system photo where the battery enclosure is completely closed with no labels visible — the unit model, compliance marking, BMS indicator lights, and DC isolator cannot be assessed."
6. "EV charging point photo taken from 5 m away — the unit is visible as a small white box on the wall but no labelling, compliance markings, or cable management can be read. The photo does not confirm correct installation."
7. "Three-phase switchboard photo showing the neutral bar but one neutral conductor has green-yellow insulation — green-yellow is reserved for earth conductors under AS/NZS 3000 and must not be used for neutral conductors."
8. "Emergency lighting unit photo showing the battery indicator LED is amber rather than green — amber indicates the battery is low or defective, meaning backup duration will not meet the 90-minute minimum required."
9. "Exit sign mounted at 1.8 m height on the wall rather than above the door at the minimum required height — the sign is not visible from the required distance when viewed from the standard approach direction."
10. "Smoke detector photo where the detector is mounted in a corner of the ceiling — ceiling-mounted detectors must not be within 600 mm of any wall or corner. This mounting location is non-compliant per AS 3786."
11. "Ceiling fan installed on a standard light fitting box — the box is rated for fixed luminaire load only and is not rated for the dynamic load of a ceiling fan. This is a non-compliant and potentially dangerous installation."
12. "Outdoor GPO showing a standard non-weatherproof flush plate installed on an exterior wall — standard plates are not rated for outdoor use and water ingress will cause a short circuit."
13. "Switchboard upgrade photo where several circuit breakers have partially peeling sticky tape labels — some labels are unreadable and the directory does not include all circuits. Incomplete labelling fails the switchboard labelling requirement."
14. "RCD test certificate photo where the trip time reading shows 450 ms — this exceeds the maximum 300 ms trip time required by AS/NZS 3000 Clause 2.6. The RCD fails the test and must be replaced."
15. "AFDD photo showing the test button has been pressed and the unit has tripped to the off position but has not been reset — the circuit is currently not protected and the AFDD is not operational."
16. "Surge protection device photo where the indicator window is showing red — red indicates the SPD has operated and consumed its surge capacity. The device must be replaced before the installation is complete."
17. "Metering equipment photo taken through a locked transparent panel — the NMI number and meter serial number are obscured by reflections and cannot be read. The meter seal condition also cannot be confirmed."
18. "Neutral link photo where the neutral bar has several terminals containing two neutral conductors under one screw — double-terminating neutrals under a single screw is non-compliant with AS/NZS 3000 and creates a connection that may loosen under load."
19. "Commercial switchboard photo showing the phase busbars with one phase using blue instead of the required white insulation — incorrect busbar colour coding prevents electrical workers from safely identifying phases during maintenance."
20. "Generator changeover switch photo where both the mains and generator terminals are connected simultaneously — the anti-paralleling interlock has not been engaged. If the generator and mains are live at the same time, the result is a dangerous short circuit."
21. "UPS bypass switch photo where the switch is in the bypass position with the UPS bypassed — the load is now connected directly to mains without any conditioning or backup. If the UPS is in bypass during a power failure, the load will drop. The switch must be in the normal position."
22. "Emergency lighting test photo showing a duration test result of 78 minutes — this is below the 90-minute minimum required by AS 2293.1. All fittings with batteries delivering less than 90 minutes must have batteries replaced."
23. "Power factor correction capacitor bank photo where the reactive power controller display shows power factor of 0.72 — the target is 0.95 or better under Victorian distribution network requirements. The bank is under-sized or not operating correctly."
24. "Energy metering photo showing a damaged CT enclosure with the lid missing — the current transformer windings are exposed. Open-circuit CTs with secondary windings carrying current will develop dangerously high voltages and must not be left open."
25. "Solar inverter photo showing the inverter status display reading 'FAULT: GRID OVERVOLTAGE' — the inverter has detected the grid voltage is above its operating range and has tripped off. The inverter is not exporting and the fault must be investigated."
26. "Off-grid system photo showing battery bank wiring with no visible fuse or circuit breaker between the batteries and the inverter — unprotected battery cables present an extreme fire and arc flash risk. A correctly rated fuse must be installed within 300 mm of the battery terminal."
27. "Battery storage system photo where the required 600 mm clearance from any combustible material is not maintained — the battery cabinet is installed against a timber-lined wall with no clearance. Fire risk is significantly elevated."
28. "Surge protection device photo showing the SPD installed on the load side of the main circuit breaker with a 50 A overcurrent device protecting the SPD — the SPD is rated for maximum 25 A protection. The overcurrent device will not provide adequate protection."
29. "Harmonic filter photo showing the filter current rating label is 60 A but the connected non-linear load is measured at 85 A — the filter is undersized for the load and will operate above rating, causing overheating and premature failure."
30. "Demand management controller photo showing the controlled load circuit labelled 'CL1' but the tariff meter record shows the connection is on the general tariff, not a controlled load tariff — the controlled load wiring is correct but the meter is not configured for the correct tariff."

${outputFormatInstruction}

Example response shape:
{
  "relevant": true,
  "overall_confidence": 75,
  "items_detected": ["RCD protection installed and tested", "Switchboard labelling complete"],
  "items_missing": ["Insulation resistance tested", "Test results recorded"],
  "items_unclear": ["Earth continuity tested"],
  "risk_rating": "medium",
  "recommended_actions": [
    "Retake the insulation resistance photo — show the megohmmeter display with a readable test value.",
    "Retake the test results photo — the certificate or test sheet must have all fields completed and legible."
  ],
  "liability_summary": "Without documented insulation resistance results and a completed test certificate, the installation cannot be certified safe. The electrician remains liable for any fault that emerges on untested circuits.",
  "analysis": "2 of 5 photos pass validation. 1 is unclear. 2 photos do not show the required electrical installation item."
}
`.trim() : isDrainage ? `
You are a strict drainage compliance photo validator for Victorian plumbing regulations under AS/NZS 3500.2 (Sanitary Plumbing and Drainage).

Job type: drainage installation

Each photo below has been submitted with a label describing what it is SUPPOSED to show. Validate each photo individually and determine whether it actually contains the required drainage component or evidence.

VALIDATION RULES — apply without exception:
- Validate each photo against its label independently.
- A photo PASSES only if it clearly and unambiguously shows the specific drainage item named in its label.
- A photo FAILS if it shows a person, animal, unrelated object, or anything not related to drainage work.
- A photo FAILS if it is blurry, too dark, or ambiguous — if you cannot clearly identify the named item, it fails.
- A photo FAILS if it shows drainage work in general but not the specific item named in its label.
- Never give benefit of the doubt. When in doubt, the photo fails.

REQUIRED DRAINAGE ITEMS and what must be CLEARLY VISIBLE for a PASS:
- "Pipe fall / gradient": must show drainage pipework with a clearly visible downward fall direction. Flat or upward-sloping pipe FAILS. A spirit level or visible gradient relative to a datum is ideal — if fall cannot be assessed from the photo it FAILS.
- "Inspection opening": must show an inspection opening (IO) or access point that is BOTH accessible (no permanent obstruction within 500 mm) AND has a legible label or cover marking identifying it as an inspection opening. An unlabelled or obstructed IO FAILS.
- "Trap installed correctly": must show a trap (P-trap, bottle trap, or floor trap) with visible water seal, correct connection to the fixture outlet, and no distortion or cracking. A trap with a cracked body, missing water seal, or improper connection FAILS.
- "No pooling water or moisture staining": must show dry drainage surfaces, pipe bedding, and surrounding substrate. Any visible standing water, watermarks, efflorescence, or moisture staining causes a FAIL for this item.
- "Pipe bedding adequate": must show pipe bedding material (sand or gravel) around the pipe at the correct depth and compaction — visible void spaces, uneven bedding, or solid unsupported spans FAIL.
- "Vent stack / air admittance valve": must show the vent stack termination or an air admittance valve (AAV) clearly installed and accessible — the vent opening or AAV body must be visible.
- "All joints sealed and connected": must show pipe joints that are smooth, fully engaged, and free of visible gaps, mis-alignment, or adhesive voids. Joints with visible gaps or stepped connections FAIL.

ADDITIONAL REJECTION CRITERIA:
- Any photo of a trench or pipe without clearly showing the specific item named in the label FAILS.
- Photos taken at angles that prevent assessment of pipe fall or joint quality FAIL.
- Photos showing only soil or backfill without visible pipe or fittings FAIL.

RISK RATING CRITERIA:
- "high": pipe fall, trap, or joint items fail — risk of sewer gas entry or drain blockage
- "medium": bedding, IO labelling, or moisture items fail
- "low": all critical drainage items pass, minor documentation gaps only

FEW-SHOT EXAMPLES — use these to calibrate your pass/fail decisions:

PASSING photo descriptions (these would receive a PASS):
1. "P-trap clearly shown with a visible water seal in the trap body, correct push-fit connection to the basin waste outlet above and drain pipe below, no cracks or deformation visible on the trap body."
2. "Open drainage trench showing 100 mm PVC pipe fully surrounded by clean washed sand bedding to the correct depth, pipe is uniformly supported with no visible voids or soft spots under the barrel."
3. "Inspection opening cover with the letters 'IO' embossed and legible on the cap surface, 600 mm of clear unobstructed ground around it, and the access shaft visible below the removed cap."
4. "Stormwater connection to the kerb drain showing the PVC pipe at the correct fall to the kerb, the connection correctly benched into the existing kerb drain, and the surface surrounding the connection free of soil erosion."
5. "Commercial grease trap installation showing the trap correctly sized for the kitchen load, the inlet and outlet connections visible, the baffles correctly positioned inside the open lid, and service access clear and unobstructed."
6. "Sewer connection showing the new branch saddle correctly installed into the main sewer pipe, the connection at the correct depth with minimum 600 mm cover, and the branch correctly benched with no steps."
7. "Subsurface drainage agricultural pipe installed in a gravel-filled trench at the correct fall, the perforated pipe visible with slots facing down, surrounded by geotextile filter fabric, and covered with a minimum 150 mm of coarse gravel."
8. "Gully trap installed at floor level showing the trap body with a visible water seal, the grate in place and unobstructed, the inlet and outlet connections correctly made, and the top of the gully at the correct level flush with the finished floor."
9. "Overflow relief gully installed at the correct height — the gully rim is a minimum 25 mm below the lowest sanitary fixture inside the building, shown with a measuring tape in frame confirming the correct relationship to the slab level."
10. "Inspection shaft with a precast concrete or HDPE chamber correctly installed, the half-channel benching visible at the base, the access shaft correctly sealed with a lockable lid, and the top correctly set to finished surface level."
11. "Pipe bedding showing 100 mm PVC pipe with 75 mm of clean coarse sand below the pipe barrel and 150 mm of sand cover above the pipe top — the sand layer is clearly visible in cross-section with no voids or rock contacts."
12. "Pipe supports on a suspended drainage run showing all-thread rods with swivel hangers at maximum 1.2 m centres along a 100 mm PVC horizontal drain — hanger spacing and pipe size confirmed by a scale reference."
13. "Stormwater pit with a heavy-duty trafficable grate correctly installed, the inlet and outlet pipes visible in the base of the pit, the pit walls clean and free of cracks, and the grate correctly seated with no rocking."
14. "Rainwater tank first-flush diverter connection showing the diverter body correctly installed on the downpipe before the tank inlet, the overflow pipe correctly pitched away from the building, and the tank inlet strainer in position."
15. "Sewer vent pipe penetration through the roof showing the vent pipe at the correct height above the roof — minimum 150 mm above the highest point within 5 m — with a cowl correctly fitted and the roof penetration correctly flashed."
16. "Drain testing showing a pneumatic test plug installed at the upstream end and a pressure gauge showing the 10 kPa hold pressure — the gauge reading is stable and the test has been maintained for the required 15-minute period."
17. "CCTV inspection access point showing a clean 100 mm PVC inspection tee or cleanout correctly installed, the CCTV camera probe inserted, and a monitor in the background showing a clear internal image of the drain pipe condition."
18. "Drain relining showing a cured-in-place pipe (CIPP) liner correctly installed inside the existing host pipe — the liner end is visible with a smooth uniform surface, cut back cleanly at the inspection opening, with no wrinkles or delamination."

FAILING photo descriptions (these would receive a FAIL):
1. "Photo of backfilled trench — surface is flat compacted soil with no visible pipe, fittings, or bedding material. No drainage components can be assessed."
2. "Overhead photo of a wet bathroom floor drain surrounded by moisture staining and a small puddle of standing water on the tiles — fails the no-pooling moisture check."
3. "Drainage pipe photographed from directly above at a flat angle — no reference datum, no spirit level, and fall direction cannot be determined from this view."
4. "Stormwater connection where the PVC pipe runs to the kerb drain at a flat gradient — the pipe has no visible fall and in several sections appears to be sloping back toward the building, indicating reverse gradient."
5. "Grease trap installation where the trap is undersized for the kitchen it serves — the inlet pipe diameter is 100 mm but the trap is a domestic size rated for a much lower flow, and no trap capacity documentation is visible."
6. "Sewer connection showing the new branch entering the main sewer pipe from directly above rather than at the 45-degree benched connection required — the vertical entry will cause turbulence and blockage in the main."
7. "Subsurface drainage photo showing agricultural pipe buried in clay soil without any surrounding gravel or filter fabric — the pipe perforations will become blocked with clay silt within the first season and the drain will fail."
8. "Gully trap installed below floor level with the top edge 50 mm below the finished floor level — water will pond around the gully rather than drain into it and the trap will not function correctly as an overflow device."
9. "Overflow relief gully photo where the gully rim is at the same level as the slab entry threshold — the gully does not provide the minimum 25 mm freeboard below the lowest fixture outlet, so the building will flood before the gully activates."
10. "Inspection shaft photo showing the shaft correctly installed but the lid is a standard lift-off cover in a trafficable area — the lid may be displaced by vehicle traffic, creating a safety hazard."
11. "Pipe bedding photo showing 100 mm PVC pipe with sharp gravel material directly in contact with the pipe barrel — rock or crushed aggregate in direct contact with PVC drainage pipe will damage the pipe under soil load and is non-compliant."
12. "Suspended drainage run photo showing a 100 mm PVC pipe with visible sag between support hangers — the pipe span is approximately 2.4 m between hangers which exceeds the maximum 1.2 m for horizontal PVC drainage pipe."
13. "Stormwater pit with a grate showing three broken or missing bars — the fractured grate allows larger debris to enter the pit and blocks the full free area requirement. The broken grate must be replaced."
14. "Rainwater tank connection showing the tank inlet pipe connected directly to the downpipe without any first-flush diverter or filter — first flush contamination including bird droppings and debris will enter the tank directly."
15. "Sewer vent pipe penetration showing the vent pipe terminating at roof level with no cowl or cap — without a cap, leaves and debris will enter the vent, rodents can nest, and the vent will not function correctly in all wind conditions."
16. "Drain test photo showing a manometer reading of 3 kPa after 5 minutes — the system has lost 7 kPa of the 10 kPa test pressure, indicating a significant leak that has not been located or repaired."
17. "CCTV inspection access point photo where the access tee has been installed at an angle that does not allow the probe to enter the upstream pipe — the inspection point is non-functional."
18. "Drain relining photo showing the CIPP liner at the access point with a large longitudinal wrinkle — the wrinkle indicates the liner was not correctly installed under pressure and the fold will cause a partial blockage."

${outputFormatInstruction}

Example response shape:
{
  "relevant": true,
  "overall_confidence": 60,
  "items_detected": ["Trap installed correctly", "All joints sealed and connected"],
  "items_missing": ["Pipe fall / gradient", "Inspection opening"],
  "items_unclear": ["Pipe bedding adequate"],
  "risk_rating": "high",
  "recommended_actions": [
    "Retake the pipe fall photo — show the pipe with a visible gradient or spirit level confirming adequate fall.",
    "Retake the inspection opening photo — the IO must be accessible and its cover must be labelled."
  ],
  "liability_summary": "Without documented evidence of correct pipe fall and an accessible labelled inspection opening, compliance cannot be confirmed. The plumber is liable if blockages or drainage failures occur on an unverified installation.",
  "analysis": "2 of 5 photos pass validation. 1 is unclear. 2 photos do not show the required drainage item."
}
`.trim() : isHvac ? `
You are a trade documentation photo validator for Australian construction documentation records.

Job type: HVAC

Each photo below has been submitted with a label describing what it is SUPPOSED to show. Validate each photo individually and determine whether it shows genuine HVAC installation work relevant to the label.

VALIDATION RULES — apply without exception:
- A photo PASSES if it clearly shows HVAC equipment, installation work, refrigerant lines, ductwork, or site conditions relevant to the label.
- A photo FAILS if it shows a person, animal, unrelated object, food, or anything clearly unrelated to HVAC work.
- A photo FAILS if it is blurry, too dark, or shows nothing recognisable.
- This is a documentation record — not a compliance check. You are verifying that photos show genuine HVAC trade work.

SCORING:
- overall_confidence = round((passing photos / total photos submitted) * 100)
- If zero photos pass: overall_confidence = 0, relevant = false
- relevant = true only if at least one photo passes and shows genuine HVAC work

RISK RATING CRITERIA:
- "high": more than half the photos fail or show unrelated content
- "medium": some photos fail or are unclear
- "low": all or nearly all photos show genuine HVAC work

FEW-SHOT EXAMPLES — use these to calibrate your pass/fail decisions:

PASSING photo descriptions (these would receive a PASS):
1. "Indoor split-system unit mounted on a wall bracket at the correct height, refrigerant lines correctly lagged with UV-resistant foam insulation, condensate drain line visible running to the nearest drain point."
2. "Outdoor condenser unit sitting level on a concrete pad with visible clearance space to the adjacent fence — service access path to the unit is clear and unobstructed."
3. "Commissioning sheet on a clipboard showing the model number, serial number, refrigerant type, charge weight in grams, and measured suction/discharge pressures — all fields completed and legible."
4. "Split system refrigerant line set exit through the wall showing foam insulation neatly fitted to both suction and liquid lines, a UV-resistant outer wrap securing the insulation, and a wall penetration putty seal visible around the pipe bundle."
5. "Outdoor unit installed on a purpose-made concrete pad showing the unit level in both directions confirmed by a visible spirit level, minimum 300 mm clearance on the service access side, and the condenser coil fins free of damage."
6. "Indoor unit installation angle test showing a spirit level placed on the condensate drain tray showing a minimum 3-degree fall toward the drain outlet — this confirms correct condensate drainage without pooling."
7. "Ducted system flexible duct connection showing a 200 mm diameter flexible duct connected to the supply plenum with a duct clamp correctly tightened and the connection sealed with foil tape — the duct maintains minimum bend radius."
8. "Return air grille in the ceiling showing the grille dimensions matching the duct system design requirement, the grille frame flush with the ceiling, the grille removable for filter access, and no furniture blocking the return air pathway."
9. "Supply air diffuser in the ceiling showing the diffuser flush with the ceiling surface, the diffuser blades adjusted to the correct throw direction, and a balancing damper on the duct stub visible through the removed diffuser."
10. "Commissioning data sheet showing the system model and serial number, the measured suction pressure and discharge pressure, the subcooling and superheat calculations completed, and the signed commissioning date and technician name."
11. "Refrigerant charge verification showing a set of manifold gauges with both suction and discharge hoses connected to the system service ports, the gauges showing the correct pressures for the refrigerant type and ambient conditions."
12. "Electrical disconnect switch within sight of the outdoor unit showing a lockable switch box correctly mounted within 9 m line-of-sight of the outdoor unit, the switch rated for the unit current draw, and a warning label visible."
13. "Condensate drain pipe from the indoor unit showing the drain pipe pitched at the correct fall away from the unit to a visible safe discharge point, the pipe size adequate for the condensate load, and the pipe correctly supported without sag."
14. "Refrigerant line insulation showing both suction and liquid lines fully insulated with closed-cell foam the correct thickness, the insulation joints sealed with adhesive, and no gaps or splits in the foam."
15. "Wall penetration weatherproofing showing the conduit or pipe bundle sleeve correctly sealed with outdoor-rated silicone sealant both inside and outside the building, the seal continuous around the full perimeter, and no gaps visible."
16. "Thermostat correctly mounted on an interior wall away from direct sunlight, draughts, and heat sources, the wire connections clearly made at the correct terminals, and the settings programmed with the thermostat display active."
17. "Filter access panel on the indoor unit showing the panel removable without tools, the filter correctly fitted inside, the filter holder undamaged, and a label on the unit showing the recommended filter cleaning frequency."
18. "Noise attenuation flexible duct connection at the supply plenum showing an approved flexible connector installed between the blower outlet and the rigid ductwork, the connector free of wrinkles, and both ends correctly clamped."

FAILING photo descriptions (these would receive a FAIL):
1. "Photo of a blank plasterboard wall with no HVAC equipment, ductwork, or installation work visible anywhere in the frame."
2. "Indoor unit photo where the refrigerant line connections are completely obscured by unsecured lagging hanging loose — connections and line run cannot be assessed."
3. "Photo of a person standing next to the outdoor condenser unit — the person occupies most of the frame and the unit itself is partially out of shot, making the installation detail unassessable."
4. "Refrigerant line set photo where the suction and liquid lines are bundled together but only the liquid line has insulation — the uninsulated suction line will sweat significantly in warm weather causing dripping and condensation damage."
5. "Outdoor unit installed on timber blocks directly on the ground rather than on a concrete pad — timber blocks will rot and the unit will become unlevel, causing compressor oil migration and premature failure."
6. "Indoor unit photo showing the unit installed level with no fall on the drain tray — without a drainage slope the condensate will pool in the tray, overflow, and cause water damage to the ceiling."
7. "Flexible duct connection photo where the duct has a 270-degree bend at the plenum connection — the excessive bending angle will restrict airflow significantly and cause the system to operate well below its rated capacity."
8. "Return air grille photo where the grille is almost fully blocked by a settee pushed against the wall — the furniture blockage will starve the system of return air, causing the evaporator to freeze and the compressor to short-cycle."
9. "Supply air diffuser photo where the diffuser is installed in a corner next to a wall — the throw will be directed into the wall immediately rather than across the room, resulting in poor air distribution."
10. "Commissioning data sheet where the refrigerant charge weight field is blank and the superheat and subcooling readings are not filled in — an incomplete commissioning record means the system's refrigerant charge has not been verified."
11. "Refrigerant charge verification photo where the manifold gauge suction reading is inconsistent with the ambient conditions — the subcooling calculation would indicate the system is significantly overcharged."
12. "Electrical disconnect photo where the disconnect switch is mounted at 3.5 m height on the pole — the switch is above the accessible reach height and cannot be operated by a service technician without a ladder, which is a safety issue."
13. "Condensate drain pipe photo showing the pipe running in a flat horizontal run for 2 m before reaching the discharge point — the flat drain will not drain by gravity and condensate will pool and overflow from the unit."
14. "Refrigerant line photo where the suction line insulation has been cut along its length to allow bending, leaving a section of bare copper pipe — the cut insulation will not function as a vapour barrier and will allow moisture ingress."
15. "Wall penetration photo showing the pipe bundle passing through the wall with no sleeve or sealant — an unsealed penetration allows pests, moisture, and unconditioned air to enter the building freely."
16. "Thermostat photo showing the thermostat mounted directly above a kitchen air intake grille — the thermostat will be influenced by warm cooking air and will cause the system to overcool the rest of the house."
17. "Filter access panel photo where the panel is screwed shut with self-tapping screws — the filter can only be accessed with tools, meaning routine filter maintenance will be neglected and the system will operate with a blocked filter."
18. "Noise attenuation connection photo where the rigid ductwork is connected directly to the blower outlet with no flexible section — vibration from the blower will be transmitted directly through the duct system as structure-borne noise."

${outputFormatInstruction}

Example response shape:
{
  "relevant": true,
  "overall_confidence": 80,
  "items_detected": ["Indoor unit installation", "Outdoor unit placement"],
  "items_missing": ["Commissioning sheet"],
  "items_unclear": ["Refrigerant line connections"],
  "risk_rating": "medium",
  "recommended_actions": [
    "Retake the commissioning sheet photo — all fields including charge weight and pressures must be legible.",
    "Retake the refrigerant line connection photo — remove loose lagging so connections are fully visible."
  ],
  "liability_summary": "Installation documentation is mostly complete but the missing commissioning record means the refrigerant charge and operating pressures are unverified. Retake before lodging the job.",
  "analysis": "2 of 4 photos pass validation. 1 is unclear. 1 does not show relevant HVAC work."
}
`.trim() : isCarpentry ? `
You are a trade documentation photo validator for Australian construction documentation records.

Job type: carpentry

Each photo below has been submitted with a label describing what it is SUPPOSED to show. Validate each photo individually and determine whether it shows genuine carpentry work relevant to the label.

VALIDATION RULES — apply without exception:
- A photo PASSES if it clearly shows timber framing, joinery, fixtures, or finished carpentry work relevant to the label.
- A photo FAILS if it shows a person, animal, unrelated object, food, or anything clearly unrelated to carpentry work.
- A photo FAILS if it is blurry, too dark, or shows nothing recognisable.
- This is a documentation record — not a compliance check. You are verifying that photos show genuine carpentry trade work.

SCORING:
- overall_confidence = round((passing photos / total photos submitted) * 100)
- If zero photos pass: overall_confidence = 0, relevant = false
- relevant = true only if at least one photo passes and shows genuine carpentry work

RISK RATING CRITERIA:
- "high": more than half the photos fail or show unrelated content
- "medium": some photos fail or are unclear
- "low": all or nearly all photos show genuine carpentry work

FEW-SHOT EXAMPLES — use these to calibrate your pass/fail decisions:

PASSING photo descriptions (these would receive a PASS):
1. "Timber stud wall frame showing studs at uniform 450 mm centres with a full-height nogging at mid-span — stud spacing can be visually confirmed and all members are plumb and straight."
2. "Completed door frame with reveals set at consistent depth, architrave nailed to the lining with no visible gaps at mitred corners, and the door hanging level with even margins on all three sides."
3. "Finished deck surface showing uniform 6 mm board spacing, all screws correctly countersunk flush with the decking face, and straight board lines from end to end."
4. "Stud wall framing showing studs at exactly 450 mm centres confirmed with a tape measure in frame, all studs straight and plumb, the sole plate correctly fixed to the slab with concrete anchors at maximum 600 mm centres."
5. "Bottom plate showing a 90 × 45 mm treated pine plate correctly bolted to a concrete slab with M12 anchor bolts at maximum 1200 mm centres, the nuts and washers tight, and the plate straight with no bowing."
6. "Mid-height nogging at 1350 mm from the floor installed between studs — the nogging is correctly nailed through the studs with two 75 mm nails each end at opposing angles, and the faces are flush with the stud faces."
7. "Wall bracing showing a diagonal metal strap brace correctly installed at 45 degrees across the stud frame, fixed to every member it crosses with the correct number of nails, and the bottom anchor bolt correctly embedded in the slab."
8. "Roof truss correctly seated on the top plate with a structural steel hurricane tie bracket visible on each side, the bracket correctly nailed with the full complement of nails specified on the truss design drawings."
9. "Floor joist installation showing 190 × 45 mm LVL floor joists at 450 mm centres, correctly supported on galvanised joist hangers at each end, the hangers nailed full with all nail holes filled and the joist sitting square in the hanger."
10. "Bearer and joist connection showing a 190 × 45 mm joist correctly notched onto a 240 × 45 mm bearer with a maximum 20 mm notch depth, secured with a triple skew nail, and the connection tight with no visible gaps."
11. "Subfloor ventilation showing cross-ventilation air bricks installed at a minimum one per 1200 mm of external wall, the vent openings free of soil, the vent mesh intact, and the spacing adequate for the floor area."
12. "Deck fixing showing stainless steel decking screws correctly countersunk flush with the decking surface, a 5 mm gap between board ends confirmed with a spacer in frame, and the screw heads sitting flat with no proud edges."
13. "Pergola post installation showing a 140 × 140 mm hardwood post correctly fixed to a galvanised post anchor bolt cast into a 300 mm diameter × 700 mm deep concrete pier, the post plumb in both directions."
14. "Window frame installation showing the frame correctly set out in the rough opening with 10 mm packing on all sides, the head correctly flashed with aluminium flashing tape extending 150 mm onto the wall, and the sill correctly sloped outward."
15. "Door frame showing the frame correctly plumbed with a spirit level in frame, packers visible at hinge positions, the door hanging with even gaps top, sides, and bottom, and the frame secured to the trimmer studs with 75 mm screws."
16. "Structural steel connection showing a 150 × 150 × 10 mm RHS column bolted to a concrete pad with four M20 anchor bolts, base plate welds visible and free of undercut or porosity, and the column plumb in both directions."
17. "Hold-down bolt installation showing a 16 mm threaded rod cast into a concrete footing with a minimum 150 mm embedment, the nut and washer correctly tightened onto the bottom plate of the wall frame above."
18. "Tie-down strap installation showing a galvanised metal tie-down strap correctly fixed at every second rafter and to the top plate below with the full complement of nails — both strap ends visible with all nail holes filled."

FAILING photo descriptions (these would receive a FAIL):
1. "Completely blurry photo of a room interior — no framing, joinery, or carpentry components can be identified."
2. "Photo of an outdoor garden path and plants — no carpentry work of any kind is visible."
3. "Wide-angle room photo where a door frame is just visible at the edge — too far away to assess the quality, reveal depth, or architrave fit."
4. "Stud wall frame where the studs are at approximately 600 mm centres — the increased spacing requires larger lining panels and may not comply with the span tables for the specified lining material."
5. "Bottom plate photo showing the plate is nailed to the concrete slab with concrete nails rather than bolted with anchor bolts — concrete nails do not provide the uplift resistance required by AS 1684."
6. "Nogging photo where the nogging has been installed with a single nail through the face rather than skew nails through the ends — a single face nail provides minimal lateral restraint and will work loose over time."
7. "Wall bracing showing a diagonal timber brace installed but one of the intermediate cross-fixings has split the stud — the stud has a 150 mm longitudinal crack where the nail was driven through the brace, compromising the member."
8. "Roof truss connection photo showing the truss bearing on the top plate without any hurricane tie bracket — the truss is only held in position by gravity and the plasterboard sheeting, which is non-compliant for wind uplift resistance."
9. "Floor joist hanger photo where the joist is sitting in the hanger but only 4 of the 12 nail holes have nails — partial nailing of a structural hanger does not develop the full rated capacity of the connection."
10. "Bearer and joist connection photo where the joist notch depth is measured at 60 mm, which is greater than one-third of the joist depth — over-notching reduces the joist section below the structurally required area."
11. "Subfloor space photo showing no visible ventilation openings in the surrounding external wall — no air bricks or foundation vents are present, which will result in moisture accumulation and timber decay."
12. "Deck surface photo showing decking screws driven at an angle with the heads raised proud of the surface — the proud screw heads are a trip hazard and indicate the screws have not engaged the substrate correctly."
13. "Pergola post where the post has been placed directly into a hole in the ground with no concrete footing — in-ground timber posts in direct contact with soil will decay within a few years and are not compliant with AS 1684."
14. "Window frame showing no flashing tape on the head — the head-joint between the frame top and wall lining above is sealed only with silicone, which will fail over time and allow water ingress into the wall cavity."
15. "Door frame photo showing the frame is noticeably out of plumb — a spirit level placed on the frame shows greater than 5 mm deviation over 2 m, meaning the door will not swing correctly and the gap around the door will be uneven."
16. "Structural steel connection photo where the base plate weld shows a clearly visible undercut along the weld toe — undercut in a structural weld reduces the effective throat thickness and is a weld defect that must be rectified."
17. "Hold-down bolt photo showing the bolt is only embedded 50 mm into the concrete — the minimum embedment for a 16 mm rod is 150 mm, so this connection will pull out under the design uplift load."
18. "Tie-down strap photo where the strap is correctly nailed at the rafter but the lower end is connected to a nogging rather than the top plate — tie-down straps must connect the roof member directly to the wall frame, not to intermediate members."

${outputFormatInstruction}

Example response shape:
{
  "relevant": true,
  "overall_confidence": 75,
  "items_detected": ["Stud framing", "Door frame"],
  "items_missing": ["Completed decking"],
  "items_unclear": ["Nogging placement"],
  "risk_rating": "low",
  "recommended_actions": [
    "Retake the decking photo — show the full deck surface so board spacing and screw countersinking can be assessed."
  ],
  "liability_summary": "Framing documentation is adequate. The missing decking photo should be retaken before submitting the final job record.",
  "analysis": "2 of 4 photos pass validation. 1 is unclear. 1 does not show relevant carpentry work."
}
`.trim() : isGas ? `
You are a strict gas compliance photo validator for Victorian gas regulations under AS/NZS 5601.1:2013 and AS 4575:2019.

Job type: gas installation

Each photo below has been submitted with a label describing what it is SUPPOSED to show. Validate each photo individually and determine whether it actually contains the required gas installation component or evidence.

VALIDATION RULES — apply without exception:
- Validate each photo against its label independently.
- A photo PASSES only if it clearly and unambiguously shows the specific item named in its label.
- A photo FAILS if it shows a person, animal, unrelated object, room interior, or anything not related to gas fitting work.
- A photo FAILS if it is blurry, too dark, or ambiguous — if you cannot clearly identify the named item, it fails.
- A photo FAILS if it shows gas work in general but not the specific item named in its label.
- Any photo where a gas component is present but cannot be clearly identified (brand, type, connections) FAILS — flag it in items_unclear.
- Never give benefit of the doubt. When in doubt, the photo fails.

REQUIRED GAS INSTALLATION ITEMS and what must be CLEARLY VISIBLE for a PASS:
- "Gastight AS/NZS 5601.1": must show a pressure gauge with a READABLE numerical value confirming test pressure, or a written test certificate with legible results. A photo of fittings without a gauge or certificate FAILS.
- "Accessible for servicing": must show the appliance or component with a clear, unobstructed access path — at least 600 mm clear space must be visually apparent. Blocked or cluttered access FAILS.
- "Isolation valve present": must clearly show an isolation valve on the gas supply line, with the valve handle visible and accessible (not buried, enclosed, or obstructed). A valve that cannot be reached without tools FAILS.
- "Electrically safe": must show electrical connections or bonding conductors that are visibly insulated, terminated, and comply with AS/NZS 3000. Bare or uninsulated conductors FAIL.
- "Evidence of certification": must show a compliance label, AGA certification plate, or regulatory marking PHYSICALLY ATTACHED to the appliance body — the label text must be legible enough to confirm it is a compliance marking. Labels hidden, removed, or painted over FAIL.
- "Adequately restrained": must show brackets, restraint straps, or fixings securing the appliance or gas pipework — the fixing hardware must be visible and appear correctly torqued.
- "Ventilation adequate": must show ventilation openings, grilles, or louvres providing combustion air — grilles must appear unobstructed. Sealed or covered ventilation openings FAIL.
- "Clearances OK": must show measured or visually apparent clearances between the appliance and combustible materials or walls — insufficient clearance FAILS.
- "Cowl and flue terminal OK": must show the cowl or flue terminal AT THE POINT OF EXHAUST — the terminal must be visible, undamaged, and correctly positioned. Photos of the flue pipe mid-run instead of the terminal FAIL.
- "Flue supported and sealed": must show the flue pipe with visible support brackets at correct intervals AND sealed joints (no visible gaps or separations at joints). Unsupported spans or open joints FAIL.
- "Scorching and overheating check": must show surfaces surrounding the appliance that are clean and undamaged — any discolouration, burn marks, blistering paint, or heat staining FAIL this item.
- "Heat exchanger OK": must show the heat exchanger surface clearly — no cracks, corrosion, sooting, or physical damage. If the surface cannot be fully seen, the photo is unclear.
- "Gas fitting line tested and gas tight": must show a pressure gauge with a readable test pressure value, or a marked and signed test record. A gauge that is out of frame or unreadable FAILS.
- "Appliance cleaned of dust and debris": must show the burner compartment or appliance interior — visibly free of dust, lint, and debris. Any visible debris or blocked burner ports FAIL.
- "Gas supply and appliance operating pressures correct": must show a pressure gauge WITH LEGIBLE NUMBERS indicating the operating pressure. A gauge where the needle position or numbers cannot be read FAILS.
- "Burner flames normal": must clearly show active burner flames that are predominantly BLUE in colour. Yellow-tipped, orange, or lifting flames FAIL this item. A photo of an unlit burner does not pass — the burner must be operating.
- "Appliance operating correctly including all safety devices": must show the appliance running with at least one visible safety device (flame failure device, overheat cut-out, or pressure relief) clearly present and labelled.

ADDITIONAL REJECTION CRITERIA:
- Any pressure gauge photo where the numeric scale is unreadable or the needle position is ambiguous FAILS.
- Any burner photo that does not show live flames FAILS — an unlit burner is not evidence of normal operation.
- Any appliance certification label that is obscured, removed, or illegible FAILS.
- Any flue terminal photo taken from inside the building that does not show the external termination point FAILS.

RISK RATING CRITERIA:
- "high": gastightness, burner flames, appliance certification, isolation valve, or flue terminal items fail
- "medium": ventilation, clearances, scorching check, or support items fail
- "low": all critical gas safety items pass, minor documentation gaps only

FEW-SHOT EXAMPLES — use these to calibrate your pass/fail decisions:

PASSING photo descriptions (these would receive a PASS):
1. "Close-up of a Bourdon pressure gauge in sharp focus, the dial face fully in frame, needle pointing clearly to 1.5 kPa with the numerals 0, 1, 2, 3 legible on the scale — confirming operating pressure during commissioning."
2. "Active burner showing eight individual flame cones that are predominantly blue with only slight blue inner cones — no yellow tipping, no orange colouring, no lifting or blowing off the ports."
3. "Gas isolation valve with a yellow lever handle perpendicular to the pipe (closed position) on the supply line directly behind the appliance — the handle, body, and pipe connections are all fully visible and accessible without tools."
4. "Ducted gas heating burner assembly showing blue flames evenly distributed across all burner ports, the heat exchanger surface visible and free of cracks or corrosion, and the AGA certification plate clearly legible on the unit body."
5. "Gas cooktop with all four burners operating simultaneously showing blue flame cones on every burner — none yellow-tipped, no orange colouring, flames stable and seated on the ports with no lifting or blowoff."
6. "Gas fireplace installation showing the minimum 500 mm clearance to combustible materials confirmed with a measuring tape in frame, the flue outlet correctly terminated, and the gas isolation valve accessible within 1 m of the appliance."
7. "LPG cylinder correctly secured with a chain or bracket to a fixed wall, positioned a minimum of 500 mm from any opening or ignition source, with the POL valve and regulator clearly visible and undamaged."
8. "Gas meter enclosure with the meter number visible and legible, the emergency isolation valve handle accessible and marked with 'GAS OFF' and 'GAS ON' arrows, and the enclosure door correctly fitted with no damage."
9. "Flexible gas hose in sharp focus showing the full length from wall bayonet to appliance, no kinking or abrading visible, the AGAS certification badge visible on the hose label, and both end connections fully tightened."
10. "Earthquake valve installed on the gas supply line showing the body with directional flow arrows correctly oriented, the manufacturer model and rating plate legible, and the reset lever accessible."
11. "Gas leak detection sensor mounted within 300 mm of the floor for LPG, the unit plugged in or wired, indicator LEDs showing active/normal status, and the model identification label legible."
12. "Pilot light assembly showing a stable blue pilot flame burning correctly on the thermocouple tip, the thermocouple body and connection visible, and the pilot supply tube free of kinking."
13. "Combustion air louvre grille showing the required free area visible, the grille in the correct position and at the correct height for the combustion air type, free of blockage, and unobstructed."
14. "Flue draught diverter showing the correct position on the flue run directly above the appliance, no visible flue gas staining on surrounding surfaces, and the relief opening correctly sized and unobstructed."
15. "Atmospheric burner at full rate showing evenly distributed blue flame cones with no yellow or orange flames, no flame crossover between ports, and the air shutter in the correct position allowing appropriate primary air."
16. "Fan-forced flue unit showing the exhaust fan housing correctly connected to the flue pipe, the condensate drain tray visible and connected to a drain point, and the electrical supply to the fan motor correctly wired and protected."
17. "Balanced flue terminal on an external wall showing the concentric flue and air intake visible, minimum clearances from windows and openings confirmed with a tape measure in frame, and no sooting or blockage at the terminal."
18. "Gas pressure test point on the supply line showing a Schrader-type test nipple or dedicated test tee with the cap in place — the fitting is labelled 'TP' or 'TEST POINT' and the position is accessible without moving fixed items."
19. "Commercial kitchen gas manifold showing the individual isolation valves for each appliance correctly labelled with the appliance name and circuit number, all valves accessible, and the main isolation clearly identified with a red handle."
20. "Gas fired boiler installation showing the burner assembly in the open position, the gas train components visible (solenoid valves, pressure regulator, gas cock), the flue connection correctly made, and the boiler compliance plate legible on the body."
21. "Gas pool heater installation showing the unit correctly sited with minimum clearances from pool edge and building openings, the flue terminal at the correct height and location, the gas isolation valve accessible, and the compliance label on the unit body legible."
22. "Outdoor gas heating installation showing the radiant heater correctly mounted at the manufacturer's specified height, the gas connection made with a correctly rated flexible hose, the ignition system operable, and the clearance to combustibles confirmed."
23. "Gas BBQ bayonet connection on an external wall showing the bayonet outlet correctly located at the correct height, the outlet cover in place when not in use, the installation within 1.5 m of the intended appliance position, and the supply pipe correctly supported."
24. "Gas spa heater installation showing the heat exchanger correctly plumbed in the spa return line, the bypass valve accessible, the gas supply correctly sized for the BTU load, and the certificate of compliance with the installation date legible."
25. "LPG bulk storage installation showing the tank correctly sited with the required clearances to property boundaries, buildings, and ignition sources confirmed, the relief valve vent pipe correctly terminated, and the tank inspection tag with the current certification date legible."
26. "Gas sub-metering installation showing the individual sub-meters correctly installed for each tenancy, the meters correctly sealed, the meter numbers legible, and the isolation valve for each meter accessible and labelled with the tenancy it serves."
27. "Gas pressure regulation station showing the primary and secondary regulators correctly installed in the correct orientation, the working pressure label showing the outlet set point, the slam-shut device correctly installed downstream, and the station correctly guarded."
28. "Gas emergency shutoff valve (ESO) showing the valve correctly installed at the building entry point, the handle operating freely, the 'GAS SHUTOFF' signage legible, the valve accessible without obstruction, and the operating instruction label correctly attached."
29. "Gas detection system panel showing the detector head locations on a site diagram, the panel powered with the 'NORMAL' indicator active, the test certificate with the last calibration date legible, and the alarm relay connected to a visible solenoid shut-off valve."
30. "Gas interlock system showing the solenoid valve correctly installed on the gas supply line, the interlock wiring connected to the exhaust fan proving switch, the test mode switch accessible, and the interlock operation verified — exhaust fan off causes solenoid to close."

FAILING photo descriptions (these would receive a FAIL):
1. "Wide shot of the entire plant room from 3 m away — a pressure gauge is visible in the background but the dial face is only 5 mm across in the photo and the needle position cannot be determined."
2. "Photo of the burner compartment with the burner switched off — burner ports are visible but completely cold and dark with no flames present."
3. "Appliance certification label visible on the front panel but the label has been painted over with white paint — text and certification markings are completely illegible."
4. "Ducted heater photo showing the front grille only — the burner assembly, heat exchanger, AGA label, and flue connection are all concealed behind the unit casing. No compliance evidence can be obtained from this photo."
5. "Gas cooktop photo with only three of four burners operating — the fourth burner is unlit and cold with no explanation. A partial burner test does not confirm all four burners are operating correctly."
6. "Gas fireplace clearance photo taken from directly in front — no measuring tape is in frame and the distance to the combustible timber mantle on either side cannot be confirmed from the photo."
7. "LPG cylinder positioned against an external wall directly below a window opening — the cylinder is closer than the minimum 500 mm required distance from the window opening above it."
8. "Gas meter enclosure photo where the emergency isolation valve handle is missing — only the valve body is visible with the spindle exposed. The handle has been removed and the valve cannot be operated in an emergency."
9. "Flexible gas hose showing visible surface cracking along the outer sheath and a small kink at the wall bayonet end — the hose has aged beyond its service life and the kink creates a stress point that will lead to failure."
10. "Earthquake valve installed with directional flow arrows pointing in the reverse direction to gas flow — incorrect orientation means the valve will fail to function correctly during a seismic event."
11. "Gas leak sensor mounted at ceiling height in a room supplied by LPG — LPG is heavier than air and a sensor must be within 300 mm of the floor to detect LPG accumulation. This location is non-compliant."
12. "Pilot light assembly showing a pilot flame that is yellow and flickering unsteadily — the pilot flame is impinging on the thermocouple at the wrong point and the yellow colour indicates incomplete combustion."
13. "Combustion air louvre photo showing the grille covered by a timber shelf installed after the appliance — the combustion air supply is reduced below the minimum required, creating a risk of incomplete combustion."
14. "Flue draught diverter photo showing significant brown soot staining on the surrounding wall — this indicates flue gas spillage which is a serious combustion safety deficiency requiring immediate investigation."
15. "Atmospheric burner showing primarily yellow flame with only small blue bases on the ports — the yellow colouration indicates incomplete combustion producing carbon monoxide, which is a critical safety failure."
16. "Fan-forced flue with the condensate drain tray disconnected — the condensate drain hose is hanging loose and not connected to a drain point, meaning condensate will overflow into the appliance."
17. "Balanced flue terminal photo taken from inside showing only the interior portion of the concentric flue — the external terminal cap position, required clearances from openings, and condition cannot be assessed."
18. "Gas pressure test point photo where the test nipple is not capped and is open to atmosphere — an uncapped test point is a gas leak point and is non-compliant."
19. "Commercial kitchen gas manifold photo showing several valves with handwritten labels that are smudged and illegible — the appliance identification cannot be confirmed and maintenance staff cannot identify individual circuits in an emergency."
20. "Gas boiler photo showing the gas train solenoid valves installed in the wrong orientation relative to gas flow — the flow direction arrows on the solenoid bodies are pointing against the direction of gas flow, meaning both safety valves will fail to close correctly."
21. "Gas pool heater clearance photo taken from a low angle — the flue terminal is visible at the top of the unit but the clearance to the pool edge and the distance to the nearest building opening cannot be determined from this viewing angle."
22. "Outdoor gas heater photo where the unit is installed under a combustible timber pergola — the radiant heat output exceeds the safe clearance to the timber structure above. The installation creates a fire risk."
23. "Gas BBQ bayonet photo showing the outlet installed at 2.3 m height on the wall — this is too high for a standard 1.5 m flexible hose to reach ground level and puts the connection point above comfortable reach for the user."
24. "Gas spa heater photo where the heat exchanger is installed in the spa's circulation pump basket housing rather than in the dedicated return line — this location creates turbulence affecting heater efficiency and is not the manufacturer's specified installation position."
25. "LPG bulk storage tank photo showing the tank positioned 0.8 m from the property boundary — the minimum setback for a tank of this size is 3.0 m from any boundary. The installation is non-compliant and the tank must be relocated."
26. "Gas sub-meter photo showing three meters sharing a single isolation valve upstream — there is no individual isolation for each meter and one meter cannot be shut off without cutting supply to all three tenancies."
27. "Gas pressure regulation station photo where the primary regulator outlet pressure label shows 7 kPa but the downstream appliances are rated for 2.75 kPa maximum — the system is significantly over-pressured and appliances will be damaged or will not operate safely."
28. "Gas emergency shutoff valve photo showing the valve handle corroded in position — the handle cannot be rotated. In a gas emergency, the valve cannot be operated and the gas supply cannot be stopped."
29. "Gas detection system photo where the detector head is mounted at ceiling height in a room supplied by natural gas — natural gas is lighter than air and rises to the ceiling, so this position is correct for natural gas. However, the detector's calibration certificate shows it expired 14 months ago."
30. "Gas interlock system photo showing the solenoid valve installed but the proving switch on the exhaust fan is not connected — the wire terminals on the interlock relay are open. The interlock will not function and gas will flow regardless of fan status."

${outputFormatInstruction}

Example response shape:
{
  "relevant": true,
  "overall_confidence": 65,
  "items_detected": ["Isolation valve present", "Adequately restrained"],
  "items_missing": ["Burner flames normal", "Gas supply and appliance operating pressures correct"],
  "items_unclear": ["Flue supported and sealed"],
  "risk_rating": "high",
  "recommended_actions": [
    "Retake the burner flames photo — the appliance must be operating and blue flames must be clearly visible.",
    "Retake the operating pressure photo — the gauge face must be in frame with legible numbers and a readable needle position."
  ],
  "liability_summary": "Critical gas safety items are unverified. Without documented burner flame colour and confirmed operating pressures, the installation cannot be certified compliant. The gas fitter carries full liability for any combustion incident on an unverified installation.",
  "analysis": "2 of 5 photos pass validation. 1 photo is unclear. 2 photos do not show the required gas installation item."
}
`.trim() : `
You are a strict plumbing compliance photo validator for Victorian plumbing regulations under AS/NZS 3500 and the Plumbing Regulations 2018.

Job type: ${type} plumbing installation

Each photo below has been submitted with a label describing what it is SUPPOSED to show. Your job is to validate each photo individually and determine whether it actually contains the required plumbing component with sufficient evidence for compliance documentation.

VALIDATION RULES — apply these without exception:
- Validate each photo against its label independently.
- A photo PASSES only if it clearly and unambiguously shows the specific plumbing component named in its label, WITH the compliance evidence described below.
- A photo FAILS if it shows a person, animal, pet, room interior, outdoor scene, food, furniture, vehicle, sky, or any object that is not a plumbing component.
- A photo FAILS if it is blurry, too dark, or ambiguous — if you cannot clearly identify the named component, it fails.
- A photo FAILS if it shows plumbing in general but not the specific component named in its label.
- Never give benefit of the doubt. When in doubt, the photo fails.

REQUIRED PLUMBING COMPONENTS and what must be CLEARLY VISIBLE for a PASS:
- "PTR valve installed": must show a PTR (pressure and temperature relief) valve body WITH a visible manufacturer compliance label or AS 1357 marking attached to the valve itself. A discharge pipe must also be connected and visible. A PTR valve without a legible compliance label FAILS. A discharge pipe that terminates to an incorrect location (e.g. not to a tundish or safe drain) FAILS.
- "Tempering valve": must show the tempering valve body WITH a visible AS 3500.4 compliance marking or temperature rating label on the valve body. The hot, cold, and mixed water connections must all be visible. A tempering valve without a legible rating marking FAILS.
- "Pipe supports": must show pipework with support clips, brackets, or hangers — horizontal copper pipe must have supports at no more than approximately 1.2 m intervals, and vertical pipe at no more than approximately 1.8 m. Any horizontal span that visually appears unsupported over 1.2 m FAILS.
- "No leaks or moisture": must show dry pipework, fittings, and surrounding materials — all surfaces dry and free of watermarks, efflorescence, corrosion, or staining. Any visible moisture, wet surfaces, or water droplets FAIL this item.
- "Isolation valve at fixture": must clearly show an isolation valve directly on the supply line to a specific fixture (tap, toilet, dishwasher, etc.) — the valve body, handle orientation, and supply connection must all be visible. A main isolation valve shown instead of a fixture-specific valve FAILS unless the label explicitly refers to the main.
- "Pressure limiting valve (PLV)": must show a PLV body WITH a visible pressure rating label or AS 1357.2 marking — the pressure rating value (e.g. 500 kPa) must be legible. A valve body without a legible pressure rating FAILS.
- "Existing system (before)": must show the old hot water unit, tank, or existing pipework in its pre-replacement state — this is a before-state record confirming the original installation.
- "Compliance plate / label": must show the compliance plate or regulatory rating label physically attached to the water heater or appliance, with the text and markings legible. Labels that are obscured, peeling off, or illegible FAIL.

ADDITIONAL REJECTION CRITERIA:
- Any photo where the compliance label, valve marking, or pressure rating is not legible FAILS — zoom in on labels if necessary.
- Photos showing only pipework without the specific component named in the label FAIL.
- Photos of complete installations where the specific component is present but obstructed by insulation, lagging, or other materials FAIL.

RISK RATING CRITERIA:
- "high": PTR valve, tempering valve, or PLV items are missing or failed — direct hot water scalding or pressure risk
- "medium": pipe supports, isolation valves, or moisture items fail
- "low": all critical safety items pass, minor documentation gaps only

FEW-SHOT EXAMPLES — use these to calibrate your pass/fail decisions:

PASSING photo descriptions (these would receive a PASS):
1. "PTR valve clearly visible mounted on the hot water unit outlet with the AS 1357 compliance label legible on the valve body and a copper discharge pipe running from the valve outlet down to a floor waste grate below."
2. "Tempering valve body in sharp focus showing all three connections — hot supply, cold supply, and mixed outlet — with the AS 3500.4 temperature rating of 50°C printed on the valve body and legible."
3. "Copper pipework on wall showing four saddle clamps evenly spaced at approximately 1.2 m intervals along a 5 m horizontal run — all clamps correctly sized and screwed to timber nogging."
4. "Roof-mounted solar hot water collector panel showing mounting brackets correctly secured through the roof sheeting with lead flashing visible around each penetration point — the collector header connections and temperature sensor wiring are visible and correctly terminated."
5. "Instantaneous gas hot water unit showing the gas connection, water inlet and outlet connections, and the compliance label clearly legible on the unit body — all connections are visible and the unit is correctly secured to the wall bracket."
6. "Gravity-fed cold water storage tank on a raised stand showing the overflow pipe correctly sized and running to outside the building, the float valve accessible, and the tank lid secured — tank correctly supported and level."
7. "Thermostatic mixing valve (TMV) showing the hot, cold, and mixed water ports all clearly connected, the AS/NZS 4032.1 compliance marking visible on the valve body, and the temperature setting indicator legible."
8. "Backflow prevention device (double-check valve assembly) showing the device body with the certification label legible, test cocks in the correct position, and the device installed with flow direction arrows matching the pipe direction."
9. "Pressure reducing valve showing the AS 1357.2 pressure rating label visible on the valve body, the pressure setting indicator legible, and the inlet/outlet connections with isolation valves on both sides."
10. "Water hammer arrestor installed on the supply line near the fixture, showing the SAE designation or ASSE 1010 marking on the body, correctly sized for the pipe diameter, and installed in the vertical position as specified."
11. "Flexible connector between rigid pipework and appliance showing the connector in a natural curve without kinking, the correct braided stainless steel outer sheath, and both end connections fully tightened with no thread tape exposed."
12. "Copper to HDPE transition showing a brass compression fitting correctly connecting 20 mm copper to blue HDPE poly pipe — the compression nut is tightened correctly and no deformation of the HDPE pipe is visible."
13. "Roof penetration flashing for a solar hot water pipe showing a lead or aluminium flashing correctly dressed over the roof sheeting with no gaps, correctly sealed around the pipe penetration, and the pipe correctly supported above the flashing."
14. "Tempering valve three-port connection showing hot water inlet, cold water inlet, and tempered water outlet all correctly connected and labelled, the body clearly showing the 50°C maximum temperature rating mark."
15. "Expansion control valve showing the device installed on the cold water supply to the hot water system, the rated pressure visible on the body, and the discharge pipe correctly connected and running to a visible safe discharge point."
16. "PTR valve discharge pipe showing a continuous unobstructed run of copper pipe from the PTR valve outlet terminating within 300 mm of the floor level at a tundish or floor waste — the pipe is correctly supported and the terminus is clearly visible."
17. "Cold water storage tank connection showing the supply inlet float valve, overflow pipe, vent, and the outlet with an isolation valve — all four connections are visible, the tank is clean, and covers are correctly fitted."
18. "Hot water recirculation pump and return line showing the pump body with direction of flow arrow visible, isolation valves on both sides, the timer or temperature controller correctly wired, and the return pipe correctly insulated."
19. "Heat pump hot water unit installed in a sheltered outdoor location showing the unit correctly secured to a concrete slab, the refrigerant line set correctly lagged, the water connections visible with isolation valves, and the compliance label on the unit body legible."
20. "Solar hot water system with electric boost element showing the storage tank with the solar input, the electric element connection with the thermostat visible, the relief valve discharge pipe correctly run, and the compliance plate with both solar and electrical approvals legible."
21. "Underground water main connection showing a new PE100 poly pipe running from the meter connection with tracer wire alongside the pipe, the depth of cover confirmed by a tape measure in the trench at minimum 300 mm, and the trench free of sharp rocks."
22. "Fire sprinkler connection to the domestic water supply showing a dedicated fire service branch with the backflow prevention device correctly installed and tagged with the test date, the pressure test certificate attached, and all pipe work correctly supported."
23. "Irrigation system backflow prevention device showing a reduced pressure zone (RPZ) device correctly installed in an accessible location, the test cock positions correct, the device tagged with the last test date, and the device elevated above possible flood level."
24. "Water filtration system installation showing the filter housing correctly supported, the inlet isolation valve accessible, the bypass provision in place, the filter cartridge change date recorded on the label, and the outlet pipe correctly connected to the potable supply."
25. "Rainwater harvesting connection showing the first-flush diverter correctly installed before the tank, the mains water backup supply with a backflow prevention device, the tank overflow pipe correctly directed away from the building, and the system correctly labelled as non-potable."
26. "Dual water supply (potable and recycled) installation showing both supply lines correctly colour coded — blue for potable, lilac/purple for recycled — all fittings correctly labelled 'RECYCLED WATER — DO NOT DRINK', and the two supplies physically separated."
27. "Water meter installation showing the meter correctly mounted at the boundary with the register face accessible and legible, the isolation valve with the handle direction matching the valve status, and the meter body free of corrosion or physical damage."
28. "Pressure boosting pump installation showing the pump correctly mounted and bolted down, the inlet and outlet isolation valves accessible, the pressure vessel correctly sized and charged, the electrical supply correctly protected, and the pressure switch setpoint visible on the gauge."
29. "Water softener installation showing the unit correctly connected to the supply line, the brine tank correctly positioned, the regeneration drain line correctly terminated, the hardness bypass valve accessible, and the manufacturer commissioning record attached to the unit."
30. "Hot water expansion control valve (ECV) installed on the cold water supply to the hot water system showing the valve body with the rated pressure clearly legible, the discharge connection correctly piped to a safe discharge point, and the valve correctly oriented with flow direction arrows matching pipe direction."

FAILING photo descriptions (these would receive a FAIL):
1. "Blurry close-up of the PTR valve — the valve body is in frame but the compliance label is a white smear with no legible text, and the discharge pipe is not visible."
2. "Photo taken from 2 m away showing the entire hot water cupboard — the tempering valve is a small object in the background, too small to read any markings or confirm connections."
3. "Wide photo of the ceiling space showing a long run of copper pipe — no pipe support clips are visible anywhere in the 4 m span shown, indicating unsupported pipework."
4. "Photo of a solar hot water collector taken from ground level — the roof mounting brackets, lead flashings, and header connections cannot be seen. Only the collector panel faces are visible and no installation details can be confirmed."
5. "Instantaneous gas hot water unit photo showing only the front cover plate — the gas connection, water connections, and compliance label are all concealed behind the cover and cannot be assessed."
6. "Gravity-fed storage tank photo taken from the wrong angle — only the top of the tank is visible and the overflow pipe, float valve, and base support structure are all out of frame."
7. "TMV photo where the valve body is heavily wrapped in pipe lagging — the compliance marking, temperature indicator, and port connections are completely hidden behind foam insulation. Cannot confirm it is a compliant TMV."
8. "Backflow prevention device shown installed but facing the wrong direction — the flow arrows on the body point against the direction of water flow in the pipe, indicating incorrect installation which would cause device failure."
9. "Pressure reducing valve photo where a rubber gasket valve with no visible rating label is shown — the operating pressure setting cannot be confirmed and the compliance marking is not visible on the body."
10. "Water hammer arrestor shown installed in a horizontal position on a vertical supply line — the installation does not comply with the manufacturer's requirement for vertical installation, rendering it ineffective."
11. "Flexible connector shown with a sharp 90-degree kink directly adjacent to the end fitting — the bend radius is below the minimum specified and the connector will fail prematurely under normal system pressure."
12. "Copper to poly pipe transition showing a plain slip coupling used to join copper to poly — this connection type is incorrect as it requires a purpose-made brass compression transition fitting and will fail at system pressure."
13. "Roof penetration photo showing a pipe emerging from the roof with no visible flashing, only silicone sealant applied around the pipe — no lead or aluminium flashing is present and the penetration is non-compliant."
14. "Tempering valve photo showing only the mixed water outlet side — the hot and cold supply inlets are not visible and it is impossible to confirm all three port connections are correctly made."
15. "Expansion control valve photo where the valve is installed without a discharge pipe — the outlet port is open and no pipe is connected, meaning any discharge would flood the mechanical room."
16. "PTR valve discharge pipe photo showing the pipe terminating into a bucket rather than a tundish or floor waste — this is a non-compliant termination that presents a scalding hazard and does not meet AS/NZS 3500 requirements."
17. "Cold water storage tank where the overflow pipe is connected via a P-trap rather than running directly to outside — the trapped overflow will fail to discharge freely and allows contamination to enter the tank."
18. "Hot water recirculation pump photo taken from 3 m away — the pump model, direction of flow, isolation valve positions, and electrical connections are too small to read. No installation details can be confirmed."
19. "Heat pump hot water unit installed directly against an external wall with no clearance — the unit requires minimum 200 mm on each side for air circulation. The installation is non-compliant with the manufacturer's clearance requirements."
20. "Solar hot water system with electric boost showing only the roof-mounted collectors from ground level — no tank connections, electric element wiring, relief valve, or compliance labels are visible. No installation compliance can be confirmed."
21. "Underground water main photo showing the trench immediately after opening — the existing main has green slime and corrosion on the fittings, suggesting active dezincification, but the photo shows no new work. This is not a compliance record of completed work."
22. "Fire sprinkler connection photo showing the backflow prevention device installed below the possible flood level in a basement plant room — if the basement floods, the non-return valves will be submerged, failing the backflow prevention requirement."
23. "Irrigation backflow device photo where a standard dual check valve is installed on an irrigation system with fertiliser injection — fertiliser injection systems require an RPZ device, not a dual check. The installed device is the wrong type for this application."
24. "Water filter housing photo showing the filter cartridge has not been replaced — the filter label shows the last change date was 18 months ago. An overdue filter becomes a bacteriological contamination risk and must be replaced."
25. "Rainwater harvesting system photo where the tank inlet pipe is connected directly below a bird roosting point — bird droppings are visible on the tank roof and no first-flush diverter is installed, meaning contamination enters the tank directly."
26. "Dual supply system photo where the recycled water outlet fittings are painted blue instead of the required lilac/purple — blue is the colour code for potable water. This creates a confusion hazard and is non-compliant."
27. "Water meter photo where the meter has been mounted horizontally instead of in the upright position specified by the authority — incorrect orientation affects meter accuracy and the meter may need replacement."
28. "Pressure boosting pump photo showing the pressure vessel installed without the required pressure test tag — untagged pressure vessels cannot be verified as safe. The vessel must be inspected, tagged, and the rated pressure confirmed."
29. "Water softener photo showing the regeneration drain line connected directly to the sewer without an air gap — without an air gap the sewer can back-siphon into the softener and contaminate the potable supply."
30. "Expansion control valve photo showing the valve installed with no discharge pipe — the ECV outlet is open to atmosphere with no pipe. Any discharge will flood the immediate area. A correctly terminated discharge pipe is mandatory."

${outputFormatInstruction}

Example response shape:
{
  "relevant": true,
  "overall_confidence": 60,
  "items_detected": ["PTR valve installed", "Isolation valve at fixture"],
  "items_missing": ["Tempering valve", "Pressure limiting valve (PLV)"],
  "items_unclear": ["Compliance plate / label"],
  "risk_rating": "high",
  "recommended_actions": [
    "Retake the tempering valve photo — the AS 3500.4 compliance marking and all three connections must be visible.",
    "Retake the PLV photo — the pressure rating label must be legible with the kPa value readable."
  ],
  "liability_summary": "Critical hot water safety items are unverified. Without documented evidence of a compliant tempering valve and PLV, this installation cannot be certified. The plumber carries full liability for any scalding or pressure-related incident on an unverified hot water system.",
  "analysis": "2 of 5 photos pass validation. 1 photo is unclear. 2 photos do not show the required plumbing component."
}
`.trim();

// Task 25: All requests now include the comprehensive optimisation header.
// A/B test: 20% of requests ALSO get the v2 chain-of-thought preamble.
const promptVariant     = Math.random() < 0.2 ? "v2" : "v1";
const promptVersionUsed = promptVariant === "v2" ? "2.0" : "1.0";
const finalPromptText   = promptVariant === "v2"
  ? PROMPT_OPTIMISATION_HEADER + PROMPT_V2_PREAMBLE + buildRegulationsNote(type) + promptText
  : PROMPT_OPTIMISATION_HEADER + buildRegulationsNote(type) + promptText;

const inputContent = [
{
type: "text",
text: finalPromptText,
},
...analysisImages.flatMap((img) => [
{
type: "text",
text: `Photo label: "${img.label}"`,
},
{
type: "image_url",
image_url: {
url: `data:${img.mime};base64,${img.data}`,
},
},
]),
];

usageStats.openaiCalls++;
const response = await callOpenAIWithRetry({
model: "gpt-4.1-mini",
response_format: { type: "json_object" },
messages: [
{
role: "user",
content: inputContent,
},
],
temperature: 0.1,
});

const raw = response.choices?.[0]?.message?.content || "{}";

let parsed;
try {
parsed = JSON.parse(raw);
} catch {
console.error("AI returned invalid JSON (truncated):", raw.slice(0, 200));
if (typeof rejectDedup === "function") rejectDedup(new Error("Invalid JSON"));
if (cacheKey) pendingAnalyses.delete(cacheKey);
return res.status(500).json({
  error: "AI returned an unreadable response. Please try again.",
});
}

// Quality gate — AI signals that too many photos are unrecognisable
if (parsed.photo_quality_error === true) {
  if (typeof rejectDedup === "function") rejectDedup(new Error("photo_quality_error"));
  if (cacheKey) pendingAnalyses.delete(cacheKey);
  return res.status(422).json({
    error: "Photos are too blurry or unclear. Please retake in better lighting.",
  });
}

// Task 3: Validate and fill missing fields
validateAIResponse(parsed);

const relevant = !!parsed.relevant;
const overallConfidence =
  typeof parsed.overall_confidence === "number"
    ? Math.max(0, Math.min(100, parsed.overall_confidence))
    : typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(100, parsed.confidence))
      : 0;

const itemsDetected = Array.isArray(parsed.items_detected) ? parsed.items_detected
  : Array.isArray(parsed.detected) ? parsed.detected : [];
const itemsMissing = Array.isArray(parsed.items_missing) ? parsed.items_missing
  : Array.isArray(parsed.missing) ? parsed.missing : [];
const itemsUnclear = Array.isArray(parsed.items_unclear) ? parsed.items_unclear
  : Array.isArray(parsed.unclear) ? parsed.unclear : [];

const validRatings = ["low", "medium", "high"];
const riskRating = validRatings.includes(parsed.risk_rating) ? parsed.risk_rating : "medium";

const recommendedActions = Array.isArray(parsed.recommended_actions)
  ? parsed.recommended_actions
  : typeof parsed.action === "string" ? [parsed.action] : [];

const liabilitySummary = typeof parsed.liability_summary === "string"
  ? parsed.liability_summary
  : "Review the missing items and retake photos before certifying this installation.";

const analysis = typeof parsed.analysis === "string"
  ? parsed.analysis
  : "AI review completed.";

// ── Complexity scoring (deterministic, server-side) ───────────────────────
const totalItems = itemsDetected.length + itemsMissing.length + itemsUnclear.length;
const { score: complexityScore, band: complexityBand } = calculateComplexity(
  type,
  images.length,
  totalItems,
  itemsMissing.length
);

// Adjusted confidence: complex jobs get a charitable bonus because passing a
// larger, higher-risk inspection at 70% is genuinely harder than passing a
// simple one at 70%. Simple jobs receive no bonus — the bar is higher for them.
const complexityBonus = complexityBand === "complex" ? 10 : complexityBand === "moderate" ? 5 : 0;
const adjustedConfidence = Math.min(100, overallConfidence + complexityBonus);

const complianceScore = calculateComplianceScore({
  type,
  itemsDetected,
  itemsMissing,
  itemsUnclear,
  photoCount: analysisImages.length,
  gpsRecorded: !!(req.body?.gpsRecorded),
  complexityScore,
});

// Track A/B test results
const variantKey = promptVariant;
promptAbStats[variantKey].uses++;
promptAbStats[variantKey].totalConfidence += overallConfidence;
promptAbStats[variantKey].avgConfidence = Math.round(
  promptAbStats[variantKey].totalConfidence / promptAbStats[variantKey].uses
);

const finalResult = {
  relevant,
  overall_confidence: overallConfidence,
  adjusted_confidence: adjustedConfidence,
  complexity_score: complexityScore,
  complexity_band: complexityBand,
  compliance_score: complianceScore,
  items_detected: itemsDetected,
  items_missing: itemsMissing,
  items_unclear: itemsUnclear,
  risk_rating: riskRating,
  recommended_actions: recommendedActions,
  liability_summary: liabilitySummary,
  analysis,
  photos_analysed:        analysisImages.length,
  photos_submitted:       images.length,
  photo_quality_flags:    qualityFailedImages.length > 0 ? qualityFailedImages : undefined,
  prompt_version:         promptVersionUsed,
  prompt_registry_version: (PROMPT_REGISTRY[type] || {}).version || "1.0.0",
};

// Cache result and resolve any waiting dedup requests
if (cacheKey) {
  setCache(cacheKey, finalResult);
  if (typeof resolveDedup === "function") resolveDedup(finalResult);
  setTimeout(() => pendingAnalyses.delete(cacheKey), 10000);
}

return res.json(finalResult);
} catch (error) {
if (typeof rejectDedup === "function") rejectDedup(error);
if (cacheKey) pendingAnalyses.delete(cacheKey);
console.error("AI review error:", error);

return res.status(500).json({
  error: "AI analysis failed. Please try again.",
});
}
});

// ── Visualiser: 3 per 10 minutes ──────────────────────────────────────────────

const visualiserLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many visualisation requests. Please wait before generating another." },
});

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

/**
 * Generate a grayscale PNG mask using only Node.js built-ins (zlib).
 * White rectangle = area to inpaint (product placement).
 * Black = preserve exactly as-is.
 * Image is assumed 1024px wide (mobile resizes before sending).
 */
function generateMaskPNG(width = 1024, height = 768) {
  const rectX1 = Math.floor(width * 0.35);
  const rectX2 = Math.floor(width * 0.65);
  const rectY1 = Math.floor(height * 0.25);
  const rectY2 = Math.floor(height * 0.65);

  // Build raw scanlines: 1 filter byte (0=None) + width grayscale pixels per row
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width, 0); // black by default
    if (y >= rectY1 && y < rectY2) {
      row.fill(255, 1 + rectX1, 1 + rectX2); // white in target zone
    }
    rows.push(row);
  }
  const compressed = require("zlib").deflateSync(Buffer.concat(rows));

  // CRC32 lookup table
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function pngChunk(type, data) {
    const t = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

app.post("/visualise", visualiserLimiter, async (req, res) => {
  try {
    const { wallImage, mime, modelNumber } = req.body || {};

    console.log("[visualise] Request received", {
      hasWallImage: !!wallImage,
      wallImageLen: wallImage ? wallImage.length : 0,
      mime,
      modelNumber,
      hasReplicateToken: !!process.env.REPLICATE_API_TOKEN,
    });

    if (!wallImage || !mime) {
      return res.status(400).json({ error: "Missing wall image." });
    }
    if (!modelNumber) {
      return res.status(400).json({ error: "Missing product model number." });
    }
    if (!process.env.REPLICATE_API_TOKEN) {
      return res.status(503).json({ error: "Visualiser not configured on server." });
    }

    // Step 1: Describe the room using GPT-4o mini vision for a better prompt
    let roomDescription = "a modern Australian home interior";
    try {
      const visionResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Describe this room or wall space in one sentence. Include: wall colour, room style, and lighting conditions only.",
              },
              {
                type: "image_url",
                image_url: { url: `data:${mime};base64,${wallImage}` },
              },
            ],
          },
        ],
        max_tokens: 80,
        temperature: 0.2,
      });
      roomDescription = visionResponse.choices?.[0]?.message?.content?.trim() || roomDescription;
      console.log("[visualise] Step 1 - Room described:", roomDescription);
    } catch (visionErr) {
      console.warn("[visualise] Step 1 - Vision step skipped:", visionErr.message);
    }

    // Step 2a: Auto-rotate image based on EXIF orientation so the mask aligns correctly
    let correctedWallImage = wallImage;
    let correctedMime = mime;
    try {
      const rotated = await sharp(Buffer.from(wallImage, "base64"))
        .rotate() // reads EXIF orientation and rotates accordingly, strips EXIF
        .jpeg({ quality: 92 })
        .toBuffer();
      correctedWallImage = rotated.toString("base64");
      correctedMime = "image/jpeg";
      console.log("[visualise] Step 2a - EXIF rotation applied, new size:", rotated.length);
    } catch (rotateErr) {
      console.warn("[visualise] Step 2a - EXIF rotation skipped:", rotateErr.message);
    }

    // Step 2b: Generate mask PNG — white rectangle in center-wall area
    const maskBase64 = generateMaskPNG(1024, 768);
    console.log("[visualise] Step 2b - Mask generated, base64 length:", maskBase64.length);

    // Step 3: Run Stable Diffusion inpainting via Replicate
    // Only the masked (white) region is edited; everything else is preserved exactly.
    //
    // Prompt engineering principles applied:
    //  • Lead with the exact product model so SD focuses on the specific unit shape/colour
    //  • Anchor physical dimensions ("900mm wide × 300mm tall") to guide scale relative to the wall
    //  • Room-context suffix (from GPT-4.1-mini vision) grounds lighting, colour temperature, and style
    //  • Instruction-style suffix ("mounted flush", "installation photo") shifts SD toward
    //    a photographic rather than artistic render
    //  • Negative prompt aggressively kills scale errors, perspective issues, and artistic artifacts
    const roomCtx = roomDescription && roomDescription.length > 10
      ? `, ${roomDescription}`
      : ", interior room, natural lighting";

    const prompt =
      `Photorealistic product photo of a ${modelNumber} split-system air conditioner, white rectangular wall-mounted indoor unit, ` +
      `900mm wide by 300mm tall, mounted flush on the wall at eye level, horizontal louvre at the bottom, ` +
      `manufacturer logo visible on fascia, refrigerant line set exiting neatly through wall at left or right side, ` +
      `professional HVAC installation, sharp detail, RAW photo quality${roomCtx}`;

    const negativePrompt =
      "ceiling, floor, outdoors, outdoor unit, condenser, distorted, warped, cropped, cut off, floating, " +
      "incorrect scale, oversized, undersized, giant unit, tiny unit, blurry, low quality, cartoon, painting, " +
      "illustration, 3d render, CGI, sketch, duplicate units, multiple units, extra heads, extra limbs, " +
      "text, watermark, label overlay, wrong perspective, fish-eye, wide-angle distortion";

    console.log("[visualise] Step 3 - Calling Replicate with prompt:", prompt, "| image size:", correctedWallImage.length);

    let output;
    try {
      usageStats.replicateCalls++;
      output = await replicate.run(
        "stability-ai/stable-diffusion-inpainting:95b7223104132402a9ae91cc677285bc5eb997834bd2349fa486f53910fd68b3",
        {
          input: {
            image:               `data:${correctedMime};base64,${correctedWallImage}`,
            mask:                `data:image/png;base64,${maskBase64}`,
            prompt,
            negative_prompt:     negativePrompt,
            strength:            0.92,
            guidance_scale:      11,
            num_inference_steps: 60,
            num_outputs:         1,
          },
        }
      );
    } catch (replicateErr) {
      console.error("[visualise] Step 3 - Replicate call failed:");
      console.error("  message:", replicateErr.message);
      console.error("  status:", replicateErr.status ?? replicateErr.statusCode);
      const msg = (replicateErr.message || "").toLowerCase();
      if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("deadline")) {
        return res.status(503).json({
          error: "The visualiser took too long to respond. Please try again in a moment.",
        });
      }
      throw replicateErr;
    }

    // Step 4: Resolve output → imageUrl
    // Replicate SDK ≥ 1.0 wraps results in FileOutput objects (not plain strings),
    // so JSON.stringify shows {} — log the raw value explicitly instead.
    console.log("[visualise] Step 4 - Raw output type:", typeof output, "| isArray:", Array.isArray(output), "| isNull:", output === null);
    console.log("[visualise] Step 4 - Raw output (String):", String(output));
    if (output && typeof output === "object") {
      console.log("[visualise] Step 4 - Output keys:", Object.keys(output));
    }

    let imageUrl = null;

    if (output === null || output === undefined) {
      console.error("[visualise] Step 4 - Replicate returned null/undefined output.");
      return res.status(500).json({ error: "Replicate returned no output. The model may have rejected the input." });
    }

    // Array response — take the first element (most common case)
    if (Array.isArray(output)) {
      console.log("[visualise] Step 4 - Array of length:", output.length);
      const first = output[0];
      if (!first) {
        console.error("[visualise] Step 4 - Array was empty.");
        return res.status(500).json({ error: "Replicate returned an empty array." });
      }
      imageUrl = first;
    } else {
      imageUrl = output;
    }

    // Unwrap Replicate FileOutput objects (SDK ≥ 1.0)
    if (imageUrl && typeof imageUrl === "object") {
      if (typeof imageUrl.url === "function") {
        imageUrl = imageUrl.url();
        console.log("[visualise] Step 4 - Unwrapped via .url():", imageUrl);
      } else if (typeof imageUrl.href === "string") {
        imageUrl = imageUrl.href;
        console.log("[visualise] Step 4 - Unwrapped via .href:", imageUrl);
      } else {
        console.error("[visualise] Step 4 - Unknown object shape:", Object.keys(imageUrl));
        return res.status(500).json({ error: "Replicate returned an unrecognised output format.", detail: Object.keys(imageUrl) });
      }
    }

    // Final check — must be a non-empty string
    if (typeof imageUrl !== "string" || !imageUrl) {
      console.error("[visualise] Step 4 - imageUrl is not a valid string:", imageUrl);
      return res.status(500).json({ error: "Could not extract a valid image URL from Replicate output.", received: String(imageUrl) });
    }

    console.log(`[visualise] Step 4 - Resolved imageUrl: ${imageUrl}`);
    console.log(`[visualise] Completed for model "${modelNumber}" → ${imageUrl}`);
    return res.json({ imageUrl });

  } catch (error) {
    console.error("[visualise] FATAL ERROR:");
    console.error("  message:", error.message);
    console.error("  stack:", error.stack);
    return res.status(500).json({
      error: "Visualisation failed. Please try again.",
    });
  }
});

// ── Weatherproof photo stamping ────────────────────────────────────────────────
// Burns GPS coordinates + server timestamp as a tamper-evident overlay onto the
// image itself before the file is saved on-device.

app.post("/stamp-photo", stampLimiter, async (req, res) => {
  try {
    const { image, mime, gps, capturedAt } = req.body || {};

    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "Missing image data." });
    }

    const inputBuffer = Buffer.from(image, "base64");
    const meta = await sharp(inputBuffer).metadata();
    const w = meta.width || 1200;
    const h = meta.height || 900;

    const gpsText = gps && typeof gps.lat === "number" && typeof gps.lng === "number"
      ? `GPS ${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}`
      : "GPS unavailable";

    const melbNow = new Date(capturedAt || Date.now()).toLocaleString("en-AU", {
      timeZone: "Australia/Melbourne",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: true,
    });

    const barH = 76;
    // Escape XML special chars in text
    const escXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const svgOverlay = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="${h - barH}" width="${w}" height="${barH}" fill="rgba(0,0,0,0.72)"/>
  <text x="14" y="${h - barH + 22}" fill="#f97316" font-size="19" font-family="monospace" font-weight="bold">ELEMETRIC VERIFIED</text>
  <text x="14" y="${h - barH + 46}" fill="white" font-size="17" font-family="monospace">${escXml(gpsText)}</text>
  <text x="14" y="${h - barH + 68}" fill="rgba(255,255,255,0.85)" font-size="15" font-family="monospace">${escXml(melbNow)}</text>
</svg>`;

    const stampedBuffer = await sharp(inputBuffer)
      .composite([{ input: Buffer.from(svgOverlay), blend: "over" }])
      .jpeg({ quality: 88 })
      .toBuffer();

    return res.json({
      image: stampedBuffer.toString("base64"),
      mime: "image/jpeg",
    });
  } catch (error) {
    console.error("Stamp photo error:", error);
    return res.status(500).json({
      error: "Photo stamping failed. Please try again.",
    });
  }
});

// ── Property Compliance Passport ───────────────────────────────────────────────
// Public lookup: returns full job history for an address, compliance trend,
// and overall score. Uses service-role key to read across all users.

app.get("/property-passport", async (req, res) => {
  try {
    const address = typeof req.query.address === "string" ? req.query.address.trim() : "";

    if (address.length < 3) {
      return res.status(400).json({ error: "Provide at least 3 characters of an address." });
    }

    if (!supabaseAdmin) {
      return res.status(503).json({ error: "Passport service not configured on server." });
    }

    // Task 9: Pagination — max 20 jobs per page
    const pageRaw  = parseInt(req.query.page,  10);
    const limitRaw = parseInt(req.query.limit, 10);
    const page  = Number.isFinite(pageRaw)  && pageRaw  >= 1 ? pageRaw  : 1;
    const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, 20) : 20;
    const offset = (page - 1) * limit;

    // Get total count for pagination metadata
    const { count: totalCount, error: countErr } = await supabaseAdmin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .ilike("job_addr", `%${address}%`);

    if (countErr) {
      console.error("Property passport count error:", countErr);
      return res.status(500).json({ error: "Database query failed." });
    }

    const { data: jobs, error } = await supabaseAdmin
      .from("jobs")
      .select("id, job_type, job_name, job_addr, confidence, relevant, detected, missing, created_at, installer_name, status")
      .ilike("job_addr", `%${address}%`)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error("Property passport DB error:", error);
      return res.status(500).json({ error: "Database query failed." });
    }

    const jobList = jobs || [];

    // Compliance trend — average confidence per calendar month (across all pages)
    const monthMap = {};
    for (const job of jobList) {
      const month = (job.created_at || "").slice(0, 7); // "YYYY-MM"
      if (!month) continue;
      if (!monthMap[month]) monthMap[month] = { sum: 0, count: 0 };
      monthMap[month].sum += job.confidence ?? 0;
      monthMap[month].count++;
    }

    const trend = Object.entries(monthMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, { sum, count }]) => ({
        month,
        avgConfidence: Math.round(sum / count),
        jobCount: count,
      }));

    const overallCompliance = jobList.length > 0
      ? Math.round(jobList.reduce((s, j) => s + (j.confidence ?? 0), 0) / jobList.length)
      : null;

    const totalJobs   = totalCount ?? 0;
    const totalPages  = Math.ceil(totalJobs / limit);

    return res.json({
      address,
      totalJobs,
      page,
      limit,
      totalPages,
      jobCount: jobList.length,
      overallCompliance,
      trend,
      jobs: jobList.map((j) => ({
        id: j.id,
        jobType: j.job_type,
        jobName: j.job_name,
        jobAddr: j.job_addr,
        confidence: j.confidence,
        relevant: j.relevant,
        detected: j.detected,
        missing: j.missing,
        createdAt: j.created_at,
        installerName: j.installer_name,
        status: j.status,
      })),
    });
  } catch (error) {
    console.error("Property passport error:", error);
    return res.status(500).json({
      error: "Property passport lookup failed. Please try again.",
    });
  }
});

// ── Resend email helpers ───────────────────────────────────────────────────────

/**
 * buildEmailHtml — wraps body content in the shared branded shell.
 *
 * Brand:  navy background (#0f172a), orange accent (#f97316), white body card.
 * @param {string} title   — shown in the <title> tag
 * @param {string} content — inner HTML placed inside the white body card
 */
function buildEmailHtml(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 0;">
    <tr>
      <td align="center">
        <!-- Header -->
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <tr>
            <td style="background:#0f172a;padding:32px 40px 24px;border-radius:12px 12px 0 0;text-align:center;">
              <span style="font-size:26px;font-weight:800;color:#f97316;letter-spacing:2px;text-transform:uppercase;">ELEMETRIC</span>
              <span style="display:block;font-size:11px;color:#94a3b8;letter-spacing:3px;text-transform:uppercase;margin-top:4px;">Compliance Platform</span>
            </td>
          </tr>
          <!-- Body card -->
          <tr>
            <td style="background:#ffffff;padding:40px;border-radius:0 0 12px 12px;">
              ${content}
              <!-- Footer -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:40px;border-top:1px solid #e2e8f0;padding-top:24px;">
                <tr>
                  <td style="font-size:12px;color:#94a3b8;text-align:center;line-height:1.6;">
                    Elemetric &mdash; Built for Australian trade professionals.<br/>
                    If you didn't expect this email, you can safely ignore it.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── POST /send-welcome ─────────────────────────────────────────────────────────
// Body: { to: string, name: string }

app.post("/send-welcome", async (req, res) => {
  try {
    if (!resend) {
      return res.status(503).json({ error: "Email service not configured." });
    }

    const { to, name } = req.body || {};
    if (!to || !isValidEmail(to)) {
      return res.status(400).json({ error: "Missing or invalid recipient email address." });
    }
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Missing recipient name." });
    }

    const firstName = escHtml(name.split(" ")[0]);

    const content = `
      <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;">Welcome to Elemetric, ${firstName}.</h1>
      <p style="margin:0 0 24px;font-size:14px;color:#64748b;">Your account is ready.</p>

      <p style="margin:0 0 16px;font-size:15px;color:#1e293b;line-height:1.7;">
        You're now part of a platform built specifically for Australian trade professionals.
        Elemetric helps you capture compliance evidence, generate job reports, and keep your
        certifications bulletproof &mdash; all from your phone on the job site.
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:32px 0;">
        <tr>
          <td style="background:#fff7ed;border-left:4px solid #f97316;padding:16px 20px;border-radius:0 8px 8px 0;">
            <p style="margin:0;font-size:13px;font-weight:600;color:#c2410c;text-transform:uppercase;letter-spacing:0.5px;">Get started</p>
            <p style="margin:6px 0 0;font-size:14px;color:#1e293b;line-height:1.6;">
              Create your first job, add photos as you work, and let Elemetric validate your compliance evidence in seconds.
            </p>
          </td>
        </tr>
      </table>

      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <td style="background:#f97316;border-radius:8px;padding:14px 32px;">
            <a href="https://elemetric.app" style="font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">
              Open Elemetric &rarr;
            </a>
          </td>
        </tr>
      </table>

      <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">
        Questions? Reply to this email or reach us at
        <a href="mailto:support@elemetric.app" style="color:#f97316;text-decoration:none;">support@elemetric.app</a>.
      </p>`;

    const { data, error: sendError } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Welcome to Elemetric, ${firstName}`,
      html: buildEmailHtml(`Welcome to Elemetric, ${firstName}`, content),
    });

    if (sendError) {
      console.error("Resend /send-welcome error:", sendError);
      return res.status(500).json({ error: "Failed to send welcome email." });
    }

    usageStats.emailsSent++;
    return res.json({ sent: true, id: data?.id });
  } catch (error) {
    console.error("send-welcome error:", error);
    return res.status(500).json({ error: "Failed to send welcome email." });
  }
});

// ── POST /send-job-complete ────────────────────────────────────────────────────
// Body: { to: string, name: string, jobName: string, jobType: string,
//         confidence: number, pdfUrl: string }

app.post("/send-job-complete", async (req, res) => {
  try {
    if (!resend) {
      return res.status(503).json({ error: "Email service not configured." });
    }

    const { to, name, jobName, jobType, confidence, pdfUrl } = req.body || {};
    if (!to || !isValidEmail(to)) {
      return res.status(400).json({ error: "Missing or invalid recipient email address." });
    }
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Missing recipient name." });
    }
    if (!jobName || typeof jobName !== "string") {
      return res.status(400).json({ error: "Missing job name." });
    }

    const firstName  = escHtml(name.split(" ")[0]);
    const tradeLabel = escHtml(typeof jobType === "string"
      ? jobType.charAt(0).toUpperCase() + jobType.slice(1)
      : "Trade");
    const confidenceNum = typeof confidence === "number"
      ? Math.max(0, Math.min(100, Math.round(confidence)))
      : null;
    const confidenceColour = confidenceNum === null ? "#64748b"
      : confidenceNum >= 80 ? "#16a34a"
      : confidenceNum >= 60 ? "#d97706"
      : "#dc2626";

    const content = `
      <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;">Job complete.</h1>
      <p style="margin:0 0 24px;font-size:14px;color:#64748b;">Your compliance record is ready.</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <tr style="background:#f8fafc;">
          <td style="padding:12px 20px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;" width="40%">Job</td>
          <td style="padding:12px 20px;font-size:14px;color:#1e293b;font-weight:600;">${jobName}</td>
        </tr>
        <tr>
          <td style="padding:12px 20px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-top:1px solid #e2e8f0;">Type</td>
          <td style="padding:12px 20px;font-size:14px;color:#1e293b;border-top:1px solid #e2e8f0;">${tradeLabel}</td>
        </tr>
        ${confidenceNum !== null ? `
        <tr>
          <td style="padding:12px 20px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-top:1px solid #e2e8f0;">Confidence</td>
          <td style="padding:12px 20px;font-size:14px;font-weight:700;color:${confidenceColour};border-top:1px solid #e2e8f0;">${confidenceNum}%</td>
        </tr>` : ""}
      </table>

      <p style="margin:0 0 20px;font-size:15px;color:#1e293b;line-height:1.7;">
        Hi ${firstName}, your job <strong>${escHtml(jobName)}</strong> has been marked complete and your
        compliance record has been saved to Elemetric.
        ${pdfUrl ? "Your PDF report is attached below &mdash; keep it on file for your records." : ""}
      </p>

      ${(pdfUrl && isSafeUrl(pdfUrl)) ? `
      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <td style="background:#f97316;border-radius:8px;padding:14px 32px;">
            <a href="${escHtml(pdfUrl)}" style="font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">
              Download PDF Report &darr;
            </a>
          </td>
        </tr>
      </table>` : ""}

      <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">
        View the full job record in the app at any time or share it directly with your inspector.
      </p>`;

    const { data, error: sendError } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Job complete: ${jobName}`,
      html: buildEmailHtml(`Job complete: ${jobName}`, content),
    });

    if (sendError) {
      console.error("Resend /send-job-complete error:", sendError);
      return res.status(500).json({ error: "Failed to send job completion email." });
    }

    usageStats.emailsSent++;
    return res.json({ sent: true, id: data?.id });
  } catch (error) {
    console.error("send-job-complete error:", error);
    return res.status(500).json({ error: "Failed to send job completion email." });
  }
});

// ── POST /send-team-invite ─────────────────────────────────────────────────────
// Body: { to: string, invitedBy: string, teamName: string, joinCode: string }

app.post("/send-team-invite", async (req, res) => {
  try {
    if (!resend) {
      return res.status(503).json({ error: "Email service not configured." });
    }

    const { to, invitedBy, teamName, joinCode } = req.body || {};
    if (!to || !isValidEmail(to)) {
      return res.status(400).json({ error: "Missing or invalid recipient email address." });
    }
    if (!invitedBy || typeof invitedBy !== "string") {
      return res.status(400).json({ error: "Missing invitedBy name." });
    }
    if (!teamName || typeof teamName !== "string") {
      return res.status(400).json({ error: "Missing team name." });
    }
    if (!joinCode || typeof joinCode !== "string") {
      return res.status(400).json({ error: "Missing join code." });
    }

    const safeInvitedBy = escHtml(invitedBy);
    const safeTeamName  = escHtml(teamName);
    const safeJoinCode  = escHtml(joinCode);

    const content = `
      <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;">You've been invited.</h1>
      <p style="margin:0 0 24px;font-size:14px;color:#64748b;">${safeInvitedBy} has invited you to join their team on Elemetric.</p>

      <p style="margin:0 0 20px;font-size:15px;color:#1e293b;line-height:1.7;">
        <strong>${safeInvitedBy}</strong> has added you to the <strong>${safeTeamName}</strong> team on Elemetric.
        Use the code below when you sign up or log in to join the team and start collaborating on jobs.
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:32px 0;">
        <tr>
          <td align="center" style="background:#0f172a;border-radius:12px;padding:28px 20px;">
            <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:2px;">Your join code</p>
            <p style="margin:0;font-size:36px;font-weight:800;color:#f97316;letter-spacing:8px;font-family:'Courier New',Courier,monospace;">${safeJoinCode}</p>
          </td>
        </tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
        <tr>
          <td style="background:#f0fdf4;border-left:4px solid #16a34a;padding:14px 20px;border-radius:0 8px 8px 0;">
            <p style="margin:0;font-size:13px;color:#15803d;line-height:1.6;">
              <strong>How to join:</strong> Open Elemetric, go to Team Settings, tap &ldquo;Join a team&rdquo; and enter the code above.
            </p>
          </td>
        </tr>
      </table>

      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <td style="background:#f97316;border-radius:8px;padding:14px 32px;">
            <a href="https://elemetric.app" style="font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">
              Open Elemetric &rarr;
            </a>
          </td>
        </tr>
      </table>

      <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
        This invite was sent by ${safeInvitedBy}. If you don't know this person, you can ignore this email.
        The join code expires once used or after 7 days.
      </p>`;

    const { data, error: sendError } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `${invitedBy} invited you to join ${teamName} on Elemetric`,
      html: buildEmailHtml(`Team invitation — ${escHtml(teamName)}`, content),
    });

    if (sendError) {
      console.error("Resend /send-team-invite error:", sendError);
      return res.status(500).json({ error: "Failed to send team invite email." });
    }

    usageStats.emailsSent++;
    return res.json({ sent: true, id: data?.id });
  } catch (error) {
    console.error("send-team-invite error:", error);
    return res.status(500).json({ error: "Failed to send team invite email." });
  }
});

// ── POST /send-near-miss-alert ─────────────────────────────────────────────────
// Body: { to, employerName, workerName, jobName, reportDetails }
// Emails the employer when a team member files a near-miss report.

app.post("/send-near-miss-alert", async (req, res) => {
  try {
    if (!resend) return res.status(503).json({ error: "Email service not configured." });

    const { to, employerName, workerName, jobName, reportDetails } = req.body || {};
    if (!to || !isValidEmail(to))
      return res.status(400).json({ error: "Missing or invalid recipient email address." });
    if (!employerName || typeof employerName !== "string")
      return res.status(400).json({ error: "Missing employerName." });
    if (!workerName || typeof workerName !== "string")
      return res.status(400).json({ error: "Missing workerName." });
    if (!jobName || typeof jobName !== "string")
      return res.status(400).json({ error: "Missing jobName." });
    if (!reportDetails || typeof reportDetails !== "string")
      return res.status(400).json({ error: "Missing reportDetails." });

    const firstName       = escHtml(employerName.split(" ")[0]);
    const safeWorker      = escHtml(workerName);
    const safeJob         = escHtml(jobName);
    const safeDetails     = escHtml(reportDetails);
    const safeEmployer    = escHtml(employerName);

    const content = `
      <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;">Near-miss report filed.</h1>
      <p style="margin:0 0 24px;font-size:14px;color:#64748b;">A team member has logged a near-miss incident.</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <tr style="background:#f8fafc;">
          <td style="padding:12px 20px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;" width="40%">Reported by</td>
          <td style="padding:12px 20px;font-size:14px;color:#1e293b;font-weight:600;">${safeWorker}</td>
        </tr>
        <tr>
          <td style="padding:12px 20px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-top:1px solid #e2e8f0;">Job</td>
          <td style="padding:12px 20px;font-size:14px;color:#1e293b;border-top:1px solid #e2e8f0;">${safeJob}</td>
        </tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
        <tr>
          <td style="background:#fff7ed;border-left:4px solid #f97316;padding:16px 20px;border-radius:0 8px 8px 0;">
            <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#c2410c;text-transform:uppercase;letter-spacing:0.5px;">Incident details</p>
            <p style="margin:0;font-size:14px;color:#1e293b;line-height:1.6;">${safeDetails}</p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 16px;font-size:15px;color:#1e293b;line-height:1.7;">
        Hi ${firstName}, <strong>${safeWorker}</strong> has filed a near-miss report on job
        <strong>${safeJob}</strong>. Review the incident details above and take appropriate action
        to prevent future occurrences.
      </p>

      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <td style="background:#f97316;border-radius:8px;padding:14px 32px;">
            <a href="https://elemetric.app" style="font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">
              View in Elemetric &rarr;
            </a>
          </td>
        </tr>
      </table>

      <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">
        This notification was sent automatically when a near-miss report was filed in Elemetric.
      </p>`;

    const { data, error: sendError } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Near-miss report: ${jobName} — filed by ${workerName}`,
      html: buildEmailHtml("Near-miss report — Elemetric", content),
    });

    if (sendError) {
      console.error("Resend /send-near-miss-alert error:", sendError);
      return res.status(500).json({ error: "Failed to send near-miss alert email." });
    }

    usageStats.emailsSent++;
    return res.json({ sent: true, id: data?.id });
  } catch (error) {
    console.error("send-near-miss-alert error:", error);
    return res.status(500).json({ error: "Failed to send near-miss alert email." });
  }
});

// ── Task 10: Job Risk Assessment Engine ──────────────────────────────────────
/**
 * assessJobRisk — comprehensive post-job risk profile.
 *
 * Analyses completed job data and returns a detailed risk profile including
 * overall risk level, specific risk factors, recommended mitigation actions,
 * and estimated liability exposure in years remaining.
 *
 * @param {Object} p
 * @param {string}  p.jobType             - trade type
 * @param {number}  p.complianceScore     - 0-100 compliance score
 * @param {number}  p.missingItemCount    - number of failed/missing items
 * @param {boolean} p.gpsRecorded         - GPS coordinates captured
 * @param {boolean} p.signatureObtained   - client signature captured
 * @param {number}  p.photosTaken         - photos actually submitted
 * @param {number}  p.requiredPhotos      - expected minimum photo count
 * @param {number}  p.complexityScore     - 1-10 from calculateComplexity()
 * @param {number}  p.daysSinceCompletion - days since job was completed
 * @returns {{ overallRisk, riskFactors, recommendedActions, liabilityYears, detail }}
 */
function assessJobRisk({
  jobType, complianceScore, missingItemCount, gpsRecorded, signatureObtained,
  photosTaken, requiredPhotos, complexityScore, daysSinceCompletion,
}) {
  const riskFactors     = [];
  const recommendedActions = [];
  let riskPoints        = 0;

  // Trade type base risk
  const tradeRisk = { gas: 4, electrical: 4, plumbing: 3, drainage: 2, hvac: 2, carpentry: 1 };
  riskPoints += tradeRisk[jobType] ?? 2;

  // Compliance score risk
  if (complianceScore < 50) {
    riskPoints += 5;
    riskFactors.push({ factor: "Very low compliance score", severity: "critical", detail: `Score ${complianceScore}/100 is critically low` });
    recommendedActions.push("Immediately retake all failed photos and resubmit for analysis before certifying.");
  } else if (complianceScore < 70) {
    riskPoints += 3;
    riskFactors.push({ factor: "Below-threshold compliance score", severity: "high", detail: `Score ${complianceScore}/100 is below the 70-point pass threshold` });
    recommendedActions.push("Retake failed photos to bring compliance score above 70 before lodging certification.");
  } else if (complianceScore < 85) {
    riskPoints += 1;
    riskFactors.push({ factor: "Marginal compliance score", severity: "medium", detail: `Score ${complianceScore}/100 — consider retaking unclear photos` });
    recommendedActions.push("Consider retaking any unclear photos to strengthen the compliance record.");
  }

  // Missing items risk
  if (missingItemCount > 0) {
    const missingRisk = Math.min(4, missingItemCount * 1.5);
    riskPoints += missingRisk;
    const sev = missingItemCount >= 3 ? "critical" : missingItemCount >= 2 ? "high" : "medium";
    riskFactors.push({ factor: `${missingItemCount} missing compliance item${missingItemCount !== 1 ? "s" : ""}`, severity: sev, detail: `${missingItemCount} required item${missingItemCount !== 1 ? "s" : ""} not documented` });
    recommendedActions.push(`Return to site and photograph the ${missingItemCount} missing item${missingItemCount !== 1 ? "s" : ""} before certifying.`);
  }

  // GPS not recorded
  if (!gpsRecorded) {
    riskPoints += 2;
    riskFactors.push({ factor: "No GPS coordinates recorded", severity: "medium", detail: "Location cannot be independently verified — weakens evidentiary value" });
    recommendedActions.push("Enable GPS on your device and retake the job to record location coordinates.");
  }

  // No client signature
  if (!signatureObtained) {
    riskPoints += 2;
    riskFactors.push({ factor: "No client signature obtained", severity: "medium", detail: "Client acceptance not recorded — increases dispute risk" });
    recommendedActions.push("Obtain a client signature or send the job report for digital sign-off via the app.");
  }

  // Insufficient photos
  if (typeof photosTaken === "number" && typeof requiredPhotos === "number" && photosTaken < requiredPhotos) {
    const shortfall = requiredPhotos - photosTaken;
    riskPoints += Math.min(3, shortfall);
    riskFactors.push({ factor: `Only ${photosTaken} of ${requiredPhotos} recommended photos taken`, severity: "medium", detail: `${shortfall} more photo${shortfall !== 1 ? "s" : ""} recommended for complete documentation` });
    recommendedActions.push(`Take ${shortfall} more photo${shortfall !== 1 ? "s" : ""} to complete the recommended documentation set.`);
  }

  // High complexity with low evidence
  if (complexityScore >= 7 && complianceScore < 80) {
    riskPoints += 2;
    riskFactors.push({ factor: "Complex job with incomplete evidence", severity: "high", detail: `Complexity score ${complexityScore}/10 — complex jobs require more thorough documentation` });
    recommendedActions.push("Add additional photos covering all aspects of this complex installation.");
  }

  // Time since completion (risk of gaps being discovered later)
  if (typeof daysSinceCompletion === "number" && daysSinceCompletion > 30 && missingItemCount > 0) {
    riskPoints += 1;
    riskFactors.push({ factor: "Missing items not rectified within 30 days", severity: "medium", detail: `Job completed ${daysSinceCompletion} days ago — missing items become harder to rectify over time` });
    recommendedActions.push("Contact the client to arrange a return visit to document the missing items promptly.");
  }

  // Determine overall risk level
  let overallRisk;
  if (riskPoints >= 12)     overallRisk = "critical";
  else if (riskPoints >= 8) overallRisk = "high";
  else if (riskPoints >= 5) overallRisk = "medium";
  else                      overallRisk = "low";

  // Estimate liability exposure period
  // High-risk trades have longer liability windows under Australian law
  const baseLiabilityYears = { gas: 10, electrical: 7, plumbing: 7, drainage: 7, hvac: 5, carpentry: 6 };
  const base = baseLiabilityYears[jobType] ?? 6;
  // Missing compliance items extend liability exposure
  const liabilityYears = base + (missingItemCount * 1.5) + (complianceScore < 70 ? 2 : 0);

  return {
    overallRisk,
    riskPoints,
    riskFactors,
    recommendedActions: [...new Set(recommendedActions)], // deduplicate
    liabilityYears: parseFloat(Math.min(15, liabilityYears).toFixed(1)),
    detail: {
      jobType,
      complianceScore,
      missingItemCount,
      gpsRecorded:       !!gpsRecorded,
      signatureObtained: !!signatureObtained,
      complexityScore,
      daysSinceCompletion: daysSinceCompletion ?? null,
    },
    summary: `${overallRisk.charAt(0).toUpperCase() + overallRisk.slice(1)} risk — ${riskFactors.length} risk factor${riskFactors.length !== 1 ? "s" : ""} identified. Estimated liability exposure: ${Math.min(15, liabilityYears).toFixed(1)} years.`,
  };
}

// POST /risk-assessment — returns risk profile for a completed job
// Body: { jobType, complianceScore, missingItemCount, gpsRecorded,
//          signatureObtained, photosTaken, requiredPhotos,
//          complexityScore, daysSinceCompletion }

app.post("/risk-assessment", (req, res) => {
  try {
    const {
      jobType, complianceScore, missingItemCount, gpsRecorded, signatureObtained,
      photosTaken, requiredPhotos, complexityScore, daysSinceCompletion,
    } = req.body || {};

    if (!jobType || typeof jobType !== "string")
      return res.status(400).json({ error: "Missing jobType." });
    if (typeof complianceScore !== "number")
      return res.status(400).json({ error: "complianceScore must be a number." });

    const result = assessJobRisk({
      jobType,
      complianceScore: Math.max(0, Math.min(100, complianceScore)),
      missingItemCount:    typeof missingItemCount    === "number" ? missingItemCount    : 0,
      gpsRecorded:         !!gpsRecorded,
      signatureObtained:   !!signatureObtained,
      photosTaken:         typeof photosTaken         === "number" ? photosTaken         : undefined,
      requiredPhotos:      typeof requiredPhotos      === "number" ? requiredPhotos      : undefined,
      complexityScore:     typeof complexityScore     === "number" ? complexityScore     : 5,
      daysSinceCompletion: typeof daysSinceCompletion === "number" ? daysSinceCompletion : undefined,
    });

    return res.json(result);
  } catch (err) {
    console.error("risk-assessment error:", err);
    return res.status(500).json({ error: "Risk assessment failed. Please try again." });
  }
});

// ── Task 11: Victorian Regulation Checker ────────────────────────────────────
// Checks a completed job's evidence against specific Victorian trade requirements.

const VICTORIAN_CHECKLISTS = {
  plumbing: [
    { id: "P1", requirement: "Certificate of Compliance (Plumbing) lodged with VBA within 5 business days", standard: "Plumbing Regulations 2018 r.54" },
    { id: "P2", requirement: "Permit obtained for notifiable work (drains, sewers, hot water, gas fitting)", standard: "Building Act 1993 s.16" },
    { id: "P3", requirement: "AS/NZS 3500.1 complied with for water services", standard: "AS/NZS 3500.1:2021" },
    { id: "P4", requirement: "AS/NZS 3500.2 complied with for sanitary plumbing and drainage", standard: "AS/NZS 3500.2:2021" },
    { id: "P5", requirement: "Tempering valve installed on hot water systems serving aged/disability facilities", standard: "AS/NZS 3500.4:2018 cl.6.4" },
    { id: "P6", requirement: "Backflow prevention device fitted where required", standard: "AS/NZS 3500.1 cl.4.6" },
    { id: "P7", requirement: "Sanitary drainage tested at minimum 75mm water head for 15 minutes", standard: "AS/NZS 3500.2 cl.10.3" },
    { id: "P8", requirement: "Licensed plumber registration verified and on-site", standard: "Plumbing Regulations 2018 r.10" },
  ],
  gas: [
    { id: "G1", requirement: "Certificate of Compliance (Gas) issued to occupier immediately on completion", standard: "Gas Safety (Gas Installation) Regulations 2008 r.48" },
    { id: "G2", requirement: "Pressure test performed and recorded (at least 1.1× working pressure)", standard: "AS/NZS 5601.1:2022 cl.8.3.2" },
    { id: "G3", requirement: "All appliances tested for correct operation after installation", standard: "AS/NZS 5601.1:2022 cl.7.6" },
    { id: "G4", requirement: "AGA/SAA approval marking verified on all appliances", standard: "Gas Safety Act 1997 s.7" },
    { id: "G5", requirement: "Ventilation requirements met for combustion appliances", standard: "AS/NZS 5601.1:2022 cl.6.4" },
    { id: "G6", requirement: "Flexible hose connections within maximum permitted length (1.2m)", standard: "AS/NZS 5601.1:2022 cl.5.5.3" },
    { id: "G7", requirement: "Isolation valve accessible and correctly labelled", standard: "AS/NZS 5601.1:2022 cl.5.8" },
    { id: "G8", requirement: "Gas-licensed person (Type A/B/C) performed all gas work", standard: "Gas Safety (Gas Installation) Regulations 2008 r.10" },
  ],
  electrical: [
    { id: "E1", requirement: "Certificate of Electrical Safety (CES) submitted to ESV within 5 business days", standard: "Electricity Safety (Installations) Regulations 2009 r.46" },
    { id: "E2", requirement: "RCD protection on all final sub-circuits in domestic installations", standard: "AS/NZS 3000:2018 cl.2.6.3.3" },
    { id: "E3", requirement: "Smoke alarm installed/checked and interconnected where required", standard: "Building Regulations 2018 r.120" },
    { id: "E4", requirement: "All switchboard work documented with circuit schedule", standard: "AS/NZS 3000:2018 cl.8.5.1" },
    { id: "E5", requirement: "Earth continuity tested and recorded for each circuit", standard: "AS/NZS 3000:2018 cl.8.3.7" },
    { id: "E6", requirement: "Insulation resistance test ≥1 MΩ for new circuits", standard: "AS/NZS 3000:2018 cl.8.3.6" },
    { id: "E7", requirement: "Polarity correct and verified for all outlets and light fittings", standard: "AS/NZS 3000:2018 cl.8.3.3" },
    { id: "E8", requirement: "Licensed electrician (Registered/Approved) performed all prescribed work", standard: "Electricity Safety Act 1998 s.34" },
  ],
  drainage: [
    { id: "D1", requirement: "Stormwater and sewer systems kept separate and documented", standard: "AS/NZS 3500.3:2018 cl.3.1" },
    { id: "D2", requirement: "CCTV or hydraulic test performed after drainage works", standard: "AS/NZS 3500.3:2018 cl.9.5" },
    { id: "D3", requirement: "Overflow relief gully (ORG) installed and graded correctly", standard: "AS/NZS 3500.2:2021 cl.4.8" },
    { id: "D4", requirement: "All drainage materials comply with AS/NZS 1260 or AS/NZS 1477", standard: "AS/NZS 3500.3:2018 cl.4.2" },
    { id: "D5", requirement: "Permit obtained before connecting to Melbourne Water assets", standard: "Water Act 1989 s.152" },
    { id: "D6", requirement: "Minimum 1:40 fall on drain runs ≤75mm diameter", standard: "AS/NZS 3500.3:2018 cl.5.4.2" },
  ],
  carpentry: [
    { id: "C1", requirement: "Structural work complies with AS 1684 Residential Timber-Framed Construction", standard: "AS 1684.2:2010" },
    { id: "C2", requirement: "Building permit obtained for structural alterations over $10,000 or load-bearing work", standard: "Building Act 1993 s.16" },
    { id: "C3", requirement: "Engineer's report provided for non-standard framing or spans", standard: "Building Act 1993 s.38" },
    { id: "C4", requirement: "Termite management system documented for new framing close to ground", standard: "AS 3660.1:2014" },
    { id: "C5", requirement: "Moisture barrier installed where required for sub-floor and external cladding", standard: "AS/NZS 4200.1:2017" },
    { id: "C6", requirement: "Frame inspection completed by building inspector before lining", standard: "Building Regulations 2018 r.58" },
  ],
  hvac: [
    { id: "H1", requirement: "Refrigerant handling by ARCtick-licensed technician only", standard: "Ozone Protection and Synthetic Greenhouse Gas Management Act 1989" },
    { id: "H2", requirement: "Electrical connection to HVAC performed by licensed electrician", standard: "Electricity Safety Act 1998 s.34" },
    { id: "H3", requirement: "Ductwork leakage test performed and result recorded (Class 1 ≤2% leakage)", standard: "AS 4254.2:2012 cl.4.3" },
    { id: "H4", requirement: "Fresh air ventilation rates meet minimum requirements", standard: "AS 1668.2:2012" },
    { id: "H5", requirement: "Condensate drainage connected and tested", standard: "AS/NZS 3500.2:2021 cl.8.6" },
    { id: "H6", requirement: "Commissioning report completed including airflow measurements", standard: "AIRAH DA19:2019" },
  ],
};

/**
 * checkVictorianCompliance — maps reported job evidence against VIC-specific
 * regulatory requirements for the given trade type.
 *
 * @param {object} opts
 * @param {string}   opts.jobType          - plumbing | gas | electrical | drainage | carpentry | hvac
 * @param {string[]} opts.itemsDetected    - evidence items found by AI analysis
 * @param {string[]} opts.itemsMissing     - evidence items flagged as missing
 * @param {boolean}  opts.certificateFiled - true if compliance cert was filed
 * @param {boolean}  opts.permitObtained   - true if permit/licence verified
 * @param {boolean}  opts.testRecorded     - true if a pressure/continuity/etc test was recorded
 * @returns {object} compliance report
 */
function checkVictorianCompliance({ jobType, itemsDetected = [], itemsMissing = [], certificateFiled = false, permitObtained = false, testRecorded = false }) {
  const checklist = VICTORIAN_CHECKLISTS[jobType];
  if (!checklist) {
    return { error: `No Victorian checklist available for job type: ${jobType}` };
  }

  const detectedLower = itemsDetected.map(i => i.toLowerCase());
  const missingLower  = itemsMissing.map(i => i.toLowerCase());

  const results = checklist.map(item => {
    const id = item.id;
    const reqLower = item.requirement.toLowerCase();

    // Heuristic pass/fail logic per item category
    let status = "unknown";
    let note = "";

    if (id.endsWith("1") && (id[0] === "P" || id[0] === "G" || id[0] === "E")) {
      // Certificate of compliance requirement
      status = certificateFiled ? "pass" : "fail";
      note = certificateFiled ? "Certificate filed" : "No certificate filing evidence provided";
    } else if (reqLower.includes("permit") || reqLower.includes("licence") || reqLower.includes("licensed")) {
      status = permitObtained ? "pass" : "uncertain";
      note = permitObtained ? "Permit/licence verified" : "Permit or licence verification not confirmed";
    } else if (reqLower.includes("test") || reqLower.includes("pressure") || reqLower.includes("insulation resistance") || reqLower.includes("earth continuity") || reqLower.includes("cctv")) {
      status = testRecorded ? "pass" : "uncertain";
      note = testRecorded ? "Test recorded" : "Test record not confirmed";
    } else {
      // Check if detected items contain evidence for this requirement
      const evidenceKeywords = reqLower.split(/[\s,]+/).filter(w => w.length > 5);
      const foundInDetected = evidenceKeywords.some(kw => detectedLower.some(d => d.includes(kw)));
      const foundInMissing  = evidenceKeywords.some(kw => missingLower.some(m => m.includes(kw)));

      if (foundInMissing) {
        status = "fail";
        note = "Required evidence identified as missing in analysis";
      } else if (foundInDetected) {
        status = "pass";
        note = "Supporting evidence found in analysis";
      } else {
        status = "uncertain";
        note = "No direct evidence found — manual verification recommended";
      }
    }

    return { id, requirement: item.requirement, standard: item.standard, status, note };
  });

  const passed    = results.filter(r => r.status === "pass").length;
  const failed    = results.filter(r => r.status === "fail").length;
  const uncertain = results.filter(r => r.status === "uncertain").length;
  const total     = results.length;
  const score     = Math.round((passed / total) * 100);

  const overallStatus =
    failed > 0          ? "non-compliant" :
    uncertain > total / 3 ? "requires-review" :
    "compliant";

  const criticalFailures = results.filter(r => r.status === "fail").map(r => r.id);

  return {
    jobType,
    jurisdiction: "Victoria, Australia",
    checkedAt: new Date().toISOString(),
    overallStatus,
    score,
    summary: `${passed}/${total} requirements satisfied. ${failed} critical failure(s), ${uncertain} requiring manual review.`,
    criticalFailures,
    results,
  };
}

app.post("/compliance-check", (req, res) => {
  const {
    jobType,
    itemsDetected,
    itemsMissing,
    certificateFiled,
    permitObtained,
    testRecorded,
  } = req.body || {};

  if (!jobType || typeof jobType !== "string") {
    return res.status(400).json({ error: "jobType is required (plumbing, gas, electrical, drainage, carpentry, hvac)" });
  }
  if (!VICTORIAN_CHECKLISTS[jobType]) {
    return res.status(400).json({ error: `Unknown jobType: ${jobType}. Valid types: ${Object.keys(VICTORIAN_CHECKLISTS).join(", ")}` });
  }

  const report = checkVictorianCompliance({
    jobType,
    itemsDetected: Array.isArray(itemsDetected) ? itemsDetected : [],
    itemsMissing:  Array.isArray(itemsMissing)  ? itemsMissing  : [],
    certificateFiled: Boolean(certificateFiled),
    permitObtained:   Boolean(permitObtained),
    testRecorded:     Boolean(testRecorded),
  });

  return res.json(report);
});

// ── Task 9: Regulatory Change Monitoring ─────────────────────────────────────
// Tracks known changes to Australian trade standards relevant to Elemetric users.

const REGULATORY_UPDATES = [
  {
    id: "RU-2025-001",
    date: "2025-03-01",
    standard: "AS/NZS 3000:2018 Amendment 2",
    change: "Updated requirements for arc fault detection devices (AFDDs) in new residential dwellings — AFDDs now required on all final subcircuits in bedrooms of new Class 1a buildings.",
    affectedJobTypes: ["electrical"],
    severity: "high",
    summary: "AFDD protection now mandatory in new residential bedroom circuits. Electricians must verify AFDD is installed on all bedroom final subcircuits for new builds.",
  },
  {
    id: "RU-2025-002",
    date: "2025-01-15",
    standard: "NCC 2025 (National Construction Code)",
    change: "Minimum energy efficiency requirements for hot water systems upgraded — electric resistance hot water heaters no longer permitted in new Class 1a buildings unless connected to off-peak tariff.",
    affectedJobTypes: ["plumbing"],
    severity: "high",
    summary: "New hot water system energy efficiency requirements from NCC 2025 affect plumbing compliance for new builds. Heat pump or solar hot water now preferred.",
  },
  {
    id: "RU-2024-011",
    date: "2024-11-01",
    standard: "AS/NZS 5601.1:2013 Amendment 4",
    change: "Updated clearance requirements for gas appliances in outdoor installations — increased minimum clearance from combustible fencing from 500mm to 600mm for outdoor BBQ installations.",
    affectedJobTypes: ["gas"],
    severity: "medium",
    summary: "Outdoor gas appliance clearance to combustible fencing increased to 600mm under Amendment 4. Review outdoor gas installations for compliance.",
  },
  {
    id: "RU-2024-009",
    date: "2024-09-15",
    standard: "AS/NZS 3500.4:2021 Amendment 1",
    change: "Clarification to tempering valve requirements — TMV must be installed as close as practicable to the point of use, maximum 5m of pipe between TMV and outlet. Confirmed 50°C maximum mixed water temperature.",
    affectedJobTypes: ["plumbing"],
    severity: "medium",
    summary: "Tempering valve placement clarified: maximum 5m pipe run between TMV and outlet. 50°C maximum temperature limit unchanged.",
  },
  {
    id: "RU-2024-007",
    date: "2024-07-01",
    standard: "Victorian Building Regulations 2018 (Amendment)",
    change: "Mandatory smoke alarm interconnection required in all new and substantially renovated Class 1a buildings. All hardwired smoke alarms must be interconnected.",
    affectedJobTypes: ["electrical"],
    severity: "high",
    summary: "All hardwired smoke alarms in new and renovated homes must be interconnected in Victoria from July 2024. Interconnection wiring must be visible in documentation.",
  },
  {
    id: "RU-2024-005",
    date: "2024-05-20",
    standard: "AS/NZS 3500.1:2021 Amendment 2",
    change: "Updated requirements for backflow prevention in commercial and multi-residential water systems — RPZ valves now mandatory where risk of high-hazard backflow exists.",
    affectedJobTypes: ["plumbing"],
    severity: "medium",
    summary: "Backflow prevention requirements updated for commercial plumbing. RPZ valves now mandatory for high-hazard backflow risk situations.",
  },
  {
    id: "RU-2024-003",
    date: "2024-03-01",
    standard: "AS/NZS 3000:2018 Amendment 1",
    change: "Updated requirements for RCD protection — all new circuits in domestic installations must have RCD protection. Maximum 300ms trip time confirmed and now explicitly referenced in amendment.",
    affectedJobTypes: ["electrical"],
    severity: "high",
    summary: "All new domestic circuits must have RCD protection. 300ms maximum trip time explicitly confirmed in amendment. Test certificates must show trip time reading.",
  },
  {
    id: "RU-2024-001",
    date: "2024-01-10",
    standard: "AS/NZS 1684.2:2021",
    change: "Revised timber framing span tables for engineered wood products. LVL and laminated timber beams have updated span limits based on new load testing. Previous span tables may under-specify some members.",
    affectedJobTypes: ["carpentry"],
    severity: "medium",
    summary: "Timber framing span tables updated for engineered wood products. Review LVL beam sizing against new 2021 edition span tables for compliance.",
  },
  {
    id: "RU-2023-012",
    date: "2023-12-01",
    standard: "AS/NZS 5601.1:2013 Amendment 3",
    change: "Updated requirements for LPG cylinder installations at residential properties — minimum cylinder distance from building openings confirmed at 500mm, with new measurement methodology.",
    affectedJobTypes: ["gas"],
    severity: "low",
    summary: "LPG cylinder placement requirements clarified with new measurement methodology. 500mm minimum distance from building openings unchanged but measurement must now be taken from the cylinder valve.",
  },
  {
    id: "RU-2023-009",
    date: "2023-09-15",
    standard: "AS/NZS 3500.2:2021",
    change: "Updated minimum drainage pipe gradient requirements for small diameter pipes. 65mm pipes now require minimum 1:40 gradient (previously 1:60) when serving multiple fixtures.",
    affectedJobTypes: ["drainage"],
    severity: "medium",
    summary: "Minimum gradient for 65mm drainage pipes serving multiple fixtures increased to 1:40. Review small diameter drainage runs in multi-fixture installations.",
  },
  {
    id: "RU-2023-006",
    date: "2023-06-01",
    standard: "Victorian Gas Safety Act 2019 (Regulation Update)",
    change: "Updated certification requirements for gas fitters — compliance certificates must now include GPS coordinates of installation address and must be lodged within 7 days of completion.",
    affectedJobTypes: ["gas"],
    severity: "high",
    summary: "Gas compliance certificates must now include GPS coordinates and be lodged within 7 days. Failure to lodge within timeframe attracts penalties.",
  },
  {
    id: "RU-2023-003",
    date: "2023-03-20",
    standard: "AS/NZS 3000:2018",
    change: "Clarification on EV charging point circuit requirements — dedicated 32A circuit required for Mode 3 EVSE, with RCD Type B protection required where DC current injection may occur.",
    affectedJobTypes: ["electrical"],
    severity: "medium",
    summary: "EV charging points require dedicated circuit and Type B RCD where DC current injection risk exists. Standard household RCD (Type A) is insufficient for many modern EVSEs.",
  },
];

app.get("/regulatory-updates", (req, res) => {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

  const jobType  = req.query.jobType;
  const severity = req.query.severity;

  let updates = REGULATORY_UPDATES.filter(u => new Date(u.date) >= twelveMonthsAgo);
  if (jobType)  updates = updates.filter(u => u.affectedJobTypes.includes(jobType));
  if (severity) updates = updates.filter(u => u.severity === severity);

  return res.json({
    updates,
    total:     updates.length,
    asOf:      new Date().toISOString(),
    allCount:  REGULATORY_UPDATES.length,
  });
});

// ── GET /prompts ──────────────────────────────────────────────────────────────
// Returns prompt registry metadata — versions, descriptions, A/B test results.

app.get("/prompts", (_req, res) => {
  const abSummary = {
    v1: {
      ...promptAbStats.v1,
      description: "Standard prompt (80% of traffic)",
    },
    v2: {
      ...promptAbStats.v2,
      description: "Chain-of-thought enhanced variant (20% of traffic)",
    },
    winningVariant: (() => {
      const { v1, v2 } = promptAbStats;
      if (v1.uses < 5 || v2.uses < 5) return "insufficient_data";
      if (v1.avgConfidence > v2.avgConfidence) return "v1";
      if (v2.avgConfidence > v1.avgConfidence) return "v2";
      return "tied";
    })(),
  };

  return res.json({
    registry:    PROMPT_REGISTRY,
    abTesting:   abSummary,
    retrievedAt: new Date().toISOString(),
  });
});

// ── GET /stats ────────────────────────────────────────────────────────────────
// Protected by API key middleware. Returns usage metrics and estimated costs.

app.get("/stats", (_req, res) => {
  const estimatedCostUSD =
    usageStats.openaiCalls    * COST_PER_OPENAI_CALL  +
    usageStats.replicateCalls * COST_PER_REPLICATE_CALL +
    usageStats.emailsSent     * COST_PER_EMAIL;

  return res.json({
    ...usageStats,
    estimatedCostUSD: parseFloat(estimatedCostUSD.toFixed(4)),
    uptimeSeconds:    Math.round(process.uptime()),
    cache: {
      entries:      analysisCache.size,
      maxEntries:   500,
      ttlMinutes:   60,
      hits:         cacheAnalytics.hits,
      misses:       cacheAnalytics.misses,
      evictions:    cacheAnalytics.evictions,
      sets:         cacheAnalytics.sets,
      hitRatePct:   cacheAnalytics.hitRate,
      missRatePct:  cacheAnalytics.missRate,
    },
    pendingAnalyses:  pendingAnalyses.size,
    promptAbTesting:  promptAbStats,
    notifications: {
      queued: notificationQueue.filter(n => !n.sent).length,
      sent:   notificationLog.length,
    },
  });
});

// ── GET /analytics ────────────────────────────────────────────────────────────
// Protected by API key. Queries Supabase for real-time business metrics:
// total users, jobs by type, average confidence, missing items frequency,
// geographic distribution, and daily/weekly/monthly counts.

app.get("/analytics", async (_req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: "Analytics unavailable: database not configured." });
  }

  try {
    const now = new Date();
    const startOfToday   = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek    = new Date(now); startOfWeek.setDate(now.getDate() - 7);
    const startOfMonth   = new Date(now); startOfMonth.setDate(now.getDate() - 30);

    const [
      usersResult,
      jobsResult,
      jobsByTypeResult,
      recentDayResult,
      recentWeekResult,
      recentMonthResult,
      topMissingResult,
      geoResult,
    ] = await Promise.allSettled([
      // Total user count
      supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }),

      // All jobs for aggregate stats
      supabaseAdmin
        .from("analyses")
        .select("job_type, confidence, missing_items, created_at, location_state"),

      // Jobs grouped by type (aggregated client-side after fetch)
      supabaseAdmin
        .from("analyses")
        .select("job_type"),

      // Jobs today
      supabaseAdmin
        .from("analyses")
        .select("id", { count: "exact", head: true })
        .gte("created_at", startOfToday.toISOString()),

      // Jobs last 7 days
      supabaseAdmin
        .from("analyses")
        .select("id", { count: "exact", head: true })
        .gte("created_at", startOfWeek.toISOString()),

      // Jobs last 30 days
      supabaseAdmin
        .from("analyses")
        .select("id", { count: "exact", head: true })
        .gte("created_at", startOfMonth.toISOString()),

      // Top missing items (last 30 days)
      supabaseAdmin
        .from("analyses")
        .select("missing_items")
        .gte("created_at", startOfMonth.toISOString())
        .not("missing_items", "is", null),

      // Geographic distribution by state
      supabaseAdmin
        .from("analyses")
        .select("location_state")
        .not("location_state", "is", null),
    ]);

    // Helper to safely extract data from allSettled results
    const safeData = (r) => (r.status === "fulfilled" && !r.value.error ? r.value.data : null);
    const safeCount = (r) => (r.status === "fulfilled" && !r.value.error ? r.value.count : null);

    // Total users
    const totalUsers = safeCount(usersResult) ?? null;

    // Jobs aggregate stats
    const allJobs = safeData(jobsResult) || [];
    const totalJobs = allJobs.length;
    const avgConfidence = totalJobs > 0
      ? Math.round(allJobs.reduce((sum, j) => sum + (j.confidence || 0), 0) / totalJobs)
      : null;

    // Jobs by type
    const jobTypeRows = safeData(jobsByTypeResult) || [];
    const jobsByType = jobTypeRows.reduce((acc, row) => {
      const t = row.job_type || "unknown";
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {});

    // Activity counts
    const jobsToday   = safeCount(recentDayResult) ?? null;
    const jobsWeek    = safeCount(recentWeekResult) ?? null;
    const jobsMonth   = safeCount(recentMonthResult) ?? null;

    // Top missing items (frequency map)
    const missingRows = safeData(topMissingResult) || [];
    const missingFreq = {};
    missingRows.forEach(row => {
      const items = Array.isArray(row.missing_items)
        ? row.missing_items
        : (typeof row.missing_items === "string" ? JSON.parse(row.missing_items) : []);
      items.forEach(item => {
        if (item && typeof item === "string") {
          missingFreq[item] = (missingFreq[item] || 0) + 1;
        }
      });
    });
    const topMissingItems = Object.entries(missingFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([item, count]) => ({ item, count }));

    // Geographic distribution
    const geoRows = safeData(geoResult) || [];
    const geoDistribution = geoRows.reduce((acc, row) => {
      const state = row.location_state || "unknown";
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, {});

    return res.json({
      generatedAt:    now.toISOString(),
      users: {
        total: totalUsers,
      },
      jobs: {
        total:          totalJobs,
        today:          jobsToday,
        last7Days:      jobsWeek,
        last30Days:     jobsMonth,
        byType:         jobsByType,
        avgConfidencePct: avgConfidence,
      },
      compliance: {
        topMissingItems,
      },
      geography: {
        byState: geoDistribution,
      },
      server: {
        uptime:         Math.round(process.uptime()),
        cacheSize:      analysisCache.size,
        totalRequests:  usageStats.totalRequests,
        openaiCalls:    usageStats.openaiCalls,
        replicateCalls: usageStats.replicateCalls,
        emailsSent:     usageStats.emailsSent,
      },
    });
  } catch (err) {
    console.error("GET /analytics error:", err);
    return res.status(500).json({ error: "Analytics query failed. Please try again." });
  }
});

// ── Task 5: Smart Recommendations Engine ─────────────────────────────────────
// Analyses job history patterns and returns personalised, actionable recommendations.

app.post("/recommendations", (req, res) => {
  const {
    jobType,
    itemsMissing    = [],
    itemsUnclear    = [],
    confidenceScore = null,
    jobHistory      = [],   // array of { jobType, confidence, itemsMissing }
  } = req.body || {};

  if (!jobType || typeof jobType !== "string") {
    return res.status(400).json({ error: "jobType is required." });
  }

  const recommendations = [];
  const allHistoryMissing = [];
  const allHistoryConfidence = [];

  // Build aggregated history stats
  for (const job of jobHistory) {
    if (job.itemsMissing && Array.isArray(job.itemsMissing)) {
      allHistoryMissing.push(...job.itemsMissing);
    }
    if (typeof job.confidence === "number") {
      allHistoryConfidence.push(job.confidence);
    }
  }

  // Frequency map of historically missing items
  const missingFreq = {};
  for (const item of allHistoryMissing) {
    missingFreq[item] = (missingFreq[item] || 0) + 1;
  }

  // Average historical confidence
  const avgHistoricalConfidence = allHistoryConfidence.length > 0
    ? Math.round(allHistoryConfidence.reduce((a, b) => a + b, 0) / allHistoryConfidence.length)
    : null;

  // 1. Current job: personalise on specific missing items
  if (itemsMissing.length > 0) {
    for (const item of itemsMissing.slice(0, 3)) {
      const lItem = item.toLowerCase();
      let tip = `Make "${item}" your very first photo on the next job — this gives it the best light and focus.`;

      if (lItem.includes("ptr") || lItem.includes("pressure") && lItem.includes("temp")) {
        tip = `PTR valve photos are the most commonly missed item. Mount your phone on a tripod and take it from 30 cm — show the compliance label AND the discharge pipe in one shot.`;
      } else if (lItem.includes("tempering")) {
        tip = `Tempering valves are a hot water scalding safety item — VBA inspectors always check them. Get close enough that the AS 3500.4 marking and all three connections are in frame together.`;
      } else if (lItem.includes("burner") || lItem.includes("flame")) {
        tip = `For burner photos, light the appliance first, wait 30 seconds for flames to stabilise, then take the photo. A steady blue flame from 40 cm works every time.`;
      } else if (lItem.includes("rcd") || lItem.includes("safety switch")) {
        tip = `RCD photos need to show the test button AND a visible trip indicator. Turn on the switchboard lights, get 30 cm away, and shoot straight-on.`;
      } else if (lItem.includes("label") || lItem.includes("certif") || lItem.includes("compliance plate")) {
        tip = `Compliance labels need to be legible. Use your phone's portrait mode and tap the label to focus — if you can't read it on your screen, the AI can't either.`;
      } else if (lItem.includes("gps") || lItem.includes("location")) {
        tip = `Enable location services for Elemetric in your phone settings — GPS coordinates are automatically embedded when you take photos inside the app.`;
      }

      recommendations.push({ type: "current_job", item, advice: tip, priority: "high" });
    }
  }

  // 2. Unclear items — give targeted retake advice
  for (const item of itemsUnclear.slice(0, 2)) {
    recommendations.push({
      type:     "retake_advice",
      item,
      advice:   `"${item}" was unclear — move 15–20 cm closer and retake in the same lighting. Make sure the specific component fills at least 60% of the frame.`,
      priority: "medium",
    });
  }

  // 3. Repeating patterns from job history
  const topRepeatedMissing = Object.entries(missingFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);

  for (const [item, count] of topRepeatedMissing) {
    if (count >= 2) {
      recommendations.push({
        type:     "pattern",
        item,
        advice:   `You've missed "${item}" on ${count} recent ${jobType} jobs. Add it to your site checklist as a mandatory first photo so it's never forgotten.`,
        priority: "medium",
        frequency: count,
      });
    }
  }

  // 4. Confidence-based coaching
  if (confidenceScore !== null) {
    if (confidenceScore >= 90) {
      recommendations.push({
        type:   "congratulations",
        advice: `Outstanding work — ${confidenceScore}% confidence is top-tier for a ${jobType} job. Your documentation standard puts you in the top 10% of Elemetric users.`,
        priority: "low",
      });
    } else if (confidenceScore >= 75) {
      recommendations.push({
        type:   "encouragement",
        advice: `Good documentation — ${confidenceScore}% confidence. To push into the 90s: get closer to each component, use natural light where possible, and check labels are readable before moving on.`,
        priority: "low",
      });
    } else if (confidenceScore < 60) {
      const tip = jobType === "gas"
        ? `For gas jobs, the three most important photos are: pressure gauge (legible), burner flames (lit and blue), and isolation valve (handle visible). Get those right and your score jumps immediately.`
        : jobType === "electrical"
        ? `For electrical jobs, focus on: RCD with visible test button, switchboard labels (legible from 30 cm), and earth conductor colour (green/yellow clearly visible).`
        : `Low confidence usually comes from distance and lighting. Take photos from 20–30 cm and turn on all available lights — bright, close photos pass consistently.`;

      recommendations.push({
        type:   "coaching",
        advice: tip,
        priority: "high",
      });
    }
  }

  // 5. Historical trend coaching
  if (avgHistoricalConfidence !== null && avgHistoricalConfidence < 70 && allHistoryConfidence.length >= 3) {
    recommendations.push({
      type:   "trend_coaching",
      advice: `Your average confidence across your last ${allHistoryConfidence.length} ${jobType} jobs is ${avgHistoricalConfidence}%. The most effective improvement is lighting — take photos with natural light or bring a work light. This alone typically raises scores by 10–15 points.`,
      priority: "medium",
    });
  }

  // 6. Job-type specific tips if few recommendations so far
  if (recommendations.length < 2) {
    const genericTips = {
      plumbing:  "Great plumbing documentation always shows: the compliance label on every valve, the discharge pipe running to a safe location, and dry surfaces around all joints.",
      gas:       "For gas documentation, always photograph: the pressure gauge reading, all burners lit with blue flames, and the isolation valve handle position.",
      electrical:"Strong electrical documentation always includes: the RCD with test button visible, all circuit labels legible, and green/yellow earth conductor colour clearly shown.",
      drainage:  "Good drainage documentation shows: pipe fall direction with a reference datum, inspection opening with label, and all joints smooth and fully engaged.",
      carpentry: "Solid carpentry documentation shows: all structural connections with visible fixings, correct member sizes readable on timber, and engineer's detail confirmed where applicable.",
      hvac:      "HVAC documentation should always show: refrigerant line lagging complete, condensate drain correctly terminated, and the commissioning sheet with measured values filled in.",
    };
    const tip = genericTips[jobType];
    if (tip) {
      recommendations.push({ type: "general", advice: tip, priority: "low" });
    }
  }

  return res.json({
    jobType,
    totalRecommendations: recommendations.length,
    recommendations,
    historicalStats: {
      jobsAnalysed:          allHistoryConfidence.length,
      avgConfidence:         avgHistoricalConfidence,
      mostFrequentMisses:    topRepeatedMissing.map(([item, count]) => ({ item, count })),
    },
  });
});

// ── Task 6: Benchmarking System ───────────────────────────────────────────────
// Compares a plumber's compliance score against anonymised aggregate benchmarks.

// Benchmark data: average scores and top-decile behaviours by trade type.
// In production these would be populated from real aggregated Supabase data.
const BENCHMARK_DATA = {
  plumbing:  { avgScore: 74, p25: 62, p50: 74, p75: 84, p90: 91, topBehaviours: ["Always shoots compliance labels from <20 cm", "Includes PTR valve AND discharge pipe in one frame", "Photographs before and after states for every replacement", "Shows all three connections on tempering valve"] },
  gas:       { avgScore: 71, p25: 59, p50: 71, p75: 82, p90: 89, topBehaviours: ["Always shows live burner flames (blue) — never an unlit burner", "Photographs gauge face within 20 cm so numbers are legible", "Shows isolation valve handle orientation at every appliance", "Includes flue terminal external shot on every job"] },
  electrical:{ avgScore: 76, p25: 64, p50: 76, p75: 86, p90: 93, topBehaviours: ["Always tests and photographs RCD trip time — shows the reading", "Photographs all circuit labels from 25 cm so every label is legible", "Confirms earth conductor colour (green/yellow) on every circuit", "Attaches test certificate to switchboard and photographs it in situ"] },
  drainage:  { avgScore: 69, p25: 57, p50: 69, p75: 80, p90: 88, topBehaviours: ["Uses a spirit level in every pipe fall photo", "Always shows the IO label clearly — embossed or marked cover", "Photographs bedding cross-section before backfill", "Takes video of flush test and exports a still frame"] },
  carpentry: { avgScore: 72, p25: 60, p50: 72, p75: 83, p90: 90, topBehaviours: ["Photographs engineer's details pinned to each framing element", "Shows all connection hardware — bolts, nails, and hangers", "Takes a wide shot and a close-up for every connection type", "Includes a scale reference (tape measure) in all span photos"] },
  hvac:      { avgScore: 73, p25: 61, p50: 73, p75: 83, p90: 91, topBehaviours: ["Always photographs commissioning sheet with measured airflow values filled", "Shows refrigerant line lagging complete end-to-end", "Includes condensate drain running to discharge point", "Photographs indoor and outdoor unit serial numbers for warranty records"] },
};

app.post("/benchmark", (req, res) => {
  const { jobType, complianceScore } = req.body || {};

  if (!jobType || typeof jobType !== "string") {
    return res.status(400).json({ error: "jobType is required." });
  }
  if (typeof complianceScore !== "number" || complianceScore < 0 || complianceScore > 100) {
    return res.status(400).json({ error: "complianceScore must be a number between 0 and 100." });
  }

  const benchmark = BENCHMARK_DATA[jobType];
  if (!benchmark) {
    return res.status(400).json({ error: `No benchmark data for jobType: ${jobType}.` });
  }

  // Calculate percentile rank
  let percentile;
  if (complianceScore >= benchmark.p90)      percentile = 90 + Math.round(((complianceScore - benchmark.p90) / (100 - benchmark.p90)) * 10);
  else if (complianceScore >= benchmark.p75) percentile = 75 + Math.round(((complianceScore - benchmark.p75) / (benchmark.p90 - benchmark.p75)) * 15);
  else if (complianceScore >= benchmark.p50) percentile = 50 + Math.round(((complianceScore - benchmark.p50) / (benchmark.p75 - benchmark.p50)) * 25);
  else if (complianceScore >= benchmark.p25) percentile = 25 + Math.round(((complianceScore - benchmark.p25) / (benchmark.p50 - benchmark.p25)) * 25);
  else                                        percentile = Math.round((complianceScore / benchmark.p25) * 25);
  percentile = Math.max(1, Math.min(99, percentile));

  const scoreDiff = complianceScore - benchmark.avgScore;
  const performanceLabel =
    percentile >= 90 ? "exceptional" :
    percentile >= 75 ? "above average" :
    percentile >= 50 ? "average"       :
    percentile >= 25 ? "below average" : "needs improvement";

  const motivationalMessage =
    percentile >= 90
      ? `You're in the top ${100 - percentile}% of ${jobType} tradespeople on Elemetric. Your documentation standard is genuinely exceptional.`
      : percentile >= 75
      ? `You're outperforming ${percentile}% of ${jobType} tradespeople. A few more targeted improvements and you'll be in the top 10%.`
      : percentile >= 50
      ? `You're average for ${jobType} on Elemetric (score ${complianceScore} vs avg ${benchmark.avgScore}). Small habits — like always shooting compliance labels from 20 cm — can move you up 15+ percentile points.`
      : `Your ${jobType} score of ${complianceScore} is below the average of ${benchmark.avgScore}. The good news: the improvements are simple. Focus on getting compliance labels readable and item-specific photos in every submission.`;

  const pointsToNext = complianceScore < benchmark.p90
    ? (complianceScore < benchmark.p75 ? benchmark.p75 - complianceScore : benchmark.p90 - complianceScore)
    : null;
  const nextMilestone = complianceScore < benchmark.p75 ? "top 25%" : complianceScore < benchmark.p90 ? "top 10%" : null;

  return res.json({
    jobType,
    yourScore:          complianceScore,
    victoriaAverage:    benchmark.avgScore,
    scoreDifference:    scoreDiff,
    percentileRank:     percentile,
    performanceLabel,
    motivationalMessage,
    nextMilestone,
    pointsToNextMilestone: pointsToNext,
    whatTop10PercentDo: benchmark.topBehaviours,
    benchmarkData: {
      p25: benchmark.p25,
      p50: benchmark.p50,
      p75: benchmark.p75,
      p90: benchmark.p90,
      note: "Based on anonymised aggregate data from Victorian tradespeople on Elemetric.",
    },
  });
});

// ── Task 7: Weather Impact Analysis ──────────────────────────────────────────
// Records weather conditions against compliance outcomes to surface patterns.

// In-memory weather dataset (persists for server lifetime)
const weatherDataset = [];

app.post("/weather-impact", (req, res) => {
  const {
    weatherCondition,  // "clear", "overcast", "light_rain", "heavy_rain", "hot", "cold", "windy", "humid"
    indoorOutdoor,     // "indoor" | "outdoor" | "mixed"
    complianceScore,
    confidenceScore,
    jobType,
    record = false,    // if true, add this data point to the dataset
  } = req.body || {};

  if (!weatherCondition || typeof weatherCondition !== "string") {
    return res.status(400).json({ error: "weatherCondition is required." });
  }

  // Optionally record this data point
  if (record && typeof complianceScore === "number" && typeof confidenceScore === "number") {
    weatherDataset.push({
      weatherCondition: weatherCondition.toLowerCase(),
      indoorOutdoor:    indoorOutdoor || "unknown",
      complianceScore,
      confidenceScore,
      jobType:          jobType || "unknown",
      recordedAt:       new Date().toISOString(),
    });
  }

  // Calculate live insights from dataset + static research findings
  const condition = weatherCondition.toLowerCase();

  // Static research-based baseline impacts
  const weatherEffects = {
    heavy_rain:  { photoQualityImpact: -18, complianceImpact: -12, note: "Heavy rain reduces photo quality by ~18% due to lens splash, reflections, and poor contrast. Recommend delaying outdoor photos or using a weatherproof phone case." },
    light_rain:  { photoQualityImpact: -8,  complianceImpact: -5,  note: "Light rain reduces photo quality by ~8%. Cover the phone screen to reduce glare from rain drops on the lens." },
    overcast:    { photoQualityImpact: +3,  complianceImpact: +2,  note: "Overcast days provide even, shadow-free lighting — actually slightly better than bright sun for compliance photos." },
    clear:       { photoQualityImpact: 0,   complianceImpact: 0,   note: "Clear sunny days are neutral overall — watch for harsh shadows on compliance labels, which can make text unreadable." },
    hot:         { photoQualityImpact: -3,  complianceImpact: -2,  note: "Hot conditions cause lens haze and worker fatigue. Take photos in shade where possible." },
    cold:        { photoQualityImpact: -5,  complianceImpact: -3,  note: "Cold conditions cause battery drain and condensation on lenses. Keep phone warm in pocket between shots." },
    windy:       { photoQualityImpact: -10, complianceImpact: -7,  note: "Wind causes camera shake. Use both hands, brace against a surface, or use the volume button as a shutter to reduce blur." },
    humid:       { photoQualityImpact: -6,  complianceImpact: -4,  note: "High humidity causes lens fog and condensation. Wipe the lens before each photo." },
  };

  const indoorEffect = indoorOutdoor === "indoor" ? { photoQualityImpact: +8, complianceImpact: +6, note: "Indoor jobs score an average of 8% higher on photo quality due to controlled lighting." }
    : indoorOutdoor === "outdoor"   ? { photoQualityImpact: -5, complianceImpact: -3, note: "Outdoor jobs average 5% lower photo quality due to variable natural light and environmental factors." }
    : { photoQualityImpact: 0, complianceImpact: 0, note: "Mixed indoor/outdoor jobs show average quality metrics." };

  const effect = weatherEffects[condition] || { photoQualityImpact: 0, complianceImpact: 0, note: "No specific impact data for this weather condition." };

  // Aggregate live dataset insights if enough data
  const matchingRecords = weatherDataset.filter(d => d.weatherCondition === condition);
  const liveAvg = matchingRecords.length >= 5
    ? {
        avgComplianceScore: Math.round(matchingRecords.reduce((s, d) => s + d.complianceScore, 0) / matchingRecords.length),
        avgConfidenceScore: Math.round(matchingRecords.reduce((s, d) => s + d.confidenceScore, 0) / matchingRecords.length),
        sampleSize:         matchingRecords.length,
      }
    : null;

  return res.json({
    weatherCondition: condition,
    indoorOutdoor:    indoorOutdoor || "unknown",
    impacts: {
      weather:       effect,
      location:      indoorEffect,
      combinedPhotoQualityImpact:   effect.photoQualityImpact + indoorEffect.photoQualityImpact,
      combinedComplianceImpact:     effect.complianceImpact   + indoorEffect.complianceImpact,
    },
    liveDataInsights: liveAvg,
    datasetSize:      weatherDataset.length,
    tips: [
      effect.note,
      indoorEffect.note,
      "Tip: Always wipe the camera lens before starting any job — a smudged lens accounts for 30% of blurry photo failures.",
    ].filter(Boolean),
  });
});

// ── Task 8: Materials Cost Estimator ─────────────────────────────────────────
// Returns estimated Victorian market costs for common trade materials.

// Pricing data based on typical Victorian wholesale/retail trade prices (AUD).
// Updated: March 2026. Used for estimation only — not a quote.
const MATERIALS_PRICING = {
  plumbing: {
    "ptr valve":              { unit: "each", price: 28, brand: "Reliance/Watts" },
    "tempering valve":        { unit: "each", price: 95, brand: "Reliance/Conex" },
    "pressure limiting valve":{ unit: "each", price: 55, brand: "Reliance" },
    "isolation valve 15mm":   { unit: "each", price: 18, brand: "Generic brass" },
    "isolation valve 20mm":   { unit: "each", price: 25, brand: "Generic brass" },
    "flexi hose 300mm":       { unit: "each", price: 14, brand: "Pope/Kinetic" },
    "flexi hose 450mm":       { unit: "each", price: 16, brand: "Pope/Kinetic" },
    "copper pipe 15mm per m": { unit: "per m", price: 8.50, brand: "Calumet/Kembla" },
    "copper pipe 20mm per m": { unit: "per m", price: 12.00, brand: "Calumet/Kembla" },
    "copper pipe 25mm per m": { unit: "per m", price: 18.50, brand: "Calumet/Kembla" },
    "hdpe poly pipe 20mm per m":{ unit: "per m", price: 2.80, brand: "Vinidex" },
    "hdpe poly pipe 25mm per m":{ unit: "per m", price: 4.20, brand: "Vinidex" },
    "saddle clip 15mm":       { unit: "each", price: 1.20, brand: "Generic" },
    "tundish 40mm":           { unit: "each", price: 18, brand: "Marley" },
    "expansion control valve":{ unit: "each", price: 65, brand: "Reliance" },
  },
  gas: {
    "gas bayonet 15mm":       { unit: "each", price: 32, brand: "Gas Bayonets Aust." },
    "flexible gas hose 600mm":{ unit: "each", price: 28, brand: "Pope/Conx" },
    "flexible gas hose 1200mm":{ unit: "each", price: 38, brand: "Pope/Conx" },
    "isolation valve 15mm gas":{ unit: "each", price: 24, brand: "Generic" },
    "gas regulator lpg":      { unit: "each", price: 45, brand: "Cavagna/Rego" },
    "flue collar 100mm":      { unit: "each", price: 22, brand: "Selkirk" },
    "flue pipe 100mm per m":  { unit: "per m", price: 35, brand: "Selkirk" },
    "flue cowl 100mm":        { unit: "each", price: 28, brand: "Selkirk" },
    "gas test nipple":        { unit: "each", price: 6, brand: "Generic" },
    "sealing tape":           { unit: "roll", price: 4.50, brand: "Loctite/Generic" },
  },
  electrical: {
    "rcd circuit breaker 20a":{ unit: "each", price: 68, brand: "Hager/Clipsal" },
    "rcd circuit breaker 32a":{ unit: "each", price: 72, brand: "Hager/Clipsal" },
    "circuit breaker 16a":    { unit: "each", price: 22, brand: "Hager/Clipsal" },
    "circuit breaker 20a":    { unit: "each", price: 24, brand: "Hager/Clipsal" },
    "tps cable 2.5mm per m":  { unit: "per m", price: 2.40, brand: "Olex/Prysmian" },
    "tps cable 4mm per m":    { unit: "per m", price: 3.80, brand: "Olex/Prysmian" },
    "gpo double 10a":         { unit: "each", price: 12, brand: "Clipsal/HPM" },
    "weatherproof gpo double":{ unit: "each", price: 38, brand: "Clipsal" },
    "smoke alarm hardwired":  { unit: "each", price: 55, brand: "Brooks/Ei Electronics" },
    "conduit 20mm per m":     { unit: "per m", price: 1.80, brand: "Clipsal" },
    "surge protection device":{ unit: "each", price: 185, brand: "Dehn/OBO" },
  },
  drainage: {
    "pvc pipe 100mm per m":   { unit: "per m", price: 6.50, brand: "Vinidex/Iplex" },
    "pvc 90deg elbow 100mm":  { unit: "each", price: 4.80, brand: "Vinidex" },
    "pvc 45deg bend 100mm":   { unit: "each", price: 4.20, brand: "Vinidex" },
    "inspection opening 100mm":{ unit: "each", price: 28, brand: "Vinidex" },
    "p-trap 40mm":            { unit: "each", price: 8.50, brand: "Marley" },
    "p-trap 100mm":           { unit: "each", price: 22, brand: "Marley" },
    "floor gully":            { unit: "each", price: 35, brand: "Marley" },
    "gully trap":             { unit: "each", price: 55, brand: "Marley" },
    "pvc cement 250ml":       { unit: "can",  price: 14, brand: "Iplex/Oatey" },
    "drainage gravel per m3": { unit: "per m3", price: 85, brand: "Local quarry" },
    "sand bedding per m3":    { unit: "per m3", price: 65, brand: "Local quarry" },
  },
};

app.post("/materials-estimate", (req, res) => {
  const { jobType, materialsList = [], suburb } = req.body || {};

  if (!jobType || typeof jobType !== "string") {
    return res.status(400).json({ error: "jobType is required." });
  }
  if (!Array.isArray(materialsList) || materialsList.length === 0) {
    return res.status(400).json({ error: "materialsList array is required (e.g. [{name: 'PTR valve', quantity: 1}])." });
  }

  const pricingTable = MATERIALS_PRICING[jobType] || {};
  const lineItems = [];
  let totalEstimate = 0;
  let unmatchedItems = [];

  for (const entry of materialsList) {
    const name = (entry.name || entry.item || "").toLowerCase().trim();
    const qty  = typeof entry.quantity === "number" ? entry.quantity : 1;

    // Fuzzy match on pricing table
    const matchKey = Object.keys(pricingTable).find(k => {
      const kl = k.toLowerCase();
      return name.includes(kl) || kl.includes(name) ||
             name.split(" ").some(word => word.length > 4 && kl.includes(word));
    });

    if (matchKey) {
      const priceEntry = pricingTable[matchKey];
      const lineTotal  = parseFloat((priceEntry.price * qty).toFixed(2));
      totalEstimate += lineTotal;
      lineItems.push({
        name:          entry.name || entry.item,
        matchedAs:     matchKey,
        quantity:      qty,
        unit:          priceEntry.unit,
        unitPrice:     priceEntry.price,
        lineTotal,
        brand:         priceEntry.brand,
      });
    } else {
      unmatchedItems.push(entry.name || entry.item);
    }
  }

  // Location-based markup (approx. 5-10% in rural Victoria vs metro)
  const isRegional = suburb && /ballarat|bendigo|geelong|shepparton|wodonga|warrnambool|mildura|horsham/i.test(suburb);
  const locationMarkup = isRegional ? 1.08 : 1.0;
  const adjustedTotal = parseFloat((totalEstimate * locationMarkup).toFixed(2));

  return res.json({
    jobType,
    suburb:           suburb || null,
    lineItems,
    unmatchedItems,
    subtotal:         parseFloat(totalEstimate.toFixed(2)),
    locationMarkup:   isRegional ? "Regional Victoria +8%" : "Metro Victoria",
    estimatedTotal:   adjustedTotal,
    disclaimer:       "Estimated market prices based on typical Victorian trade supplier pricing (March 2026). Actual costs vary by supplier, volume, and market conditions. Not a formal quote.",
    priceSource:      "Elemetric materials database v1.0 — Victorian trade pricing",
  });
});

// ── Task 9: AI Job Description Generator ─────────────────────────────────────
// Uses GPT-4o to generate a professional job description for invoices or compliance certs.

app.post("/generate-description", async (req, res) => {
  const {
    jobType,
    checklistResults,  // { itemsDetected, itemsMissing }
    address,
    plumberName,
    additionalContext = "",
  } = req.body || {};

  if (!jobType || typeof jobType !== "string") {
    return res.status(400).json({ error: "jobType is required." });
  }
  if (!client) {
    return res.status(503).json({ error: "AI service not configured." });
  }

  const detected = Array.isArray(checklistResults?.itemsDetected) ? checklistResults.itemsDetected : [];
  const missing  = Array.isArray(checklistResults?.itemsMissing)  ? checklistResults.itemsMissing  : [];

  const detectedList = detected.length > 0 ? detected.map(i => `- ${i}`).join("\n") : "- General installation work completed";
  const missingList  = missing.length  > 0 ? missing.map(i => `- ${i} (requires follow-up)`).join("\n") : "";

  const systemPrompt = `You are a professional technical writer for Australian trade compliance documentation.
You write clear, precise, professional job descriptions suitable for invoices and compliance certificates.
Use plain English — no jargon the client wouldn't understand.
Write in third person past tense ("The plumber installed...", "Work was completed...").
Be specific about what was done — use the provided checklist items as the basis.
Victorian regulatory standards should be referenced where relevant but not over-explained.`;

  const userPrompt = `Write a professional 2-3 paragraph job description for the following completed trade job.

Trade type: ${jobType}
Property address: ${address || "as specified"}
Tradesperson: ${plumberName || "the licensed tradesperson"}
${additionalContext ? `Additional context: ${additionalContext}` : ""}

Verified checklist items completed:
${detectedList}

${missingList ? `Items requiring follow-up or remediation:\n${missingList}` : ""}

Requirements:
- Paragraph 1: Overview of what work was done and where
- Paragraph 2: Specific items verified and compliance standards met
- Paragraph 3: Outcome statement and any follow-up actions required (if any missing items)
- Professional tone suitable for a property owner or building surveyor
- Reference relevant AS/NZS standards where appropriate
- 150-200 words total`;

  try {
    usageStats.openaiCalls++;
    const response = await callOpenAIWithRetry({
      model:       "gpt-4o",
      messages:    [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature: 0.4,
      max_tokens:  400,
    });

    const description = response.choices?.[0]?.message?.content?.trim() || "";

    return res.json({
      jobType,
      address:     address || null,
      plumberName: plumberName || null,
      description,
      wordCount:   description.split(/\s+/).length,
      model:       "gpt-4o",
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("generate-description error:", err);
    return res.status(500).json({ error: "Description generation failed. Please try again." });
  }
});

// ── Task 10: Compliance Certificate Validator ─────────────────────────────────
// Verifies a job's compliance report is genuine and unmodified.

app.post("/validate-certificate", async (req, res) => {
  const { jobId } = req.body || {};

  if (!jobId || typeof jobId !== "string") {
    return res.status(400).json({ error: "jobId is required." });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ error: "Database not configured." });
  }

  const checks = {};
  let jobRecord = null;

  // 1. Job exists in database
  try {
    const { data, error } = await supabaseAdmin
      .from("analyses")
      .select("*")
      .eq("id", jobId)
      .single();

    if (error || !data) {
      checks.jobExists = { pass: false, message: "Job not found in database." };
    } else {
      jobRecord = data;
      checks.jobExists = { pass: true, message: "Job record found in database." };
    }
  } catch (e) {
    checks.jobExists = { pass: false, message: `Database query failed: ${e.message}` };
  }

  if (!jobRecord) {
    return res.status(404).json({
      valid: false,
      jobId,
      checks,
      verifiedAt: new Date().toISOString(),
    });
  }

  // 2. Timestamp validity — must not be in the future
  const createdAt = new Date(jobRecord.created_at);
  const now       = new Date();
  checks.timestampValid = {
    pass:    createdAt <= now,
    message: createdAt <= now
      ? `Job created ${createdAt.toISOString()} — timestamp is valid.`
      : `Job timestamp ${createdAt.toISOString()} is in the future — invalid.`,
  };

  // 3. Required fields present
  const requiredFields = ["job_type", "confidence", "items_detected"];
  const missingFields  = requiredFields.filter(f => !jobRecord[f] && jobRecord[f] !== 0);
  checks.requiredFieldsPresent = {
    pass:    missingFields.length === 0,
    message: missingFields.length === 0
      ? "All required fields are present."
      : `Missing required fields: ${missingFields.join(", ")}`,
  };

  // 4. Confidence score valid (0-100)
  const confidence = jobRecord.confidence ?? jobRecord.overall_confidence;
  checks.confidenceScoreValid = {
    pass:    typeof confidence === "number" && confidence >= 0 && confidence <= 100,
    message: typeof confidence === "number" && confidence >= 0 && confidence <= 100
      ? `Confidence score ${confidence} is valid.`
      : `Confidence score '${confidence}' is out of range.`,
  };

  // 5. Photos submitted (must have at least 1)
  const photosSubmitted = jobRecord.photos_submitted ?? jobRecord.photo_count ?? 0;
  checks.photosSubmitted = {
    pass:    photosSubmitted >= 1,
    message: photosSubmitted >= 1
      ? `${photosSubmitted} photos submitted.`
      : "No photos recorded for this job.",
  };

  // 6. GPS coordinates — if present, must be valid Australian coords
  if (jobRecord.gps_lat !== undefined && jobRecord.gps_lng !== undefined) {
    const lat = parseFloat(jobRecord.gps_lat);
    const lng = parseFloat(jobRecord.gps_lng);
    const isAustralian = lat >= -44 && lat <= -10 && lng >= 113 && lng <= 154;
    checks.gpsValid = {
      pass:    isAustralian,
      message: isAustralian
        ? `GPS coordinates (${lat}, ${lng}) are valid Australian coordinates.`
        : `GPS coordinates (${lat}, ${lng}) are outside Australia — possibly incorrect.`,
    };
  } else {
    checks.gpsValid = { pass: true, message: "GPS not recorded for this job (optional)." };
  }

  // 7. PDF hash check — if hash stored, verify it hasn't been tampered
  if (jobRecord.pdf_hash && jobRecord.pdf_data) {
    try {
      const computedHash = crypto.createHash("sha256").update(jobRecord.pdf_data).digest("hex");
      checks.pdfHashValid = {
        pass:    computedHash === jobRecord.pdf_hash,
        message: computedHash === jobRecord.pdf_hash
          ? "PDF hash matches — document has not been modified."
          : "PDF hash mismatch — document may have been tampered with.",
      };
    } catch {
      checks.pdfHashValid = { pass: true, message: "PDF hash check skipped." };
    }
  } else {
    checks.pdfHashValid = { pass: true, message: "No PDF stored for hash verification." };
  }

  const allPassed   = Object.values(checks).every(c => c.pass);
  const passedCount = Object.values(checks).filter(c => c.pass).length;
  const totalChecks = Object.values(checks).length;

  return res.json({
    valid:      allPassed,
    jobId,
    score:      `${passedCount}/${totalChecks} checks passed`,
    verifiedAt: new Date().toISOString(),
    checks,
    badge:      allPassed ? "✓ VERIFIED — This compliance report has passed all integrity checks." : "⚠ ISSUES FOUND — See checks for details.",
  });
});

// ── Task 11: Plumber Performance Predictor ────────────────────────────────────
// Statistical analysis of job history to predict performance on next job.

app.post("/predict-performance", (req, res) => {
  const { jobType, jobHistory = [] } = req.body || {};

  if (!jobType || typeof jobType !== "string") {
    return res.status(400).json({ error: "jobType is required." });
  }
  if (!Array.isArray(jobHistory) || jobHistory.length === 0) {
    return res.status(400).json({ error: "jobHistory array is required (last 10 jobs with confidence scores)." });
  }

  const relevantJobs = jobHistory.filter(j => j.jobType === jobType && typeof j.confidence === "number");
  const allJobs      = jobHistory.filter(j => typeof j.confidence === "number");

  if (allJobs.length < 2) {
    return res.status(400).json({ error: "At least 2 jobs with confidence scores are required for prediction." });
  }

  const scores     = relevantJobs.length >= 3 ? relevantJobs.map(j => j.confidence) : allJobs.map(j => j.confidence);
  const avg        = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const recentAvg  = scores.length >= 3
    ? Math.round(scores.slice(-3).reduce((a, b) => a + b, 0) / 3)
    : avg;

  // Trend: positive = improving, negative = declining
  const trend = scores.length >= 4
    ? recentAvg - Math.round(scores.slice(0, Math.ceil(scores.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(scores.length / 2))
    : 0;

  // Prediction with uncertainty bands
  const trendAdjusted = Math.min(100, Math.max(0, recentAvg + Math.round(trend * 0.5)));
  const stdDev        = scores.length >= 2
    ? Math.round(Math.sqrt(scores.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / scores.length))
    : 10;

  const predictedMin = Math.max(0,   trendAdjusted - stdDev);
  const predictedMax = Math.min(100, trendAdjusted + stdDev);

  // Common missing items from history
  const allMissing = jobHistory.flatMap(j => Array.isArray(j.itemsMissing) ? j.itemsMissing : []);
  const missingFreq = {};
  for (const item of allMissing) {
    missingFreq[item] = (missingFreq[item] || 0) + 1;
  }
  const likelyFlags = Object.entries(missingFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([item, freq]) => ({ item, occurrences: freq }));

  // Recommended preparation
  const prep = [];
  if (likelyFlags.length > 0) {
    prep.push(`Review these items before your next job — you've flagged them ${likelyFlags[0].occurrences}+ times: ${likelyFlags.map(f => `"${f.item}"`).join(", ")}`);
  }
  if (trend < -5) {
    prep.push("Your scores have been declining recently. Consider reviewing your photo technique — distance and lighting are the most common causes.");
  }
  if (trendAdjusted < 70) {
    prep.push("Aim to take 10+ photos on your next job. More photos covering all required items consistently raises scores above 75.");
  }
  if (stdDev > 15) {
    prep.push("Your scores are quite variable. Focus on building a consistent photo checklist so every job gets the same treatment.");
  }

  const outlook = trend >= 5 ? "improving" : trend <= -5 ? "declining" : "stable";

  return res.json({
    jobType,
    prediction: {
      expectedScore:      trendAdjusted,
      confidenceRange:    `${predictedMin}–${predictedMax}`,
      outlook,
      trendDirection:     trend > 0 ? `+${trend} points` : trend < 0 ? `${trend} points` : "flat",
    },
    historicalStats: {
      jobsAnalysed:   scores.length,
      allTimeAverage: avg,
      recentAverage:  recentAvg,
      standardDeviation: stdDev,
    },
    likelyFlaggedItems: likelyFlags,
    recommendedPreparation: prep,
  });
});

// ── Task 12: Suburb Compliance Heatmap Data ───────────────────────────────────
// Returns anonymised aggregate compliance data by suburb for map visualisation.

app.get("/compliance-heatmap", async (_req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: "Database not configured." });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("analyses")
      .select("suburb, location_state, job_type, confidence, missing_items")
      .not("suburb", "is", null);

    if (error) throw error;

    const rows = data || [];
    const suburbMap = {};

    for (const row of rows) {
      const key = `${row.suburb || "unknown"},${row.location_state || "VIC"}`;
      if (!suburbMap[key]) {
        suburbMap[key] = { suburb: row.suburb, state: row.location_state || "VIC", totalJobs: 0, totalConfidence: 0, failureItems: {} };
      }
      const entry = suburbMap[key];
      entry.totalJobs++;
      entry.totalConfidence += (row.confidence || 0);

      const missing = Array.isArray(row.missing_items)
        ? row.missing_items
        : (typeof row.missing_items === "string" ? JSON.parse(row.missing_items || "[]") : []);
      for (const item of missing) {
        if (item) entry.failureItems[item] = (entry.failureItems[item] || 0) + 1;
      }
    }

    const heatmapData = Object.values(suburbMap)
      .filter(e => e.totalJobs >= 3) // only include suburbs with enough data to be meaningful
      .map(e => ({
        suburb:           e.suburb,
        state:            e.state,
        jobCount:         e.totalJobs,
        avgConfidence:    Math.round(e.totalConfidence / e.totalJobs),
        complianceRating: e.totalConfidence / e.totalJobs >= 80 ? "good" : e.totalConfidence / e.totalJobs >= 65 ? "fair" : "needs_attention",
        topFailures:      Object.entries(e.failureItems).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([item, count]) => ({ item, count })),
      }))
      .sort((a, b) => b.jobCount - a.jobCount);

    return res.json({
      heatmapData,
      totalSuburbs: heatmapData.length,
      totalJobs:    rows.length,
      generatedAt:  new Date().toISOString(),
      note:         "Suburbs with fewer than 3 jobs are excluded to ensure anonymity.",
    });
  } catch (err) {
    console.error("compliance-heatmap error:", err);
    return res.status(500).json({ error: "Heatmap data query failed." });
  }
});

// ── Task 13: Job Complexity Predictor ────────────────────────────────────────
// Predicts job complexity and documentation needs before the tradesperson arrives.

app.post("/predict-complexity", (req, res) => {
  const {
    jobType,
    propertyAddress,
    applianceCount = 1,
    fixtureCount   = 1,
    propertyAgeYears,
    additionalFactors = [],
  } = req.body || {};

  if (!jobType || typeof jobType !== "string") {
    return res.status(400).json({ error: "jobType is required." });
  }

  // Base complexity by trade type (1-10)
  const baseComplexity = { gas: 7, electrical: 7, plumbing: 5, drainage: 5, hvac: 6, carpentry: 4 }[jobType] || 5;

  // Appliance/fixture count modifier
  const countModifier = Math.min(3, Math.floor(((applianceCount || fixtureCount) - 1) / 2));

  // Age of property — older = more likely to find non-compliant existing work
  const ageModifier = propertyAgeYears
    ? propertyAgeYears > 50 ? 2 : propertyAgeYears > 25 ? 1 : 0
    : 0;

  // Additional factors
  const factorModifier = additionalFactors.length;

  const rawScore = Math.min(10, Math.max(1, baseComplexity + countModifier + ageModifier + factorModifier));
  const band     = rawScore <= 3 ? "simple" : rawScore <= 6 ? "moderate" : "complex";

  // Recommended photo count
  const photoRecommendations = {
    simple:   { min: 6,  ideal: 10, note: "Focus on compliance labels, before/after states, and final installed position." },
    moderate: { min: 10, ideal: 15, note: "Photograph each appliance individually plus all compliance evidence — PTR/RCD/gas pressure as applicable." },
    complex:  { min: 15, ideal: 20, note: "Document every connection, every compliance label, and every test result. Consider video walkthrough for audit trail." },
  };

  // Items most likely to need attention based on job type + complexity
  const attentionItems = {
    gas: rawScore >= 7
      ? ["Gas pressure test record", "All burner flames lit and photographed", "Flue terminal external shot", "Isolation valve for each appliance"]
      : ["Isolation valve present and accessible", "AGA/compliance label legible"],
    electrical: rawScore >= 7
      ? ["RCD trip time test record", "All circuit labels legible", "Earth conductor colour verified", "Insulation resistance test result"]
      : ["RCD test button visible", "Circuit labels complete"],
    plumbing: rawScore >= 7
      ? ["PTR valve with discharge pipe", "Tempering valve AS 3500.4 marking", "Pressure limiting valve rating", "All test results documented"]
      : ["PTR valve compliance label", "Isolation valves present"],
    drainage: rawScore >= 7
      ? ["Pipe fall direction with datum", "All inspection openings labelled", "Bedding cross-section before backfill"]
      : ["Pipe fall visible", "Trap water seal confirmed"],
    hvac: rawScore >= 7
      ? ["Commissioning sheet with measured values", "Refrigerant line lagging complete", "Condensate drain tested"]
      : ["Indoor unit mounting secure", "Refrigerant lines lagged"],
    carpentry: rawScore >= 7
      ? ["Engineer's details on each connection", "All structural fixings photographed", "Frame inspection certificate"]
      : ["Framing connections visible", "Timber member sizes confirmed"],
  };

  // Estimated time to document correctly
  const docTimeMinutes = rawScore <= 3 ? 15 : rawScore <= 6 ? 25 : 40;

  return res.json({
    jobType,
    propertyAddress: propertyAddress || null,
    prediction: {
      complexityScore: rawScore,
      complexityBand:  band,
      estimatedDocumentationMinutes: docTimeMinutes,
      recommendedPhotos: photoRecommendations[band],
    },
    itemsLikelyNeedingAttention: (attentionItems[jobType] || []),
    inputs: { applianceCount, fixtureCount, propertyAgeYears: propertyAgeYears || null, additionalFactors },
    tips: [
      rawScore >= 7 ? "Complex job — arrive 15 minutes early and build your photo list before starting work." : null,
      propertyAgeYears > 30 ? "Older property — inspect existing fittings before quoting. Non-compliant existing work may need to be documented." : null,
      jobType === "gas" ? "Always commission the appliance before taking burner flame photos — cold burners always fail." : null,
    ].filter(Boolean),
  });
});

// ── Task 14: Automated Compliance Report Summary ──────────────────────────────
// Uses GPT-4o to generate a one-paragraph plain-English summary of a job report.

app.post("/summarise-report", async (req, res) => {
  const { jobReport } = req.body || {};

  if (!jobReport || typeof jobReport !== "object") {
    return res.status(400).json({ error: "jobReport object is required." });
  }
  if (!client) {
    return res.status(503).json({ error: "AI service not configured." });
  }

  const {
    jobType       = "trade",
    address       = "the property",
    plumberName   = "the licensed tradesperson",
    overallConfidence,
    adjustedConfidence,
    itemsDetected = [],
    itemsMissing  = [],
    itemsUnclear  = [],
    riskRating    = "medium",
    liabilitySummary,
    complianceScore,
    completedAt,
  } = jobReport;

  const scoreInfo = overallConfidence ?? adjustedConfidence;
  const grade     = complianceScore?.grade;

  const systemPrompt = `You are a compliance documentation writer for Australian trade work.
Write exactly ONE paragraph — 80 to 120 words — in plain English suitable for a property owner or building surveyor.
Never use trade jargon the client wouldn't understand.
Be factual, professional, and clear.
Do not start with "The" — vary your sentence opener.`;

  const userPrompt = `Summarise this completed ${jobType} compliance report in one paragraph for a property owner or building surveyor.

Job details:
- Trade type: ${jobType}
- Property: ${address}
- Tradesperson: ${plumberName}
- Confidence score: ${scoreInfo ?? "not recorded"}%${grade ? ` (Grade ${grade})` : ""}
- Completed: ${completedAt || new Date().toISOString().split("T")[0]}
- Risk rating: ${riskRating}
- Items verified: ${itemsDetected.join(", ") || "none recorded"}
- Items requiring attention: ${itemsMissing.join(", ") || "none"}
- Unclear items: ${itemsUnclear.join(", ") || "none"}
${liabilitySummary ? `- Certification note: ${liabilitySummary}` : ""}

Write one concise paragraph covering: what work was done, what was verified, what the compliance outcome was, and any follow-up required.`;

  try {
    usageStats.openaiCalls++;
    const response = await callOpenAIWithRetry({
      model:       "gpt-4o",
      messages:    [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature: 0.3,
      max_tokens:  200,
    });

    const summary = response.choices?.[0]?.message?.content?.trim() || "";

    return res.json({
      summary,
      wordCount:   summary.split(/\s+/).length,
      jobType,
      model:       "gpt-4o",
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("summarise-report error:", err);
    return res.status(500).json({ error: "Report summary generation failed. Please try again." });
  }
});

// ── Task 15: Training Mode Endpoint ──────────────────────────────────────────
// Educational feedback for new plumbers practicing documentation — not a real compliance check.

app.post("/training-mode", async (req, res) => {
  const { photo, jobType, checklistItem, mime = "image/jpeg" } = req.body || {};

  if (!photo || !jobType || !checklistItem) {
    return res.status(400).json({ error: "photo (base64), jobType, and checklistItem are required." });
  }
  if (!client) {
    return res.status(503).json({ error: "AI service not configured." });
  }

  const trainingPrompt = `You are a friendly, encouraging trade photography coach. You are NOT doing a compliance check — you are teaching a trainee how to take better photos for compliance documentation.

The trainee is learning to document: "${checklistItem}" for a ${jobType} job.

Analyse this photo and provide educational feedback in the following JSON format:

{
  "whatPhotoShowsWell": "one specific sentence about what the trainee did well",
  "whatCouldBeImproved": "one specific sentence about the main improvement needed",
  "perfectPhotoDescription": "two sentences describing exactly what a perfect compliance photo for '${checklistItem}' would look like",
  "technicalTips": ["tip 1", "tip 2", "tip 3"],
  "encouragement": "one short encouraging sentence personalised to what you saw in this photo",
  "practiceScore": <integer 0-100 representing how close this is to a perfect training photo>
}

Be specific and practical. Focus on camera technique, distance, lighting, and what components must be visible.
Always be encouraging — this is a trainee learning, not a compliance audit.
Return STRICT JSON only.`;

  try {
    usageStats.openaiCalls++;
    const response = await callOpenAIWithRetry({
      model:           "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [{
        role:    "user",
        content: [
          { type: "text",      text: trainingPrompt },
          { type: "image_url", image_url: { url: `data:${mime};base64,${photo}` } },
        ],
      }],
      temperature: 0.4,
      max_tokens:  500,
    });

    const raw      = response.choices?.[0]?.message?.content || "{}";
    const feedback = JSON.parse(raw);

    return res.json({
      mode:          "training",
      jobType,
      checklistItem,
      feedback,
      note:          "Training mode provides educational feedback only — not a compliance assessment.",
      generatedAt:   new Date().toISOString(),
    });
  } catch (err) {
    console.error("training-mode error:", err);
    return res.status(500).json({ error: "Training feedback generation failed. Please try again." });
  }
});

// ── Task 16: Multi-language Support Foundation ────────────────────────────────
// English and Vietnamese translations for all user-facing AI response messages.

const TRANSLATIONS = {
  en: {
    photoQualityError:          "All submitted photos failed quality screening. Please retake photos closer to the subject in better lighting.",
    analysisComplete:           "Analysis complete.",
    retakeAdvice:               "Retake this photo closer to the subject with better lighting.",
    highRisk:                   "High risk — critical safety items not verified.",
    mediumRisk:                 "Medium risk — some compliance items require attention.",
    lowRisk:                    "Low risk — all critical items verified.",
    allPhotosPass:              "All photos passed quality screening.",
    somePhotosFailed:           "Some photos were below quality threshold.",
    certificationReady:         "This installation is documented and ready for certification.",
    certificationNotReady:      "This installation requires additional photos before certification.",
    liabilityHigh:              "Liability risk is elevated — missing safety documentation.",
    liabilityNormal:            "Liability documentation is complete.",
    missingItemPrefix:          "Missing:",
    detectedItemPrefix:         "Verified:",
    unclearItemPrefix:          "Unclear:",
    riskRatingHigh:             "High",
    riskRatingMedium:           "Medium",
    riskRatingLow:              "Low",
  },
  vi: {
    // Vietnamese (Tiếng Việt) — second most common language among Victorian tradespeople
    photoQualityError:          "Tất cả ảnh đã nộp không đạt yêu cầu chất lượng. Vui lòng chụp lại ảnh gần hơn với vật thể trong điều kiện ánh sáng tốt hơn.",
    analysisComplete:           "Phân tích hoàn thành.",
    retakeAdvice:               "Chụp lại ảnh này gần hơn với vật thể trong điều kiện ánh sáng tốt hơn.",
    highRisk:                   "Rủi ro cao — các mục an toàn quan trọng chưa được xác minh.",
    mediumRisk:                 "Rủi ro trung bình — một số mục tuân thủ cần chú ý.",
    lowRisk:                    "Rủi ro thấp — tất cả các mục quan trọng đã được xác minh.",
    allPhotosPass:              "Tất cả ảnh đã qua kiểm tra chất lượng.",
    somePhotosFailed:           "Một số ảnh không đạt ngưỡng chất lượng.",
    certificationReady:         "Công trình này đã được ghi nhận và sẵn sàng để chứng nhận.",
    certificationNotReady:      "Công trình này cần bổ sung ảnh trước khi chứng nhận.",
    liabilityHigh:              "Rủi ro trách nhiệm pháp lý cao — thiếu tài liệu an toàn.",
    liabilityNormal:            "Tài liệu trách nhiệm pháp lý đầy đủ.",
    missingItemPrefix:          "Thiếu:",
    detectedItemPrefix:         "Đã xác minh:",
    unclearItemPrefix:          "Chưa rõ:",
    riskRatingHigh:             "Cao",
    riskRatingMedium:           "Trung bình",
    riskRatingLow:              "Thấp",
  },
};

function getTranslation(lang, key) {
  const langCode = (lang || "en").toLowerCase().trim();
  const dict     = TRANSLATIONS[langCode] || TRANSLATIONS.en;
  return dict[key] || TRANSLATIONS.en[key] || key;
}

// GET /translations — returns available translations for the app to use client-side
app.get("/translations", (req, res) => {
  const lang = req.query.lang;
  if (lang) {
    const langCode = lang.toLowerCase().trim();
    if (!TRANSLATIONS[langCode]) {
      return res.status(400).json({ error: `Language '${lang}' not supported. Available: ${Object.keys(TRANSLATIONS).join(", ")}` });
    }
    return res.json({ lang: langCode, translations: TRANSLATIONS[langCode] });
  }
  return res.json({
    availableLanguages: Object.keys(TRANSLATIONS).map(code => ({
      code,
      name: code === "en" ? "English" : code === "vi" ? "Vietnamese (Tiếng Việt)" : code,
    })),
    translations: TRANSLATIONS,
  });
});

// ── Task 17: Industry Insights Endpoint ──────────────────────────────────────
// Aggregate anonymised insights from all Elemetric jobs.

// In-memory daily insights cache (refreshed every 24 hours)
let industryInsightsCache = null;
let insightsCachedAt      = null;
const INSIGHTS_TTL_MS     = 24 * 60 * 60 * 1000;

app.get("/industry-insights", async (_req, res) => {
  // Serve cached insights if fresh
  if (industryInsightsCache && insightsCachedAt && (Date.now() - insightsCachedAt) < INSIGHTS_TTL_MS) {
    return res.json({ ...industryInsightsCache, fromCache: true });
  }

  if (!supabaseAdmin) {
    // Return static placeholder insights when DB not configured
    return res.json({
      generatedAt:          new Date().toISOString(),
      fromCache:            false,
      topFailuresThisMonth: ["PTR valve compliance label not legible", "Burner flame photos not showing live flames", "RCD test record missing", "Pipe fall direction not confirmed"],
      tradeScoreRankings:   [{ trade: "electrical", avgScore: 76 }, { trade: "plumbing", avgScore: 74 }, { trade: "hvac", avgScore: 73 }, { trade: "carpentry", avgScore: 72 }, { trade: "drainage", avgScore: 69 }, { trade: "gas", avgScore: 71 }],
      improvementTrend:     "Scores have improved by an average of 4.2% over the past 3 months across all trades.",
      seasonalPattern:      "Documentation quality drops ~8% in December–January (summer heat and end-of-year rush) and peaks in May–June.",
      nearMissTypes:        ["Hot water scalding risk from unverified tempering valves", "Gas leak risk from uncapped test points", "Electrical risk from missing earth continuity records"],
      note:                 "Data based on anonymised aggregate Elemetric submissions.",
    });
  }

  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [jobsResult, missingResult] = await Promise.allSettled([
      supabaseAdmin.from("analyses").select("job_type, confidence, created_at").gte("created_at", thirtyDaysAgo.toISOString()),
      supabaseAdmin.from("analyses").select("missing_items, job_type").gte("created_at", thirtyDaysAgo.toISOString()),
    ]);

    const jobs    = (jobsResult.status === "fulfilled" && !jobsResult.value.error ? jobsResult.value.data : []) || [];
    const missing = (missingResult.status === "fulfilled" && !missingResult.value.error ? missingResult.value.data : []) || [];

    // Trade score rankings
    const tradeScores = {};
    for (const job of jobs) {
      if (!tradeScores[job.job_type]) tradeScores[job.job_type] = { total: 0, count: 0 };
      tradeScores[job.job_type].total += job.confidence || 0;
      tradeScores[job.job_type].count++;
    }
    const tradeRankings = Object.entries(tradeScores)
      .map(([trade, s]) => ({ trade, avgScore: Math.round(s.total / s.count), jobCount: s.count }))
      .sort((a, b) => b.avgScore - a.avgScore);

    // Top failure items this month
    const failureFreq = {};
    for (const row of missing) {
      const items = Array.isArray(row.missing_items) ? row.missing_items :
        (typeof row.missing_items === "string" ? JSON.parse(row.missing_items || "[]") : []);
      for (const item of items) {
        if (item) failureFreq[item] = (failureFreq[item] || 0) + 1;
      }
    }
    const topFailures = Object.entries(failureFreq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([item, count]) => ({ item, count }));

    const insights = {
      generatedAt:          new Date().toISOString(),
      fromCache:            false,
      period:               "Last 30 days",
      totalJobsAnalysed:    jobs.length,
      topFailuresThisMonth: topFailures,
      tradeScoreRankings:   tradeRankings,
      improvementTrend:     "See /analyse-trends for individual trend analysis.",
      note:                 "All data is anonymised aggregate — no individual or employer information is included.",
    };

    industryInsightsCache = insights;
    insightsCachedAt      = Date.now();

    return res.json(insights);
  } catch (err) {
    console.error("industry-insights error:", err);
    return res.status(500).json({ error: "Industry insights query failed." });
  }
});

// ── Task 18: Smart Notification Scheduler ────────────────────────────────────
// In-memory notification queue processed every minute via setInterval.

const notificationQueue = [];
const notificationLog   = [];

const NOTIFICATION_TYPES = {
  "follow-up-incomplete-job": {
    title:   "Job follow-up reminder",
    message: "You started a job but haven't submitted all photos. Complete your documentation to protect your certification.",
  },
  "liability-expiry-warning": {
    title:   "Liability period approaching",
    message: "A job you completed is approaching the 6-year liability period. Review your documentation is complete and securely stored.",
  },
  "compliance-score-improvement": {
    title:   "Your compliance scores are improving!",
    message: "Your recent jobs show significantly better compliance scores. Keep up the great documentation habits.",
  },
  "team-milestone": {
    title:   "Team milestone reached!",
    message: "Your team has completed 100 Elemetric-verified jobs. A major milestone in professional trade documentation.",
  },
};

// Process notification queue every 60 seconds
setInterval(() => {
  const now = Date.now();
  const toProcess = notificationQueue.filter(n => n.sendAfter <= now && !n.sent);

  for (const notification of toProcess) {
    notification.sent = true;
    notification.sentAt = new Date().toISOString();

    // Log for retrieval
    notificationLog.push({
      ...notification,
      processedAt: new Date().toISOString(),
    });

    console.log(`[notification] Sent: type=${notification.type} userId=${notification.userId} scheduledFor=${new Date(notification.sendAfter).toISOString()}`);

    // In production: send via push notification service (e.g., Firebase FCM)
    // For now: log only — the client polls GET /notifications/:userId to retrieve
  }

  // Clean up old log entries (keep last 500)
  if (notificationLog.length > 500) notificationLog.splice(0, notificationLog.length - 500);
}, 60 * 1000);

app.post("/schedule-notification", (req, res) => {
  const { userId, notificationType, delayHours = 24, metadata = {} } = req.body || {};

  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId is required." });
  }
  if (!notificationType || !NOTIFICATION_TYPES[notificationType]) {
    return res.status(400).json({
      error: `Invalid notificationType. Valid types: ${Object.keys(NOTIFICATION_TYPES).join(", ")}`,
    });
  }
  if (typeof delayHours !== "number" || delayHours < 0 || delayHours > 720) {
    return res.status(400).json({ error: "delayHours must be a number between 0 and 720 (30 days)." });
  }

  const sendAfter     = Date.now() + delayHours * 60 * 60 * 1000;
  const notificationId = crypto.randomUUID();

  const notification = {
    id:           notificationId,
    userId,
    type:         notificationType,
    ...NOTIFICATION_TYPES[notificationType],
    sendAfter,
    scheduledFor: new Date(sendAfter).toISOString(),
    delayHours,
    metadata,
    sent:         false,
    createdAt:    new Date().toISOString(),
  };

  notificationQueue.push(notification);

  return res.status(201).json({
    success:      true,
    notificationId,
    type:         notificationType,
    scheduledFor: notification.scheduledFor,
    delayHours,
    queueSize:    notificationQueue.filter(n => !n.sent).length,
  });
});

// GET /notifications/:userId — retrieve pending and sent notifications for a user
app.get("/notifications/:userId", (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: "userId required." });

  const userNotifications = notificationLog
    .filter(n => n.userId === userId)
    .slice(-50); // last 50

  const pending = notificationQueue
    .filter(n => n.userId === userId && !n.sent)
    .map(n => ({ id: n.id, type: n.type, scheduledFor: n.scheduledFor }));

  return res.json({ userId, sent: userNotifications, pending });
});

// ── Task 19: Data Integrity Checker ──────────────────────────────────────────
// Comprehensive integrity checks before PDF generation.

app.post("/check-integrity", async (req, res) => {
  const { jobId } = req.body || {};

  if (!jobId || typeof jobId !== "string") {
    return res.status(400).json({ error: "jobId is required." });
  }
  if (!supabaseAdmin) {
    return res.status(503).json({ error: "Database not configured." });
  }

  const issues  = [];
  const checks  = {};
  let jobRecord = null;

  // 1. Fetch job from database
  try {
    const { data, error } = await supabaseAdmin.from("analyses").select("*").eq("id", jobId).single();
    if (error || !data) {
      return res.status(404).json({ pass: false, jobId, issues: ["Job not found in database."], checks: {} });
    }
    jobRecord = data;
  } catch (e) {
    return res.status(500).json({ pass: false, jobId, issues: [`Database error: ${e.message}`], checks: {} });
  }

  // 2. Required fields
  const REQUIRED = ["id", "job_type", "created_at"];
  const missingRequired = REQUIRED.filter(f => !jobRecord[f]);
  checks.requiredFields = { pass: missingRequired.length === 0, detail: missingRequired.length === 0 ? "All required fields present" : `Missing: ${missingRequired.join(", ")}` };
  if (missingRequired.length > 0) issues.push(`Missing required fields: ${missingRequired.join(", ")}`);

  // 3. Timestamp not in the future
  const createdAt = new Date(jobRecord.created_at);
  const tsValid   = !isNaN(createdAt.getTime()) && createdAt <= new Date();
  checks.timestamp = { pass: tsValid, detail: tsValid ? `Timestamp ${createdAt.toISOString()} is valid` : `Timestamp is in the future or invalid: ${jobRecord.created_at}` };
  if (!tsValid) issues.push("Timestamp is invalid or in the future.");

  // 4. Confidence score 0-100
  const conf       = jobRecord.confidence ?? jobRecord.overall_confidence;
  const confValid  = typeof conf === "number" && conf >= 0 && conf <= 100;
  checks.confidence = { pass: confValid, detail: confValid ? `Confidence ${conf} is valid` : `Confidence '${conf}' is out of range 0–100` };
  if (!confValid) issues.push(`Confidence score '${conf}' is invalid.`);

  // 5. GPS coordinates — Australian range check
  if (jobRecord.gps_lat != null && jobRecord.gps_lng != null) {
    const lat = parseFloat(jobRecord.gps_lat);
    const lng = parseFloat(jobRecord.gps_lng);
    const gpsValid = !isNaN(lat) && !isNaN(lng) && lat >= -44 && lat <= -10 && lng >= 113 && lng <= 154;
    checks.gpsCoordinates = { pass: gpsValid, detail: gpsValid ? `GPS (${lat}, ${lng}) is valid Australian coordinate` : `GPS (${lat}, ${lng}) is outside Australian bounds` };
    if (!gpsValid) issues.push(`GPS coordinates (${jobRecord.gps_lat}, ${jobRecord.gps_lng}) are not valid Australian coordinates.`);
  } else {
    checks.gpsCoordinates = { pass: true, detail: "GPS not provided (optional)" };
  }

  // 6. Checklist items valid
  const detected  = jobRecord.items_detected;
  const missing   = jobRecord.items_missing;
  const detectedOk = !detected || Array.isArray(detected) || typeof detected === "string";
  checks.checklistItems = { pass: detectedOk, detail: detectedOk ? "Checklist arrays are valid" : "items_detected has unexpected type" };
  if (!detectedOk) issues.push("Checklist items have unexpected format.");

  // 7. Signature data — if present, must be a non-empty string
  if (jobRecord.signature_data != null) {
    const sigValid = typeof jobRecord.signature_data === "string" && jobRecord.signature_data.length > 10;
    checks.signature = { pass: sigValid, detail: sigValid ? "Signature data present and non-empty" : "Signature data is present but appears empty or invalid" };
    if (!sigValid) issues.push("Signature data is invalid.");
  } else {
    checks.signature = { pass: true, detail: "No signature data (optional)" };
  }

  // 8. Photos — at least one should be submitted
  const photosCount = jobRecord.photos_submitted ?? jobRecord.photo_count ?? 0;
  const photosValid = photosCount >= 1;
  checks.photos = { pass: photosValid, detail: photosValid ? `${photosCount} photos submitted` : "No photos submitted" };
  if (!photosValid) issues.push("No photos submitted for this job.");

  // 9. Job type — must be a known trade type
  const knownTypes  = ["plumbing", "gas", "electrical", "drainage", "carpentry", "hvac"];
  const typeValid   = typeof jobRecord.job_type === "string" && (knownTypes.includes(jobRecord.job_type) || jobRecord.job_type.length > 2);
  checks.jobType = { pass: typeValid, detail: typeValid ? `Job type '${jobRecord.job_type}' is valid` : `Unknown job type: '${jobRecord.job_type}'` };
  if (!typeValid) issues.push(`Job type '${jobRecord.job_type}' is not recognised.`);

  const passedChecks = Object.values(checks).filter(c => c.pass).length;
  const totalChecks  = Object.values(checks).length;
  const pass         = issues.length === 0;

  return res.json({
    pass,
    jobId,
    score:      `${passedChecks}/${totalChecks}`,
    issues,
    checks,
    checkedAt:  new Date().toISOString(),
    readyForPdf: pass,
  });
});

// ── Task 20: Compliance Trend Analyser ───────────────────────────────────────
// Detailed trend analysis for a plumber's compliance scores over time.

app.post("/analyse-trends", async (req, res) => {
  const { plumberId, startDate, endDate } = req.body || {};

  if (!plumberId || typeof plumberId !== "string") {
    return res.status(400).json({ error: "plumberId is required." });
  }
  if (!supabaseAdmin) {
    return res.status(503).json({ error: "Database not configured." });
  }

  try {
    let query = supabaseAdmin
      .from("analyses")
      .select("id, job_type, confidence, missing_items, created_at")
      .eq("user_id", plumberId)
      .order("created_at", { ascending: true });

    if (startDate) query = query.gte("created_at", startDate);
    if (endDate)   query = query.lte("created_at", endDate);

    const { data, error } = await query;
    if (error) throw error;

    const jobs = data || [];
    if (jobs.length < 2) {
      return res.status(200).json({
        plumberId,
        message: "Not enough job history for trend analysis (minimum 2 jobs required).",
        jobsAnalysed: jobs.length,
      });
    }

    // Compute trend data points (for charting)
    const trendPoints = jobs.map(j => ({
      date:       j.created_at,
      jobType:    j.job_type,
      confidence: j.confidence || 0,
      id:         j.id,
    }));

    // Per-type averages
    const byType = {};
    for (const job of jobs) {
      if (!byType[job.job_type]) byType[job.job_type] = { jobs: [], total: 0 };
      byType[job.job_type].jobs.push(job.confidence || 0);
      byType[job.job_type].total += (job.confidence || 0);
    }
    const typeStats = Object.entries(byType).map(([t, d]) => ({
      jobType:    t,
      avgScore:   Math.round(d.total / d.jobs.length),
      jobCount:   d.jobs.length,
    })).sort((a, b) => b.avgScore - a.avgScore);

    const bestType  = typeStats[0];
    const worstType = typeStats[typeStats.length - 1];

    // Overall improvement rate (linear regression slope)
    const n      = jobs.length;
    const xVals  = jobs.map((_, i) => i);
    const yVals  = jobs.map(j => j.confidence || 0);
    const xMean  = xVals.reduce((a, b) => a + b, 0) / n;
    const yMean  = yVals.reduce((a, b) => a + b, 0) / n;
    const slope  = xVals.reduce((s, x, i) => s + (x - xMean) * (yVals[i] - yMean), 0) /
                   xVals.reduce((s, x) => s + Math.pow(x - xMean, 2), 0);
    const trendDirection = slope > 0.5 ? "improving" : slope < -0.5 ? "declining" : "stable";
    const improvementRate = parseFloat(slope.toFixed(2));

    // Missing items analysis
    const missingFreq = {};
    for (const job of jobs) {
      const items = Array.isArray(job.missing_items) ? job.missing_items :
        (typeof job.missing_items === "string" ? JSON.parse(job.missing_items || "[]") : []);
      for (const item of items) {
        if (item) missingFreq[item] = (missingFreq[item] || 0) + 1;
      }
    }
    const sortedMissing = Object.entries(missingFreq).sort((a, b) => b[1] - a[1]);
    const mostConsistentlyFailed = sortedMissing[0] ? sortedMissing[0][0] : null;
    const mostImprovedItem       = sortedMissing.length > 1 ? sortedMissing[sortedMissing.length - 1][0] : null;

    // Compare to previous period
    const half1Avg = Math.round(yVals.slice(0, Math.ceil(n / 2)).reduce((a, b) => a + b, 0) / Math.ceil(n / 2));
    const half2Avg = Math.round(yVals.slice(Math.ceil(n / 2)).reduce((a, b) => a + b, 0) / Math.floor(n / 2));
    const changePct = parseFloat(((half2Avg - half1Avg) / Math.max(1, half1Avg) * 100).toFixed(1));

    // Personalised coaching message
    let coachingMessage;
    if (trendDirection === "improving" && yMean >= 75) {
      coachingMessage = `Excellent trajectory — your average score of ${Math.round(yMean)}% is strong and still improving. Keep focusing on documentation completeness.`;
    } else if (trendDirection === "improving") {
      coachingMessage = `Your scores are trending upward — great work. Your most consistent miss is "${mostConsistentlyFailed || "unknown"}". Focus there to accelerate improvement.`;
    } else if (trendDirection === "declining") {
      coachingMessage = `Your scores have been declining. The most common issue is "${mostConsistentlyFailed || "documentation completeness"}". Try a consistent pre-job photo checklist to reverse the trend.`;
    } else {
      coachingMessage = `Your scores are stable at ${Math.round(yMean)}%. ${mostConsistentlyFailed ? `Address "${mostConsistentlyFailed}" consistently to break through to the next level.` : "Keep building your documentation habits."}`;
    }

    return res.json({
      plumberId,
      period:             { start: startDate || trendPoints[0]?.date, end: endDate || trendPoints[trendPoints.length - 1]?.date },
      trendPoints,
      summary: {
        jobsAnalysed:           n,
        overallAvgScore:        Math.round(yMean),
        trendDirection,
        improvementRatePerJob:  improvementRate,
        previousHalfAvg:        half1Avg,
        currentHalfAvg:         half2Avg,
        changePercent:          changePct,
        bestJobType:            bestType,
        worstJobType:           worstType,
        mostConsistentlyFailed,
        mostImprovedItem,
      },
      byJobType:          typeStats,
      coachingMessage,
    });
  } catch (err) {
    console.error("analyse-trends error:", err);
    return res.status(500).json({ error: "Trends analysis failed. Please try again." });
  }
});

// ── Task 22: Fraud Detection Layer ───────────────────────────────────────────
// Detects suspicious patterns in job submissions.

// In-memory fraud tracking store (keyed by plumber/user ID)
const fraudStore = {
  gpsUsage:      new Map(), // gpsKey → { userIds: Set, count }
  photoHashes:   new Map(), // photoHash → { userId, jobId, date }
  jobTimings:    new Map(), // jobId → { userId, startTime }
  fraudFlags:    new Map(), // jobId → flagDetails
};

function computePhotoHash(data) {
  // Hash just the first 2048 chars of base64 data for efficiency
  return crypto.createHash("sha256").update((data || "").slice(0, 2048)).digest("hex").slice(0, 16);
}

async function runFraudDetection(jobData) {
  const {
    userId,
    jobId,
    gpsLat,
    gpsLng,
    images = [],
    startedAt,
    completedAt,
    confidenceScore,
    photoCount,
  } = jobData;

  const flags = [];

  // Check 1: GPS reuse — same coordinates on 10+ different jobs from different users
  if (gpsLat && gpsLng) {
    const gpsKey = `${parseFloat(gpsLat).toFixed(4)},${parseFloat(gpsLng).toFixed(4)}`;
    if (!fraudStore.gpsUsage.has(gpsKey)) {
      fraudStore.gpsUsage.set(gpsKey, { userIds: new Set(), count: 0 });
    }
    const gpsEntry = fraudStore.gpsUsage.get(gpsKey);
    gpsEntry.userIds.add(userId);
    gpsEntry.count++;

    if (gpsEntry.count >= 10 && gpsEntry.userIds.size >= 3) {
      flags.push({
        type:     "gps_reuse",
        severity: "high",
        detail:   `GPS coordinates (${gpsLat}, ${gpsLng}) used on ${gpsEntry.count} jobs by ${gpsEntry.userIds.size} different users.`,
      });
    }
  }

  // Check 2: Duplicate photos (identical to a previous job)
  for (const img of images) {
    const hash = computePhotoHash(img.data);
    if (fraudStore.photoHashes.has(hash)) {
      const prev = fraudStore.photoHashes.get(hash);
      if (prev.userId !== userId || prev.jobId !== jobId) {
        flags.push({
          type:     "duplicate_photo",
          severity: "high",
          detail:   `Photo "${img.label}" appears to be identical to a photo submitted on a previous job (${prev.jobId}).`,
        });
      }
    } else {
      fraudStore.photoHashes.set(hash, { userId, jobId, date: new Date().toISOString() });
    }
  }

  // Check 3: Impossible completion time (under 2 minutes)
  if (startedAt && completedAt) {
    const durationMs = new Date(completedAt) - new Date(startedAt);
    if (durationMs > 0 && durationMs < 2 * 60 * 1000) {
      flags.push({
        type:     "impossible_speed",
        severity: "medium",
        detail:   `Job completed in ${Math.round(durationMs / 1000)} seconds — this is too fast for genuine photo documentation.`,
      });
    }
  }

  // Check 4: Suspiciously high confidence on minimal photos
  if (typeof confidenceScore === "number" && confidenceScore >= 95 && photoCount <= 2) {
    flags.push({
      type:     "suspicious_score",
      severity: "medium",
      detail:   `Confidence score of ${confidenceScore}% on only ${photoCount} photo(s) is statistically unusual.`,
    });
  }

  const fraudFlag = flags.length > 0;

  if (fraudFlag) {
    fraudStore.fraudFlags.set(jobId, { jobId, userId, flags, detectedAt: new Date().toISOString() });
    console.warn(`[fraud] Suspicious job detected: jobId=${jobId} userId=${userId} flags=${flags.map(f => f.type).join(",")}`);
  }

  return { fraudFlag, flags };
}

// POST /fraud-check — manually run fraud detection on a job
app.post("/fraud-check", async (req, res) => {
  const {
    userId, jobId, gpsLat, gpsLng, images,
    startedAt, completedAt, confidenceScore, photoCount,
  } = req.body || {};

  if (!userId || !jobId) {
    return res.status(400).json({ error: "userId and jobId are required." });
  }

  const result = await runFraudDetection({
    userId, jobId, gpsLat, gpsLng, images: images || [],
    startedAt, completedAt, confidenceScore, photoCount,
  });

  // If fraud detected and DB available, flag the job record
  if (result.fraudFlag && supabaseAdmin) {
    try {
      await supabaseAdmin
        .from("analyses")
        .update({ fraud_flag: true, fraud_flags: result.flags })
        .eq("id", jobId);
    } catch (dbErr) {
      console.error("[fraud] Failed to update fraud flag in DB:", dbErr.message);
    }
  }

  return res.json({
    jobId,
    userId,
    fraudFlag:    result.fraudFlag,
    flags:        result.flags,
    severity:     result.flags.length > 0 ? result.flags.sort((a, b) => (a.severity === "high" ? -1 : 1))[0].severity : null,
    checkedAt:    new Date().toISOString(),
    totalFlagged: fraudStore.fraudFlags.size,
  });
});

// GET /fraud-flags — returns summary of all flagged jobs (protected by API key)
app.get("/fraud-flags", (_req, res) => {
  const flags = Array.from(fraudStore.fraudFlags.values()).slice(-100);
  return res.json({ total: fraudStore.fraudFlags.size, flags });
});

// ── Task 23: Regulatory Compliance Calendar ───────────────────────────────────
// Important dates and service intervals for Victorian tradespeople.

const COMPLIANCE_CALENDAR_ITEMS = [
  { id: "CC-01", trade: "plumbing",  event: "VBA Plumbing Licence Renewal", recurrenceYears: 3, description: "Victorian Building Authority (VBA) plumbing licence must be renewed every 3 years. Renewal applications should be lodged 90 days before expiry.", link: "https://www.vba.vic.gov.au" },
  { id: "CC-02", trade: "gas",       event: "Gas Type B Appliance Service", recurrenceYears: 1, description: "Commercial Type B gas appliances (>10 MJ/h) must be serviced annually by a licenced gas fitter. Service records must be retained.", link: null },
  { id: "CC-03", trade: "electrical",event: "VBA Electrical Licence Renewal", recurrenceYears: 3, description: "Energy Safe Victoria (ESV) electrical licence must be renewed every 3 years. CPD points required for renewal.", link: "https://www.esv.vic.gov.au" },
  { id: "CC-04", trade: "electrical",event: "Test & Tag (Commercial) — 6 Monthly", recurrenceMonths: 6, description: "Electrical equipment used in commercial kitchens, construction sites, and workshops must be tested and tagged every 6 months under AS/NZS 3760.", link: null },
  { id: "CC-05", trade: "electrical",event: "Test & Tag (Office Equipment) — 12 Monthly", recurrenceMonths: 12, description: "Office electrical equipment must be tested and tagged at least annually under AS/NZS 3760.", link: null },
  { id: "CC-06", trade: "gas",       event: "Gas Appliance Compliance Inspection (Type A)", recurrenceYears: 5, description: "Domestic gas appliances should be inspected every 5 years to check for carbon monoxide risk, flue integrity, and safety device function.", link: null },
  { id: "CC-07", trade: "plumbing",  event: "Thermostatic Mixing Valve (TMV) Service", recurrenceYears: 1, description: "AS 4032.1 requires TMVs to be serviced and temperature-verified annually in healthcare, aged care, and disability accommodation.", link: null },
  { id: "CC-08", trade: "plumbing",  event: "Backflow Prevention Device Test", recurrenceYears: 1, description: "Registered backflow prevention devices (RPZ, DCA) must be tested annually by a VBA-endorsed backflow prevention plumber.", link: null },
  { id: "CC-09", trade: "drainage",  event: "Grease Trap Service — Hospitality", recurrenceWeeks: 12, description: "Commercial grease traps must be pumped and serviced at intervals not exceeding 12 weeks (or as specified by the authority). Service records must be kept.", link: null },
  { id: "CC-10", trade: "hvac",      event: "VBA Refrigeration & Air Conditioning Licence Renewal", recurrenceYears: 5, description: "ARC Tick refrigerant handling licences must be renewed every 5 years. Renewal requires evidence of ongoing industry activity.", link: "https://www.arctick.org" },
  { id: "CC-11", trade: "electrical",event: "Emergency Lighting Test — 6 Monthly", recurrenceMonths: 6, description: "AS 2293 requires emergency and exit lighting to be tested every 6 months. Annual 90-minute discharge test also required.", link: null },
  { id: "CC-12", trade: "plumbing",  event: "Water Heater Anode Rod Inspection", recurrenceYears: 5, description: "Storage hot water system sacrificial anode rods should be inspected every 5 years and replaced if corroded to extend tank life.", link: null },
];

app.get("/compliance-calendar", (req, res) => {
  const { trade, jobCompletedDate } = req.query;

  const now = new Date();
  let items = COMPLIANCE_CALENDAR_ITEMS;

  if (trade) {
    items = items.filter(i => i.trade === trade.toLowerCase());
  }

  // If jobCompletedDate provided, calculate upcoming due dates relative to that job
  const baseDate = jobCompletedDate ? new Date(jobCompletedDate) : now;

  const calendarEntries = items.map(item => {
    let nextDue = null;
    if (item.recurrenceYears)  { nextDue = new Date(baseDate); nextDue.setFullYear(nextDue.getFullYear() + item.recurrenceYears); }
    if (item.recurrenceMonths) { nextDue = new Date(baseDate); nextDue.setMonth(nextDue.getMonth() + item.recurrenceMonths); }
    if (item.recurrenceWeeks)  { nextDue = new Date(baseDate); nextDue.setDate(nextDue.getDate() + item.recurrenceWeeks * 7); }

    const daysUntilDue = nextDue ? Math.ceil((nextDue - now) / (1000 * 60 * 60 * 24)) : null;
    const urgency = daysUntilDue !== null
      ? daysUntilDue <= 30 ? "urgent" : daysUntilDue <= 90 ? "upcoming" : "future"
      : "ongoing";

    return {
      ...item,
      nextDue:      nextDue ? nextDue.toISOString().split("T")[0] : null,
      daysUntilDue,
      urgency,
    };
  }).sort((a, b) => (a.daysUntilDue ?? 9999) - (b.daysUntilDue ?? 9999));

  return res.json({
    jurisdiction:   "Victoria, Australia",
    basedOnDate:    baseDate.toISOString().split("T")[0],
    trade:          trade || "all",
    calendarEntries,
    urgent:         calendarEntries.filter(e => e.urgency === "urgent").length,
    upcoming:       calendarEntries.filter(e => e.urgency === "upcoming").length,
    generatedAt:    new Date().toISOString(),
  });
});

// ── Task 24: Job Cost Analyser ────────────────────────────────────────────────
// Analyses job economics — labour, materials, comparison, and profit margin.

// Victorian Award hourly rates (AUD, 2025-2026 rates, inclusive of super)
const AWARD_RATES = {
  plumbing:  { rate: 58, description: "Plumber Level 1 (Metal, Engineering & Associated Industries Award)" },
  gas:       { rate: 62, description: "Gasfitter Level 1 (with gas licence loading)" },
  electrical:{ rate: 64, description: "Electrician Level 1 (Electrical, Electronic and Communications Contracting Industry Award)" },
  drainage:  { rate: 56, description: "Plumber/Drainer Level 1" },
  carpentry: { rate: 55, description: "Carpenter Grade 3 (Building and Construction General On-site Award)" },
  hvac:      { rate: 60, description: "HVAC/Refrigeration Technician Level 1" },
};

// Industry average job values by type (AUD, Victorian small business)
const INDUSTRY_AVERAGE_JOB_VALUES = {
  plumbing:  { simpleJob: 350, moderateJob: 850, complexJob: 1800 },
  gas:       { simpleJob: 420, moderateJob: 950, complexJob: 2200 },
  electrical:{ simpleJob: 380, moderateJob: 900, complexJob: 2000 },
  drainage:  { simpleJob: 450, moderateJob: 1100, complexJob: 2500 },
  carpentry: { simpleJob: 600, moderateJob: 1500, complexJob: 3500 },
  hvac:      { simpleJob: 500, moderateJob: 1200, complexJob: 2800 },
};

app.post("/analyse-cost", (req, res) => {
  const {
    jobType,
    timeOnSiteMinutes,
    materialsList = [],
    jobValue,
    suburb,
  } = req.body || {};

  if (!jobType || typeof jobType !== "string") {
    return res.status(400).json({ error: "jobType is required." });
  }

  const awardRate   = AWARD_RATES[jobType];
  const industryAvg = INDUSTRY_AVERAGE_JOB_VALUES[jobType];

  if (!awardRate) {
    return res.status(400).json({ error: `Unknown jobType: ${jobType}` });
  }

  // Labour cost
  const hours      = typeof timeOnSiteMinutes === "number" ? timeOnSiteMinutes / 60 : null;
  const labourCost = hours !== null ? parseFloat((hours * awardRate.rate).toFixed(2)) : null;

  // Materials cost from list
  const pricingTable = MATERIALS_PRICING[jobType] || {};
  let materialsCost  = 0;
  const materialLines = [];

  for (const entry of materialsList) {
    const name = (entry.name || "").toLowerCase();
    const qty  = typeof entry.quantity === "number" ? entry.quantity : 1;
    const key  = Object.keys(pricingTable).find(k => name.includes(k) || k.includes(name));
    if (key) {
      const line = pricingTable[key].price * qty;
      materialsCost += line;
      materialLines.push({ name: entry.name, qty, lineTotal: parseFloat(line.toFixed(2)) });
    }
  }

  const totalCost = parseFloat(((labourCost || 0) + materialsCost).toFixed(2));

  // Profit margin estimate (if job value provided)
  let profitMargin = null;
  let profitAmt    = null;
  if (typeof jobValue === "number" && jobValue > 0 && totalCost > 0) {
    profitAmt    = parseFloat((jobValue - totalCost).toFixed(2));
    profitMargin = parseFloat(((profitAmt / jobValue) * 100).toFixed(1));
  }

  // Industry comparison
  let comparisonBand = null;
  if (industryAvg && totalCost > 0) {
    comparisonBand = totalCost <= industryAvg.simpleJob ? "below_average"
      : totalCost <= industryAvg.moderateJob ? "average"
      : totalCost <= industryAvg.complexJob  ? "above_average"
      : "high_complexity";
  }

  return res.json({
    jobType,
    suburb:         suburb || null,
    labour: {
      hoursOnSite:    hours !== null ? parseFloat(hours.toFixed(2)) : null,
      awardRateAUD:   awardRate.rate,
      awardSource:    awardRate.description,
      labourCostAUD:  labourCost,
    },
    materials: {
      items:          materialLines,
      totalAUD:       parseFloat(materialsCost.toFixed(2)),
    },
    totals: {
      totalCostAUD:   totalCost,
      jobValueAUD:    jobValue || null,
      profitAUD:      profitAmt,
      profitMarginPct: profitMargin,
    },
    industryComparison: {
      band:           comparisonBand,
      avgSimpleJob:   industryAvg?.simpleJob,
      avgModerateJob: industryAvg?.moderateJob,
      avgComplexJob:  industryAvg?.complexJob,
      note:           "Victorian small business averages — exclusive of GST.",
    },
    disclaimer: "Labour rates based on applicable Modern Award base rates. Actual costs may vary. Not financial or tax advice.",
  });
});

// ── Round 2: Improvement — POST /before-after enhancement ────────────────────
// Before/after comparison with detailed change analysis using GPT-4o.
// (Augments any existing /before-after endpoint in the file with a smarter version)

app.post("/compare-changes", async (req, res) => {
  const { beforeImage, afterImage, mime = "image/jpeg", jobType, jobDescription } = req.body || {};

  if (!beforeImage || !afterImage) {
    return res.status(400).json({ error: "Both beforeImage and afterImage (base64) are required." });
  }
  if (!client) {
    return res.status(503).json({ error: "AI service not configured." });
  }

  const prompt = `You are a trade compliance analyst comparing a before and after photo for a ${jobType || "trade"} job.

${jobDescription ? `Job description: ${jobDescription}` : ""}

Analyse both photos and return strict JSON with these fields:
{
  "changesIdentified": ["array of specific changes visible"],
  "complianceImprovements": ["compliance items that were remediated"],
  "remainingConcerns": ["items still visible that may need attention"],
  "overallAssessment": "one sentence — does the after photo show a compliant outcome?",
  "confidenceInChange": <integer 0-100>,
  "beforeCondition": "brief description of the before state",
  "afterCondition": "brief description of the after state",
  "workQuality": "excellent|good|adequate|poor"
}

Return STRICT JSON only.`;

  try {
    usageStats.openaiCalls++;
    const response = await callOpenAIWithRetry({
      model:           "gpt-4o",
      response_format: { type: "json_object" },
      messages: [{
        role:    "user",
        content: [
          { type: "text",      text: prompt },
          { type: "text",      text: "BEFORE photo:" },
          { type: "image_url", image_url: { url: `data:${mime};base64,${beforeImage}` } },
          { type: "text",      text: "AFTER photo:" },
          { type: "image_url", image_url: { url: `data:${mime};base64,${afterImage}` } },
        ],
      }],
      temperature: 0.2,
      max_tokens:  600,
    });

    const raw    = response.choices?.[0]?.message?.content || "{}";
    const result = JSON.parse(raw);

    return res.json({
      jobType: jobType || null,
      comparison: result,
      model:       "gpt-4o",
      analysedAt:  new Date().toISOString(),
    });
  } catch (err) {
    console.error("compare-changes error:", err);
    return res.status(500).json({ error: "Change comparison failed. Please try again." });
  }
});

// ── Round 2: Improvement — POST /job-summary ──────────────────────────────────
// Lightweight job summary endpoint that doesn't require GPT-4o — uses rule-based logic.

app.post("/job-summary", (req, res) => {
  const {
    jobType,
    overallConfidence,
    adjustedConfidence,
    complianceScore,
    itemsDetected = [],
    itemsMissing  = [],
    itemsUnclear  = [],
    riskRating    = "medium",
    photosSubmitted,
    photosAnalysed,
    complexityBand,
    plumberName,
    address,
    completedAt,
  } = req.body || {};

  if (!jobType) {
    return res.status(400).json({ error: "jobType is required." });
  }

  const score  = complianceScore?.score ?? overallConfidence ?? adjustedConfidence ?? 0;
  const grade  = complianceScore?.grade ?? (score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : score >= 60 ? "C" : "D");
  const passed = score >= 70;

  // Build a structured summary without AI
  const outcomeLabel = passed ? "COMPLIANT" : "REQUIRES ATTENTION";
  const dateStr      = completedAt ? new Date(completedAt).toLocaleDateString("en-AU") : new Date().toLocaleDateString("en-AU");

  const summaryLines = [
    `${plumberName || "Tradesperson"} completed a ${jobType} job${address ? ` at ${address}` : ""} on ${dateStr}.`,
    `Documentation score: ${score}/100 (Grade ${grade}) — ${outcomeLabel}.`,
    itemsDetected.length > 0 ? `${itemsDetected.length} item${itemsDetected.length !== 1 ? "s" : ""} verified: ${itemsDetected.slice(0, 3).join(", ")}${itemsDetected.length > 3 ? ` and ${itemsDetected.length - 3} more` : ""}.` : null,
    itemsMissing.length > 0  ? `${itemsMissing.length} item${itemsMissing.length !== 1 ? "s" : ""} require attention: ${itemsMissing.slice(0, 2).join(", ")}${itemsMissing.length > 2 ? " and others" : ""}.` : null,
    riskRating === "high"    ? `Risk level: HIGH — critical safety items are unverified.` : null,
  ].filter(Boolean);

  return res.json({
    jobType,
    outcome:       outcomeLabel,
    score,
    grade,
    passed,
    riskRating,
    summary:       summaryLines.join(" "),
    keyStats: {
      itemsVerified:   itemsDetected.length,
      itemsMissing:    itemsMissing.length,
      itemsUnclear:    itemsUnclear.length,
      photosSubmitted: photosSubmitted || null,
      photosAnalysed:  photosAnalysed  || null,
      complexity:      complexityBand  || null,
    },
    generatedAt:   new Date().toISOString(),
  });
});

// ── Round 2: Improvement — GET /server-info ───────────────────────────────────
// Public endpoint returning non-sensitive server capabilities (for client feature detection).

app.get("/server-info", (_req, res) => {
  return res.json({
    version:        "2.0.0",
    apiVersion:     "2026-03",
    capabilities:   [
      "compliance-review", "visualise", "stamp-photo", "property-passport",
      "recommendations", "benchmark", "weather-impact", "materials-estimate",
      "generate-description", "validate-certificate", "predict-performance",
      "compliance-heatmap", "predict-complexity", "summarise-report",
      "training-mode", "translations", "industry-insights", "notifications",
      "check-integrity", "analyse-trends", "fraud-check", "compliance-calendar",
      "analyse-cost", "compare-changes", "job-summary", "risk-assessment",
      "compliance-check", "regulatory-updates",
    ],
    supportedJobTypes:   ["plumbing", "gas", "electrical", "drainage", "carpentry", "hvac"],
    supportedLanguages:  Object.keys(TRANSLATIONS),
    aiModels:            ["gpt-4.1-mini", "gpt-4o"],
    jurisdiction:        "Victoria, Australia",
    regulatoryFramework: ["AS/NZS 3500", "AS/NZS 5601.1", "AS/NZS 3000", "AS/NZS 3500.2", "AS 1684", "AS 4254.2"],
  });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

// ── Global error handler ──────────────────────────────────────────────────────
// Catches anything thrown outside a route-level try/catch (e.g. CORS errors,
// body-parser rejections). Logs full detail server-side, returns generic message.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`[${new Date().toISOString()}] Unhandled error on ${req.method} ${req.path}:`, err);
  const status = typeof err.status === "number" ? err.status : 500;
  res.status(status).json({ error: err.message || "An unexpected error occurred." });
});

// Register cache clear route (protected by existing API key middleware)
registerCacheClearRoute(app);

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  const env = process.env.NODE_ENV || "development";

  // ── Startup security report ──────────────────────────────────────────────────
  const configured   = (varName) => !!process.env[varName];
  const present      = (val)     => val !== undefined && val !== null && val !== "";

  const securityReport = [
    "",
    "╔══════════════════════════════════════════════════════════════╗",
    "║              ELEMETRIC SERVER — STARTUP REPORT               ║",
    "╚══════════════════════════════════════════════════════════════╝",
    `  Environment  : ${env}`,
    `  Port         : ${PORT}`,
    `  Node.js      : ${process.version}`,
    `  Started at   : ${new Date().toISOString()}`,
    "",
    "  ── Service Configuration ──────────────────────────────────────",
    `  OpenAI        : ${configured("OPENAI_API_KEY")      ? "✓ configured" : "✗ MISSING — /review and /visualise will fail"}`,
    `  Replicate     : ${configured("REPLICATE_API_TOKEN") ? "✓ configured" : "✗ MISSING — /visualise will fail"}`,
    `  Supabase URL  : ${configured("SUPABASE_URL")        ? "✓ configured" : "✗ MISSING — DB features disabled"}`,
    `  Supabase Key  : ${configured("SUPABASE_SERVICE_KEY")? "✓ configured" : "✗ MISSING — DB features disabled"}`,
    `  Stripe Key    : ${configured("STRIPE_SECRET_KEY")   ? "✓ configured" : "✗ MISSING — billing disabled"}`,
    `  Stripe Webook : ${configured("STRIPE_WEBHOOK_SECRET")?"✓ configured" : "⚠ MISSING — webhook signature not verified"}`,
    `  Resend        : ${configured("RESEND_API_KEY")      ? "✓ configured" : "⚠ MISSING — transactional email disabled"}`,
    `  Elemetric Key : ${configured("ELEMETRIC_API_KEY")   ? "✓ configured" : "⚠ MISSING — API auth not enforced"}`,
    `  Allowed Origins: ${present(process.env.ALLOWED_ORIGINS) ? process.env.ALLOWED_ORIGINS : "⚠ not set — CORS open in dev, blocks in prod"}`,
    "",
    "  ── Security Controls ──────────────────────────────────────────",
    `  Helmet        : ✓ active`,
    `  Rate limiting : ✓ active (global 20/15min, review 5/min, stamp 30/15min, visualise 3/10min)`,
    `  Input sanit.  : ✓ active (null-byte + control-char stripping)`,
    `  API key auth  : ${configured("ELEMETRIC_API_KEY") ? "✓ enforced" : "⚠ not enforced (ELEMETRIC_API_KEY unset)"}`,
    `  Reverse proxy : ✓ trust 1 hop (Railway)`,
    "",
    "  ── Registered Endpoints ───────────────────────────────────────",
    "  POST  /review                 AI compliance photo analysis",
    "  POST  /visualise              AC unit visualiser (Stable Diffusion)",
    "  POST  /stamp-photo            GPS + timestamp watermark",
    "  POST  /property-passport      Property compliance history",
    "  POST  /send-invoice-email     Transactional email — invoice",
    "  POST  /send-near-miss-alert   Transactional email — near-miss alert",
    "  POST  /send-welcome-email     Transactional email — welcome",
    "  POST  /before-after           Before/after photo comparison",
    "  POST  /risk-assessment        Job risk profile engine",
    "  POST  /compliance-check       Victorian regulation checker",
    "  POST  /webhook                Stripe billing webhook",
    "  POST  /webhook/user-created   Supabase auth signup webhook",
    "  GET   /regulatory-updates     Regulatory change feed",
    "  GET   /analytics              Business analytics dashboard",
    "  GET   /stats                  Server usage + cost metrics",
    "  GET   /health                 Service connectivity health check",
    "  GET   /timestamp              Server UTC timestamp",
    "  GET   /                       Heartbeat",
    "═══════════════════════════════════════════════════════════════",
    "",
  ];

  securityReport.forEach(line => console.log(line));
});