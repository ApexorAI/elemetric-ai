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
const isDrainage = type === "drainage";
const isGeneralDoc = type === "hvac" || type === "carpentry";

const tradeLabel = type === "hvac" ? "HVAC" : type;

// Shared output format instruction appended to every prompt
const outputFormatInstruction = `
CONFIDENCE BREAKDOWN — return ALL of the following fields in your JSON response:
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
- overall_confidence = round((passing photos / total photos submitted) * 100)
- If zero photos pass: overall_confidence = 0, relevant = false
- relevant = true only if at least one photo passes and shows genuine ${tradeLabel} work

RISK RATING CRITERIA:
- "high": more than half the photos fail or show unrelated content
- "medium": some photos fail or are unclear
- "low": all or nearly all photos show genuine trade work

${outputFormatInstruction}

Example response shape:
{
  "relevant": true,
  "overall_confidence": 80,
  "items_detected": ["Site Overview", "Completed Work"],
  "items_missing": ["Labels / Documentation"],
  "items_unclear": ["Equipment / Materials"],
  "risk_rating": "low",
  "recommended_actions": [
    "Retake the labels photo — current photo does not show trade documentation or equipment markings."
  ],
  "liability_summary": "Documentation is mostly complete. The missing labels photo is a minor gap — retake before submitting the final job record.",
  "analysis": "2 of 4 photos pass validation. 1 is unclear. 1 does not show relevant work."
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

return res.json({
  relevant,
  overall_confidence: overallConfidence,
  items_detected: itemsDetected,
  items_missing: itemsMissing,
  items_unclear: itemsUnclear,
  risk_rating: riskRating,
  recommended_actions: recommendedActions,
  liability_summary: liabilitySummary,
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