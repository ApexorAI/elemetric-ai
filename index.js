require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (_req, res) => {
res.json({
ok: true,
service: "Elemetric AI server",
});
});

app.post("/review", async (req, res) => {
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

const promptText = `
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

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
console.log(`Elemetric AI server running on http://0.0.0.0:${PORT}`);
});