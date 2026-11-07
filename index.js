const API = "https://api.pocketcasts.com";
const PODCAST_API = "https://podcast-api.pocketcasts.com";
const LISTS = "https://lists.pocketcasts.com";
const WEB = "https://pocketcasts.com";
const IMAGE = "https://static.pocketcasts.com/discover/images/webp/480";
const GRAVATAR = "https://www.gravatar.com/avatar";
const PAGE_SIZE = 30;
const REQUEST_TIMEOUT = 20000;

const t = (text) => host.t(text);
const episodeCache = new Map();
const searchCache = new Map();
const notesCache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let popularCache = null;
let trendingCache = null;
let refreshPromise = null;
let profilePromise = null;
let ffmpegPath;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readAuth() {
  const auth = host.storage.get("auth");
  return auth && typeof auth === "object" ? auth : null;
}

function writeAuth(auth) {
  host.storage.set("auth", { ...readAuth(), ...auth });
}

function tokenNeedsRefresh(auth) {
  const seconds = Number(auth.expiresIn);
  return (
    Number.isFinite(seconds) &&
    seconds > 0 &&
    Number(auth.obtainedAt) > 0 &&
    Date.now() >= Number(auth.obtainedAt) + seconds * 1000 - 60000
  );
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    let value = part.slice(at + 1).trim();
    for (let i = 0; i < 2; i++) {
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch {
        break;
      }
    }
    return value.startsWith("j:") ? value.slice(2) : value;
  }
  return "";
}

function authFromCookie(header) {
  const value = cookieValue(header, "auth");
  if (!value) throw fail("signIn", t("Pocket Casts did not finish signing in"));
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw fail("signIn", t("Pocket Casts returned an invalid session"));
  }
  const accessToken = parsed.accessToken || parsed.token || "";
  if (!accessToken) throw fail("signIn", t("Pocket Casts returned no access token"));
  return {
    accessToken,
    refreshToken: parsed.refreshToken || "",
    expiresIn: Number(parsed.expiresIn) || 0,
    tokenType: parsed.tokenType || "Bearer",
  };
}

function accountOf(auth) {
  const id =
    auth.accountId ||
    host.crypto.md5(String(auth.accessToken || auth.refreshToken || "")).slice(0, 16);
  if (!auth.accountId) writeAuth({ accountId: id });
  const email = String(auth.email || "").trim();
  return {
    id,
    name: email || t("Pocket Casts account"),
    imageUrl: email ? gravatarURL(email) : "",
  };
}

// Pocket Casts shows the listener's Gravatar, by the hash of their email.
function gravatarURL(email) {
  const address = String(email || "").trim().toLowerCase();
  if (!address) return "";
  return `${GRAVATAR}/${host.crypto.md5(address)}?d=404&s=400`;
}

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "X-App-Language": host.language() === "zh-CN" ? "zh" : "en",
    "X-User-Region": "global",
  };
}

