import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { loadPlugin } from "./harness.mjs";

const root = new URL("..", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));

const podcast = {
  uuid: "pod-1",
  title: "The Daily",
  author: "The New York Times",
  description: "A daily news podcast.",
  slug: "the-daily",
  episodes: [
    {
      uuid: "ep-1",
      title: "Episode One",
      slug: "episode-one",
      url: "https://cdn.example/episode-one.mp3",
      file_type: "audio/mpeg",
      file_size: 1234,
      duration: 120,
      published: "2026-11-01T00:00:00Z",
    },
    {
      uuid: "ep-2",
      title: "Episode Two",
      slug: "episode-two",
      url: "https://cdn.example/episode-two.mp3",
      file_type: "audio/mpeg",
      file_size: 2345,
      duration: 60,
      published: "2026-11-02T00:00:00Z",
    },
  ],
};

const calls = [];
let historyCalls = 0;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(options) {
  return options.body ? JSON.parse(options.body) : {};
}

async function fetchImpl(url, options = {}) {
  const parsed = new URL(url);
  const body = parseBody(options);
  calls.push({ url: parsed.href, method: options.method, body, headers: options.headers });

  if (parsed.hostname === "lists.pocketcasts.com" && parsed.pathname === "/popular.json") {
    return json({ podcasts: [{ uuid: "pod-1", title: "The Daily", author: "The New York Times" }] });
  }
  if (parsed.hostname === "lists.pocketcasts.com" && parsed.pathname === "/trending.json") {
    return json({ podcasts: [{ uuid: "pod-3", title: "Trending Show", author: "Someone" }] });
  }
  if (parsed.pathname.startsWith("/episode/show_notes/")) {
    const id = parsed.pathname.split("/").pop();
    return json({
      show_notes: `<p>Episode ${id} &amp; <b>notes</b>&#xff0c; ok</p><script>ignored()</script>`,
    });
  }
  if (parsed.hostname === "podcast-api.pocketcasts.com" && parsed.pathname === "/v2/search/combined") {
    return json({
      results: [
        {
          type: "podcast",
          uuid: "pod-1",
          title: "The Daily",
          author: "The New York Times",
          slug: "the-daily",
        },
        {
          type: "episode",
          uuid: "ep-2",
          title: "Episode Two",
          url: "https://cdn.example/episode-two.mp3",
          duration: 60,
          published: "2026-11-02T00:00:00Z",
          podcast_uuid: "pod-1",
          podcast_title: "The Daily",
        },
      ],
    });
  }
  if (parsed.pathname === "/podcast/full/pod-1") {
    return json({ episode_count: 2, podcast });
  }
  if (parsed.pathname === "/user/token") {
    return json({
      accessToken: "test-access-2",
      refreshToken: "test-refresh-2",
      expiresIn: 3600,
      tokenType: "Bearer",
      email: "daily@example.com",
      uuid: "user-1",
    });
  }
  if (parsed.pathname === "/user/history") {
    historyCalls += 1;
    if (historyCalls === 1) return json({ errorMessage: "expired" }, 401);
    return json({ episodes: [podcast.episodes[1]] });
  }
  if (parsed.pathname === "/user/new_releases") {
    return json({ episodes: [podcast.episodes[0]] });
  }
  if (parsed.pathname === "/user/in_progress") {
    return json({ episodes: [podcast.episodes[1]] });
  }
  if (parsed.pathname === "/user/starred") {
    return json({ episodes: [podcast.episodes[0]] });
  }
  if (parsed.pathname === "/user/podcast/list") {
    return json({ podcasts: [{ uuid: "pod-1", title: "The Daily", author: "The New York Times" }] });
  }
  if (parsed.pathname === "/user/podcast/subscribe" || parsed.pathname === "/user/podcast/unsubscribe") {
    return json({});
  }
  if (parsed.pathname === "/sync/update_episode_star") {
    return json({});
  }
  if (parsed.pathname === "/user/episode") {
    return json({ episode: { ...podcast.episodes[0], podcast_uuid: "pod-1", podcast_title: "The Daily" } });
  }
  return json({ errorMessage: `unhandled ${parsed.pathname}` }, 500);
}

const session = await loadPlugin({ fetchImpl });
const { api, storage } = session;

after(async () => {
  await session.close();
});

test("manifest is a Pocket Casts stream source", () => {
  assert.equal(manifest.id, "pocket-casts");
  assert.equal(manifest.name, "Pocket Casts");
  assert.equal(manifest.playback, "stream");
  assert.equal(manifest.main, "index.js");
  assert.ok(manifest.permissions.network.includes("api.pocketcasts.com"));
  assert.ok(manifest.permissions.network.includes("podcast-api.pocketcasts.com"));
  assert.ok(manifest.permissions.network.includes("pocketcasts.com"));
});

