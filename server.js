import http from "node:http";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = process.env.USERS_FILE || path.join(DATA_DIR, "users.json");
const REWRITES_FILE = process.env.REWRITES_FILE || path.join(DATA_DIR, "rewrites.json");
const SESSION_COOKIE = "news_session";

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
const STORIES_PER_SOURCE = 25;
const AUTHOR_SOURCE_HOURLY_LIMIT = 5;
const HOUR_MS = 60 * 60 * 1000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const sessions = new Map();
let usersCache = null;
let rewritesCache = null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

async function loadUsers() {
  if (usersCache) return usersCache;

  try {
    usersCache = JSON.parse(await readFile(USERS_FILE, "utf8"));
  } catch {
    usersCache = {
      users: ADMIN_PASSWORD ? [
        {
          username: ADMIN_USER,
          role: "admin",
          passwordHash: hashPassword(ADMIN_PASSWORD),
          createdAt: new Date().toISOString()
        }
      ] : []
    };
    await saveUsers();
  }

  return usersCache;
}

async function saveUsers() {
  await mkdir(path.dirname(USERS_FILE), { recursive: true });
  await writeFile(USERS_FILE, JSON.stringify(usersCache, null, 2));
}

async function loadRewrites() {
  if (rewritesCache) return rewritesCache;

  try {
    rewritesCache = JSON.parse(await readFile(REWRITES_FILE, "utf8"));
  } catch {
    rewritesCache = { rewrites: [] };
    await saveRewrites();
  }

  return rewritesCache;
}

async function saveRewrites() {
  await mkdir(path.dirname(REWRITES_FILE), { recursive: true });
  await writeFile(REWRITES_FILE, JSON.stringify(rewritesCache, null, 2));
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .map((cookie) => {
      const index = cookie.indexOf("=");
      return [cookie.slice(0, index), decodeURIComponent(cookie.slice(index + 1))];
    }));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function portalKeyFromLink(link = "") {
  try {
    return new URL(link).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function addRewriteStatus(newsPayload, rewrites) {
  const rewritesByLink = new Map();
  for (const rewrite of rewrites) {
    const existing = rewritesByLink.get(rewrite.sourceLink);
    if (!existing || new Date(rewrite.updatedAt) > new Date(existing.updatedAt)) {
      rewritesByLink.set(rewrite.sourceLink, rewrite);
    }
  }

  return {
    ...newsPayload,
    items: newsPayload.items.map((item) => {
      const rewrite = rewritesByLink.get(item.link);
      if (!rewrite) return item;
      return {
        ...item,
        rewrittenBy: rewrite.createdBy,
        rewrittenAt: rewrite.updatedAt,
        rewrittenTitle: rewrite.title
      };
    })
  };
}

function redirect(res, location) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

async function getCurrentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;

  const store = await loadUsers();
  return store.users.find((user) => user.username === session.username) || null;
}

async function requireUser(req, res) {
  if (!ADMIN_PASSWORD) return { username: "local", role: "admin" };

  const user = await getCurrentUser(req);
  if (user) return user;

  if ((req.headers.accept || "").includes("application/json") || req.url.startsWith("/api/")) {
    res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "Login required" }));
    return null;
  }

  redirect(res, "/login");
  return null;
}

