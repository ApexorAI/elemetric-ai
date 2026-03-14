require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const rateLimit = require("express-rate-limit");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ── Stripe webhook — raw body MUST come before express.json() ─────────────────

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-12-18.acacia" })
  : null;

const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

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

    try {
      if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
        const subscription = event.data.object;

        // Retrieve the Stripe customer to get their email
        const customer = await stripe.customers.retrieve(subscription.customer);
        const email = customer.email;
        if (!email) {
          console.warn("Webhook: No customer email found.");
          return res.sendStatus(200);
        }

        const role = roleFromSubscription(subscription);

        // Look up the Supabase user by email
        const { data: users, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (listErr) throw listErr;

        const user = users?.users?.find((u) => u.email === email);
        if (!user) {
          console.warn(`Webhook: No Supabase user found for email ${email}`);
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

        console.log(`Webhook: Updated ${email} → role=${role}`);
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;

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

        console.log(`Webhook: Downgraded ${email} → free`);
      }
    } catch (err) {
      console.error("Webhook handler error:", err);
      // Still return 200 so Stripe doesn't retry
    }

    res.sendStatus(200);
  }
);

app.use(cors());
app.use(express.json({ limit: "50mb" }));

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
  if (req.path === "/" || req.path === "/webhook") return next();

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

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (_req, res) => {
res.json({
ok: true,
service: "Elemetric AI server",
});
});

app.get("/timestamp", (_req, res) => {
  const now = new Date();
  res.json({
    timestamp: now.toISOString(),
    formatted: now.toLocaleString("en-AU", { timeZone: "Australia/Melbourne" }),
  });
});