test("sign-in, search, catalog and playback use the Pocket Casts shapes", async () => {
  const account = await api.signIn();
  assert.equal(account.id, "user-1");
  assert.equal(account.name, "daily@example.com");
  assert.equal(
    account.imageUrl,
    "https://www.gravatar.com/avatar/4fed28b3d8d3e4b320fa4e3212818120?d=404&s=400",
  );
  assert.ok(storage.get("auth").accessToken);

  const current = await api.account();
  assert.equal(current.id, account.id);

  const shows = await api.search({ query: "daily", kind: "shows", offset: 0 });
  assert.equal(shows.shows[0].id, "pod-1");
  assert.equal(shows.more, false);

  const tracks = await api.search({ query: "daily", kind: "tracks", offset: 0 });
  assert.equal(tracks.tracks[0].id, "ep-2");
  assert.equal(tracks.tracks[0].showId, "pod-1");

  const suggestions = await api.suggest({ query: "daily" });
  assert.ok(suggestions.includes("The Daily"));

  const page = await api.show({ id: "pod-1", offset: 0 });
  assert.equal(page.show.name, "The Daily");
  assert.equal(page.episodes[0].album.name, "The Daily");
  assert.equal(page.episodes[0].artists[0].name, "The New York Times");
  assert.equal(page.episodes[0].duration, 120000);
  assert.equal(page.episodes[0].description, "Episode ep-1 & notes， ok");
  assert.equal(page.more, false);

  const stream = await api.stream({ id: "ep-1" });
  assert.equal(stream.url, "https://cdn.example/episode-one.mp3");
  assert.equal(stream.type, "mp3");
  assert.equal(stream.size, 1234);

  const home = await api.home();
  assert.ok(home.sections.some((section) => section.tracks?.length));
  assert.ok(home.sections.some((section) => section.shows?.length));
  const trending = home.sections.find((section) => section.morePage === "trending");
  assert.ok(trending?.shows?.length, "home has no trending podcasts");

  const trendingPage = await api.browse({ page: "trending" });
  assert.equal(trendingPage.sections[0].shows[0].name, "Trending Show");

  const subscriptions = await api.shows();
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].subscribed, true);

  const liked = await api.liked({ offset: 0 });
  assert.equal(liked.tracks[0].id, "ep-1");

  await api.likeEpisode({ id: "ep-1", on: true });
  const starCall = calls.find((call) => call.url.endsWith("/sync/update_episode_star"));
  assert.deepEqual(starCall.body, { uuid: "ep-1", podcast: "pod-1", star: true });

  const recent = await api.recent();
  assert.equal(recent[0].id, "ep-2");
  assert.equal(storage.get("auth").accessToken, "test-access-2");

  const progress = await api.browse({ page: "in-progress" });
  assert.equal(progress.sections[0].tracks[0].id, "ep-2");
  await assert.rejects(() => api.browse({ page: "missing" }), (error) => error.code === "unavailable");
});

test("HE-AAC episodes are transcoded through ffmpeg", async () => {
  const started = [];
  const running = [];

  function program(stderr, { stays = false } = {}) {
    let finish;
    const done = new Promise((resolve) => (finish = resolve));
    if (stays) running.push(finish);
    return {
      errorOutput: () => stderr,
      readLine: async () => null,
      closeStdin() {},
      write() {},
      kill() {
        finish(1);
      },
      wait: () => (stays ? done : Promise.resolve(0)),
    };
  }

  const podcast = {
    uuid: "pod-he",
    title: "日谈公园",
    author: "日谈公园",
    slug: "ritan-gongyuan",
    episodes: [
      {
        uuid: "ep-he",
        title: "917访客",
        slug: "917",
        url: "https://cdn.example/he.m4a",
        file_type: "audio/x-m4a",
        duration: 4085,
        published: "2026-11-01T00:00:00Z",
      },
    ],
  };

  const session = await loadPlugin({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/podcast/full/pod-he") {
        return json({ episode_count: 1, podcast });
      }
      return json({ errorMessage: `unhandled ${parsed.pathname}` }, 500);
    },
    spawn: (path, args) => {
      started.push({ path, args });
      if (args[0] === "-version") return program("");
      if (!args.includes("-listen")) {
        return program("Stream #0:0[0x1](und): Audio: aac (HE-AAC), 44100 Hz, stereo, fltp, 64 kb/s\n");
      }
      return program("Input #0, mov,mp4,m4a\nOutput #0, mp3, to 'http://127.0.0.1:23456/'\n", {
        stays: true,
      });
    },
  });

  try {
    const page = await session.api.show({ id: "pod-he", offset: 0 });
    const stream = await session.api.stream({ id: page.episodes[0].id });
    assert.equal(stream.type, "mp3");
    assert.match(stream.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const serve = started.find((call) => call.args.includes("-listen"));
    assert.ok(serve);
    assert.ok(serve.args.includes("libmp3lame"));
    assert.ok(serve.args.includes("https://cdn.example/he.m4a"));
  } finally {
    for (const finish of running) finish(0);
    await session.close();
  }
});
