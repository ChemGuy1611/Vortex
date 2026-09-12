import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const SITE_PATH = "D:/Vortex/downloads/site";
const GAME_PATH = "D:/Vortex/downloads/skyrimse";

// what is actually on disk, keyed by full path -> size
let onDisk: Record<string, number> = {};
const removed: string[] = [];

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

vi.mock("../../../util/fs", () => ({
  statAsync: vi.fn((target: string) => {
    const size = onDisk[target];
    return size === undefined ? Promise.reject(enoent()) : Promise.resolve({ size });
  }),
  removeAsync: vi.fn((target: string) => {
    removed.push(target);
    return Promise.resolve();
  }),
}));

vi.mock("../selectors", () => ({
  downloadPathForGame: (_state: unknown, gameId: string) =>
    gameId === "site" ? SITE_PATH : GAME_PATH,
}));

vi.mock("../../profile_management/selectors", () => ({
  activeGameId: () => "skyrimse",
}));

import { makeApiHarness, makeDownload } from "../../../test-utils/builders";
import type { IDownload } from "../types/IDownload";
import removeInvalidDownloads from "./removeInvalidDownloads";

function run(downloads: Record<string, IDownload>) {
  const harness = makeApiHarness({ downloads });
  return {
    harness,
    done: removeInvalidDownloads(harness.api, "skyrimse"),
  };
}

beforeEach(() => {
  onDisk = {};
  removed.length = 0;
});

describe("removeInvalidDownloads", () => {
  it("keeps a download belonging to another game whose archive is on disk", async () => {
    // the audit runs for skyrimse, but this record is a site (extension) download: its archive
    // lives in the site folder, and resolving it against the audited game's folder would make it
    // look like the file had gone missing
    onDisk[path.join(SITE_PATH, "extension.7z")] = 4096;

    const { harness, done } = run({
      "dl-site": makeDownload({
        id: "dl-site",
        game: ["site"],
        state: "finished",
        localPath: "extension.7z",
      }),
    });
    await done;

    const record = harness.getState().persistent.downloads.files["dl-site"];
    expect(record).toBeDefined();
    // present and non-empty, so the record is repaired rather than dropped
    expect(record.size).toBe(4096);
    expect(removed).toEqual([]);
  });

  it("leaves a download still using the temporary name alone", async () => {
    // __vortex_tmp_* carries no extension by design; a download wearing it is mid-finalization
    const { harness, done } = run({
      "dl-tmp": makeDownload({
        id: "dl-tmp",
        game: ["site"],
        state: "finished",
        localPath: "__vortex_tmp_00000001",
        size: 4096,
        received: 4096,
      }),
    });
    await done;

    expect(harness.getState().persistent.downloads.files["dl-tmp"]).toBeDefined();
    expect(removed).toEqual([]);
  });

  it("removes a record whose archive is genuinely gone", async () => {
    const { harness, done } = run({
      "dl-gone": makeDownload({
        id: "dl-gone",
        game: ["skyrimse"],
        state: "finished",
        localPath: "gone.7z",
      }),
    });
    await done;

    expect(harness.getState().persistent.downloads.files["dl-gone"]).toBeUndefined();
    expect(removed).toEqual([path.join(GAME_PATH, "gone.7z")]);
  });

  it("repairs a zero-size record for the audited game when its archive is present", async () => {
    onDisk[path.join(GAME_PATH, "mod.7z")] = 200;

    const { harness, done } = run({
      "dl-game": makeDownload({
        id: "dl-game",
        game: ["skyrimse"],
        state: "finished",
        localPath: "mod.7z",
      }),
    });
    await done;

    const record = harness.getState().persistent.downloads.files["dl-game"];
    expect(record).toBeDefined();
    expect(record.size).toBe(200);
    expect(removed).toEqual([]);
  });
});
