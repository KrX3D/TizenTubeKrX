import { configRead } from '../config.js';
import Chapters from '../ui/chapters.js';
import resolveCommand from '../resolveCommand.js';
import { timelyAction, longPressData, MenuServiceItemRenderer, ShelfRenderer, TileRenderer, ButtonRenderer } from '../ui/ytUI.js';
import { PatchSettings } from '../ui/customYTSettings.js';

/**
 * This is a minimal reimplementation of the following uBlock Origin rule:
 * https://github.com/uBlockOrigin/uAssets/blob/3497eebd440f4871830b9b45af0afc406c6eb593/filters/filters.txt#L116
 *
 * This in turn calls the following snippet:
 * https://github.com/gorhill/uBlock/blob/bfdc81e9e400f7b78b2abc97576c3d7bf3a11a0b/assets/resources/scriptlets.js#L365-L470
 *
 * Seems like for now dropping just the adPlacements is enough for YouTube TV
 */
const origParse = JSON.parse;
JSON.parse = function () {
  const r = origParse.apply(this, arguments);
  const adBlockEnabled = configRead('enableAdBlock');

  if (r.adPlacements && adBlockEnabled) {
    r.adPlacements = [];
  }

  // Also set playerAds to false, just incase.
  if (r.playerAds && adBlockEnabled) {
    r.playerAds = false;
  }

  // Also set adSlots to an empty array, emptying only the adPlacements won't work.
  if (r.adSlots && adBlockEnabled) {
    r.adSlots = [];
  }

  if (r.paidContentOverlay && !configRead('enablePaidPromotionOverlay')) {
    r.paidContentOverlay = null;
  }

  if (r?.streamingData?.adaptiveFormats && configRead('videoPreferredCodec') !== 'any') {
    const preferredCodec = configRead('videoPreferredCodec');
    const hasPreferredCodec = r.streamingData.adaptiveFormats.find(format => format.mimeType.includes(preferredCodec));
    if (hasPreferredCodec) {
      r.streamingData.adaptiveFormats = r.streamingData.adaptiveFormats.filter(format => {
        if (format.mimeType.startsWith('audio/')) return true;
        return format.mimeType.includes(preferredCodec);
      });
    }
  }

  // Drop "masthead" ad from home screen
  if (
    r?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content
      ?.sectionListRenderer?.contents
  ) {
    if (adBlockEnabled) {
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
    }

    processShelves(r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents);
  }

  if (r.endscreen && configRead('enableHideEndScreenCards')) {
    r.endscreen = null;
  }

  if (r.messages && Array.isArray(r.messages) && !configRead('enableYouThereRenderer')) {
    r.messages = r.messages.filter(
      (msg) => !msg?.youThereRenderer
    );
  }

  // Remove shorts ads
  if (!Array.isArray(r) && r?.entries && adBlockEnabled) {
    r.entries = r.entries?.filter(
      (elm) => !elm?.command?.reelWatchEndpoint?.adClientParams?.isAd
    );
  }

  // Patch settings

  if (r?.title?.runs) {
    PatchSettings(r);
  }

  // DeArrow Implementation. I think this is the best way to do it. (DOM manipulation would be a pain)

  if (r?.contents?.sectionListRenderer?.contents) {
    processShelves(r.contents.sectionListRenderer.contents);
  }

  if (r?.continuationContents?.sectionListContinuation?.contents) {
    processShelves(r.continuationContents.sectionListContinuation.contents);
  }

  if (r?.continuationContents?.horizontalListContinuation?.items) {
    deArrowify(r.continuationContents.horizontalListContinuation.items);
    hqify(r.continuationContents.horizontalListContinuation.items);
    addLongPress(r.continuationContents.horizontalListContinuation.items);
    r.continuationContents.horizontalListContinuation.items = hideVideo(r.continuationContents.horizontalListContinuation.items);
  }

  if (r?.contents?.tvBrowseRenderer?.content?.tvSecondaryNavRenderer?.sections) {
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
      queuedVideosClone.unshift(TileRenderer(
        'Clear Queue',
        {
          customAction: {
            action: 'CLEAR_QUEUE'
          }
        }));
      r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents.unshift(ShelfRenderer(
        'Queued Videos',
        queuedVideosClone,
        queuedVideosClone.findIndex(v => v.contentId === window.queuedVideos.lastVideoId) !== -1 ?
          queuedVideosClone.findIndex(v => v.contentId === window.queuedVideos.lastVideoId)
          : 0
      ));
    }
  }
  /*
 
  Chapters are disabled due to the API removing description data which was used to generate chapters
 
  if (r?.contents?.singleColumnWatchNextResults?.results?.results?.contents && configRead('enableChapters')) {
    const chapterData = Chapters(r);
    r.frameworkUpdates.entityBatchUpdate.mutations.push(chapterData);
    resolveCommand({
      "clickTrackingParams": "null",
      "loadMarkersCommand": {
        "visibleOnLoadKeys": [
          chapterData.entityKey
        ],
        "entityKeys": [
          chapterData.entityKey
        ]
      }
    });
  }*/

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
                  parameters: {
                    time: segment.segment[1]
                  }
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
            buttonRenderer: ButtonRenderer(
              false,
              'Skip to highlight',
              'SKIP_NEXT',
              {
                clickTrackingParams: null,
                customAction: {
                  action: 'SKIP',
                  parameters: {
                    time: category.segment[0]
                  }
                }
              })
          }
        });
      }
    }
  }

  return r;
};

