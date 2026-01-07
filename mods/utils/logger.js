// Remote Syslog Logger for TizenTube
import { configRead } from '../config.js';

class SyslogLogger {
  constructor() {
    this.enabled = false;
    this.serverUrl = '';
    this.logLevel = 'INFO'; // DEBUG, INFO, WARN, ERROR
    this.maxBatchSize = 10;
    this.batchInterval = 5000; // 5 seconds
    this.logQueue = [];
    this.batchTimer = null;
    
    this.init();
  }

  init() {
    // You can store these in config
    this.enabled = configRead('enableRemoteLogging') || false;
    this.serverUrl = configRead('syslogServerUrl') || 'http://192.168.1.100:514'; // Change to your server
    this.logLevel = configRead('logLevel') || 'INFO';
    
    if (this.enabled) {
      this.startBatchTimer();
    }
  }

  startBatchTimer() {
    if (this.batchTimer) clearInterval(this.batchTimer);
    
    this.batchTimer = setInterval(() => {
      this.flush();
    }, this.batchInterval);
  }

  shouldLog(level) {
    const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    return levels[level] >= levels[this.logLevel];
  }

  formatMessage(level, category, message, data) {
    const timestamp = new Date().toISOString();
    const device = window.h5vcc?.tizentube?.GetVersion() || 'TizenTube';
    
    return {
      timestamp,
      device,
      level,
      category,
      message,
      data: data || {},
      url: window.location.href
    };
  }

  async sendBatch(logs) {
    if (!this.enabled || !this.serverUrl) return;

    try {
      const response = await fetch(this.serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          logs,
          source: 'TizenTube',
          version: window.h5vcc?.tizentube?.GetVersion() || 'unknown'
        })
      });

      if (!response.ok) {
        console.error('Failed to send logs to syslog server:', response.status);
      }
    } catch (error) {
      console.error('Error sending logs to syslog server:', error);
    }
  }

  log(level, category, message, data) {
    // Always log to console
    console[level.toLowerCase()](
      `[${category}]`,
      message,
      data || ''
    );

    // Send to remote syslog if enabled
    if (this.enabled && this.shouldLog(level)) {
      const logEntry = this.formatMessage(level, category, message, data);
      this.logQueue.push(logEntry);

      // Flush immediately if queue is full or if it's an error
      if (this.logQueue.length >= this.maxBatchSize || level === 'ERROR') {
        this.flush();
      }
    }
  }

  flush() {
    if (this.logQueue.length === 0) return;

    const logsToSend = [...this.logQueue];
    this.logQueue = [];
    
    this.sendBatch(logsToSend);
  }

  debug(category, message, data) {
    this.log('DEBUG', category, message, data);
  }

  info(category, message, data) {
    this.log('INFO', category, message, data);
  }

  warn(category, message, data) {
    this.log('WARN', category, message, data);
  }

  error(category, message, data) {
    this.log('ERROR', category, message, data);
  }

  // Special method for tracking video filtering
  logVideoFilter(action, videoData) {
    this.info('VIDEO_FILTER', action, {
      videoId: videoData.videoId,
      title: videoData.title,
      isShort: videoData.isShort,
      watchedPercent: videoData.watchedPercent,
      page: window.location.pathname
    });
  }

  // Special method for tracking shelf processing
  logShelfProcessing(shelfType, beforeCount, afterCount, page) {
    this.debug('SHELF_PROCESS', 'Processed shelf', {
      shelfType,
      beforeCount,
      afterCount,
      filtered: beforeCount - afterCount,
      page
    });
  }
}

// Create global logger instance
const logger = new SyslogLogger();

// Export for use in other modules
export default logger;

// Also expose globally for debugging in console
if (typeof window !== 'undefined') {
  window.TizenLogger = logger;
}