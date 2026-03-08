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

const inputContent = [
{
type: "text",
text: `
You are an AI plumbing documentation reviewer.

Job type: ${type}

Your task:
1. Decide if the photos are relevant plumbing install photos.
2. Estimate confidence from 0 to 100.
3. List clearly visible plumbing items.
4. List unclear items that cannot be confidently verified.
5. List missing items that should be documented.
6. Give one short recommended action.

IMPORTANT:
- Be practical, short, and trade-focused.
- For hot water installs, think about items like:
- existing system
- hot water unit
- PTR valve
- tempering valve
- compliance plate / label
- isolation valve
- copper piping
- insulation on pipes
- Return STRICT JSON only.
- Do not wrap in markdown.
- Use this exact shape:

{
"relevant": true,
"confidence": 85,
"detected": ["hot water heater", "copper pipe"],
"unclear": ["valve condition"],
"missing": ["insulation on pipes"],
"action": "inspect connections",
"analysis": "short summary"
}
`.trim(),
},
...images.map((img) => ({
type: "image_url",
image_url: {
url: `data:${img.mime};base64,${img.data}`,
},
})),
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
temperature: 0.2,
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
typeof parsed.action === "string" ? parsed.action : "inspect connections";
const analysis =
typeof parsed.analysis === "string" ? parsed.analysis : "";

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

const PORT = process.env.PORT || 8787;

app.listen(PORT, "0.0.0.0", () => {
console.log(`Elemetric AI server running on http://0.0.0.0:${PORT}`);
});
