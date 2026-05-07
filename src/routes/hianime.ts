import { Router } from "express";
import { HiAnime } from "aniwatch";
import { logger } from "../lib/logger";

const router = Router();
const hianime = new HiAnime.Scraper();

const JIKAN_BASE = "https://api.jikan.moe/v4";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jikanFetch(path: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${JIKAN_BASE}${path}`, {
      headers: { "User-Agent": "AniVortex/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      // Jikan rate limit: wait before retry
      await sleep(1200 * (i + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Jikan API error: ${res.status}`);
    return res.json();
  }
  throw new Error("Jikan API rate limit exceeded after retries");
}

async function jikanFetchSeq(paths: string[]) {
  const results: any[] = [];
  for (const path of paths) {
    results.push(await jikanFetch(path));
    if (paths.length > 1) await sleep(400);
  }
  return results;
}


function jikanAnimeToCard(a: any, rank?: number) {
  return {
    id: a.mal_id?.toString() || a.id,
    name: a.title_english || a.title,
    poster: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || "",
    type: a.type || "TV",
    episodes: { sub: a.episodes || null, dub: null },
    rank: rank || a.rank,
    score: a.score,
  };
}

// ─── Home (cached) ───────────────────────────────────────────────────────────

let homeCache: { data: any; cachedAt: number } | null = null;
const HOME_TTL = 5 * 60 * 1000; // 5 minutes

