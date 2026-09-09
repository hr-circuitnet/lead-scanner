# CircuitNet Expo Lead Scanner — Deployment Guide

## Package Contents

```
circuitnet/
├── index.html          Main app (open this in a browser)
├── app.js              Application logic
├── sw.js               Service worker (offline caching)
├── manifest.json       PWA manifest
├── icon-192.png        App icon (192×192)
├── icon-512.png        App icon (512×512)
└── lib/
    ├── html5-qrcode.min.js   QR/barcode scanner library
    └── xlsx.full.min.js      Excel export library
```

## Quick Start (Desktop Testing)

1. Unzip the `circuitnet` folder to any location.
2. Open `index.html` in Chrome, Edge, or Firefox.
3. Login with **admin / admin123**.
4. Go to ☰ menu → "Load Demo Data" to see sample leads.
5. Click "Scan Badge" to use the camera (requires webcam + HTTPS or localhost).

> **Note:** Camera access requires either `localhost` or HTTPS. If you open the file directly via `file://`, the camera scanner won't work, but all other features (manual entry, leads, export, dashboard) will function.

---

## Option 1: Web Deployment (Recommended for Expo)

### Using any static web host (Netlify, Vercel, GitHub Pages, Cloudflare Pages, your own server):

1. Upload all files from the `circuitnet/` folder to the web server root (or a subdirectory).
2. Ensure the server serves files over **HTTPS** (required for camera access).
3. Open the URL in a mobile browser.

### Using a simple local server (for testing at the stall):

**Python (already available on most laptops):**
```bash
cd circuitnet
python3 -m http.server 8080
```
Then open `http://localhost:8080` on the same machine, or `http://<your-laptop-IP>:8080` from a phone on the same Wi-Fi.

**Node.js:**
```bash
cd circuitnet
npx http-server -p 8080
```

### Netlify Drop (zero config, 2 minutes):
1. Go to https://app.netlify.com/drop
2. Drag the entire `circuitnet` folder onto the page
3. You get a public HTTPS URL instantly — share it with the team

---

## Option 2: Install as an App on Android

### Method A: Chrome "Add to Home Screen" (Easiest)

1. Deploy the app to a web host with HTTPS (see Option 1).
2. Open the URL in **Chrome** on your Android phone.
3. Tap the **three-dot menu** → **Add to Home screen** → **Install**.
4. The app appears on your home screen with the CircuitNet icon.
5. It works offline (service worker caches everything) and opens full-screen like a native app.

### Method B: PWA Builder APK (for distribution to the team)

1. Deploy the app to a web host with HTTPS.
2. Go to https://www.pwabuilder.com
3. Enter your deployed URL.
4. Click **Package for Stores** → **Android** → **Download**.
5. You get a signed `.apk` file — install it on any Android phone (enable "Install from unknown sources").

### Method C: TWA (Trusted Web Activity) via Android Studio

For advanced users who want a Play Store-ready package:
1. Follow https://developer.chrome.com/docs/android/trusted-web-activity/
2. Use Bubblewrap CLI: `npx @bubblewrap/cli init --manifest=<your-https-url>/manifest.json`
3. `npx @bubblewrap/cli build` → produces a signed AAB for Play Store.

---

## Option 3: Install as an App on iPhone (iOS)

### Method A: Safari "Add to Home Screen" (Easiest)

1. Deploy the app to a web host with HTTPS (see Option 1).
2. Open the URL in **Safari** on your iPhone.
3. Tap the **Share button** (square with arrow) → **Add to Home Screen**.
4. The app appears on your home screen with the CircuitNet icon.
5. It opens in full-screen mode and works offline.

> **Note:** iOS Safari requires HTTPS for camera access. The app uses the rear camera for badge scanning. iOS 16.4+ also supports push notifications for PWAs added to home screen.

---

## Camera Permissions

