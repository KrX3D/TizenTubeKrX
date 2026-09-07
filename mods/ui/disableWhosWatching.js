import { configChangeEmitter, configRead } from '../config.js';

configChangeEmitter.addEventListener('configChange', (event) => {
    const { key, value } = event.detail;
    if (key === 'enableWhoIsWatchingMenu') {
        disableWhosWatching(value);
    }
});

let interval;

// Reported on-device (standalone, Tizen 6.5): after a full TV power cycle
// (not just closing/reopening the app), the profile-selector screen
// sometimes shows up even though this is supposed to keep suppressing it.
// A power cycle is a much slower cold boot than a simple app restart — this
// function only ever ran once, synchronously, at script load, so if
// YouTube's own code hadn't created the recurring_actions localStorage key
// yet by the time this ran (a genuine race on a slow cold boot, not present
// on a warm restart where the key already exists from before), this bailed
// out immediately with just a console warning, leaving suppression never
// applied for that launch. Bounded retry so a slow cold boot gets more than
// one chance before giving up.
const MAX_RETRY_ATTEMPTS = 10;
const RETRY_DELAY_MS = 500;

function disableWhosWatching(value, attempt) {
    if (attempt === undefined) attempt = 0;
    // FIX: Wrap the entire function body — localStorage may be missing or corrupt
    // (e.g. first boot, reset, or storage quota hit) and JSON.parse can throw.
    let LeanbackRecurringActions;
    try {
        const raw = localStorage['yt.leanback.default::recurring_actions'];
        if (!raw) {
            if (attempt < MAX_RETRY_ATTEMPTS) {
                setTimeout(() => disableWhosWatching(value, attempt + 1), RETRY_DELAY_MS);
                return;
            }
            console.warn('[disableWhosWatching] recurring_actions not found in localStorage after retrying — giving up');
            return;
        }
        LeanbackRecurringActions = JSON.parse(raw);
    } catch (err) {
        console.warn('[disableWhosWatching] Failed to read/parse recurring_actions:', err);
        return;
    }

    const shouldPermanentlyEnable = configRead('permanentlyEnableWhoIsWatchingMenu');
    const date = new Date();

    if (!value) {
        try {
            // Setting it after 7 days should be enough, as it'll get executed every time the app launches.
            date.setDate(date.getDate() + 7);
            LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"] &&
                (LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"].lastFired = date.getTime());
            LeanbackRecurringActions.data.data.whos_watching_fullscreen_zero_accounts.lastFired = date.getTime();
            LeanbackRecurringActions.data.data["startup-screen-signed-out-welcome-back"] &&
                (LeanbackRecurringActions.data.data["startup-screen-signed-out-welcome-back"].lastFired = date.getTime());
            localStorage['yt.leanback.default::recurring_actions'] = JSON.stringify(LeanbackRecurringActions);
        } catch (err) {
            console.warn('[disableWhosWatching] Failed to disable who\'s watching menu:', err);
        }
    } else {
        try {
            // Do nothing if the last fired action is less than 2 hours ago.
            if (
                date.getTime() - LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"]?.lastFired > 0 &&
                date.getTime() - LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"]?.lastFired < 2 * 60 * 60 * 1000 &&
                !shouldPermanentlyEnable
            ) {
                return;
            }

            function setActions() {
                try {
                    LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"] &&
                        (LeanbackRecurringActions.data.data["startup-screen-account-selector-with-guest"].lastFired = date.getTime());
                    LeanbackRecurringActions.data.data.whos_watching_fullscreen_zero_accounts.lastFired = date.getTime();
                    LeanbackRecurringActions.data.data["startup-screen-signed-out-welcome-back"] &&
                        (LeanbackRecurringActions.data.data["startup-screen-signed-out-welcome-back"].lastFired = date.getTime());
                    localStorage['yt.leanback.default::recurring_actions'] = JSON.stringify(LeanbackRecurringActions);
                } catch (err) {
                    console.warn('[disableWhosWatching] setActions failed:', err);
                }
            }

            setActions();
            if (shouldPermanentlyEnable) {
                date.setDate(date.getDate() - 7);
                setActions();
                interval = setInterval(setActions, 60 * 1000);
            } else if (interval) {
                clearInterval(interval);
            }
        } catch (err) {
            console.warn('[disableWhosWatching] Failed to enable who\'s watching menu:', err);
        }
    }
}

disableWhosWatching(configRead('enableWhoIsWatchingMenu'));