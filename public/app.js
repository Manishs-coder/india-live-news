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
const rewriteForm = document.querySelector("#rewriteForm");
const rewriteTitle = document.querySelector("#rewriteTitle");
const originalText = document.querySelector("#originalText");
const rewriteBody = document.querySelector("#rewriteBody");
const rewriteSource = document.querySelector("#rewriteSource");
const rewriteStatus = document.querySelector("#rewriteStatus");
const saveRewriteButton = document.querySelector("#saveRewriteButton");
const copyRewriteButton = document.querySelector("#copyRewriteButton");
const loadArticleButton = document.querySelector("#loadArticleButton");
const startRewriteButton = document.querySelector("#startRewriteButton");
const savedRewrites = document.querySelector("#savedRewrites");
const appPopup = document.querySelector("#appPopup");
const popupTitle = document.querySelector("#popupTitle");
const popupMessage = document.querySelector("#popupMessage");
const popupCloseButton = document.querySelector("#popupCloseButton");
const similarityScore = document.querySelector("#similarityScore");
const similarityMessage = document.querySelector("#similarityMessage");

const AUTO_REFRESH_MS = 30 * 1000;
let feeds = [];
let searchTimer;
let activeCategory = "all";
let sourceStatusById = new Map();
let latestItems = [];
let selectedStory = null;

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

function showPopup(title, message) {
  popupTitle.textContent = title;
  popupMessage.textContent = message;
  appPopup.hidden = false;
  popupCloseButton.focus();
}

function hidePopup() {
  appPopup.hidden = true;
}

