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

// ── In-memory analysis cache (1-hour TTL) + request deduplication ────────────
const analysisCache   = new Map();
const CACHE_TTL_MS    = 60 * 60 * 1000;
const pendingAnalyses = new Map(); // cacheKey → Promise

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
  const entry = analysisCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { analysisCache.delete(key); return null; }
  return entry.result;
}

function setCache(key, result) {
  analysisCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
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

app.use(globalLimiter);

// ── API key auth ───────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  // Allow unauthenticated health check and Stripe webhook
  if (req.path === "/" || req.path === "/webhook" || req.path === "/health") return next();

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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
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

const isGas = type === "gas";
const isElectrical = type === "electrical";
const isDrainage = type === "drainage";
const isHvac = type === "hvac";
const isCarpentry = type === "carpentry";
const isGeneralDoc = isHvac || isCarpentry;

const tradeLabel = isHvac ? "HVAC" : type;

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

FAILING photo descriptions (these would receive a FAIL):
1. "Blurry switchboard photo taken from 1.5 m away — individual circuit labels, amperage markings, and RCD test button cannot be read."
2. "Closed grey switchboard door with no internal components visible — the photo only shows the outside of the board."
3. "Earthing conductor visible but it has grey insulation — the green/yellow colour coding required by AS/NZS 3000 cannot be confirmed."

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

FAILING photo descriptions (these would receive a FAIL):
1. "Photo of backfilled trench — surface is flat compacted soil with no visible pipe, fittings, or bedding material. No drainage components can be assessed."
2. "Overhead photo of a wet bathroom floor drain surrounded by moisture staining and a small puddle of standing water on the tiles — fails the no-pooling moisture check."
3. "Drainage pipe photographed from directly above at a flat angle — no reference datum, no spirit level, and fall direction cannot be determined from this view."

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

FAILING photo descriptions (these would receive a FAIL):
1. "Photo of a blank plasterboard wall with no HVAC equipment, ductwork, or installation work visible anywhere in the frame."
2. "Indoor unit photo where the refrigerant line connections are completely obscured by unsecured lagging hanging loose — connections and line run cannot be assessed."
3. "Photo of a person standing next to the outdoor condenser unit — the person occupies most of the frame and the unit itself is partially out of shot, making the installation detail unassessable."

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

FAILING photo descriptions (these would receive a FAIL):
1. "Completely blurry photo of a room interior — no framing, joinery, or carpentry components can be identified."
2. "Photo of an outdoor garden path and plants — no carpentry work of any kind is visible."
3. "Wide-angle room photo where a door frame is just visible at the edge — too far away to assess the quality, reveal depth, or architrave fit."

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

const inputContent = [
{
type: "text",
text: buildRegulationsNote(type) + promptText,
},
...images.flatMap((img) => [
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

const finalResult = {
  relevant,
  overall_confidence: overallConfidence,
  adjusted_confidence: adjustedConfidence,
  complexity_score: complexityScore,
  complexity_band: complexityBand,
  items_detected: itemsDetected,
  items_missing: itemsMissing,
  items_unclear: itemsUnclear,
  risk_rating: riskRating,
  recommended_actions: recommendedActions,
  liability_summary: liabilitySummary,
  analysis,
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
    const prompt =
      `A ${modelNumber} air conditioning unit approximately 80cm wide mounted on the wall, correct scale and ` +
      `proportion relative to the room, professional installation photo, photorealistic, natural shadows, ${roomDescription}`;

    console.log("[visualise] Step 3 - Calling Replicate with prompt:", prompt, "| image size:", correctedWallImage.length);

    let output;
    try {
      usageStats.replicateCalls++;
      output = await replicate.run(
        "stability-ai/stable-diffusion-inpainting:95b7223104132402a9ae91cc677285bc5eb997834bd2349fa486f53910fd68b3",
        {
          input: {
            image:            `data:${correctedMime};base64,${correctedWallImage}`,
            mask:             `data:image/png;base64,${maskBase64}`,
            prompt,
            negative_prompt:  "ceiling, roof, floor, distorted, blurry, cartoon, painting, unrealistic, floating, oversized, too large, giant, distorted proportions, wrong scale",
            strength:         0.95,
            guidance_scale:   9,
            num_inference_steps: 50,
            num_outputs:      1,
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

app.post("/stamp-photo", async (req, res) => {
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
    cacheSize:        analysisCache.size,
    pendingAnalyses:  pendingAnalyses.size,
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

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Elemetric AI server running on http://0.0.0.0:${PORT}`);
});