async function request(url, { method = "GET", body, headers = {}, token = "" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const options = {
      method,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    return await fetch(url, options);
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(t("Pocket Casts request timed out"));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function responseJSON(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { errorMessage: text };
  }
}

function statusError(response, data) {
  const detail =
    data?.errorMessage ||
    data?.message ||
    data?.error ||
    response.statusText ||
    `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    return fail("signIn", t("Pocket Casts session expired. Sign in again."));
  }
  if (response.status === 402) {
    return fail("unavailable", t("This needs a Pocket Casts subscription."));
  }
  if (response.status === 404) {
    return fail("unavailable", t("Pocket Casts could not find that item."));
  }
  if (response.status === 429) {
    return new Error(t("Pocket Casts is limiting requests. Try again shortly."));
  }
  return new Error(`${t("Pocket Casts request failed")}: ${detail}`);
}

async function refreshToken(auth) {
  if (!auth?.refreshToken) {
    host.storage.remove("auth");
    throw fail("signIn", t("Pocket Casts session expired. Sign in again."));
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const response = await request(`${API}/user/token`, {
      method: "POST",
      headers: apiHeaders(),
      body: {
        grantType: "refresh_token",
        refreshToken: auth.refreshToken,
      },
    });
    const data = await responseJSON(response);
    if (!response.ok || !data?.accessToken) {
      if (response.status === 400 || response.status === 401) {
        host.storage.remove("auth");
      }
      throw statusError(response, data);
    }
    const patch = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || auth.refreshToken,
      expiresIn: Number(data.expiresIn) || 0,
      tokenType: data.tokenType || auth.tokenType || "Bearer",
      obtainedAt: Date.now(),
    };
    if (data.uuid) patch.accountId = data.uuid;
    if (data.email) patch.email = data.email;
    writeAuth(patch);
    return data.accessToken;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

// The cookie a web sign-in answers holds the tokens and nothing of who they
// are: no name, no email, no picture. Refreshing the token is the one request
// that says, so it is made once after signing in, and the answer kept.
async function resolveProfile(auth) {
  if (!auth || auth.email || !auth.refreshToken) return auth;
  if (profilePromise) return profilePromise;
  const tried = Number(auth.profileTriedAt) || 0;
  if (tried && Date.now() - tried < 10 * 60 * 1000) return auth;
  profilePromise = (async () => {
    writeAuth({ profileTriedAt: Date.now() });
    try {
      await refreshToken(auth);
    } catch {
      return readAuth() || auth;
    }
    return readAuth() || auth;
  })().finally(() => {
    profilePromise = null;
  });
  return profilePromise;
}

async function accessToken() {
  const auth = readAuth();
  if (!auth?.accessToken) {
    throw fail("signIn", t("Sign in to Pocket Casts first"));
  }
  if (!tokenNeedsRefresh(auth)) return auth.accessToken;
  return refreshToken(auth);
}

async function authedJSON(path, body = {}) {
  let token = await accessToken();
  let response = await request(`${API}${path}`, {
    method: "POST",
    headers: apiHeaders(),
    body,
    token,
  });
  if (response.status === 401) {
    const auth = readAuth();
    if (auth?.refreshToken) {
      token = await refreshToken(auth);
      response = await request(`${API}${path}`, {
        method: "POST",
        headers: apiHeaders(),
        body,
        token,
      });
    }
  }
  const data = await responseJSON(response);
  if (!response.ok) throw statusError(response, data);
  return data;
}

async function publicJSON(url, body) {
  const response = await request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: apiHeaders(),
    body,
  });
  const data = await responseJSON(response);
  if (!response.ok) throw statusError(response, data);
  return data;
}

function imageURL(uuid) {
  return uuid ? `${IMAGE}/${encodeURIComponent(uuid)}.webp` : "";
}

function publishedDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function durationMs(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : 0;
}

function pageOf(items, offset) {
  const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const page = items.slice(start, start + PAGE_SIZE);
  return { page, more: start + page.length < items.length };
}

function podcastOf(item) {
  if (item?.podcast && typeof item.podcast === "object") return item.podcast;
  return item || {};
}

function showFromPodcast(item, extra = {}) {
  const podcast = podcastOf(item);
  const id = String(podcast.uuid || podcast.id || extra.uuid || "");
  if (!id) return null;
  return {
    id,
    name: String(podcast.title || podcast.name || extra.title || id),
    imageUrl:
      podcast.image ||
      podcast.imageUrl ||
      podcast.image_url ||
      podcast.thumbnail ||
      imageURL(id),
    description: String(
      podcast.description || podcast.short_description || podcast.shortDescription || "",
    ),
    publisher: String(podcast.author || podcast.publisher || ""),
    episodeCount: Number(
      extra.episodeCount ||
        podcast.episode_count ||
        podcast.episodeCount ||
        (Array.isArray(podcast.episodes) ? podcast.episodes.length : 0) ||
        0,
    ),
    subscribed: Boolean(extra.subscribed ?? podcast.subscribed),
  };
}

function episodeMeta(episode) {
  const ep = episode?.episode && typeof episode.episode === "object" ? episode.episode : episode;
  const podcast =
    ep?.podcast && typeof ep.podcast === "object" ? ep.podcast : {};
  const id = String(ep.uuid || ep.id || "");
  if (!id) return null;
  const previous = episodeCache.get(id) || {};
  const podcastUuid = String(
    ep.podcast_uuid ||
      ep.podcastUuid ||
      (typeof ep.podcast === "string" ? ep.podcast : "") ||
      podcast.uuid ||
      podcast.id ||
      previous.podcastUuid ||
      "",
  );
  const podcastTitle = String(
    podcast.title || ep.podcast_title || ep.podcastTitle || previous.podcastTitle || "",
  );
  const podcastAuthor = String(
    podcast.author ||
      ep.podcast_author ||
      ep.podcastAuthor ||
      previous.podcastAuthor ||
      podcastTitle,
  );
  const podcastSlug = String(
    podcast.slug || ep.podcast_slug || ep.podcastSlug || previous.podcastSlug || "",
  );
  const episodeSlug = String(ep.slug || previous.episodeSlug || "");
  const url = String(ep.url || ep.audio_url || ep.audioUrl || previous.url || "");
  const fileType = String(ep.file_type || ep.fileType || previous.fileType || "");
  const fileSize = Number(ep.file_size || ep.fileSize || previous.fileSize || 0) || 0;
  const video = Boolean(
    ep.is_video || ep.isVideo || previous.video || /^video\//i.test(fileType),
  );
  const page =
    podcastSlug && episodeSlug
      ? `https://pocketcasts.com/podcast/${podcastSlug}/${episodeSlug}`
      : "";
  const meta = {
    id,
    podcastUuid,
    podcastTitle,
    podcastAuthor,
    podcastSlug,
    episodeSlug,
    url,
    fileType,
    fileSize,
    video,
  };
  episodeCache.set(id, meta);
  return {
    ...meta,
    track: {
      id,
      name: String(ep.title || t("Untitled episode")),
      artists: podcastAuthor
        ? [{ id: podcastUuid || podcastTitle, name: podcastAuthor }]
        : [],
      album: {
        id: podcastUuid || podcastTitle,
        name: podcastTitle,
        imageUrl: podcastUuid ? imageURL(podcastUuid) : "",
      },
      duration: durationMs(ep.duration),
      url: page,
      showId: podcastUuid,
      description: String(ep.description || ""),
      published: publishedDate(ep.published || ep.published_at || ep.publishedAt),
      unavailable: video,
    },
  };
}

function episodesToTracks(items) {
  const tracks = [];
  for (const item of items || []) {
    const mapped = episodeMeta(item);
    if (mapped) tracks.push(mapped.track);
  }
  return tracks;
}

// Show notes come as HTML, and are most of what an episode says it's about:
// who's on it, what's in it, what it links to. The lists the app draws have
// no room for it, so they're fetched per episode, a page at a time, and kept.
const NOTES_TTL = 12 * 60 * 60 * 1000;
const NOTES_FAILED_TTL = 60 * 1000;
const NOTES_MAX = 500;

function decodeEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    middot: "·",
    bull: "•",
  };
  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    const key = body.toLowerCase();
    return key in named ? named[key] : whole;
  });
}

