require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const Replicate = require("replicate");
const rateLimit = require("express-rate-limit");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const sharp = require("sharp");

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
      console.error("  stack:", replicateErr.stack);
      throw replicateErr;
    }

    console.log("[visualise] Step 4 - Result received, output type:", typeof output, "isArray:", Array.isArray(output));
    console.log("[visualise] Step 4 - Raw output:", JSON.stringify(output, null, 2));

    // Replicate SDK ≥ 1.0 returns FileOutput objects; extract URL string
    let imageUrl = Array.isArray(output) ? output[0] : output;
    if (imageUrl && typeof imageUrl === "object" && typeof imageUrl.url === "function") {
      imageUrl = imageUrl.url();
    }
    if (imageUrl && typeof imageUrl === "object" && imageUrl.href) {
      imageUrl = imageUrl.href;
    }

    console.log("[visualise] Step 4 - Resolved imageUrl:", imageUrl);

    if (!imageUrl) {
      return res.status(500).json({ error: "No image returned from Replicate." });
    }

    console.log(`[visualise] Completed for model "${modelNumber}" → ${imageUrl}`);
    return res.json({ imageUrl });

  } catch (error) {
    console.error("[visualise] FATAL ERROR:");
    console.error("  message:", error.message);
    console.error("  stack:", error.stack);
    return res.status(500).json({
      error: "Visualisation failed",
      details: error.message || "Unknown server error",
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
      error: "Photo stamping failed",
      details: error.message || "Unknown error",
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

    const { data: jobs, error } = await supabaseAdmin
      .from("jobs")
      .select("id, job_type, job_name, job_addr, confidence, relevant, detected, missing, created_at, installer_name, status")
      .ilike("job_addr", `%${address}%`)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("Property passport DB error:", error);
      return res.status(500).json({ error: "Database query failed." });
    }

    const jobList = jobs || [];

    // Compliance trend — average confidence per calendar month
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

    return res.json({
      address,
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
      error: "Property passport failed",
      details: error.message || "Unknown error",
    });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
console.log(`Elemetric AI server running on http://0.0.0.0:${PORT}`);
});