import { configRead } from '../config.js';
import Chapters from '../ui/chapters.js';
import resolveCommand from '../resolveCommand.js';
import { timelyAction, longPressData, MenuServiceItemRenderer, ShelfRenderer, TileRenderer, ButtonRenderer } from '../ui/ytUI.js';
import { PatchSettings } from '../ui/customYTSettings.js';
import logger from '../utils/logger.js';

const origParse = JSON.parse;
JSON.parse = function () {
  const r = origParse.apply(this, arguments);
  const adBlockEnabled = configRead('enableAdBlock');

  if (r.adPlacements && adBlockEnabled) {
    logger.debug('ADBLOCK', 'Removing adPlacements', { count: r.adPlacements.length });
    r.adPlacements = [];
  }

  if (r.playerAds && adBlockEnabled) {
    logger.debug('ADBLOCK', 'Disabling playerAds');
    r.playerAds = false;
  }

  if (r.adSlots && adBlockEnabled) {
    logger.debug('ADBLOCK', 'Clearing adSlots', { count: r.adSlots.length });
    r.adSlots = [];
  }

  if (r.paidContentOverlay && !configRead('enablePaidPromotionOverlay')) {
    logger.debug('ADBLOCK', 'Removing paid content overlay');
    r.paidContentOverlay = null;
  }

  if (r?.streamingData?.adaptiveFormats && configRead('videoPreferredCodec') !== 'any') {
    const preferredCodec = configRead('videoPreferredCodec');
    const hasPreferredCodec = r.streamingData.adaptiveFormats.find(format => format.mimeType.includes(preferredCodec));
    if (hasPreferredCodec) {
      const before = r.streamingData.adaptiveFormats.length;
      r.streamingData.adaptiveFormats = r.streamingData.adaptiveFormats.filter(format => {
        if (format.mimeType.startsWith('audio/')) return true;
        return format.mimeType.includes(preferredCodec);
      });
      logger.info('VIDEO_CODEC', `Filtered formats for ${preferredCodec}`, {
        before,
        after: r.streamingData.adaptiveFormats.length
      });
    }
  }

  // Drop "masthead" ad from home screen
  if (r?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer?.contents) {
    if (adBlockEnabled) {
      const beforeAds = r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents.length;
      r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents =
        r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents.filter(
          (elm) => !elm.adSlotRenderer
        );

      for (const shelve of r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents) {
        if (shelve.shelfRenderer) {
          shelve.shelfRenderer.content.horizontalListRenderer.items =
            shelve.shelfRenderer.content.horizontalListRenderer.items.filter(
              (item) => !item.adSlotRenderer
            );
        }
      }
      
      const afterAds = r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents.length;
      if (beforeAds !== afterAds) {
        logger.info('ADBLOCK', 'Removed masthead ads', { removed: beforeAds - afterAds });
      }
    }

    processShelves(r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents);
  }

  if (r.endscreen && configRead('enableHideEndScreenCards')) {
    logger.debug('UI_FILTER', 'Hiding end screen cards');
    r.endscreen = null;
  }

  if (r.messages && Array.isArray(r.messages) && !configRead('enableYouThereRenderer')) {
    const before = r.messages.length;
    r.messages = r.messages.filter((msg) => !msg?.youThereRenderer);
    if (before !== r.messages.length) {
      logger.debug('UI_FILTER', 'Removed YouThereRenderer messages', { removed: before - r.messages.length });
    }
  }

  // Remove shorts ads
  if (!Array.isArray(r) && r?.entries && adBlockEnabled) {
    const before = r.entries.length;
    r.entries = r.entries?.filter((elm) => !elm?.command?.reelWatchEndpoint?.adClientParams?.isAd);
    if (before !== r.entries.length) {
      logger.info('ADBLOCK', 'Removed shorts ads', { removed: before - r.entries.length });
    }
  }

  if (r?.title?.runs) {
    PatchSettings(r);
  }

  if (r?.contents?.sectionListRenderer?.contents) {
    logger.debug('SHELF_ENTRY', 'Processing sectionListRenderer.contents', {
      count: r.contents.sectionListRenderer.contents.length,
      page: getCurrentPage()
    });
    processShelves(r.contents.sectionListRenderer.contents);
  }

  if (r?.continuationContents?.sectionListContinuation?.contents) {
    logger.debug('SHELF_ENTRY', 'Processing continuation contents', {
      count: r.continuationContents.sectionListContinuation.contents.length,
      page: getCurrentPage()
    });
    processShelves(r.continuationContents.sectionListContinuation.contents);
  }

  if (r?.continuationContents?.horizontalListContinuation?.items) {
    logger.debug('SHELF_ENTRY', 'Processing horizontal list continuation', {
      count: r.continuationContents.horizontalListContinuation.items.length
    });
    deArrowify(r.continuationContents.horizontalListContinuation.items);
    hqify(r.continuationContents.horizontalListContinuation.items);
    addLongPress(r.continuationContents.horizontalListContinuation.items);
    r.continuationContents.horizontalListContinuation.items = hideVideo(r.continuationContents.horizontalListContinuation.items);
  }

  if (r?.contents?.tvBrowseRenderer?.content?.tvSecondaryNavRenderer?.sections) {
    logger.debug('SHELF_ENTRY', 'Processing tvSecondaryNavRenderer sections');
    for (const section of r.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections) {
      for (const tab of section.tvSecondaryNavSectionRenderer.tabs) {
        processShelves(tab.tabRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents);
      }
    }
  }

  if (r?.contents?.singleColumnWatchNextResults?.pivot?.sectionListRenderer) {
    processShelves(r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents, false);
    if (window.queuedVideos.videos.length > 0) {
      const queuedVideosClone = window.queuedVideos.videos.slice();
      queuedVideosClone.unshift(TileRenderer('Clear Queue', { customAction: { action: 'CLEAR_QUEUE' }}));
      r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents.unshift(ShelfRenderer(
        'Queued Videos',
        queuedVideosClone,
        queuedVideosClone.findIndex(v => v.contentId === window.queuedVideos.lastVideoId) !== -1 ?
          queuedVideosClone.findIndex(v => v.contentId === window.queuedVideos.lastVideoId) : 0
      ));
    }
  }

  // Manual SponsorBlock Skips
  if (configRead('sponsorBlockManualSkips').length > 0 && r?.playerOverlays?.playerOverlayRenderer) {
    const manualSkippedSegments = configRead('sponsorBlockManualSkips');
    let timelyActions = [];
    if (window?.sponsorblock?.segments) {
      for (const segment of window.sponsorblock.segments) {
        if (manualSkippedSegments.includes(segment.category)) {
          const timelyActionData = timelyAction(
            `Skip ${segment.category}`,
            'SKIP_NEXT',
            {
              clickTrackingParams: null,
              showEngagementPanelEndpoint: {
                customAction: {
                  action: 'SKIP',
                  parameters: { time: segment.segment[1] }
                }
              }
            },
            segment.segment[0] * 1000,
            segment.segment[1] * 1000 - segment.segment[0] * 1000
          );
          timelyActions.push(timelyActionData);
        }
      }
      r.playerOverlays.playerOverlayRenderer.timelyActionRenderers = timelyActions;
      logger.debug('SPONSORBLOCK', `Added ${timelyActions.length} manual skip actions`);
    }
  } else if (r?.playerOverlays?.playerOverlayRenderer) {
    r.playerOverlays.playerOverlayRenderer.timelyActionRenderers = [];
  }

  if (r?.transportControls?.transportControlsRenderer?.promotedActions && configRead('enableSponsorBlockHighlight')) {
    if (window?.sponsorblock?.segments) {
      const category = window.sponsorblock.segments.find(seg => seg.category === 'poi_highlight');
      if (category) {
        r.transportControls.transportControlsRenderer.promotedActions.push({
          type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT',
          button: {
            buttonRenderer: ButtonRenderer(false, 'Skip to highlight', 'SKIP_NEXT', {
              clickTrackingParams: null,
              customAction: { action: 'SKIP', parameters: { time: category.segment[0] }}
            })
          }
        });
        logger.debug('SPONSORBLOCK', 'Added highlight button');
      }
    }
  }

  return r;
};

