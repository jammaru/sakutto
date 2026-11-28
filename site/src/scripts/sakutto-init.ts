/** Single deferred entrypoint for all interactive upgrades. */
import { initSakuttoStoreCtaPairs, initSakuttoStoreDownloadBlocks } from "./sakutto-store-download";
import { initSakuttoPageDemo } from "./sakutto-page-demo";
import { initSakuttoFeatureStories } from "./sakutto-feature-stories";
import { initSakuttoSocialStats } from "./sakutto-social-stats-client";

export function initSakutto(): void {
  initSakuttoStoreDownloadBlocks();
  initSakuttoStoreCtaPairs();
  initSakuttoPageDemo();
  initSakuttoFeatureStories();
  void initSakuttoSocialStats();
}
initSakutto();