The scanner requires camera access. When you tap "Start Camera":
- **Android Chrome:** A permission prompt appears. Tap **Allow**.
- **iPhone Safari:** A permission prompt appears. Tap **Allow**.
- If denied, go to browser settings → Site permissions → Camera → Allow.
- The app uses the **rear camera** (environment-facing) by default for scanning badges.

---

## Login Credentials

| Role          | Username  | Password   |
|---------------|-----------|------------|
| Admin         | admin     | admin123   |
| Salesperson   | rajesh    | pass123    |
| Salesperson   | priya     | pass123    |
| Salesperson   | arun      | pass123    |

> Admins can add/edit users and interest categories from the ☰ menu.

---

## Offline-First Behaviour

- **All data is stored locally** in the browser's IndexedDB — leads, users, categories, settings.
- **Scanning, entry, saving, and searching work 100% offline** — no internet needed.
- **Service Worker** caches all app files (HTML, JS, CSS, libraries, icons) for offline use.
- **Sync Status:** Each lead is marked Synced (green), Pending (orange, saved offline), or Failed (red).
- When internet returns, a banner appears and you can tap **Sync Now** to sync all pending leads.
- **Data is never lost** if the app closes or internet drops — everything is persisted to IndexedDB immediately.

---

## Data Export

1. Tap **Export** from the dashboard or bottom nav.
2. Apply filters (priority, interest, salesperson, sync status) or export all.
3. Tap **CSV File** or **Excel (.xlsx)** to download.
4. The file is saved to the device's Downloads folder.

---

## Admin Features

- **☰ → User Management:** Add/edit/delete salespersons and admins. Set passwords, roles, and active status.
- **☰ → Interest Categories:** Add/edit/delete interest categories that appear in the lead form.
- **☰ → Settings:** Configure company name, event name, venue, and default lead source.
- **☰ → Load Demo Data:** Load 8 sample leads for testing the complete workflow.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Camera doesn't open | Use HTTPS or localhost. Check browser camera permissions. Try Chrome on Android or Safari on iOS. |
| Scanner doesn't detect badge | Ensure good lighting. Hold the phone 10-15cm from the QR code. The scanner supports QR codes and common barcodes. |
| App doesn't work offline | Open the app at least once while online so the service worker can cache files. After that, it works offline. |
| Export doesn't download | Check browser download permissions. On iOS, files save to the Files app. |
| Lost data after closing | Data is stored in IndexedDB per browser. Use the same browser/app. Clearing browser data will erase leads — export before clearing. |
| "Add to Home Screen" not available | Use Chrome (Android) or Safari (iOS). Other browsers may not support PWA installation. |

---

## Browser Compatibility

| Browser | Scanner | Offline | Export | Install as App |
|---------|---------|---------|--------|----------------|
| Chrome (Android) | ✅ | ✅ | ✅ | ✅ |
| Safari (iOS 16.4+) | ✅ | ✅ | ✅ | ✅ |
| Chrome (Desktop) | ✅ (webcam) | ✅ | ✅ | ✅ |
| Edge (Desktop) | ✅ (webcam) | ✅ | ✅ | ✅ |
| Firefox | ✅ | ✅ | ✅ | ❌ |

---

## Data Backup

**Important:** Leads are stored in the browser's IndexedDB. To back up:
1. Go to **Export** → export all leads as Excel or CSV.
2. Store the exported file safely.
3. Before clearing browser data or changing devices, always export first.

For multi-device sync, deploy to a shared web host — each salesperson uses their own login. (Note: this version stores data locally per device; a backend sync server can be added in a future version.)

---

## Architecture

- **Frontend:** Vanilla HTML5 + CSS3 + JavaScript (no framework, no build step)
- **Storage:** IndexedDB (browser database, persists across sessions)
- **Scanner:** html5-qrcode library (supports QR, Code 128, Code 39, EAN, UPC, etc.)
- **Export:** SheetJS (xlsx) library for Excel; native Blob for CSV
- **Offline:** Service Worker + Cache API for file caching; IndexedDB for data
- **PWA:** Web App Manifest for installable app with icons

© CircuitNet Technologies — Electronica 2026