function renderLogin(error = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login - India Live News</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f2ec; color: #182027; font-family: system-ui, sans-serif; }
    form { width: min(380px, calc(100% - 32px)); display: grid; gap: 12px; padding: 22px; border: 1px solid #ded8ce; border-radius: 8px; background: #fffdf8; box-shadow: 0 16px 36px rgba(26,31,36,.08); }
    h1 { margin: 0 0 8px; font-size: 1.45rem; }
    label { display: grid; gap: 6px; font-weight: 700; color: #69737c; font-size: .86rem; }
    input, button { min-height: 40px; border-radius: 6px; font: inherit; }
    input { border: 1px solid #ded8ce; padding: 0 10px; }
    button { border: 0; background: #126f75; color: white; font-weight: 800; cursor: pointer; }
    .error { color: #a54817; font-weight: 700; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>India Live News Login</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <label>Username <input name="username" autocomplete="username" required></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Login</button>
  </form>
</body>
</html>`;
}

function renderAdmin(user, users, message = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin - India Live News</title>
  <style>
    body { margin: 0; background: #f5f2ec; color: #182027; font-family: system-ui, sans-serif; }
    main { width: min(920px, calc(100% - 32px)); margin: 28px auto; display: grid; gap: 18px; }
    section { border: 1px solid #ded8ce; border-radius: 8px; background: #fffdf8; padding: 16px; box-shadow: 0 16px 36px rgba(26,31,36,.08); }
    h1, h2 { margin: 0 0 12px; }
    form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; align-items: end; }
    label { display: grid; gap: 6px; color: #69737c; font-size: .84rem; font-weight: 800; }
    input, select, button { min-height: 38px; border-radius: 6px; font: inherit; }
    input, select { border: 1px solid #ded8ce; padding: 0 10px; background: white; }
    button { border: 0; background: #126f75; color: white; font-weight: 800; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #ded8ce; }
    nav { display: flex; gap: 10px; justify-content: space-between; align-items: center; }
    a { color: #126f75; font-weight: 800; }
    .message { color: #287044; font-weight: 800; }
    @media (max-width: 760px) { form { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <nav>
      <div>Logged in as <strong>${escapeHtml(user.username)}</strong></div>
      <div><a href="/">Dashboard</a> <a href="/logout">Logout</a></div>
    </nav>
    <section>
      <h1>Admin Users</h1>
      ${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}
      <form method="post" action="/admin/users">
        <label>Username <input name="username" required></label>
        <label>Password <input name="password" type="password" required></label>
        <label>Role
          <select name="role">
            <option value="agent">Agent</option>
            <option value="author">Author</option>
            <option value="freelancer">Freelancer</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button type="submit">Create login</button>
      </form>
    </section>
    <section>
      <h2>Existing logins</h2>
      <table>
        <thead><tr><th>Username</th><th>Role</th><th>Created</th></tr></thead>
        <tbody>
          ${users.map((item) => `<tr><td>${escapeHtml(item.username)}</td><td>${escapeHtml(item.role)}</td><td>${escapeHtml(item.createdAt || "")}</td></tr>`).join("")}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

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

function isArticleJunk(text = "") {
  if (/subscription benefits|premium stories|unlock these with subscription|the view from india|first day first show|today'?s cache|science for all|data point|thedge|health matters|the hindu on books|copyright|thg publishing|comments have to be|community guidelines|new commenting platform|vuukle/i.test(text)) {
    return true;
  }

  return /subscribe|advertisement|read more|follow us|sign in|download.*app|android hindi news apps|ios hindi news apps|stay updated with us|get all india news|अमर उजाला एप डाउनलोड करें|वीडियो विज्ञापन देखें|खबरें लगातार पढ़ने|वेबसाइट पर पढ़ना जारी/i.test(text);
}

function normalizeArticleText(value = "") {
  return stripHtml(value)
    .split(/\n{2,}|(?<=\.)\s+(?=[A-Z"“])/)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 45)
    .filter((text) => !isArticleJunk(text))
    .join("\n\n")
    .trim();
}

function collectJsonArticleBodies(value, bodies = []) {
  if (!value || typeof value !== "object") return bodies;

  if (typeof value.articleBody === "string") bodies.push(value.articleBody);
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonArticleBodies(item, bodies));
    return bodies;
  }

  Object.values(value).forEach((item) => collectJsonArticleBodies(item, bodies));
  return bodies;
}

function extractStructuredArticleText(html = "") {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    try {
      const json = JSON.parse(decodeEntities(script[1]).trim());
      const bodies = collectJsonArticleBodies(json);
      for (const body of bodies) {
        const text = normalizeArticleText(body);
        if (text.length > 400) return text;
      }
    } catch {
      // Ignore malformed structured data and continue with other extraction methods.
    }
  }

  const articleBodyMatch = html.match(/"articleBody"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (articleBodyMatch) {
    try {
      const text = normalizeArticleText(JSON.parse(`"${articleBodyMatch[1]}"`));
      if (text.length > 400) return text;
    } catch {
      const text = normalizeArticleText(articleBodyMatch[1]);
      if (text.length > 400) return text;
    }
  }

  return "";
}

function extractMetaArticleText(html = "") {
  const matches = [...html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:description|twitter:description|description)["'][^>]+content=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => normalizeArticleText(decodeEntities(match[1])))
    .filter((text) => text.length > 120 && !isArticleJunk(text));

  return matches[0] || "";
}

function extractArticleText(html = "") {
  const structuredText = extractStructuredArticleText(html);
  if (structuredText) return structuredText;

  const candidates = [];
  const articleMatch = html.match(/<article\b[\s\S]*?<\/article>/i);
  if (articleMatch) candidates.push(articleMatch[0]);

  const mainMatch = html.match(/<main\b[\s\S]*?<\/main>/i);
  if (mainMatch) candidates.push(mainMatch[0]);

  candidates.push(html);

  for (const candidate of candidates) {
    const paragraphs = [...candidate.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => stripHtml(match[1]))
      .filter((text) => text.length > 45)
      .filter((text) => !isArticleJunk(text));

    const uniqueParagraphs = [...new Set(paragraphs)].slice(0, 18);
    const text = uniqueParagraphs.join("\n\n").trim();
    if (text.length > 400 && !isArticleJunk(text)) return text;
  }

  return extractMetaArticleText(html);
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
    items: parseRss(xml, feed).slice(0, STORIES_PER_SOURCE),
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

  if (url.pathname === "/login" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderLogin());
    return;
  }

  if (url.pathname === "/login" && req.method === "POST") {
    const params = new URLSearchParams(await readBody(req));
    const username = (params.get("username") || "").trim();
    const password = params.get("password") || "";
    const store = await loadUsers();
    const user = store.users.find((item) => item.username === username);

    if (!user || !verifyPassword(password, user.passwordHash)) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderLogin("Invalid username or password"));
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { username: user.username, createdAt: Date.now() });
    res.writeHead(302, {
      location: "/",
      "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`,
      "cache-control": "no-store"
    });
    res.end();
    return;
  }

  if (url.pathname === "/logout") {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.writeHead(302, {
      location: "/login",
      "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      "cache-control": "no-store"
    });
    res.end();
    return;
  }

  const currentUser = await requireUser(req, res);
  if (!currentUser) {
    return;
  }

  if (url.pathname === "/admin" && req.method === "GET") {
    if (currentUser.role !== "admin") {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Admin access required");
      return;
    }

    const store = await loadUsers();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderAdmin(currentUser, store.users, url.searchParams.get("message") || ""));
    return;
  }

  if (url.pathname === "/admin/users" && req.method === "POST") {
    if (currentUser.role !== "admin") {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Admin access required");
      return;
    }

    const params = new URLSearchParams(await readBody(req));
    const username = (params.get("username") || "").trim();
    const password = params.get("password") || "";
    const role = params.get("role") || "agent";
    const allowedRoles = new Set(["admin", "agent", "author", "freelancer"]);

    if (!username || !password || !allowedRoles.has(role)) {
      redirect(res, "/admin?message=Missing or invalid user details");
      return;
    }

    const store = await loadUsers();
    const existing = store.users.find((item) => item.username === username);
    if (existing) {
      existing.role = role;
      existing.passwordHash = hashPassword(password);
    } else {
      store.users.push({
        username,
        role,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString()
      });
    }
    await saveUsers();
    redirect(res, `/admin?message=${encodeURIComponent(existing ? "Login updated" : "Login created")}`);
    return;
  }

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
      const rewriteStore = await loadRewrites();
      sendJson(res, 200, addRewriteStatus(payload, rewriteStore.rewrites));
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/article" && req.method === "GET") {
    const articleUrl = url.searchParams.get("url") || "";
    let parsedArticleUrl;

    try {
      parsedArticleUrl = new URL(articleUrl);
    } catch {
      sendJson(res, 400, { error: "Invalid article URL" });
      return;
    }

    if (!["http:", "https:"].includes(parsedArticleUrl.protocol)) {
      sendJson(res, 400, { error: "Invalid article URL" });
      return;
    }

    try {
      const response = await fetch(parsedArticleUrl, {
        headers: {
          "user-agent": "Mozilla/5.0 IndiaLiveNewsRewriteDesk/1.0",
          accept: "text/html,application/xhtml+xml"
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) throw new Error(`Article returned ${response.status}`);

      const html = await response.text();
      const text = extractArticleText(html);
      if (!text) {
        sendJson(res, 422, { error: "Full article text was not available from this source" });
        return;
      }

      sendJson(res, 200, { text: text.slice(0, 12000), sourceUrl: parsedArticleUrl.toString() });
    } catch (error) {
      sendJson(res, 502, { error: "Could not load full article from this source" });
    }
    return;
  }

  if (url.pathname === "/api/rewrites" && req.method === "GET") {
    const store = await loadRewrites();
    const items = [...store.rewrites].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    sendJson(res, 200, { rewrites: items.slice(0, 100) });
    return;
  }

  if (url.pathname === "/api/rewrites" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const title = String(body.title || "").trim();
      const bodyText = String(body.body || "").trim();
      const originalText = String(body.originalText || "").trim();
      const sourceTitle = String(body.sourceTitle || "").trim();
      const sourceLink = String(body.sourceLink || "").trim();
      const sourceName = String(body.sourceName || "").trim();
      const category = String(body.category || "").trim();
      const image = String(body.image || "").trim();

      if (!title || !bodyText || !sourceLink) {
        sendJson(res, 400, { error: "Title, body and source link are required" });
        return;
      }

      const store = await loadRewrites();
      const now = new Date().toISOString();
      const existing = store.rewrites.find((item) => item.sourceLink === sourceLink && item.createdBy === currentUser.username);
      const alreadyRewritten = store.rewrites.find((item) => item.sourceLink === sourceLink && item.createdBy !== currentUser.username);
      const sourcePortal = portalKeyFromLink(sourceLink);
      const sourceLabel = sourceName || sourcePortal;

      if (!existing && alreadyRewritten) {
        sendJson(res, 409, {
          error: `Already rewritten by ${alreadyRewritten.createdBy}. Please choose another story.`
        });
        return;
      }

      if (!existing && currentUser.role === "author") {
        const cutoff = Date.now() - HOUR_MS;
        const recentSourceCount = store.rewrites.filter((item) => (
          item.createdBy === currentUser.username
          && (item.sourcePortal || portalKeyFromLink(item.sourceLink) || item.sourceName || "") === sourcePortal
          && new Date(item.createdAt || item.updatedAt || 0).getTime() >= cutoff
        )).length;

        if (recentSourceCount >= AUTHOR_SOURCE_HOURLY_LIMIT) {
          sendJson(res, 429, {
            error: `Limit reached: this author can save only ${AUTHOR_SOURCE_HOURLY_LIMIT} stories from ${sourceLabel} in 1 hour`
          });
          return;
        }
      }

      const rewrite = {
        id: existing?.id || crypto.randomBytes(10).toString("hex"),
        title,
        body: bodyText,
        originalText,
        sourceTitle,
        sourceLink,
        sourceName,
        sourcePortal,
        category,
        image,
        createdBy: existing?.createdBy || currentUser.username,
        createdRole: existing?.createdRole || currentUser.role,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };

      if (existing) {
        Object.assign(existing, rewrite);
      } else {
        store.rewrites.push(rewrite);
      }

      await saveRewrites();
      sendJson(res, 200, { rewrite });
    } catch (error) {
      sendJson(res, 400, { error: "Could not save rewritten story" });
    }
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`India Live News Dashboard running at http://localhost:${PORT}`);
});