window.JSON.parse = JSON.parse;
for (const key in window._yttv) {
  if (window._yttv[key] && window._yttv[key].JSON && window._yttv[key].JSON.parse) {
    window._yttv[key].JSON.parse = JSON.parse;
  }
}

function isShortItem(item) {
  if (!item) return false;

  const detectionReasons = [];

  if (item.reelItemRenderer || item.richItemRenderer?.content?.reelItemRenderer) {
    detectionReasons.push('reelRenderer');
  }

  const videoRenderers = [
    item.videoRenderer,
    item.compactVideoRenderer,
    item.gridVideoRenderer,
    item.richItemRenderer?.content?.videoRenderer,
    item.tileRenderer
  ];

  for (const video of videoRenderers) {
    if (!video) continue;

    if (video.badges) {
      for (const badge of video.badges) {
        if (badge.metadataBadgeRenderer?.label === 'Shorts') {
          detectionReasons.push('badge');
          break;
        }
      }
    }

    if (video.thumbnailOverlays) {
      for (const overlay of video.thumbnailOverlays) {
        if (overlay.thumbnailOverlayTimeStatusRenderer?.style === 'SHORTS') {
          detectionReasons.push('overlay');
          break;
        }
      }
    }

    const navEndpoint = video.navigationEndpoint || video.onSelectCommand;
    const url = navEndpoint?.commandMetadata?.webCommandMetadata?.url || navEndpoint?.watchEndpoint?.videoId;
    
    if (url && typeof url === 'string' && url.includes('/shorts/')) {
      detectionReasons.push('url');
    }
  }

  const isShort = detectionReasons.length > 0;
  
  if (isShort) {
    const videoId = item.tileRenderer?.contentId || 
                   item.videoRenderer?.videoId || 
                   item.richItemRenderer?.content?.videoRenderer?.videoId || 
                   'unknown';
    logger.debug('SHORT_DETECTED', `Short video detected: ${videoId}`, {
      reasons: detectionReasons,
      page: getCurrentPage()
    });
  }

  return isShort;
}