app.post("/review", reviewLimiter, async (req, res) => {
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

const isGas = type === "gas";
const isElectrical = type === "electrical";
const isGeneralDoc = type === "hvac" || type === "carpentry";

const tradeLabel = type === "hvac" ? "HVAC" : type;

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

REQUIRED ELECTRICAL INSTALLATION ITEMS and what must be visible for a PASS:
- "RCD protection installed and tested": must show an RCD or safety switch with test button, ideally in a switchboard
- "Circuit breaker ratings correct": must clearly show circuit breakers with visible amperage ratings or labels
- "Earth continuity tested": must show earthing conductors, earth terminals, or test equipment confirming earth continuity
- "Polarity correct": must show wiring connections or test instrument confirming correct active/neutral polarity
- "Insulation resistance tested": must show an insulation resistance tester (megohmmeter) or clearly readable test result
- "All connections secure and terminations correct": must show cable terminations at switchboard, outlet, or fitting — no loose wires
- "Cable support and protection adequate": must show cables properly clipped, conduit, or cable management in place
- "Switchboard labelling complete": must show switchboard with circuit labels or directory visible
- "No visible damage to cables or fittings": must show cables or fittings — clean, undamaged, no burns or cuts
- "Smoke alarm installed and tested where required": must show a smoke alarm installed on ceiling or wall
- "Safety switch tested and operational": must show a safety switch (RCD) with test button or test result indicated
- "Test results recorded": must show a completed test results sheet, certificate of electrical safety, or test instrument screen

SCORING:
- confidence = round((passing photos / total photos submitted) * 100)
- If zero photos pass: confidence = 0, relevant = false
- relevant = true only if at least one photo passes and shows genuine electrical installation work

OUTPUT FIELDS:
- detected: labels of photos that clearly PASS
- unclear: labels of photos that show something electrical-related but cannot be confidently verified as the named item
- missing: labels of photos that FAIL — wrong subject, unrelated object, or required item not visible
- action: one short sentence on what to retake or fix
- analysis: one short sentence summarising how many photos passed and why others failed

Return STRICT JSON only. No markdown.

{
"relevant": true,
"confidence": 75,
"detected": ["RCD protection installed and tested", "Switchboard labelling complete"],
"unclear": ["Earth continuity tested"],
"missing": ["Insulation resistance tested", "Test results recorded"],
"action": "Retake the insulation resistance and test results photos — current photos do not show test equipment or recorded results.",
"analysis": "2 of 5 photos pass validation. 1 is unclear. 2 photos do not show the required electrical installation item."
}
`.trim() : isGeneralDoc ? `
You are a trade documentation photo validator for Australian construction documentation records.

Job type: ${tradeLabel}

Each photo below has been submitted with a label describing what it is SUPPOSED to show. Validate each photo individually and determine whether it shows genuine trade work relevant to the label.

VALIDATION RULES — apply without exception:
- A photo PASSES if it clearly shows work, equipment, materials, or a site area relevant to ${tradeLabel} work and matches the intent of its label.
- A photo FAILS if it shows a person, animal, unrelated object, food, or anything clearly unrelated to ${tradeLabel} work.
- A photo FAILS if it is blurry, too dark, or shows nothing recognisable.
- This is a documentation record — not a compliance check. You are not verifying code compliance, only that the photos show genuine ${tradeLabel} trade work.

SCORING:
- confidence = round((passing photos / total photos submitted) * 100)
- If zero photos pass: confidence = 0, relevant = false
- relevant = true only if at least one photo passes and shows genuine ${tradeLabel} work

OUTPUT FIELDS:
- detected: labels of photos that clearly PASS
- unclear: labels of photos that show something related but hard to identify
- missing: labels of photos that FAIL — wrong subject or unrelated to ${tradeLabel} work
- action: one short sentence on what to retake or fix
- analysis: one short sentence summarising how many photos passed

Return STRICT JSON only. No markdown.

{
"relevant": true,
"confidence": 80,
"detected": ["Site Overview", "Completed Work"],
"unclear": ["Equipment / Materials"],
"missing": ["Labels / Documentation"],
"action": "Retake the labels photo — current photo does not show trade documentation.",
"analysis": "2 of 4 photos pass validation. 1 is unclear. 1 does not show relevant work."
}
`.trim() : isGas ? `
You are a strict gas compliance photo validator for Victorian gas regulations under AS/NZS 5601.1:2013 and AS 4575:2019.

Job type: gas rough-in

Each photo below has been submitted with a label describing what it is SUPPOSED to show. Validate each photo individually and determine whether it actually contains the required gas installation component or evidence.

VALIDATION RULES — apply without exception:
- Validate each photo against its label independently.
- A photo PASSES only if it clearly and unambiguously shows the specific item named in its label.
- A photo FAILS if it shows a person, animal, unrelated object, room interior, or anything not related to gas fitting work.
- A photo FAILS if it is blurry, too dark, or ambiguous — if you cannot clearly identify the named item, it fails.
- A photo FAILS if it shows gas work in general but not the specific item named in its label.
- Never give benefit of the doubt. When in doubt, the photo fails.

REQUIRED GAS INSTALLATION ITEMS and what must be visible for a PASS:
- "Gastight AS/NZS 5601.1": must show evidence of gastightness testing — gauge, written test result visible, or marked connections
- "Accessible for servicing": must show the appliance or component is clearly accessible with no obstructions
- "Isolation valve present": must clearly show an isolation valve on the gas supply line
- "Electrically safe": must show electrical connections or earthing that are visibly safe and compliant
- "Evidence of certification": must show a compliance label, certificate plate, or certification marking on the appliance
- "Adequately restrained": must show restraints, brackets, or fixings holding the appliance or pipework
- "Ventilation adequate": must show ventilation openings, grilles, or ducting providing adequate airflow
- "Clearances OK": must show required clearances around the appliance to combustibles or walls
- "Cowl and flue terminal OK": must clearly show the cowl or flue terminal at the point of exhaust
- "Flue supported and sealed": must show the flue pipe with visible supports and sealed joints
- "Scorching and overheating check": must show no scorching — clean surfaces around the appliance
- "Heat exchanger OK": must show the heat exchanger surface — clean, undamaged, no cracks or corrosion
- "Gas fitting line tested and gas tight": must show test equipment or marked connections confirming gas tightness
- "Appliance cleaned of dust and debris": must show the appliance interior or burner area — visibly clean
- "Gas supply and appliance operating pressures correct": must show a pressure gauge with a readable value
- "Burner flames normal": must clearly show the burner with normal blue flames — no yellow tipping or lifting
- "Appliance operating correctly including all safety devices": must show the appliance running normally with safety devices visible

SCORING:
- confidence = round((passing photos / total photos submitted) * 100)
- If zero photos pass: confidence = 0, relevant = false
- relevant = true only if at least one photo passes and shows genuine gas installation work

OUTPUT FIELDS:
- detected: labels of photos that clearly PASS
- unclear: labels of photos that show something gas-related but cannot be confidently verified as the named item
- missing: labels of photos that FAIL — wrong subject, unrelated object, or required item not visible
- action: one short sentence on what to retake or fix
- analysis: one short sentence summarising how many photos passed and why others failed

Return STRICT JSON only. No markdown.

{
"relevant": true,
"confidence": 65,
"detected": ["Isolation valve present", "Burner flames normal"],
"unclear": ["Flue supported and sealed"],
"missing": ["Gas supply and appliance operating pressures correct", "Scorching and overheating check"],
"action": "Retake the pressure gauge photo and scorching check — current photos do not show these items.",
"analysis": "2 of 5 photos pass validation. 1 photo is unclear. 2 photos do not show the required gas installation item."
}
`.trim() : `
You are a strict plumbing compliance photo validator for Victorian plumbing regulations.

Job type: ${type}

Each photo below has been submitted with a label describing what it is SUPPOSED to show. Your job is to validate each photo individually and determine whether it actually contains the required plumbing component.

VALIDATION RULES — apply these without exception:
- Validate each photo against its label independently.
- A photo PASSES only if it clearly and unambiguously shows the specific plumbing component named in its label.
- A photo FAILS if it shows a person, animal, pet, room interior, outdoor scene, food, furniture, vehicle, sky, or any object that is not a plumbing component.
- A photo FAILS if it is blurry, too dark, or ambiguous — if you cannot clearly identify the named component, it fails.
- A photo FAILS if it shows plumbing in general but not the specific component named in its label.
- Never give benefit of the doubt. When in doubt, the photo fails.

REQUIRED COMPONENTS for a ${type} installation and what must be visible for a PASS:
- "Existing system (before)": must show the old hot water unit, tank, or existing pipework before replacement
- "PTR valve installed": must clearly show a PTR (pressure and temperature relief) valve with discharge pipe
- "Tempering valve": must clearly show a tempering valve body with markings or connections
- "Compliance plate / label": must show the compliance plate or regulatory rating label physically attached to the unit
- "Isolation valve": must clearly show an isolation valve on the supply or return pipework

SCORING:
- Count how many photos PASS their individual validation.
- confidence = round((passing photos / total photos submitted) * 100)
- If zero photos pass: confidence = 0, relevant = false.
- relevant = true only if at least one photo passes and the passing photos are genuine plumbing components.

OUTPUT FIELDS:
- detected: labels of photos that clearly PASS
- unclear: labels of photos that show something plumbing-related but cannot be confidently verified as the named component
- missing: labels of photos that FAIL — wrong subject, animal, person, unrelated object, or component not visible
- action: one short sentence on what to retake or fix
- analysis: one short sentence summarising how many photos passed and why others failed

Return STRICT JSON only. No markdown. No explanation outside the JSON.

{
"relevant": true,
"confidence": 60,
"detected": ["PTR valve installed", "Isolation valve"],
"unclear": ["Compliance plate / label"],
"missing": ["Existing system (before)", "Tempering valve"],
"action": "Retake the before photo and tempering valve — current photos do not show these components.",
"analysis": "2 of 5 photos pass validation. 1 photo is unclear. 2 photos do not show the required component."
}
`.trim();

const inputContent = [
{
type: "text",
text: promptText,
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

const response = await client.chat.completions.create({
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
return res.status(500).json({
error: "AI returned invalid JSON",
raw,
});
}

const relevant = !!parsed.relevant;
const confidence =
typeof parsed.confidence === "number"
? Math.max(0, Math.min(100, parsed.confidence))
: 0;

const detected = Array.isArray(parsed.detected) ? parsed.detected : [];
const unclear = Array.isArray(parsed.unclear) ? parsed.unclear : [];
const missing = Array.isArray(parsed.missing) ? parsed.missing : [];
const action =
typeof parsed.action === "string" ? parsed.action : "review installation";
const analysis =
typeof parsed.analysis === "string"
? parsed.analysis
: "AI review completed.";

return res.json({
relevant,
confidence,
detected,
unclear,
missing,
action,
analysis,
});
} catch (error) {
console.error("AI review error:", error);

return res.status(500).json({
error: "AI analysis failed",
details: error.message || "Unknown server error",
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

app.post("/visualise", visualiserLimiter, async (req, res) => {
  try {
    const { wallImage, mime, modelNumber } = req.body || {};

    if (!wallImage || !mime) {
      return res.status(400).json({ error: "Missing wall image." });
    }
    if (!modelNumber) {
      return res.status(400).json({ error: "Missing product model number." });
    }

    // Step 1: Describe the room using GPT-4o vision
    const visionResponse = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Describe this room or wall space in 2-3 concise sentences for use as a context in an interior design rendering prompt. Focus on: wall colour, room style, lighting, and approximate size. Do not mention any existing appliances or fixtures.",
            },
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${wallImage}` },
            },
          ],
        },
      ],
      max_tokens: 150,
      temperature: 0.3,
    });

    const roomDescription = visionResponse.choices?.[0]?.message?.content?.trim() || "a modern Australian home interior";

    // Step 2: Generate visualisation with DALL-E 3
    const dalleResponse = await client.images.generate({
      model: "dall-e-3",
      prompt: `Photorealistic interior design render of a ${modelNumber} installed in the following space: ${roomDescription}. The product is clearly visible, professionally installed, and the image looks like a real photograph. Australian home, high quality, natural lighting.`,
      n: 1,
      size: "1024x1024",
      quality: "standard",
      response_format: "b64_json",
    });

    const imageBase64 = dalleResponse.data?.[0]?.b64_json;
    if (!imageBase64) {
      return res.status(500).json({ error: "No image generated." });
    }

    return res.json({ imageBase64, roomDescription });
  } catch (error) {
    console.error("Visualiser error:", error);
    return res.status(500).json({
      error: "Visualisation failed",
      details: error.message || "Unknown server error",
    });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
console.log(`Elemetric AI server running on http://0.0.0.0:${PORT}`);
});