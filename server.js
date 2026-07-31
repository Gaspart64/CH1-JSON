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

function saveSubscription(sub, config) {
    let subs = getSubscriptions();
    // Update or add
    const index = subs.findIndex(s => s.subscription.endpoint === sub.endpoint);
    if (index > -1) {
        subs[index].config = config;
    } else {
        subs.push({ subscription: sub, config: config });
    }
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2));
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

// Hourly Cron Job (every hour at :00)
cron.schedule('0 * * * *', () => {
    console.log('Running hourly notification check...');
    const subs = getSubscriptions();
    const now = new Date();
    const hour = now.getHours();

    subs.forEach(item => {
        const { subscription, config } = item;
        const startHour = parseInt(config.startHour);
        const endHour = parseInt(config.endHour);

        let isWithinRange = false;
        if (startHour <= endHour) {
            isWithinRange = (hour >= startHour && hour <= endHour);
        } else {
            isWithinRange = (hour >= startHour || hour <= endHour);
        }

        if (isWithinRange && config.enabled === '1') {
            const payload = JSON.stringify({
                title: 'Time for Puzzles!',
                body: 'It\'s time to solve your hourly set of chess puzzles!',
                icon: './img/icon-192.png'
            });

            webpush.sendNotification(subscription, payload).catch(error => {
                console.error('Error sending notification:', error);
                // Optionally remove failed subscriptions
            });
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
