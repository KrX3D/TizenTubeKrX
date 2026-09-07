const CONFIG_KEY = 'ytaf-configuration';
const defaultConfig = {
  enableAdBlock: true,
  enableSponsorBlock: true,
  enableSponsorBlockToasts: true,
  sponsorBlockManualSkips: ['intro', 'outro', 'filler'],
  enableSponsorBlockSponsor: true,
  enableSponsorBlockIntro: true,
  enableSponsorBlockOutro: true,
  enableSponsorBlockInteraction: true,
  enableSponsorBlockSelfPromo: true,
  enableSponsorBlockPreview: true,
  enableSponsorBlockMusicOfftopic: true,
  enableSponsorBlockFiller: false,
  enableSponsorBlockHighlight: true,
  videoSpeed: 1,
  preferredVideoQuality: 'auto',
  enableDeArrow: true,
  enableDeArrowThumbnails: false,
  focusContainerColor: '#0f0f0f',
  routeColor: '#0f0f0f',
  enableFixedUI: (window.h5vcc && window.h5vcc.tizentube) ? false : true,
  enableHqThumbnails: true,
  enableChapters: true,
  enableLongPress: true,
  enableShorts: false,
  dontCheckUpdateUntil: 0,
  enableWhoIsWatchingMenu: false,
  permanentlyEnableWhoIsWatchingMenu: false,
  enableWhosWatchingMenuOnAppExit: false,
  enableShowUserLanguage: true,
  enableShowOtherLanguages: false,
  enableCaptionStylePersistence: true,
  captionStyleSettings: null,
  captionsEnabled: null,
  captionsOnCommand: null,
  captionRawKeyBackups: {},
  showWelcomeToast: false,
  enablePreviousNextButtons: false,
  enableSuperThanksButton: false,
  enableAIAskButton: false,
  enableSpeedControlsButton: true,
  enablePatchingVideoPlayer: true,
  enableMPButton: true,
  enableSwapMPWithPIP: false,
  enablePreviews: false,
  enableHideWatchedVideos: true,
  hideWatchedVideosThreshold: 5,
  hideWatchedVideosPages: [
      'home',
      'search',
      'music',
      'gaming',
      'subscriptions',
      'channel',
      'playlist',
      'more',
      'watch'
  ],
  hiddenLibraryTabIds: ['festorefront', 'fecollection_podcasts', 'femy_videos', 'fehistory', 'femy_youtube', 'feplaylist_aggregation', 'femusic_last_played'],
  hiddenSpecialPlaylistShelves: ['WL', 'LL'],
  hiddenSpecialPlaylistTiles: ['WL', 'LL'],
  enableHideEndScreenCards: false,
  enableYouThereRenderer: false,
  lastAnnouncementCheck: 0,
  enableScreenDimming: false,
  dimmingTimeout: 60,
  dimmingOpacity: 0.5,
  enablePaidPromotionOverlay: false,
  speedSettingsIncrement: 0.25,
  preferredVideoCodec: 'any',
  launchToOnStartup: null,
  reloadHomeOnStartup: true,
  disabledSidebarContents: ['TROPHY', 'NEWS', 'YOUTUBE_MUSIC', 'BROADCAST', 'CLAPPERBOARD', 'LIVE', 'GAMING', 'TAB_MORE', 'SEARCH'],
  sidebarContentsOrder: [],
  disableChannelsOnSidebar: false,
  enableUpdater: true,
  autoFrameRate: false,
  autoFrameRatePauseVideoFor: 0,
  enableSigninReminder: false,
  sortSubscriptionsByAlphabet: false,
  enableDebugConsole: false,
  enableDebugLogging: false,
  debugConsolePosition: 'top-left',
  debugConsoleHeight: 1054,
  logServerEnabled: false,
  // syslog output, independent of the log server above.
  syslogEnabled: false,
  syslogHost: '',
  syslogPort: 514,
  syslogFacility: 16,
  syslogAppName: 'TizenTube',
  syslogHostname: '',
  logServerHost: '192.168.50.57',
  logServerPort: 3030,
  enablePlaylistBatchCollect: false,
  playlistBatchCollectMaxBatches: 50,
  enableClock: false,
  isClock12HourFormat: false,
  clockShowSeconds: false,
  clockHideWhenVideoPlaying: false,
  disableEnlargingThumbnails: false,
  enableShrinkingThumbnails: false,
  hideMembersOnlyVideos: false,
  hideChannelShelves: false,
  hideSurveys: false,
  enableJumpToPercentage: false,
  hideRelatedVideosPlayer: false,
  spoofViewport: 'disabled',
  enableReloadOnResume: false,
};

let localConfig;
const populatedConfigWarnings = new Set();

try {
  const raw = window.localStorage[CONFIG_KEY];
  if (raw === undefined || raw === null || raw === '' || raw === 'undefined') {
    localConfig = { ...defaultConfig };
  } else {
    localConfig = JSON.parse(raw);
  }
} catch (err) {
  console.warn('Config read failed:', err);
  localConfig = { ...defaultConfig };
}

if (!localConfig || typeof localConfig !== 'object') {
  localConfig = { ...defaultConfig };
}

// The visual debug console (and the logging that feeds it) must always
// start off/hidden, regardless of what was last saved — confirmed
// on-device: leaving it enabled across a restart (e.g. after being turned
// on once to diagnose something) is suspected of contributing to the app
// hanging on startup. Overridden in memory only (not written back to
// storage), so re-enabling it from Settings during a session still works
// exactly as before — it just won't carry over to the next app start.
localConfig.enableDebugConsole = false;
localConfig.enableDebugLogging = false;
// Same reasoning applies to logServerEnabled: now that it alone triggers
// console.* interception work (see visualConsole.js addLog), leaving it on
// from a previous session means every console call pays that cost right
// during YouTube's own page bootstrap — the highest-load moment — without
// the user having deliberately turned it on for this session.
localConfig.logServerEnabled = false;

export function configRead(key) {
  if (localConfig[key] === undefined) {
    const hasDefault = Object.prototype.hasOwnProperty.call(defaultConfig, key);
    localConfig[key] = hasDefault ? defaultConfig[key] : undefined;
    if (hasDefault && !populatedConfigWarnings.has(key)) {
      populatedConfigWarnings.add(key);
      console.warn('Populating key', key, 'with default value', defaultConfig[key]);
    }
  }
  return localConfig[key];
}

export function configWrite(key, value) {
  console.info('Setting key', key, 'to', value);
  if (value === undefined) {
    delete localConfig[key];
  } else {
    localConfig[key] = value;
  }
  window.localStorage[CONFIG_KEY] = JSON.stringify(localConfig);
  configChangeEmitter.dispatchEvent(new CustomEvent('configChange', { detail: { key, value } }));
}

export const configChangeEmitter = {
  listeners: {},
  addEventListener(type, callback) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(callback);
  },
  removeEventListener(type, callback) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter(cb => cb !== callback);
  },
  dispatchEvent(event) {
    const type = event.type;
    if (!this.listeners[type]) return;
    this.listeners[type].forEach(cb => {
      try {
        cb.call(this, event)
      } catch (_) {};
    });
  }
};
