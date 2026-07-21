const express = require("express");
const router = express.Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Gemini's image-generation model. Google renames/rotates these fairly
// often, so this is kept overridable via an env var — if image generation
// ever starts returning 404, check https://ai.google.dev/gemini-api/docs/image-generation
// for the current model id and set GEMINI_IMAGE_MODEL in your Render env vars.
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const GEMINI_IMAGE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

const MAX_PROMPT_CHARS = 500;

router.post("/image", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").toString().trim();

    if (!prompt) {
      return res.status(400).json({ error: "Describe the image you want first." });
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ error: `Keep the description under ${MAX_PROMPT_CHARS} characters.` });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is not configured with an API key yet." });
    }

    const upstream = await fetch(`${GEMINI_IMAGE_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `Generate a clear, clean, study-friendly image: ${prompt}` }]
          }
        ],
        generationConfig: {
          responseModalities: ["IMAGE"]
        }
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!upstream.ok) {
      let detail = "";
      try { detail = (await upstream.json())?.error?.message || ""; } catch (_) { /* ignore */ }
      console.error("Gemini image request failed:", upstream.status, detail);

      if (upstream.status === 429) {
        return res.status(429).json({
          error: "The image AI is at its free-tier request limit for the next few seconds — please wait and try again."
        });
      }
      return res.status(502).json({ error: "Upstream image request failed" + (detail ? ": " + detail : "") });
    }

    const data = await upstream.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inline_data || p.inlineData);
    const inline = imagePart?.inline_data || imagePart?.inlineData;

    if (!inline?.data) {
      const finishReason = data?.candidates?.[0]?.finishReason;
      if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
        return res.status(502).json({ error: "That image request couldn't be generated — try describing it differently." });
      }
      return res.status(502).json({ error: "No image came back from the AI provider." });
    }

    const mimeType = inline.mime_type || inline.mimeType || "image/png";
    return res.json({ image: `data:${mimeType};base64,${inline.data}` });

  } catch (err) {
    console.error("Image route error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
