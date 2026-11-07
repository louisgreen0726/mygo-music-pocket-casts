import assert from "node:assert/strict";
import { loadPlugin } from "./harness.mjs";

const session = await loadPlugin({ fetchImpl: fetch });
const { api } = session;

try {
  const home = await api.home();
  assert.ok(home.sections.some((section) => section.shows?.length), "home has no podcasts");

  const results = await api.search({ query: "technology", kind: "shows", offset: 0 });
  assert.ok(results.shows.length > 0, "search returned no podcasts");

  const page = await api.show({ id: results.shows[0].id, offset: 0 });
  assert.ok(page.show.name, "show has no name");
  assert.ok(page.episodes.length > 0, "show has no episodes");

  const stream = await api.stream({ id: page.episodes[0].id });
  assert.match(stream.url, /^https?:\/\//);
  assert.ok(["mp3", "flac", "ogg", "wav", "m4a", "aac"].includes(stream.type));

  assert.ok(page.episodes[0].duration > 0);
  assert.ok(page.episodes[0].album.name);
  console.log(
    JSON.stringify({
      show: page.show.name,
      episode: page.episodes[0].name,
      type: stream.type,
      bytes: stream.size,
    }),
  );
} finally {
  await session.close();
}