function processShelves(shelves, shouldAddPreviews = true) {
  if (!Array.isArray(shelves)) {
    logger.warn('SHELF_PROCESS', 'processShelves called with non-array', { type: typeof shelves });
    return;
  }
  
  const page = getCurrentPage();
  const shortsEnabled = configRead('enableShorts');
  const hideWatchedEnabled = configRead('enableHideWatchedVideos');
  const configPages = configRead('hideWatchedVideosPages') || [];
  const shouldHideWatched = hideWatchedEnabled && (configPages.length === 0 || configPages.includes(page));
  
  logger.info('SHELF_PROCESS_START', `Processing ${shelves.length} shelves on ${page}`, {
    shortsEnabled,
    hideWatchedEnabled,
    shouldHideWatched,
    threshold: configRead('hideWatchedVideosThreshold')
  });
  
  let totalItemsBefore = 0;
  let totalItemsAfter = 0;
  let shelvesRemoved = 0;
  
  for (let i = shelves.length - 1; i >= 0; i--) {
    const shelve = shelves[i];
    if (!shelve) continue;
    
    let shelfType = 'unknown';
    let itemsBefore = 0;
    let itemsAfter = 0;
    
    // Handle shelfRenderer
    if (shelve.shelfRenderer) {
      // horizontalListRenderer
      if (shelve.shelfRenderer.content?.horizontalListRenderer?.items) {
        shelfType = 'horizontalList';
        let items = shelve.shelfRenderer.content.horizontalListRenderer.items;
        itemsBefore = items.length;
        
        deArrowify(items);
        hqify(items);
        addLongPress(items);
        if (shouldAddPreviews) addPreviews(items);
        
        if (!shortsEnabled) {
          if (shelve.shelfRenderer.tvhtml5ShelfRendererType === 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS') {
            logger.info('SHELF_REMOVED', 'Removing entire shorts shelf', { type: shelfType, page });
            shelves.splice(i, 1);
            shelvesRemoved++;
            continue;
          }
          
          const beforeShortFilter = items.length;
          items = items.filter(item => !isShortItem(item));
          if (beforeShortFilter !== items.length) {
            logger.info('SHORTS_FILTERED', `Removed ${beforeShortFilter - items.length} shorts from ${shelfType}`, { page });
          }
        }
        
        items = hideVideo(items);
        itemsAfter = items.length;
        
        shelve.shelfRenderer.content.horizontalListRenderer.items = items;
        
        if (items.length === 0) {
          logger.info('SHELF_REMOVED', `Removing empty ${shelfType} shelf`, { page });
          shelves.splice(i, 1);
          shelvesRemoved++;
          continue;
        }
      }
      
      // gridRenderer
      else if (shelve.shelfRenderer.content?.gridRenderer?.items) {
        shelfType = 'grid';
        let items = shelve.shelfRenderer.content.gridRenderer.items;
        itemsBefore = items.length;
        
        deArrowify(items);
        hqify(items);
        addLongPress(items);
        if (shouldAddPreviews) addPreviews(items);
        
        if (!shortsEnabled) {
          const beforeShortFilter = items.length;
          items = items.filter(item => !isShortItem(item));
          if (beforeShortFilter !== items.length) {
            logger.info('SHORTS_FILTERED', `Removed ${beforeShortFilter - items.length} shorts from ${shelfType}`, { page });
          }
        }
        
        items = hideVideo(items);
        itemsAfter = items.length;
        
        shelve.shelfRenderer.content.gridRenderer.items = items;
        
        if (items.length === 0) {
          logger.info('SHELF_REMOVED', `Removing empty ${shelfType} shelf`, { page });
          shelves.splice(i, 1);
          shelvesRemoved++;
          continue;
        }
      }

      // verticalListRenderer
      else if (shelve.shelfRenderer.content?.verticalListRenderer?.items) {
        shelfType = 'verticalList';
        let items = shelve.shelfRenderer.content.verticalListRenderer.items;
        itemsBefore = items.length;
        
        deArrowify(items);
        hqify(items);
        addLongPress(items);
        if (shouldAddPreviews) addPreviews(items);
        
        if (!shortsEnabled) {
          const beforeShortFilter = items.length;
          items = items.filter(item => !isShortItem(item));
          if (beforeShortFilter !== items.length) {
            logger.info('SHORTS_FILTERED', `Removed ${beforeShortFilter - items.length} shorts from ${shelfType}`, { page });
          }
        }
        
        items = hideVideo(items);
        itemsAfter = items.length;
        
        shelve.shelfRenderer.content.verticalListRenderer.items = items;
        
        if (items.length === 0) {
          logger.info('SHELF_REMOVED', `Removing empty ${shelfType} shelf`, { page });
          shelves.splice(i, 1);
          shelvesRemoved++;
          continue;
        }
      }
    }
    
    // Handle richShelfRenderer (subscriptions)
    else if (shelve.richShelfRenderer?.content?.richGridRenderer?.contents) {
      shelfType = 'richGrid';
      let contents = shelve.richShelfRenderer.content.richGridRenderer.contents;
      itemsBefore = contents.length;
      
      deArrowify(contents);
      hqify(contents);
      addLongPress(contents);
      if (shouldAddPreviews) addPreviews(contents);
      
      if (!shortsEnabled) {
        const beforeShortFilter = contents.length;
        contents = contents.filter(item => !isShortItem(item));
        if (beforeShortFilter !== contents.length) {
          logger.info('SHORTS_FILTERED', `Removed ${beforeShortFilter - contents.length} shorts from ${shelfType}`, { page });
        }
      }
      
      contents = hideVideo(contents);
      itemsAfter = contents.length;
      
      shelve.richShelfRenderer.content.richGridRenderer.contents = contents;
      
      if (contents.length === 0) {
        logger.info('SHELF_REMOVED', `Removing empty ${shelfType} shelf`, { page });
        shelves.splice(i, 1);
        shelvesRemoved++;
        continue;
      }
    }

    // Handle richSectionRenderer
    else if (shelve.richSectionRenderer?.content?.richShelfRenderer) {
      shelfType = 'richSection';
      if (!shortsEnabled) {
        const innerShelf = shelve.richSectionRenderer.content.richShelfRenderer;
        const contents = innerShelf?.content?.richGridRenderer?.contents;
        
        if (Array.isArray(contents) && contents.some(item => isShortItem(item))) {
          logger.info('SHELF_REMOVED', 'Removing shorts richSection shelf', { page });
          shelves.splice(i, 1);
          shelvesRemoved++;
          continue;
        }
      }
    }

    // Handle gridRenderer at shelf level
    else if (shelve.gridRenderer?.items) {
      shelfType = 'topLevelGrid';
      let items = shelve.gridRenderer.items;
      itemsBefore = items.length;
      
      deArrowify(items);
      hqify(items);
      addLongPress(items);
      if (shouldAddPreviews) addPreviews(items);
      
      if (!shortsEnabled) {
        const beforeShortFilter = items.length;
        items = items.filter(item => !isShortItem(item));
        if (beforeShortFilter !== items.length) {
          logger.info('SHORTS_FILTERED', `Removed ${beforeShortFilter - items.length} shorts from ${shelfType}`, { page });
        }
      }
      
      items = hideVideo(items);
      itemsAfter = items.length;
      
      shelve.gridRenderer.items = items;
      
      if (items.length === 0) {
        logger.info('SHELF_REMOVED', `Removing empty ${shelfType} shelf`, { page });
        shelves.splice(i, 1);
        shelvesRemoved++;
        continue;
      }
    }
    
    totalItemsBefore += itemsBefore;
    totalItemsAfter += itemsAfter;
    
    if (itemsBefore > 0) {
      logger.debug('SHELF_PROCESSED', `Processed ${shelfType} shelf`, {
        before: itemsBefore,
        after: itemsAfter,
        filtered: itemsBefore - itemsAfter,
        page
      });
    }
  }
  
  logger.info('SHELF_PROCESS_COMPLETE', `Finished processing shelves on ${page}`, {
    shelvesProcessed: shelves.length,
    shelvesRemoved,
    totalItemsBefore,
    totalItemsAfter,
    totalFiltered: totalItemsBefore - totalItemsAfter
  });
}