// Patch JSON.parse to use the custom one
window.JSON.parse = JSON.parse;
for (const key in window._yttv) {
  if (window._yttv[key] && window._yttv[key].JSON && window._yttv[key].JSON.parse) {
    window._yttv[key].JSON.parse = JSON.parse;
  }
}

function processShelves(shelves, shouldAddPreviews = true) {
  if (!Array.isArray(shelves)) return;
  
  for (let i = shelves.length - 1; i >= 0; i--) {
    const shelve = shelves[i];
    if (!shelve) continue;
    
    // Get shelf title for "Watch Again" detection
    let shelfTitle = '';
    if (shelve.shelfRenderer?.shelfHeaderRenderer?.title) {
      const titleObj = shelve.shelfRenderer.shelfHeaderRenderer.title;
      shelfTitle = (titleObj.simpleText || titleObj.runs?.[0]?.text || '').toLowerCase();
    }
    if (shelve.richShelfRenderer?.title) {
      const titleObj = shelve.richShelfRenderer.title;
      shelfTitle = (titleObj.simpleText || titleObj.runs?.[0]?.text || '').toLowerCase();
    }
    
    // Skip "Watch Again" / "Continue Watching" / "Erneut ansehen" shelves
    const isWatchAgainShelf = shelfTitle.includes('erneut ansehen') || 
                               shelfTitle.includes('watch again') ||
                               shelfTitle.includes('continue watching') ||
                               shelfTitle.includes('weiterschauen') ||
                               shelfTitle.includes('recently watched');
    
    // Handle shelfRenderer
    if (shelve.shelfRenderer) {
      // horizontalListRenderer
      if (shelve.shelfRenderer.content?.horizontalListRenderer?.items) {
        const items = shelve.shelfRenderer.content.horizontalListRenderer.items;
        
        deArrowify(items);
        hqify(items);
        addLongPress(items);
        if (shouldAddPreviews) addPreviews(items);
        
        // Only hide watched if NOT a watch-again shelf
        if (!isWatchAgainShelf) {
          shelve.shelfRenderer.content.horizontalListRenderer.items = hideVideo(items);
        }
        
        // Filter shorts
        if (!configRead('enableShorts')) {
          // Remove entire shorts shelf
          if (shelve.shelfRenderer.tvhtml5ShelfRendererType === 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS') {
            shelves.splice(i, 1);
            continue;
          }
          // Filter individual shorts from the items
          shelve.shelfRenderer.content.horizontalListRenderer.items = 
            shelve.shelfRenderer.content.horizontalListRenderer.items.filter(item => {
              // Check multiple shorts indicators
              if (item.tileRenderer?.tvhtml5ShelfRendererType === 'TVHTML5_TILE_RENDERER_TYPE_SHORTS') return false;
              if (item.compactVideoRenderer?.badges?.find(b => b.metadataBadgeRenderer?.label === 'Shorts')) return false;
              if (item.videoRenderer?.badges?.find(b => b.metadataBadgeRenderer?.label === 'Shorts')) return false;
              
              // Check if navigation endpoint is /shorts/
              const navEndpoint = item.tileRenderer?.onSelectCommand?.watchEndpoint || 
                                 item.compactVideoRenderer?.navigationEndpoint?.watchEndpoint ||
                                 item.videoRenderer?.navigationEndpoint?.watchEndpoint;
              if (navEndpoint?.videoId && item.tileRenderer?.metadata?.tileMetadataRenderer?.title?.simpleText) {
                // Can't detect from endpoint alone reliably, rely on other indicators
              }
              
              return true;
            });
        }
      }
      
      // gridRenderer
      if (shelve.shelfRenderer.content?.gridRenderer?.items) {
        const items = shelve.shelfRenderer.content.gridRenderer.items;
        
        deArrowify(items);
        hqify(items);
        addLongPress(items);
        if (shouldAddPreviews) addPreviews(items);
        
        if (!isWatchAgainShelf) {
          shelve.shelfRenderer.content.gridRenderer.items = hideVideo(items);
        }
        
        // Filter shorts from grid
        if (!configRead('enableShorts')) {
          shelve.shelfRenderer.content.gridRenderer.items = 
            shelve.shelfRenderer.content.gridRenderer.items.filter(item => {
              if (item.gridVideoRenderer?.badges?.find(b => b.metadataBadgeRenderer?.label === 'Shorts')) return false;
              return true;
            });
        }
      }
    }
    
    // Handle richShelfRenderer (used heavily in subscriptions)
    if (shelve.richShelfRenderer?.content?.richGridRenderer?.contents) {
      const contents = shelve.richShelfRenderer.content.richGridRenderer.contents;
      
      deArrowify(contents);
      hqify(contents);
      addLongPress(contents);
      if (shouldAddPreviews) addPreviews(contents);
      
      if (!isWatchAgainShelf) {
        shelve.richShelfRenderer.content.richGridRenderer.contents = hideVideo(contents);
      }
      
      // Filter shorts from richShelfRenderer
      if (!configRead('enableShorts')) {
        shelve.richShelfRenderer.content.richGridRenderer.contents = 
          shelve.richShelfRenderer.content.richGridRenderer.contents.filter(item => {
            const videoRenderer = item?.richItemRenderer?.content?.videoRenderer;
            const reelRenderer = item?.richItemRenderer?.content?.reelItemRenderer;
            
            // If it's a reel/short renderer, filter it out
            if (reelRenderer) return false;
            
            // Check for shorts badge
            if (videoRenderer?.badges?.find(b => b.metadataBadgeRenderer?.label === 'Shorts')) return false;
            
            // Check for shorts overlay
            if (videoRenderer?.thumbnailOverlays?.find(o => 
              o.thumbnailOverlayTimeStatusRenderer?.style === 'SHORTS'
            )) return false;
            
            return true;
          });
      }
    }
  }
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
  
  // Helper: Find progress bar - based on Chrome extension approach
  function findProgressBar(item) {
    if (!item) return null;
    
    // Try to find progress element directly
    const progressSelectors = [
      '#progress',
      '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment',
      '.thumbnail-overlay-resume-playback-progress',
      'ytd-thumbnail-overlay-resume-playback-renderer #progress',
      'ytm-thumbnail-overlay-resume-playback-renderer .thumbnail-overlay-resume-playback-progress'
    ];
    
    for (const selector of progressSelectors) {
      const progressEl = item.querySelector ? item.querySelector(selector) : null;
      if (progressEl) {
        // Get percentage from width style
        const width = progressEl.style.width;
        if (width) {
          const percent = parseFloat(width);
          if (!isNaN(percent)) {
            return { percentDurationWatched: percent };
          }
        }
      }
    }
    
    // Fallback: Check thumbnailOverlays for resume playback renderer
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
  
  // Helper: Get current page type
  function getCurrentPage() {
    const hash = location.hash ? location.hash.substring(1) : '';
    const path = location.pathname || '';
    const search = location.search || '';
    const combined = (hash + ' ' + path + ' ' + search).toLowerCase();
    
    if (combined.includes('/playlist') || combined.includes('list=')) return 'playlist';
    if (combined.includes('/feed/subscriptions') || combined.includes('subscriptions') || combined.includes('abos')) return 'subscriptions';
    if (combined.includes('/feed/library') || combined.includes('library') || combined.includes('mediathek')) return 'library';
    if (combined.includes('/results') || combined.includes('/search') || combined.includes('suche')) return 'search';
    if (combined.includes('music')) return 'music';
    if (combined.includes('gaming')) return 'gaming';
    if (combined.includes('more')) return 'more';
    if (combined === '' || combined === '/' || combined.includes('/home') || combined.includes('browse')) return 'home';
    if (combined.includes('/watch')) return 'watch';
    
    return 'other';
  }
  
  const currentPage = getCurrentPage();
  const configPages = configRead('hideWatchedVideosPages') || [];
  const threshold = Number(configRead('hideWatchedVideosThreshold') || 0);
  
  // Check if hiding is enabled for this page
  const shouldHideOnThisPage = configPages.length === 0 || configPages.includes(currentPage);
  
  if (!shouldHideOnThisPage) {
    return items;
  }
  
  // Playlist-specific check
  if (currentPage === 'playlist' && !configRead('enableHideWatchedInPlaylists')) {
    return items;
  }
  
  return items.filter(item => {
    if (!item) return false;
    
    const progressBar = findProgressBar(item);
    if (!progressBar) return true; // No progress = keep it
    
    const percentWatched = Number(progressBar.percentDurationWatched || 0);
    return percentWatched <= threshold;
  });
}