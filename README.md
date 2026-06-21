# BTC AI WORK — Chrome Miner: Installation and User Guide

This is a Chrome browser extension. It connects your computer to the pool and
performs Bitcoin mining (SHA-256 algorithm) directly in the browser. Hashrate and
status are displayed in the extension window. Mining starts only after pressing
Start and can be stopped at any time.

---

## ⚠️ Read This First

- **Mining puts a heavy load on your CPU.** While running, your computer will get warmer,
  fans will work harder, and power consumption will increase.
- **You should not expect to make money.** Browser-based Bitcoin mining generates
  approximately zero profit. The Bitcoin network operates billions of times faster
  than an ordinary computer, so valid shares are found very rarely and the actual
  earnings are close to zero. This is a technical and demonstration tool, **not an
  income source**.
- **You mine to your own wallet.** In the settings, you enter your own BTC address;
  anything that is theoretically credited goes directly to it.
- **This is an unpacked extension, not from the Chrome Web Store.** Install it only
  if you trust the source from which you downloaded the archive. It uses your PC resources.

If you understand and accept the above, continue.

---

## Requirements

- **Chrome** browser (or another Chromium-based browser such as Edge, Brave, or Opera).
- A **ZIP archive** containing the extension.
- A Windows, macOS, or Linux computer.

## Installation — 5 Steps

1. Download the ZIP archive and **extract** it to any folder. Inside you will find the
   **`extension`** folder (this is the one you need).
2. Open **`chrome://extensions`** in Chrome.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the **`extension`** folder from the extracted archive. The **₿** icon will appear.

> If you do not see the icon, click the puzzle 🧩 icon to the right of the address bar and pin the extension.

## Starting Mining

1. Click the **₿** icon to open the extension window.
2. Enter your **BTC wallet address**. The password field is already set to `x` and does not need to be changed. The server address is also preconfigured.
3. Click **Connect and Mine**.
4. If everything is working correctly, the status indicator will turn green, the hashrate will appear, and log messages will start updating.

You can close the extension window — mining will continue in the background as long as Chrome remains open. To stop mining, open the window again and click **Stop**.

## How to Verify That It Is Working

In the **Stratum Log**, you should see the following messages in order:

`websocket open` → `pool connected` → `subscribed` → `authorized ✓` → `job`

The **hashrate** should start increasing. The **accepted** field shows shares accepted by the pool. On a normal computer, there may be very few or none at all, which is completely normal.

## Troubleshooting

- **"Connection error" or unable to connect** — check your Internet connection. The server may be temporarily unavailable; try again later.
- **Empty window or unresponsive button** — reinstall the extension: remove it from `chrome://extensions` and load it again using **Load unpacked**.
- **Computer gets hot or noisy** — this is expected during mining. Stop the extension if necessary.

## Uninstalling

Open `chrome://extensions`, find the extension, and click **Remove**. Mining will stop completely.