function addPreviews(items) {
  if (!configRead('enablePreviews')) return;
  for (const item of items) {
    if (item.tileRenderer) {
      const watchEndpoint = item.tileRenderer.onSelectCommand;
      if (item.tileRenderer?.onFocusCommand?.playbackEndpoint) continue;
      item.tileRenderer.onFocusCommand = {
        startInlinePlaybackCommand: {
          blockAdoption: true,
          caption: false,
          delayMs: 3000,
          durationMs: 40000,
          muted: false,
          restartPlaybackBeforeSeconds: 10,
          resumeVideo: true,
          playbackEndpoint: watchEndpoint
        }
      };
    }
  }
}

function deArrowify(items) {
  for (const item of items) {
    if (item.adSlotRenderer) {
      const index = items.indexOf(item);
      items.splice(index, 1);
      continue;
    }
    if (!item.tileRenderer) continue;
    if (configRead('enableDeArrow')) {
      const videoID = item.tileRenderer.contentId;
      fetch(`https://sponsor.ajay.app/api/branding?videoID=${videoID}`).then(res => res.json()).then(data => {
        if (data.titles.length > 0) {
          const mostVoted = data.titles.reduce((max, title) => max.votes > title.votes ? max : title);
          item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText = mostVoted.title;
        }

        if (data.thumbnails.length > 0 && configRead('enableDeArrowThumbnails')) {
          const mostVotedThumbnail = data.thumbnails.reduce((max, thumbnail) => max.votes > thumbnail.votes ? max : thumbnail);
          if (mostVotedThumbnail.timestamp) {
            item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails = [
              {
                url: `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${videoID}&time=${mostVotedThumbnail.timestamp}`,
                width: 1280,
                height: 640
              }
            ]
          }
        }
      }).catch(() => { });
    }
  }
}