function wordsFromText(text = "") {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function shingles(words, size = 4) {
  const output = new Set();
  for (let index = 0; index <= words.length - size; index += 1) {
    output.add(words.slice(index, index + size).join(" "));
  }
  return output;
}

function similarityPercent(original, rewritten) {
  const originalShingles = shingles(wordsFromText(original));
  const rewrittenShingles = shingles(wordsFromText(rewritten));
  if (!originalShingles.size || !rewrittenShingles.size) return 0;

  let overlap = 0;
  rewrittenShingles.forEach((item) => {
    if (originalShingles.has(item)) overlap += 1;
  });

  return Math.round((overlap / rewrittenShingles.size) * 100);
}

function updateSimilarity() {
  const percent = similarityPercent(originalText.value, rewriteBody.value);
  similarityScore.textContent = originalText.value.trim() && rewriteBody.value.trim()
    ? `Similarity: ${percent}%`
    : "Similarity: --";

  similarityScore.className = percent >= 45 ? "high" : percent >= 25 ? "medium" : "low";
  similarityMessage.textContent = !originalText.value.trim() || !rewriteBody.value.trim()
    ? "Add original and rewritten text to compare."
    : percent >= 45
      ? "Too close to source. Rewrite more before saving."
      : percent >= 25
        ? "Moderate match. Review wording before publishing."
        : "Looks different enough for a rewrite check.";

  return percent;
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
  latestItems = items;

  if (!items.length) {
    newsList.innerHTML = `<div class="empty">No matching stories found. Try another source or keyword.</div>`;
    briefingList.innerHTML = `<div class="briefing-item"><a>No briefing yet</a><span>Waiting for matching stories</span></div>`;
    return;
  }

  newsList.innerHTML = items.map((item) => {
    const alreadyRewritten = Boolean(item.rewrittenBy);
    return `
    <article class="news-card ${item.image ? "" : "no-image"}">
      <div>
        <div class="meta">
          <span>${escapeHtml(item.source)}</span>
          <span>${escapeHtml(item.language)}</span>
          <span>${relativeTime(item.publishedAt)}</span>
        </div>
        ${alreadyRewritten ? `
          <div class="rewrite-badge">Already rewritten by ${escapeHtml(item.rewrittenBy)}</div>
        ` : ""}
        <h3><a href="${item.link}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a></h3>
        <p>${escapeHtml(trimText(item.description, 220))}</p>
        <div class="story-actions">
          <button class="rewrite-button" type="button" data-story-id="${escapeHtml(item.id)}" ${alreadyRewritten ? "disabled" : ""}>
            ${alreadyRewritten ? "Already rewritten" : "Rewrite"}
          </button>
          <a href="${item.link}" target="_blank" rel="noreferrer">Source</a>
        </div>
      </div>
      ${item.image ? `<img class="thumbnail" src="${item.image}" alt="">` : ""}
    </article>
  `;
  }).join("");

  briefingList.innerHTML = items.slice(0, 6).map((item) => `
    <div class="briefing-item">
      <a href="${item.link}" target="_blank" rel="noreferrer">${escapeHtml(trimText(item.title, 92))}</a>
      <span>${escapeHtml(item.source)} - ${relativeTime(item.publishedAt)}</span>
    </div>
  `).join("");
}

function selectStoryForRewrite(item) {
  selectedStory = item;
  rewriteTitle.value = item.title;
  originalText.value = item.description;
  rewriteBody.value = "";
  rewriteSource.value = item.link;
  rewriteStatus.textContent = `${item.source} - ${item.category}`;
  updateSimilarity();
  rewriteTitle.focus();
}

function rewritePayload() {
  return {
    title: rewriteTitle.value.trim(),
    body: rewriteBody.value.trim(),
    originalText: originalText.value.trim(),
    sourceLink: selectedStory?.link || rewriteSource.value.trim(),
    sourceTitle: selectedStory?.title || "",
    sourceName: selectedStory?.source || "",
    category: selectedStory?.category || "",
    image: selectedStory?.image || ""
  };
}

function formattedRewrite(payload = rewritePayload()) {
  return `${payload.title}\n\n${payload.body}\n\nSource: ${payload.sourceName || "Original report"}\n${payload.sourceLink}`;
}

async function loadRewrites() {
  try {
    const response = await fetch("/api/rewrites");
    if (!response.ok) throw new Error("Could not load rewrites");
    const data = await response.json();

    if (!data.rewrites.length) {
      savedRewrites.innerHTML = `<div class="empty small">No saved rewrites yet.</div>`;
      return;
    }

    savedRewrites.innerHTML = `
      <h3>Saved rewrites</h3>
      ${data.rewrites.slice(0, 8).map((item) => `
        <article class="saved-rewrite">
          <strong>${escapeHtml(trimText(item.title, 86))}</strong>
          <span>${escapeHtml(item.createdBy)} - ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.updatedAt))}</span>
          <button type="button" data-copy-rewrite="${escapeHtml(item.id)}">Copy</button>
        </article>
      `).join("")}
    `;

    savedRewrites.querySelectorAll("[data-copy-rewrite]").forEach((button) => {
      button.addEventListener("click", async () => {
        const item = data.rewrites.find((rewrite) => rewrite.id === button.dataset.copyRewrite);
        if (!item) return;
        await navigator.clipboard.writeText(formattedRewrite({
          title: item.title,
          body: item.body,
          sourceName: item.sourceName,
          sourceLink: item.sourceLink
        }));
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy";
        }, 1200);
      });
    });
  } catch {
    savedRewrites.innerHTML = `<div class="empty small">Saved rewrites could not load.</div>`;
  }
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
newsList.addEventListener("click", (event) => {
  const button = event.target.closest(".rewrite-button[data-story-id]");
  if (!button) return;
  if (button.disabled) return;
  const item = latestItems.find((story) => story.id === button.dataset.storyId);
  if (item) selectStoryForRewrite(item);
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
rewriteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = rewritePayload();
  if (!payload.title || !payload.body || !payload.sourceLink) {
    rewriteStatus.textContent = "Select a story first";
    return;
  }

  const percent = updateSimilarity();
  if (payload.originalText && percent >= 45) {
    showPopup("Rewrite too close", "This rewrite is too similar to the source text. Please change wording and structure before saving.");
    return;
  }

  saveRewriteButton.disabled = true;
  rewriteStatus.textContent = "Saving...";

  try {
    const response = await fetch("/api/rewrites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Save failed");
    rewriteStatus.textContent = "Rewrite saved";
    await loadRewrites();
    await loadNews(false);
  } catch (error) {
    rewriteStatus.textContent = error.message;
    showPopup(error.message.includes("Limit reached") ? "Hourly limit reached" : "Could not save", error.message);
  } finally {
    saveRewriteButton.disabled = false;
  }
});
copyRewriteButton.addEventListener("click", async () => {
  const payload = rewritePayload();
  if (!payload.title || !payload.body || !payload.sourceLink) {
    rewriteStatus.textContent = "Nothing to copy";
    return;
  }
  await navigator.clipboard.writeText(formattedRewrite(payload));
  rewriteStatus.textContent = "Copied for website";
});
loadArticleButton.addEventListener("click", async () => {
  const sourceLink = selectedStory?.link || rewriteSource.value.trim();
  if (!sourceLink) {
    rewriteStatus.textContent = "Select a story first";
    return;
  }

  loadArticleButton.disabled = true;
  rewriteStatus.textContent = "Loading full article...";

  try {
    const response = await fetch(`/api/article?url=${encodeURIComponent(sourceLink)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Full article not available");

    originalText.value = data.text;
    updateSimilarity();
    rewriteStatus.textContent = "Full article loaded";
    rewriteBody.focus();
  } catch (error) {
    rewriteStatus.textContent = error.message;
    showPopup("Full article unavailable", `${error.message}. You can still rewrite using the RSS summary and source link.`);
  } finally {
    loadArticleButton.disabled = false;
  }
});
startRewriteButton.addEventListener("click", () => {
  if (!originalText.value.trim()) {
    showPopup("Original text needed", "Load full article or paste source text first, then write your rewrite below.");
    return;
  }

  rewriteStatus.textContent = "Write the rewritten story below";
  rewriteBody.focus();
});
originalText.addEventListener("input", updateSimilarity);
rewriteBody.addEventListener("input", updateSimilarity);

loadNews();
loadRewrites();
setInterval(() => loadNews(false), AUTO_REFRESH_MS);
popupCloseButton.addEventListener("click", hidePopup);
appPopup.addEventListener("click", (event) => {
  if (event.target === appPopup) hidePopup();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !appPopup.hidden) hidePopup();
});