function htmlToText(html) {
  let text = String(html || "");
  if (!text) return "";
  text = text.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ");
  text = text.replace(/<\s*br\s*\/?>/gi, "\n");
  text = text.replace(/<\s*li[^>]*>/gi, "• ");
  text = text.replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr|blockquote|section)\s*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function showNotes(id) {
  const hit = notesCache.get(id);
  if (hit) {
    const ttl = hit.ok ? NOTES_TTL : NOTES_FAILED_TTL;
    if (Date.now() - hit.at < ttl) return hit.text;
  }
  try {
    const data = await publicJSON(`${PODCAST_API}/episode/show_notes/${encodeURIComponent(id)}`);
    const text = htmlToText(data?.show_notes || "");
    notesCache.set(id, { at: Date.now(), text, ok: true });
    if (notesCache.size > NOTES_MAX) {
      notesCache.delete(notesCache.keys().next().value);
    }
    return text;
  } catch {
    notesCache.set(id, { at: Date.now(), text: "", ok: false });
    return "";
  }
}

// fillNotes gives each track of a page its show notes, a few at a time: what
// a listener opens an episode to read, and the page would be slow without.
async function fillNotes(tracks) {
  const todo = (tracks || []).filter((track) => track && !track.description);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const track = todo[next++];
      const text = await showNotes(track.id);
      if (text) track.description = text;
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker));
  return tracks;
}

async function popularShows() {
  if (popularCache && Date.now() - popularCache.at < 10 * 60 * 1000) {
    return popularCache.shows;
  }
  const data = await publicJSON(`${LISTS}/popular.json`);
  const shows = (data?.podcasts || []).map((item) => showFromPodcast(item)).filter(Boolean);
  popularCache = { at: Date.now(), shows };
  return shows;
}

async function trendingShows() {
  if (trendingCache && Date.now() - trendingCache.at < 30 * 60 * 1000) {
    return trendingCache.shows;
  }
  const data = await publicJSON(`${LISTS}/trending.json`);
  const shows = (data?.podcasts || []).map((item) => showFromPodcast(item)).filter(Boolean);
  trendingCache = { at: Date.now(), shows };
  return shows;
}