function hqify(items) {
  for (const item of items) {
    if (!item.tileRenderer) continue;
    if (item.tileRenderer.style !== 'TILE_STYLE_YTLR_DEFAULT') continue;
    if (configRead('enableHqThumbnails')) {
      const videoID = item.tileRenderer.onSelectCommand.watchEndpoint.videoId;
      const queryArgs = item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url.split('?')[1];
      item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails = [
        {
          url: `https://i.ytimg.com/vi/${videoID}/sddefault.jpg${queryArgs ? `?${queryArgs}` : ''}`,
          width: 640,
          height: 480
        }
      ];
    }
  }
}

function addLongPress(items) {
  for (const item of items) {
    if (!item.tileRenderer) continue;
    if (item.tileRenderer.style !== 'TILE_STYLE_YTLR_DEFAULT') continue;
    if (item.tileRenderer.onLongPressCommand) {
      item.tileRenderer.onLongPressCommand.showMenuCommand.menu.menuRenderer.items.push(MenuServiceItemRenderer('Add to Queue', {
        clickTrackingParams: null,
        playlistEditEndpoint: {
          customAction: {
            action: 'ADD_TO_QUEUE',
            parameters: item
          }
        }
      }));
      continue;
    }
    if (!configRead('enableLongPress')) continue;
    const subtitle = item.tileRenderer.metadata.tileMetadataRenderer.lines[0].lineRenderer.items[0].lineItemRenderer.text;
    const data = longPressData({
      videoId: item.tileRenderer.contentId,
      thumbnails: item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails,
      title: item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText,
      subtitle: subtitle.runs ? subtitle.runs[0].text : subtitle.simpleText,
      watchEndpointData: item.tileRenderer.onSelectCommand.watchEndpoint,
      item
    });
    item.tileRenderer.onLongPressCommand = data;
  }
}

