import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadPlugin({
  storage = new Map(),
  settings = {},
  webSignIn = async () => ({
    cookie: `auth=${encodeURIComponent(
      JSON.stringify({
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresIn: 3600,
      }),
    )}`,
  }),
  fetchImpl = () => {
    throw new Error("network access is disabled in this test");
  },
  spawn = () => {
    throw new Error("spawn is not configured in this test");
  },
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "mygo-source-starter-"));
  const locale = JSON.parse(
    await readFile(join(root, "locales", "zh-CN.json"), "utf8").catch(() => "{}"),
  );
  const openedURLs = [];

  const host = {
    platform: process.platform,
    arch: process.arch,
    dir: root,
    dataDir,
    storage: {
      get: (key) => (storage.has(key) ? structuredClone(storage.get(key)) : null),
      set: (key, value) => {
        storage.set(key, structuredClone(value));
      },
      remove: (key) => {
        storage.delete(key);
      },
    },
    setting: (key) => settings[key] ?? "",
    t: (text) => locale[text] ?? text,
    language: () => "zh-CN",
    crypto: {
      md5: (text) => createHash("md5").update(text).digest("hex"),
    },
    openURL: (url) => {
      openedURLs.push(url);
    },
    signInPrompt: () => {},
    waitForRedirect: async () => {
      throw new Error("waitForRedirect is not configured in this test");
    },
    webSignIn,
    spawn,
    removeDataDir: async (name) => {
      if (!name || name.includes("/") || name.includes("\\")) {
        throw new Error("invalid data directory name");
      }
      await rm(join(dataDir, name), { recursive: true, force: true });
    },
  };

  const context = vm.createContext({
    AbortController,
    Blob,
    FormData,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    fetch: fetchImpl,
    host,
    setInterval,
    setTimeout,
  });

  const source = await readFile(join(root, "index.js"), "utf8");
  const module = new vm.SourceTextModule(source, {
    identifier: join(root, "index.js"),
    context,
  });
  await module.link(() => {
    throw new Error("MyGo plugins are loaded as one module");
  });
  await module.evaluate();

  return {
    api: module.namespace,
    host,
    openedURLs,
    storage,
    close: () => rm(dataDir, { recursive: true, force: true }),
  };
}
