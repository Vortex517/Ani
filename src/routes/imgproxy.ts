import { Router } from "express";

const router = Router();

router.get("/imgproxy", async (req, res) => {
  const url = String(req.query.url || "");
  if (!url) return res.status(400).send("url is required");

  try {
    const allowed = ["myanimelist.net", "cdn.myanimelist.net", "i.imgur.com"];
    const parsed = new URL(url);
    if (!allowed.some((h) => parsed.hostname.endsWith(h))) {
      return res.status(403).send("Domain not allowed");
    }

    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AniVortex/1.0)",
        "Referer": "https://myanimelist.net/",
        "Accept": "image/*,*/*",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!upstream.ok) return res.status(upstream.status).send("Image fetch failed");

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err: any) {
    res.status(500).send("Image proxy error");
  }
});

export default router;