function hideVideo(items) {
  if (!configRead('enableHideWatchedVideos')) {
    return items;
  }
  
  if (!Array.isArray(items)) return items;
  
  const page = getCurrentPage();
  const configPages = configRead('hideWatchedVideosPages') || [];
  const threshold = Number(configRead('hideWatchedVideosThreshold') || 0);
  const shouldHideOnThisPage = configPages.length === 0 || configPages.includes(page);
  
  if (!shouldHideOnThisPage) {
    logger.debug('WATCHED_SKIP', `Skipping watched video hiding on ${page}`, {
      configPages,
      threshold
    });
    return items;
  }
  
  if (page === 'playlist' && !configRead('enableHideWatchedInPlaylists')) {
    logger.debug('WATCHED_SKIP', 'Skipping watched video hiding in playlist (disabled)');
    return items;
  }
  
  const beforeCount = items.length;
  let hiddenCount = 0;
  
  const filtered = items.filter(item => {
    if (!item) return false;
    
    const progressBar = findProgressBar(item);
    if (!progressBar) return true;
    
    const percentWatched = Number(progressBar.percentDurationWatched || 0);
    const shouldHide = percentWatched > threshold;
    
    if (shouldHide) {
      hiddenCount++;
      const videoId = item.tileRenderer?.contentId || 
                     item.videoRenderer?.videoId || 
                     item.richItemRenderer?.content?.videoRenderer?.videoId || 
                     'unknown';
      
      logger.debug('WATCHED_HIDDEN', `Hiding watched video ${videoId}`, {
        percentWatched,
        threshold,
        page
      });
    }
    
    return !shouldHide;
  });
  
  if (hiddenCount > 0) {
    logger.info('WATCHED_FILTERED', `Hidden ${hiddenCount} watched videos on ${page}`, {
      before: beforeCount,
      after: filtered.length,
      threshold
    });
  }
  
  return filtered;
}

function findProgressBar(item) {
  if (!item) return null;
  
  const checkRenderer = (renderer) => {
    if (!renderer) return null;
    
    const overlayPaths = [
      renderer.thumbnailOverlays,
      renderer.header?.tileHeaderRenderer?.thumbnailOverlays,
      renderer.thumbnail?.thumbnailOverlays
    ];
    
    for (const overlays of overlayPaths) {
      if (!Array.isArray(overlays)) continue;
      const progressOverlay = overlays.find(o => o?.thumbnailOverlayResumePlaybackRenderer);
      if (progressOverlay) {
        return progressOverlay.thumbnailOverlayResumePlaybackRenderer;
      }
    }
    return null;
  };
  
  const rendererTypes = [
    item.tileRenderer,
    item.playlistVideoRenderer,
    item.compactVideoRenderer,
    item.gridVideoRenderer,
    item.videoRenderer,
    item.richItemRenderer?.content?.videoRenderer,
    item.richItemRenderer?.content?.reelItemRenderer
  ];
  
  for (const renderer of rendererTypes) {
    const result = checkRenderer(renderer);
    if (result) return result;
  }
  
  return null;
}

function getCurrentPage() {
  const hash = location.hash ? location.hash.substring(1) : '';
  const path = location.pathname || '';
  const search = location.search || '';
  const combined = (hash + ' ' + path + ' ' + search).toLowerCase();
  
  if (combined.includes('/playlist') || combined.includes('list=')) return 'playlist';
  if (combined.includes('/feed/subscriptions') || combined.includes('subscriptions') || combined.includes('abos')) return 'subscriptions';
  if (combined.includes('/feed/library') || combined.includes('library') || combined.includes('mediathek')) return 'library';
  if (combined.includes('/results') || combined.includes('/search') || combined.includes('suche')) return 'search';
  if (combined.includes('/@') || combined.includes('/channel/') || combined.includes('/c/') || combined.includes('/user/')) return 'channel';
  if (combined.includes('music')) return 'music';
  if (combined.includes('gaming')) return 'gaming';
  if (combined.includes('more')) return 'more';
  if (combined === '' || combined === '/' || combined.includes('/home') || combined.includes('browse')) return 'home';
  if (combined.includes('/watch')) return 'watch';
  
  return 'other';
}