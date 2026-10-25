package dev.amit.mail;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/** Receives the server's data-only FCM message and shows the notification itself (with Mark read / Delete / Reply). */
public class MailMessagingService extends FirebaseMessagingService {
  static final String CHANNEL = "mail";
  static final String GROUP = "mail";
  static final int SUMMARY_ID = 1;

  @Override
  public void onNewToken(String token) {
    PushNotificationsPlugin.onNewToken(token);
  }

  @Override
  public void onMessageReceived(RemoteMessage msg) {
    if (MainActivity.visible) { // app is on screen: let the web app refresh instead of notifying
      PushNotificationsPlugin.sendRemoteMessage(msg);
      return;
    }
    Map<String, String> d = msg.getData();
    String id = d.get("id"), t = d.get("t");
    String title = d.get("title") != null ? d.get("title") : "New mail";
    String body = d.get("body") != null ? d.get("body") : "";
    int nid = id != null ? (id.hashCode() & 0x7fffffff) | 2 : (int) (System.currentTimeMillis() & 0x7fffffff) | 2;

    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
      NotificationChannel ch = new NotificationChannel(CHANNEL, "New mail", NotificationManager.IMPORTANCE_HIGH);
      nm.createNotificationChannel(ch);
    }

    int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
    NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_mail)
        .setColor(0xFFD0BCFF)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
        .setAutoCancel(true)
        .setCategory(NotificationCompat.CATEGORY_EMAIL)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setGroup(GROUP)
        .setContentIntent(PendingIntent.getActivity(this, nid, open(id, t, false), flags));

    if (id != null && t != null) {
      b.addAction(0, "Mark read", PendingIntent.getBroadcast(this, nid + 1, act("read", id, t, nid), flags));
      b.addAction(0, "Delete", PendingIntent.getBroadcast(this, nid + 3, act("delete", id, t, nid), flags));
      b.addAction(0, "Reply", PendingIntent.getActivity(this, nid + 5, open(id, t, true), flags));
    }
    NotificationManagerCompat.from(this).notify(nid, b.build());

    int active = 0;
    for (StatusBarNotification n : nm.getActiveNotifications()) if (n.getId() != SUMMARY_ID) active++;
    if (active >= 2) {
      NotificationCompat.Builder s = new NotificationCompat.Builder(this, CHANNEL)
          .setSmallIcon(R.drawable.ic_stat_mail)
          .setColor(0xFFD0BCFF)
          .setContentTitle(active + " new mails")
          .setStyle(new NotificationCompat.InboxStyle().setSummaryText(active + " new mails"))
          .setGroup(GROUP)
          .setGroupSummary(true)
          .setAutoCancel(true)
          .setContentIntent(PendingIntent.getActivity(this, 1, open(null, null, false), flags));
      NotificationManagerCompat.from(this).notify(SUMMARY_ID, s.build());
    }
  }

  private Intent open(String id, String t, boolean reply) {
    Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    if (id != null) i.putExtra("mailId", id).putExtra("mailToken", t).putExtra("reply", reply);
    return i;
  }

  private Intent act(String op, String id, String t, int nid) {
    return new Intent(this, MailActionReceiver.class).putExtra("op", op).putExtra("id", id).putExtra("t", t).putExtra("nid", nid);
  }
}
