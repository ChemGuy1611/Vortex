import * as path from "path";

import type { IExtensionApi } from "../../../types/IExtensionContext";
import type { IState } from "../../../types/IState";
import * as fs from "../../../util/fs";
import { batchDispatch } from "../../../util/util";
import { activeGameId } from "../../profile_management/selectors";
import { downloadProgress, removeDownloadSilent } from "../actions/state";
import { downloadPathForGame } from "../selectors";
import type { IDownload } from "../types/IDownload";
import { isTempDownloadName } from "./downloadNames";
import getDownloadGames from "./getDownloadGames";

/**
 * Drops download records that can no longer refer to a usable archive: ones that reached a
 * terminal state with no file, no bytes, or under a name that isn't a file name at all. A record
 * whose archive turns out to be present and non-empty is repaired instead of removed.
 */
async function removeInvalidDownloads(api: IExtensionApi, gameId?: string): Promise<void> {
  const state: IState = api.store.getState();
  const auditedGameId = gameId || activeGameId(state);
  if (!auditedGameId) {
    return;
  }

  const downloads: { [id: string]: IDownload } = state.persistent.downloads.files;

  const incomplete = Object.keys(downloads).filter(
    (dlId) =>
      ["finished", "paused", "failed"].includes(downloads[dlId].state) &&
      (!downloads[dlId].localPath || downloads[dlId].received === 0 || downloads[dlId].size === 0),
  );
  const invalid = Object.keys(downloads).filter(
    (dlId) =>
      ["finished", "failed"].includes(downloads[dlId].state) &&
      downloads[dlId].localPath &&
      // the temp placeholder carries no extension by design, and a download still wearing it is
      // mid-finalization rather than broken
      !isTempDownloadName(downloads[dlId].localPath) &&
      !path.extname(downloads[dlId].localPath),
  );
  const removeSet = new Set<string>(incomplete.concat(invalid));

  // The audit is triggered for one game but the record set is global, so each record is resolved
  // against its OWN game's download folder. Resolving everything against the audited game's folder
  // made every other game's records look like their archive had gone missing.
  const pathByGame = new Map<string, string>();
  const downloadPathOf = (download: IDownload): string => {
    const downloadGameId = getDownloadGames(download)[0] || auditedGameId;
    let downloadPath = pathByGame.get(downloadGameId);
    if (downloadPath === undefined) {
      downloadPath = downloadPathForGame(state, downloadGameId);
      pathByGame.set(downloadGameId, downloadPath);
    }
    return downloadPath;
  };

  const toRemove: string[] = [];
  const repairActions: Array<ReturnType<typeof downloadProgress>> = [];

  await Promise.all(
    Array.from(removeSet).map(async (dlId) => {
      if (downloads[dlId].localPath === undefined) {
        toRemove.push(dlId);
        return;
      }
      const filePath = path.join(downloadPathOf(downloads[dlId]), downloads[dlId].localPath);
      const stats = await fs.statAsync(filePath).catch(() => undefined);
      if (stats?.size > 0) {
        // file exists and is valid on disk - repair the state instead of deleting
        repairActions.push(downloadProgress(dlId, stats.size, stats.size, undefined));
      } else {
        // file genuinely missing or empty - safe to clean up
        await fs.removeAsync(filePath).catch(() => null);
        toRemove.push(dlId);
      }
    }),
  );

  batchDispatch(api.store, [
    ...repairActions,
    ...toRemove.map((dlId) => removeDownloadSilent(dlId)),
  ]);
}

export default removeInvalidDownloads;
