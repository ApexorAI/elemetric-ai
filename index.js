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
You are an AI plumbing documentation reviewer.

Job type: ${type}

You are reviewing a SET of job photos for a plumbing installation.

VERY IMPORTANT LOGIC:
- Judge the FULL SET of images, not just one image.
- If most images are clearly relevant to plumbing or hot water installation work, set "relevant" to true.
- If one image is random, blurry, unrelated, or non-plumbing, DO NOT automatically set "relevant" to false.
- Only set "relevant" to false if the overall set is mostly unrelated to plumbing work.
- If at least some clear plumbing installation evidence is visible across the set, that strongly supports "relevant": true.

For hot water installs, look for things like:
- hot water unit / heater / tank
- existing system
- PTR valve
- tempering valve
- compliance plate / label
- isolation valve
- copper piping
- insulation on pipes
- plumbing connections
- drainage or discharge pipework

Your task:
1. Decide if the overall photo set is relevant plumbing documentation.
2. Estimate confidence from 0 to 100.
3. List clearly visible plumbing items across the set.
4. List unclear items that cannot be confidently verified.
5. List missing items that should still be documented.
6. Give one short recommended action.
7. Give one short analysis summary.

Rules:
- Be practical, short, and trade-focused.
- Do not be overly harsh.
- Base missing items on what is not yet clearly documented across the set.
- Return STRICT JSON only.
- Do not wrap in markdown.
- Use this exact shape:

{
"relevant": true,
"confidence": 85,
"detected": ["hot water heater", "copper pipe"],
"unclear": ["valve condition"],
"missing": ["insulation on pipes"],
"action": "capture compliance plate",
"analysis": "Most images show a relevant hot water installation with visible unit and copper piping. Some required documentation items are still not clearly shown."
}
`.trim();

const inputContent = [
{
type: "text",
text: promptText,
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