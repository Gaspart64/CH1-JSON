const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 5000;

// VAPID keys
const publicVapidKey = 'BLUCuBSqeYhGyywgwekJCwIdNm9GX1Akv_eOMVwZq5LjXk7csu_MCQTGu-hxgAXk0Vl-UGLNqiljlcJU-TN4MBg';
const privateVapidKey = '0xYQsTG0o0Geau027FczsLabJPYff-8akPNoNaUw7lI';

webpush.setVapidDetails(
    'mailto:example@yourdomain.org',
    publicVapidKey,
    privateVapidKey
);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, './')));

const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');

// Helper to read/write subscriptions
function getSubscriptions() {
    if (!fs.existsSync(SUBSCRIPTIONS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE));
    } catch (e) {
        return [];
    }
}

function writeSubscriptions(subs) {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2));
}

// Update or add a subscription. Preserves the server-managed `notifyState`
// field (today's send-tracking) across config updates from the client —
// the client only ever sends `subscription` + `config`.
function saveSubscription(sub, config) {
    let subs = getSubscriptions();
    const index = subs.findIndex(s => s.subscription.endpoint === sub.endpoint);
    if (index > -1) {
        subs[index].config = config;
    } else {
        subs.push({ subscription: sub, config: config, notifyState: null });
    }
    writeSubscriptions(subs);
}

// Subscribe Route
app.post('/subscribe', (req, res) => {
    const { subscription, config } = req.body;
    saveSubscription(subscription, config);
    res.status(201).json({});
});

// Get Public Key Route
app.get('/vapidPublicKey', (req, res) => {
    res.send(publicVapidKey);
});

// ── Timezone-correct scheduling helpers ─────────────────────────────────────
// Client sends timezoneOffsetMinutes = Date.prototype.getTimezoneOffset(),
// i.e. minutes the user's local time is BEHIND UTC (e.g. Houston/CDT = 300).
// We shift "now" by that many minutes and read the UTC fields off the
// shifted date — that gives us the user's local hour/date without needing
// a timezone database on the server.
function pad2(n) { return String(n).padStart(2, '0'); }

function getUserLocalNow(timezoneOffsetMinutes) {
    const offset = typeof timezoneOffsetMinutes === 'number' ? timezoneOffsetMinutes : 0;
    const shiftedMs = Date.now() - offset * 60000;
    return new Date(shiftedMs);
}

function localDateString(localNow) {
    return `${localNow.getUTCFullYear()}-${pad2(localNow.getUTCMonth() + 1)}-${pad2(localNow.getUTCDate())}`;
}

function isWithinNotificationWindow(hour, startHour, endHour) {
    if (startHour <= endHour) return hour >= startHour && hour <= endHour;
    return hour >= startHour || hour <= endHour; // wraps past midnight
}

// Hours remaining (inclusive of the current hour) until the window closes.
function hoursRemainingInWindow(hour, startHour, endHour) {
    if (startHour <= endHour) return endHour - hour;
    if (hour >= startHour) return (24 - hour) + endHour;
    return endHour - hour;
}

function daysBetweenDateStrings(a, b) {
    const da = new Date(`${a}T00:00:00Z`);
    const db = new Date(`${b}T00:00:00Z`);
    return Math.round((db - da) / 86400000);
}

// Builds the { title, body } for whichever notification slot fired.
function buildNotificationPayload(kind, config, localDateStr) {
    const streak = config.dailyStreak || 0;
    const daysSince = config.lastPlayedDate ? daysBetweenDateStrings(config.lastPlayedDate, localDateStr) : null;

    if (kind === 'risk') {
        return {
            title: `🔥 Don't lose your ${streak}-day streak!`,
            body: 'Your practice window closes soon today — solve a quick set now to keep it alive.'
        };
    }

    // kind === 'reminder'
    if (streak > 0) {
        return {
            title: `🔥 Keep your ${streak}-day streak going!`,
            body: "You haven't solved today's puzzles yet — jump in whenever you're ready."
        };
    }
    if (daysSince !== null && daysSince >= 2) {
        return {
            title: 'We miss you!',
            body: `It's been ${daysSince} days since your last set. Come back and start a new streak!`
        };
    }
    return {
        title: 'Time for Puzzles!',
        body: "It's time to solve your set of chess puzzles!"
    };
}

// Hourly Cron Job (every hour at :00)
cron.schedule('0 * * * *', () => {
    console.log('Running hourly notification check...');
    const subs = getSubscriptions();
    let dirty = false;

    subs.forEach(item => {
        const { subscription, config } = item;
        if (!config || config.enabled !== '1') return;

        const startHour = parseInt(config.startHour, 10);
        const endHour = parseInt(config.endHour, 10);
        if (Number.isNaN(startHour) || Number.isNaN(endHour)) return;

        const localNow = getUserLocalNow(config.timezoneOffsetMinutes);
        const localDateStr = localDateString(localNow);
        const localHour = localNow.getUTCHours();

        // Reset the per-day send-tracking when we roll into a new local day.
        if (!item.notifyState || item.notifyState.date !== localDateStr) {
            item.notifyState = { date: localDateStr, reminderSent: false, riskSent: false };
            dirty = true;
        }

        // Already practiced today — nothing to nudge them about.
        if (config.lastPlayedDate === localDateStr) return;

        if (!isWithinNotificationWindow(localHour, startHour, endHour)) return;

        const hoursLeft = hoursRemainingInWindow(localHour, startHour, endHour);
        const isLastStretch = hoursLeft <= 1;

        let kind = null;
        if (isLastStretch && (config.dailyStreak || 0) > 0 && !item.notifyState.riskSent) {
            kind = 'risk';
        } else if (!item.notifyState.reminderSent) {
            kind = 'reminder';
        }

        if (!kind) return;

        const { title, body } = buildNotificationPayload(kind, config, localDateStr);
        const payload = JSON.stringify({ title, body, icon: './img/icon-192.png' });

        webpush.sendNotification(subscription, payload).catch(error => {
            console.error('Error sending notification:', error);
            // Optionally remove failed subscriptions
        });

        if (kind === 'risk') item.notifyState.riskSent = true;
        item.notifyState.reminderSent = true;
        dirty = true;
    });

    if (dirty) writeSubscriptions(subs);
});

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
