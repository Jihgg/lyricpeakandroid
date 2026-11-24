# Lyric Peak for Android

Full-screen animated lyrics for whatever's playing in **Spotify** (it also works with most other music apps). The words slam in one by one and shake to the beat. Made for the Nothing Phone (4a) Pro, but it runs on any Android 8 or newer.

- **Peak**: big stacked words that punch in one at a time, with glow, a red/blue split and shake on each beat, and music "mountains" along the bottom
- **Flow**: smooth scrolling karaoke lines over the blurred album art
- **Constellation**: each word becomes a star, joined by lines

Tap the screen for controls (play/pause/skip, style, colour, beat, sync). Swipe left or right to change style.

---

## Get the APK (no installs needed, about 5 minutes)

GitHub builds the app for you for free.

1. Make a free account at **github.com** and sign in (works in your laptop's browser).
2. Click **+** (top right), then **New repository**. Name it `lyric-peak`, choose **Public** (easiest for downloading on your phone) and click **Create repository**.
3. On the new page, click the **uploading an existing file** link.
4. Open the unzipped `LyricPeak-Android` folder on your laptop. Press **Ctrl+A** to select **everything inside it**, including the `.github` folder, and drag it all onto the GitHub page.
   Drag the *contents*, not the folder itself.
5. Click **Commit changes**.
6. Open the **Actions** tab. A build called "Build Lyric Peak APK" starts by itself and takes about 3–5 minutes. Wait for the green tick.
7. On your phone, open `github.com/<your-username>/lyric-peak/releases` and tap **LyricPeak.apk** to download it.

**No build in the Actions tab?** The `.github` folder didn't upload. In GitHub, go to **Actions**, then **set up a workflow yourself**, paste in the contents of `.github/workflows/build-apk.yml`, and click **Commit changes**.

## Install it on the phone

1. Open the downloaded **LyricPeak.apk**. If Android asks, allow your browser or Files app to **install unknown apps**.
2. If Play Protect warns about an unknown app, tap **More details**, then **Install anyway**. This is normal for apps that don't come from the Play Store.
3. Open **Lyric Peak** and tap **Allow access**, then turn on Lyric Peak in the list. Android calls this "notification access". It's the only way an app can see which song Spotify is playing. The app never reads your notifications.
   - **Switch greyed out, or it says "Restricted setting"?** Android 13 and newer does this for apps installed from a file. Go to **Settings → Apps → Lyric Peak**, tap **⋮** in the top-right corner, then **Allow restricted settings**. Then try again.
4. Play a song in Spotify and switch back to Lyric Peak.
5. To make it react to the beat: tap the screen, tap **Beat**, then **Allow**. Android lists this under the microphone permission because it reads the phone's audio output, but nothing is recorded.

## Or build it with Android Studio

Open this folder in Android Studio, let it sync, then use **Build → Build App Bundle(s) / APK(s) → Build APK(s)**. The APK ends up in `app/build/outputs/apk/debug/`.

## Notes

- Lyrics come from [LRCLIB](https://lrclib.net), a free community lyrics database. Most popular songs have time-synced lyrics. If a song doesn't, you can search with a different title or artist right on the screen.
- LRCLIB times each line, not each word, so the app spreads each line's words across the line. It's close, but not perfect on very slow or very fast lines. Use **− / +** to shift the timing. The app remembers that setting for each song.
- Fonts: Anton and Inter Display (SIL Open Font License).