async function combinedSearch(term) {
  const key = String(term || "").trim().toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < 2 * 60 * 1000) return cached.results;
  if (!key) return [];
  const data = await publicJSON(`${PODCAST_API}/v2/search/combined`, { term });
  const results = Array.isArray(data?.results) ? data.results : [];
  searchCache.set(key, { at: Date.now(), results });
  return results;
}

async function listEpisodes(path) {
  const data = await authedJSON(path, {});
  return fillNotes(episodesToTracks(data?.episodes || data?.results || []));
}

async function episodeFor(id) {
  const cached = episodeCache.get(id);
  if (cached?.url) return cached;
  const data = await authedJSON("/user/episode", { uuid: id });
  const mapped = episodeMeta(data?.episode || data);
  if (!mapped) throw fail("unavailable", t("Pocket Casts could not find that episode"));
  return episodeCache.get(id);
}

function streamType(meta) {
  const type = String(meta.fileType || "").toLowerCase();
  const url = String(meta.url || "").toLowerCase();
  if (/^video\//.test(type) || /\.(mp4|mov|webm)(\?|$)/.test(url)) {
    throw fail("unavailable", t("Video episodes are not supported here"));
  }
  if (type.includes("mpeg") || type.includes("mp3") || /\.mp3(\?|$)/.test(url)) return "mp3";
  if (type.includes("flac") || /\.flac(\?|$)/.test(url)) return "flac";
  if (type.includes("ogg") || /\.ogg(\?|$)/.test(url)) return "ogg";
  if (type.includes("wav") || /\.wav(\?|$)/.test(url)) return "wav";
  if (type.includes("aac") && !type.includes("mp4")) return "aac";
  if (type.includes("mp4") || type.includes("m4a") || /\.m4a(\?|$)/.test(url)) return "m4a";
  return "mp3";
}

export async function signIn() {
  let header;
  try {
    const result = await host.webSignIn({
      url: `${WEB}/user/login?redirect=%2Fplay`,
      cookiesOf: WEB,
      until: ["auth"],
    });
    header = typeof result === "string" ? result : result?.cookie;
  } catch (error) {
    throw fail("signIn", error instanceof Error ? error.message : String(error));
  }
  const auth = authFromCookie(header);
  auth.accountId = host.crypto.md5(auth.accessToken).slice(0, 16);
  auth.obtainedAt = Date.now();
  writeAuth(auth);
  const profile = await resolveProfile(readAuth());
  return accountOf(profile);
}

export function signOut() {
  host.storage.remove("auth");
}

export async function account() {
  let auth = readAuth();
  if (!auth?.accessToken) return null;
  if (!auth.email) {
    try {
      auth = await resolveProfile(auth);
    } catch {
      auth = readAuth() || auth;
    }
  }
  if (!auth?.accessToken) return null;
  return accountOf(auth);
}

export async function home() {
  const sections = [];
  const auth = readAuth();
  if (auth?.accessToken) {
    const [newReleases, inProgress] = await Promise.all([
      listEpisodes("/user/new_releases").catch(() => []),
      listEpisodes("/user/in_progress").catch(() => []),
    ]);
    if (newReleases.length) {
      sections.push({
        title: t("New releases"),
        tracks: newReleases,
        morePage: "new-releases",
        pageTitle: t("New releases"),
      });
    }
    if (inProgress.length) {
      sections.push({
        title: t("In progress"),
        tracks: inProgress.slice(0, 12),
        morePage: "in-progress",
        pageTitle: t("In progress"),
      });
    }
  }
  try {
    const shows = await popularShows();
    sections.push({
      title: t("Popular podcasts"),
      shows: shows.slice(0, 12),
      morePage: "popular",
    });
  } catch {
    sections.push({
      title: t("Popular podcasts"),
      empty: t("Could not load popular podcasts"),
    });
  }
  try {
    const shows = await trendingShows();
    sections.push({
      title: t("Trending podcasts"),
      shows: shows.slice(0, 12),
      morePage: "trending",
    });
  } catch {
    sections.push({
      title: t("Trending podcasts"),
      empty: t("Could not load trending podcasts"),
    });
  }
  return { sections };
}