router.get("/home", async (_req, res) => {
  if (homeCache && Date.now() - homeCache.cachedAt < HOME_TTL) {
    return res.json({ success: true, data: homeCache.data });
  }
  try {
    // Run first 2 in parallel, then second 2 with a small delay to avoid Jikan rate limits
    const [trending, airing] = await Promise.all([
      jikanFetch("/top/anime?filter=airing&limit=15"),
      jikanFetch("/seasons/now?limit=15"),
    ]);
    await sleep(350);
    const [upcoming, popular] = await Promise.all([
      jikanFetch("/seasons/upcoming?limit=10"),
      jikanFetch("/top/anime?filter=bypopularity&limit=10"),
    ]);

    const spotlightAnimes = (trending.data || []).slice(0, 5).map((a: any) => ({
      id: a.mal_id?.toString(),
      name: a.title_english || a.title,
      poster: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || "",
      description: a.synopsis || "",
      rank: a.rank,
      genres: (a.genres || []).map((g: any) => g.name),
      type: a.type,
      otherInfo: [a.type, a.status, a.aired?.string],
    }));

    const trendingAnimes = (trending.data || []).map((a: any, i: number) => jikanAnimeToCard(a, i + 1));
    const latestEpisodeAnimes = (airing.data || []).map((a: any) => jikanAnimeToCard(a));
    const topUpcomingAnimes = (upcoming.data || []).map((a: any) => jikanAnimeToCard(a));
    const topAiringAnimes = (airing.data || []).slice(0, 10).map((a: any) => jikanAnimeToCard(a));
    const mostPopularAnimes = (popular.data || []).map((a: any) => jikanAnimeToCard(a));

    const responseData = {
      spotlightAnimes,
      trendingAnimes,
      latestEpisodeAnimes,
      topUpcomingAnimes,
      topAiringAnimes,
      mostPopularAnimes,
      mostFavoriteAnimes: [],
      latestCompletedAnimes: [],
    };
    homeCache = { data: responseData, cachedAt: Date.now() };
    res.json({ success: true, data: responseData });
  } catch (err: any) {
    logger.error(err, "Error fetching home");
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Search ─────────────────────────────────────────────────────────────────

router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "");
    const page = Number(req.query.page) || 1;
    if (!q) return res.json({ success: true, data: { animes: [], totalPages: 0 } });

    const data = await jikanFetch(`/anime?q=${encodeURIComponent(q)}&page=${page}&limit=20&sfw=true`);
    const animes = (data.data || []).map((a: any) => jikanAnimeToCard(a));
    const totalPages = Math.ceil((data.pagination?.items?.total || 0) / 20);

    res.json({ success: true, data: { animes, totalPages, hasNextPage: data.pagination?.has_next_page } });
  } catch (err: any) {
    logger.error(err, "Search error");
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Anime Info ─────────────────────────────────────────────────────────────

router.get("/anime/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const [detail, recs] = await jikanFetchSeq([
      `/anime/${id}/full`,
      `/anime/${id}/recommendations`,
    ]);
    const chars = { data: [] };

    const a = detail.data;
    if (!a) return res.status(404).json({ success: false, message: "Anime not found" });

    const anime = {
      info: {
        id: a.mal_id?.toString(),
        name: a.title_english || a.title,
        poster: a.images?.jpg?.large_image_url || "",
        description: a.synopsis || "",
        stats: {
          rating: a.rating || "",
          quality: "HD",
          episodes: { sub: a.episodes || null, dub: null },
          type: a.type || "TV",
          duration: a.duration || "",
          score: a.score,
        },
      },
      moreInfo: {
        japanese: a.title_japanese || "",
        genres: (a.genres || []).map((g: any) => g.name),
        studios: (a.studios || []).map((s: any) => s.name),
        producers: (a.producers || []).map((p: any) => p.name),
        aired: a.aired?.string || "",
        status: a.status || "",
        premiered: `${a.season || ""} ${a.year || ""}`.trim(),
        duration: a.duration || "",
        mal_score: a.score,
        mal_scored_by: a.scored_by,
        rank: a.rank,
        popularity: a.popularity,
      },
    };

    const relatedAnimes = (a.relations || []).flatMap((r: any) =>
      (r.entry || []).filter((e: any) => e.type === "anime").map((e: any) => ({
        id: e.mal_id?.toString(),
        name: e.name,
        type: "Anime",
        relation: r.relation,
        poster: "",
      }))
    );

    const recommendedAnimes = (recs.data || []).slice(0, 12).map((r: any) => ({
      id: r.entry?.mal_id?.toString(),
      name: r.entry?.title,
      poster: r.entry?.images?.jpg?.large_image_url || "",
      type: "TV",
      episodes: { sub: null, dub: null },
    }));

    res.json({ success: true, data: { anime, relatedAnimes, recommendedAnimes, seasons: [] } });
  } catch (err: any) {
    logger.error(err, "Anime info error");
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Episodes ───────────────────────────────────────────────────────────────

router.get("/anime/:id/episodes", async (req, res) => {
  try {
    const id = req.params.id;
    // Fetch first page to get count, then fetch all pages
    const first = await jikanFetch(`/anime/${id}/episodes?page=1`);
    const total = first.pagination?.last_visible_page || 1;

    let episodes = [...(first.data || [])];
    if (total > 1) {
      const pages = await Promise.all(
        Array.from({ length: total - 1 }, (_, i) =>
          jikanFetch(`/anime/${id}/episodes?page=${i + 2}`).then((d) => d.data || [])
        )
      );
      episodes = episodes.concat(...pages);
    }

    const mapped = episodes.map((ep: any) => ({
      episodeId: `${id}-ep-${ep.mal_id}`,
      number: ep.mal_id,
      title: ep.title || ep.title_romanji || `Episode ${ep.mal_id}`,
      isFiller: ep.filler || false,
      isRecap: ep.recap || false,
      aired: ep.aired,
    }));

    res.json({ success: true, data: { totalEpisodes: mapped.length, episodes: mapped } });
  } catch (err: any) {
    logger.error(err, "Episodes error");
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Category ───────────────────────────────────────────────────────────────

const CATEGORY_MAP: Record<string, string> = {
  "top-airing": "/top/anime?filter=airing",
  "trending": "/top/anime?filter=airing",
  "most-popular": "/top/anime?filter=bypopularity",
  "most-favorite": "/top/anime?filter=favorite",
  "top-upcoming": "/seasons/upcoming",
  "subbed-anime": "/top/anime?filter=airing&type=tv",
  "dubbed-anime": "/top/anime?type=tv&rating=pg13",
  "latest-completed": "/top/anime?filter=complete",
};

router.get("/category/:category", async (req, res) => {
  try {
    const cat = req.params.category;
    const page = Number(req.query.page) || 1;
    const baseUrl = CATEGORY_MAP[cat];
    if (!baseUrl) return res.status(404).json({ success: false, message: "Category not found" });

    const separator = baseUrl.includes("?") ? "&" : "?";
    const data = await jikanFetch(`${baseUrl}${separator}page=${page}&limit=24`);
    const animes = (data.data || []).map((a: any, i: number) => jikanAnimeToCard(a, (page - 1) * 24 + i + 1));
    const totalPages = Math.ceil((data.pagination?.items?.total || 100) / 24);

    res.json({ success: true, data: { animes, totalPages, hasNextPage: data.pagination?.has_next_page } });
  } catch (err: any) {
    logger.error(err, "Category error");
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Genre ──────────────────────────────────────────────────────────────────

router.get("/genre/:genre", async (req, res) => {
  try {
    const genre = req.params.genre.replace(/-/g, " ");
    const page = Number(req.query.page) || 1;

    // Get genre list to find the ID
    const genres = await jikanFetch("/genres/anime");
    const genreEntry = (genres.data || []).find(
      (g: any) => g.name.toLowerCase() === genre.toLowerCase()
    );

    if (!genreEntry) {
      // Try fuzzy search
      const data = await jikanFetch(`/anime?genres=${genre}&page=${page}&limit=24`);
      const animes = (data.data || []).map((a: any) => jikanAnimeToCard(a));
      return res.json({ success: true, data: { animes, totalPages: 1 } });
    }

    const data = await jikanFetch(`/anime?genres=${genreEntry.mal_id}&page=${page}&limit=24&order_by=popularity`);
    const animes = (data.data || []).map((a: any) => jikanAnimeToCard(a));
    const totalPages = Math.ceil((data.pagination?.items?.total || 0) / 24);

    res.json({ success: true, data: { animes, totalPages, genreName: genreEntry.name } });
  } catch (err: any) {
    logger.error(err, "Genre error");
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Producer ───────────────────────────────────────────────────────────────

router.get("/producer/:producer", async (req, res) => {
  try {
    const producer = req.params.producer;
    const page = Number(req.query.page) || 1;
    const data = await jikanFetch(`/anime?producers=${producer}&page=${page}&limit=24`);
    const animes = (data.data || []).map((a: any) => jikanAnimeToCard(a));
    res.json({ success: true, data: { animes, totalPages: data.pagination?.last_visible_page || 1 } });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Schedule ───────────────────────────────────────────────────────────────

router.get("/schedule", async (req, res) => {
  try {
    const date = String(req.query.date || new Date().toISOString().split("T")[0]);
    const dayOfWeek = new Date(date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();

    const data = await jikanFetch(`/schedules?filter=${dayOfWeek}&limit=25`);
    const scheduledAnimes = (data.data || []).map((a: any) => ({
      id: a.mal_id?.toString(),
      name: a.title_english || a.title,
      poster: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || "",
      type: a.type,
      episodes: a.episodes,
      time: a.broadcast?.time || "",
      airingTimestamp: null,
      secondsUntilAiring: null,
    }));

    res.json({ success: true, data: { scheduledAnimes } });
  } catch (err: any) {
    logger.error(err, "Schedule error");
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Episode Sources (Streaming via TMDB embed services) ────────────────────

const ARM_API = "https://arm.haglund.dev/api/v2/ids";

// In-memory cache: malId → { tmdbId, type, cachedAt }
const tmdbIdCache = new Map<string, { tmdbId: string; type: "tv" | "movie"; cachedAt: number }>();

async function resolveTmdbId(malId: string): Promise<{ tmdbId: string; type: "tv" | "movie" }> {
  const cached = tmdbIdCache.get(malId);
  if (cached && Date.now() - cached.cachedAt < 24 * 60 * 60 * 1000) {
    return { tmdbId: cached.tmdbId, type: cached.type };
  }

  const res = await fetch(`${ARM_API}?source=myanimelist&id=${malId}`, {
    headers: { "User-Agent": "AniVortex/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ARM API error: ${res.status}`);
  const data = await res.json();
  const tmdbId = data?.themoviedb?.toString();
  if (!tmdbId) throw new Error(`No TMDB ID found for MAL ID ${malId}`);

  // Determine if movie or TV using Jikan type field
  let type: "tv" | "movie" = "tv";
  try {
    const jikanData = await jikanFetch(`/anime/${malId}`);
    const animeType = jikanData?.data?.type?.toLowerCase() || "";
    if (animeType === "movie" || animeType === "film") type = "movie";
  } catch (_) {}

  tmdbIdCache.set(malId, { tmdbId, type, cachedAt: Date.now() });
  return { tmdbId, type };
}

// Build embed URLs for each server
function buildEmbedUrls(tmdbId: string, type: "tv" | "movie", season: number, episode: number) {
  if (type === "movie") {
    return {
      "hd-1": `https://vidsrc.to/embed/movie/${tmdbId}`,
      "hd-2": `https://2embed.org/embed/movie?tmdb=${tmdbId}`,
      "megacloud": `https://autoembed.co/movie/tmdb/${tmdbId}`,
    };
  }
  return {
    "hd-1": `https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}`,
    "hd-2": `https://2embed.org/embed/tv?tmdb=${tmdbId}&s=${season}&e=${episode}`,
    "megacloud": `https://autoembed.co/tv/tmdb/${tmdbId}-${season}-${episode}`,
  };
}

router.get("/episode/sources", async (req, res) => {
  try {
    const episodeId = String(req.query.animeEpisodeId || "");
    const category = String(req.query.category || "sub");
    const serverParam = String(req.query.server || "hd-1");

    if (!episodeId) {
      return res.status(400).json({ success: false, message: "animeEpisodeId is required" });
    }

    // Parse episodeId: format is "{malId}-ep-{epNumber}"
    const match = episodeId.match(/^(\d+)-ep-(\d+)$/);
    if (!match) {
      return res.status(400).json({ success: false, message: "Invalid episode ID format" });
    }

    const malId = match[1];
    const epNumber = parseInt(match[2], 10);

    logger.info({ malId, epNumber, server: serverParam }, "Resolving episode via TMDB embed");

    // 1. Get TMDB ID via arm.haglund.dev
    const { tmdbId, type } = await resolveTmdbId(malId);
    logger.info({ tmdbId, type }, "Resolved TMDB ID");

    // 2. Build all embed URLs (season=1 works for most anime)
    const embedUrls = buildEmbedUrls(tmdbId, type, 1, epNumber);
    const primaryEmbed = (embedUrls as any)[serverParam] || embedUrls["megacloud"];

    res.json({
      success: true,
      data: {
        sources: [],
        tracks: [],
        intro: null,
        embedUrl: primaryEmbed,
        embedUrls,
        tmdbId,
        type,
        server: serverParam,
        category,
        malID: malId,
      },
    });
  } catch (err: any) {
    logger.error(err, "Episode sources error");
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
