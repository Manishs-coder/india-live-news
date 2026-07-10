import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const feeds = [
  {
    id: "the-hindu-national",
    name: "The Hindu - National",
    url: "https://www.thehindu.com/news/national/feeder/default.rss",
    language: "English",
    category: "India"
  },
  {
    id: "indian-express-india",
    name: "Indian Express - India",
    url: "https://indianexpress.com/section/india/feed/",
    language: "English",
    category: "India"
  },
  {
    id: "hindustan-times-india",
    name: "Hindustan Times - India",
    url: "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml",
    language: "English",
    category: "India"
  },
  {
    id: "ndtv-top",
    name: "NDTV - Top Stories",
    url: "https://feeds.feedburner.com/ndtvnews-top-stories",
    language: "English",
    category: "India"
  },
  {
    id: "toi-top",
    name: "Times of India - Top Stories",
    url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
    language: "English",
    category: "India"
  },
  {
    id: "bbc-hindi-india",
    name: "BBC Hindi - India",
    url: "https://feeds.bbci.co.uk/hindi/rss.xml",
    language: "Hindi",
    category: "India"
  },
  {
    id: "amar-ujala-india",
    name: "Amar Ujala - India",
    url: "https://www.amarujala.com/rss/india-news.xml",
    language: "Hindi",
    category: "India"
  },
  {
    id: "toi-entertainment",
    name: "Times of India - Entertainment",
    url: "https://timesofindia.indiatimes.com/rssfeeds/1081479906.cms",
    language: "English",
    category: "Bollywood"
  },
  {
    id: "bollywood-hungama-news",
    name: "Bollywood Hungama - News",
    url: "https://www.bollywoodhungama.com/rss/news.xml",
    language: "English",
    category: "Bollywood"
  }
];

const cache = new Map();
const CACHE_MS = 30 * 1000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function decodeEntities(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(value = "") {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeEntities(match[1]).trim() : "";
}

function getImage(itemXml) {
  const enclosure = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["']/i);
  if (enclosure) return decodeEntities(enclosure[1]);

  const media = itemXml.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);
  if (media) return decodeEntities(media[1]);

  const htmlImage = itemXml.match(/<img[^>]+src=["']([^"']+)["']/i);
  return htmlImage ? decodeEntities(htmlImage[1]) : "";
}

function parseRss(xml, feed) {
  const itemBlocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const entryBlocks = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  const blocks = itemBlocks.length ? itemBlocks : entryBlocks;

  return blocks.map((itemXml, index) => {
    const title = stripHtml(getTag(itemXml, "title"));
    const link = decodeEntities(getTag(itemXml, "link")) || decodeEntities(itemXml.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || "");
    const description = stripHtml(getTag(itemXml, "description") || getTag(itemXml, "summary") || getTag(itemXml, "content:encoded"));
    const publishedRaw = getTag(itemXml, "pubDate") || getTag(itemXml, "published") || getTag(itemXml, "updated");
    const publishedAt = publishedRaw ? new Date(publishedRaw).toISOString() : "";

    return {
      id: `${feed.id}-${index}-${title.slice(0, 24)}`,
      title,
      link,
      description,
      publishedAt,
      source: feed.name,
      sourceId: feed.id,
      language: feed.language,
      category: feed.category,
      image: getImage(itemXml)
    };
  }).filter((item) => item.title && item.link);
}

async function fetchFeed(feed, forceRefresh = false) {
  const cached = cache.get(feed.id);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached;
  }

  const response = await fetch(feed.url, {
    headers: {
      "user-agent": "IndiaLiveNewsDashboard/1.0 (+local app)",
      accept: "application/rss+xml, application/xml, text/xml, */*"
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`${feed.name} returned ${response.status}`);
  }

  const xml = await response.text();
  const result = {
    feed,
    fetchedAt: Date.now(),
    items: parseRss(xml, feed).slice(0, 25),
    error: null
  };
  cache.set(feed.id, result);
  return result;
}

function allSources() {
  return feeds;
}

async function getNews(url) {
  const selectedSource = url.searchParams.get("source") || "all";
  const selectedCategory = url.searchParams.get("category") || "all";
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const sources = allSources();
  const selectedSources = sources.filter((source) => {
    const matchesSource = selectedSource === "all" || source.id === selectedSource;
    const matchesCategory = selectedCategory === "all" || source.category === selectedCategory;
    return matchesSource && matchesCategory;
  });

  const settled = await Promise.allSettled(selectedSources.map((source) => fetchFeed(source, forceRefresh)));
  const sourceStatuses = settled.map((entry, index) => {
    const feed = selectedSources[index];
    if (entry.status === "fulfilled") {
      return {
        id: feed.id,
        name: feed.name,
        language: feed.language,
        category: feed.category,
        ok: true,
        count: entry.value.items.length,
        fetchedAt: new Date(entry.value.fetchedAt).toISOString()
      };
    }
    return {
      id: feed.id,
      name: feed.name,
      language: feed.language,
      category: feed.category,
      ok: false,
      count: 0,
      error: entry.reason.message
    };
  });

  let items = settled
    .filter((entry) => entry.status === "fulfilled")
    .flatMap((entry) => entry.value.items);

  if (query) {
    items = items.filter((item) => `${item.title} ${item.description} ${item.source}`.toLowerCase().includes(query));
  }

  items.sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bTime - aTime;
  });

  return {
    generatedAt: new Date().toISOString(),
    feeds: sources,
    categories: ["all", "India", "Bollywood"],
    sources: sourceStatuses,
    items: items.slice(0, 80)
  };
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/public/index.html" : `/public${pathname}`;
  const filePath = path.join(__dirname, safePath);

  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/feeds") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify({ feeds: allSources(), categories: ["all", "India", "Bollywood"] }));
    return;
  }

  if (url.pathname === "/api/news") {
    try {
      const payload = await getNews(url);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`India Live News Dashboard running at http://localhost:${PORT}`);
});