export async function browse({ page }) {
  if (page === "popular") {
    const shows = await popularShows();
    return {
      title: t("Popular podcasts"),
      sections: [{ title: t("Top podcasts"), shows }],
    };
  }
  if (page === "trending") {
    const shows = await trendingShows();
    return {
      title: t("Trending podcasts"),
      sections: [{ title: t("Trending podcasts"), shows }],
    };
  }
  if (page === "new-releases") {
    return {
      title: t("New releases"),
      sections: [{ title: t("Latest episodes"), tracks: await listEpisodes("/user/new_releases") }],
    };
  }
  if (page === "in-progress") {
    return {
      title: t("In progress"),
      sections: [{ title: t("Unfinished episodes"), tracks: await listEpisodes("/user/in_progress") }],
    };
  }
  if (page === "history") {
    return {
      title: t("History"),
      sections: [{ title: t("Recently played"), tracks: await listEpisodes("/user/history") }],
    };
  }
  throw fail("unavailable", t("No such page"));
}

export async function search({ query, kind, offset }) {
  const term = String(query || "").trim();
  if (kind === "shows") {
    const shows = term
      ? (await combinedSearch(term))
          .filter((item) => item?.type === "podcast")
          .map((item) => showFromPodcast(item))
          .filter(Boolean)
      : await popularShows();
    const result = pageOf(shows, offset);
    return { shows: result.page, more: result.more };
  }
  if (kind === "tracks") {
    const episodes = (await combinedSearch(term))
      .filter((item) => item?.type === "episode")
      .map((item) => episodeMeta(item)?.track)
      .filter(Boolean);
    const result = pageOf(episodes, offset);
    await fillNotes(result.page);
    return { tracks: result.page, more: result.more };
  }
  return { [kind]: [], more: false };
}

export async function suggest({ query }) {
  const term = String(query || "").trim();
  if (!term) return [];
  try {
    const results = await combinedSearch(term);
    const names = results
      .filter((item) => item?.type === "podcast" || item?.type === "episode")
      .map((item) => String(item.title || ""))
      .filter(Boolean);
    return [...new Set(names)].slice(0, 8);
  } catch {
    return [];
  }
}

export async function shows() {
  const data = await authedJSON("/user/podcast/list", { v: 1 });
  const raw = Array.isArray(data?.podcasts) ? data.podcasts : [];
  const ids = new Set();
  const out = [];
  for (const item of raw) {
    const show = showFromPodcast(item, { subscribed: true });
    if (!show) continue;
    ids.add(show.id);
    out.push(show);
  }
  host.storage.set("subscribedIds", [...ids]);
  return out;
}

export async function show({ id, offset }) {
  const data = await publicJSON(`${PODCAST_API}/podcast/full/${encodeURIComponent(id)}`);
  const podcast = podcastOf(data);
  const raw = Array.isArray(podcast.episodes) ? podcast.episodes : [];
  const subscribed = new Set(host.storage.get("subscribedIds") || []).has(id);
  const item = showFromPodcast(podcast, {
    episodeCount: data?.episode_count,
    subscribed,
  });
  if (!item) throw fail("unavailable", t("Pocket Casts could not find that podcast"));
  const tracks = episodesToTracks(
    raw.map((episode) => ({
      ...episode,
      podcast_uuid: episode.podcast_uuid || id,
      podcast_title: episode.podcast_title || podcast.title,
      podcast_author: episode.podcast_author || podcast.author,
    })),
  );
  const result = pageOf(tracks, offset);
  await fillNotes(result.page);
  return { show: item, episodes: result.page, more: result.more };
}

export async function subscribeShow({ id, on }) {
  await authedJSON(on ? "/user/podcast/subscribe" : "/user/podcast/unsubscribe", {
    uuid: id,
  });
  const ids = new Set(host.storage.get("subscribedIds") || []);
  if (on) ids.add(id);
  else ids.delete(id);
  host.storage.set("subscribedIds", [...ids]);
}

export async function recent() {
  if (!readAuth()?.accessToken) return [];
  return listEpisodes("/user/history");
}

export async function liked({ offset }) {
  if (!readAuth()?.accessToken) return { tracks: [], more: false };
  const tracks = await listEpisodes("/user/starred");
  const result = pageOf(tracks, offset);
  return { tracks: result.page, more: result.more };
}

export async function likeEpisode({ id, on }) {
  const meta = await episodeFor(id);
  await authedJSON("/sync/update_episode_star", {
    uuid: id,
    podcast: meta.podcastUuid,
    star: Boolean(on),
  });
}

// ---------------------------------------------------------------------------
// Playing: the app decodes AAC-LC itself, and no HE-AAC, which many podcasts
// use for speech. Those go to ffmpeg, which decodes them to MP3 on this
// machine as they play, and serves that to the app.

