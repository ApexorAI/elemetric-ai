const express = require("express");
const cors = require("cors");
require("dotenv").config();

const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (_req, res) => {
  res.send("Elemetric AI server running");
});

app.post("/review", async (req, res) => {
  try {
    const type = req.body?.type || "hotwater";
    const images = req.body?.images;

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "No images provided" });
    }

    const first = images[0];
    const base64 = first?.data || first?.base64;
    const mime = first?.mime || "image/jpeg";

    if (!base64) {
      return res.status(400).json({ error: "Image base64 missing" });
    }

    // STEP 1: Ask AI if this is even a plumbing photo
    const gateResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 120,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are strict. Decide if the photo is a plumbing installation photo. If unsure, say it is NOT relevant.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                'Reply ONLY as JSON like this: {"relevant": true/false, "reason": "short reason"}',
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mime};base64,${base64}`,
              },
            },
          ],
        },
      ],
    });

    const gateText = gateResponse.choices[0].message.content || "{}";
    let gate;
    try {
      gate = JSON.parse(gateText);
    } catch {
      gate = { relevant: false, reason: "Could not understand image" };
    }

    if (!gate.relevant) {
      return res.json({
        relevant: false,
        confidence: 5,
        detected: [],
        unclear: [],
        missing: [],
        action: "This does not look like a plumbing install photo. Take a clearer install photo.",
      });
    }

    // STEP 2: Ask AI for structured plumbing result
    const reviewResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a careful plumbing compliance assistant. Never guess. If you cannot clearly see something, put it in unclear.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Job type: ${type}. Look at this plumbing photo and reply ONLY as JSON with this exact shape:
{
  "relevant": true,
  "confidence": 0-100,
  "detected": ["short item", "short item"],
  "unclear": ["short item"],
  "missing": ["short item"],
  "action": "short action"
}

Rules:
- Only list things actually visible or likely missing.
- If not visible, put in unclear or missing.
- Keep each item short.
- Do not write extra words outside the JSON.`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mime};base64,${base64}`,
              },
            },
          ],
        },
      ],
    });

    const reviewText = reviewResponse.choices[0].message.content || "{}";

    let result;
    try {
      result = JSON.parse(reviewText);
    } catch {
      result = {
        relevant: true,
        confidence: 0,
        detected: [],
        unclear: [],
        missing: ["AI returned bad JSON"],
        action: "Try again with a clearer photo",
      };
    }

    return res.json({
      relevant: true,
      confidence: Number(result.confidence) || 0,
      detected: Array.isArray(result.detected) ? result.detected : [],
      unclear: Array.isArray(result.unclear) ? result.unclear : [],
      missing: Array.isArray(result.missing) ? result.missing : [],
      action: typeof result.action === "string" ? result.action : "",
    });
  } catch (err) {
    console.error("AI ERROR:", err);

    return res.status(500).json({
      error: "AI analysis failed",
      details: err.message,
    });
  }
});

app.listen(8787, "0.0.0.0", () => {
  console.log("Elemetric AI server running on port 8787");
});