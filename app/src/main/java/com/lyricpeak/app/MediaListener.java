package com.lyricpeak.app;

import android.service.notification.NotificationListenerService;

/**
 * Empty on purpose. Android only lets an app read other apps' media sessions
 * (what Spotify is playing, and where it is in the song) if the app has
 * notification access, which is granted to a NotificationListenerService.
 * Lyric Peak never reads or stores your notifications.
 */
public class MediaListener extends NotificationListenerService {
}