function ffmpegHint() {
  switch (host.platform) {
    case "darwin":
      return t("Install ffmpeg with Homebrew (brew install ffmpeg), then play again.");
    case "windows":
      return t("Install ffmpeg (in a terminal: winget install Gyan.FFmpeg), then restart MyGo Music.");
    default:
      return t("Install ffmpeg with your package manager (such as sudo apt install ffmpeg), then play again.");
  }
}

// An ffmpeg that's there, by the name the process permission gives, or "" for
// one that isn't: no ffmpeg only costs the episodes the app can't decode.
async function ffmpegBinary() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  for (const path of ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    let proc;
    try {
      proc = host.spawn(path, ["-version"]);
    } catch {
      continue;
    }
    proc.closeStdin();
    while ((await proc.readLine()) !== null) {}
    if ((await proc.wait()) === 0) return (ffmpegPath = path);
  }
  return (ffmpegPath = "");
}

function lastLine(text) {
  const lines = String(text || "").trim().split("\n").filter(Boolean);
  const line = lines.length ? lines[lines.length - 1].trim() : "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

// What an episode's audio is, as ffmpeg reads it: "he" for HE-AAC, which the
// app can't decode, "lc" for what it can, or "" when it can't be told.
async function probeCodec(url) {
  const bin = await ffmpegBinary();
  if (!bin) return "";
  let proc;
  try {
    proc = host.spawn(bin, [
      "-nostdin", "-hide_banner", "-loglevel", "info",
      "-rw_timeout", "15000000",
      "-i", url,
      "-t", "0.5", "-f", "null", "-",
    ]);
  } catch {
    return "";
  }
  proc.closeStdin();
  const timer = setTimeout(() => proc.kill(), 9000);
  try {
    await proc.wait();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
  const log = String(proc.errorOutput() || "");
  if (/HE-AAC/i.test(log)) return "he";
  if (/Stream #\d+:\d+.*Audio:\s*aac\b/i.test(log)) return "lc";
  return "";
}

// ffmpeg answers the one request the app makes for the track, as it converts,
// so the track starts before all of it has come. No more than a few wait at a
// time, for tracks skipped before the app asked for them.
const serving = [];

async function serve(url) {
  const bin = await ffmpegBinary();
  if (!bin) throw fail("unavailable", `${t("This episode is HE-AAC, which MyGo Music can't decode.")} ${ffmpegHint()}`);
  while (serving.length >= 3) serving.shift().kill();
  const port = 20000 + Math.floor(Math.random() * 40000);
  let proc;
  try {
    proc = host.spawn(bin, [
      "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      "-rw_timeout", "15000000",
      "-i", url,
      "-vn", "-map", "0:a:0",
      "-c:a", "libmp3lame", "-b:a", "96k",
      "-f", "mp3",
      "-listen", "1", `http://127.0.0.1:${port}/`,
    ]);
  } catch (error) {
    throw fail("unavailable", `${t("This episode is HE-AAC, which MyGo Music can't decode.")} ${ffmpegHint()} (${error.message})`);
  }
  proc.closeStdin();
  serving.push(proc);
  let stopped = false;
  const timer = setTimeout(() => proc.kill(), 3 * 60 * 60 * 1000);
  proc.wait().then(() => {
    stopped = true;
    clearTimeout(timer);
    const at = serving.indexOf(proc);
    if (at >= 0) serving.splice(at, 1);
  });
  // ffmpeg prints the input before it opens the port, and the output only once
  // the app has connected, so what it read is the sign it's nearly listening.
  const until = Date.now() + 12000;
  while (!String(proc.errorOutput() || "").includes("Input #0")) {
    if (stopped) {
      throw new Error(`${t("Pocket Casts couldn't start this episode")}: ${lastLine(proc.errorOutput())}`);
    }
    if (Date.now() > until) {
      proc.kill();
      throw new Error(`${t("Pocket Casts couldn't start this episode")}: ${lastLine(proc.errorOutput())}`);
    }
    await sleep(40);
  }
  await sleep(250);
  return `http://127.0.0.1:${port}/`;
}

export async function stream({ id }) {
  const meta = await episodeFor(id);
  if (!meta?.url) throw fail("unavailable", t("This episode has no audio"));
  if (meta.video) throw fail("unavailable", t("Video episodes are not supported here"));
  const type = streamType(meta);
  if (type === "aac" || type === "m4a") {
    if (!meta.codec) meta.codec = await probeCodec(meta.url);
    if (meta.codec === "he") {
      return { url: await serve(meta.url), type: "mp3", quality: "high", bitRate: 96000 };
    }
  }
  return {
    url: meta.url,
    type,
    size: meta.fileSize || 0,
  };
}
