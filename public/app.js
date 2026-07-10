const sourceSelect = document.querySelector("#sourceSelect");
const categoryButtons = [...document.querySelectorAll(".category-button")];
const searchInput = document.querySelector("#searchInput");
const refreshButton = document.querySelector("#refreshButton");
const newsList = document.querySelector("#newsList");
const briefingList = document.querySelector("#briefingList");
const sourceStrip = document.querySelector("#sourceStrip");
const headlineCount = document.querySelector("#headlineCount");
const lastUpdated = document.querySelector("#lastUpdated");
const activeFilter = document.querySelector("#activeFilter");

const AUTO_REFRESH_MS = 30 * 1000;
let feeds = [];
let searchTimer;
let activeCategory = "all";
let sourceStatusById = new Map();

function relativeTime(isoDate) {
  if (!isoDate) return "Recently";
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(isoDate));
}

function trimText(text, maxLength) {
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function escapeHtml(value = "") {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function renderSources(sources) {
  sources.forEach((source) => {
    sourceStatusById.set(source.id, source);
  });

  const activeSource = sourceSelect.value || "all";
  const visibleFeeds = feeds.filter((feed) => activeCategory === "all" || feed.category === activeCategory);
  const visibleSources = visibleFeeds.map((feed) => sourceStatusById.get(feed.id) || {
    ...feed,
    ok: true,
    count: null
  });
  const allCount = visibleSources.reduce((total, source) => total + (source.ok && Number.isFinite(source.count) ? source.count : 0), 0);
  const pills = [
    {
      id: "all",
      name: "All sources",
      ok: true,
      count: allCount || null
    },
    ...visibleSources
  ];

  sourceStrip.innerHTML = pills.map((source) => `
    <button class="source-pill ${activeSource === source.id ? "active" : ""}" type="button" data-source="${escapeHtml(source.id)}" title="${escapeHtml(source.error || `${source.count} stories`)}">
      <span class="dot ${source.ok ? "" : "offline"}" aria-hidden="true"></span>
      ${escapeHtml(source.name)}${source.ok ? (source.count == null ? "" : ` - ${source.count}`) : " - offline"}
    </button>
  `).join("");
}

function renderNews(items) {
  if (!items.length) {
    newsList.innerHTML = `<div class="empty">No matching stories found. Try another source or keyword.</div>`;
    briefingList.innerHTML = `<div class="briefing-item"><a>No briefing yet</a><span>Waiting for matching stories</span></div>`;
    return;
  }

  newsList.innerHTML = items.map((item) => `
    <article class="news-card ${item.image ? "" : "no-image"}">
      <div>
        <div class="meta">
          <span>${escapeHtml(item.source)}</span>
          <span>${escapeHtml(item.language)}</span>
          <span>${relativeTime(item.publishedAt)}</span>
        </div>
        <h3><a href="${item.link}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a></h3>
        <p>${escapeHtml(trimText(item.description, 220))}</p>
      </div>
      ${item.image ? `<img class="thumbnail" src="${item.image}" alt="">` : ""}
    </article>
  `).join("");

  briefingList.innerHTML = items.slice(0, 6).map((item) => `
    <div class="briefing-item">
      <a href="${item.link}" target="_blank" rel="noreferrer">${escapeHtml(trimText(item.title, 92))}</a>
      <span>${escapeHtml(item.source)} - ${relativeTime(item.publishedAt)}</span>
    </div>
  `).join("");
}

function updateFeedOptions() {
  const selected = sourceSelect.value || "all";
  sourceSelect.innerHTML = `
    <option value="all">All sources</option>
    ${feeds.map((feed) => `<option value="${feed.id}">${escapeHtml(feed.name)}</option>`).join("")}
  `;
  sourceSelect.value = selected;
}

async function loadNews(forceRefresh = false) {
  const source = sourceSelect.value || "all";
  const category = activeCategory;
  const q = searchInput.value.trim();
  const params = new URLSearchParams({ source, category, q });
  if (forceRefresh) params.set("refresh", "1");

  refreshButton.disabled = true;
  headlineCount.textContent = "Loading...";
  lastUpdated.textContent = "Fetching latest RSS stories";

  try {
    const response = await fetch(`/api/news?${params}`);
    if (!response.ok) throw new Error("News service failed");
    const data = await response.json();

    feeds = data.feeds;
    if (sourceSelect.options.length <= 1) updateFeedOptions();

    headlineCount.textContent = `${data.items.length} stories`;
    lastUpdated.textContent = `Updated ${new Intl.DateTimeFormat("en-IN", { timeStyle: "medium" }).format(new Date(data.generatedAt))}`;
    const sourceLabel = source === "all" ? "All sources" : feeds.find((feed) => feed.id === source)?.name || "Selected source";
    activeFilter.textContent = category === "all" ? sourceLabel : `${sourceLabel} / ${category}`;

    renderSources(data.sources);
    renderNews(data.items);
  } catch (error) {
    headlineCount.textContent = "Could not load";
    lastUpdated.textContent = error.message;
    newsList.innerHTML = `<div class="empty">The app could not reach the RSS feeds right now. Please refresh after a moment.</div>`;
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => loadNews(true));
sourceSelect.addEventListener("change", () => loadNews(true));
sourceStrip.addEventListener("click", (event) => {
  const button = event.target.closest(".source-pill[data-source]");
  if (!button) return;
  sourceSelect.value = button.dataset.source || "all";
  loadNews(true);
});
categoryButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeCategory = button.dataset.category || "all";
    categoryButtons.forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    sourceSelect.value = "all";
    loadNews(true);
  });
});
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadNews(true), 350);
});

loadNews();
setInterval(() => loadNews(false), AUTO_REFRESH_MS);
