package dev.amit.mail;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.app.NotificationManagerCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/** Notification buttons: runs Mark read / Delete on the server with the mail's push token (no sign-in needed). */
public class MailActionReceiver extends BroadcastReceiver {
  static final String BASE = "https://mail.amit.is-a.dev";

  @Override
  public void onReceive(Context ctx, Intent i) {
    final PendingResult pr = goAsync();
    final String op = i.getStringExtra("op"), id = i.getStringExtra("id"), t = i.getStringExtra("t");
    NotificationManagerCompat.from(ctx).cancel(i.getIntExtra("nid", 0));
    new Thread(() -> {
      try {
        JSONObject o = new JSONObject().put("op", op).put("id", id).put("t", t);
        HttpURLConnection h = (HttpURLConnection) new URL(BASE + "/api/push/action").openConnection();
        h.setRequestMethod("POST");
        h.setRequestProperty("Content-Type", "application/json");
        h.setConnectTimeout(10000);
        h.setReadTimeout(10000);
        h.setDoOutput(true);
        try (OutputStream out = h.getOutputStream()) { out.write(o.toString().getBytes("UTF-8")); }
        h.getResponseCode();
        h.disconnect();
      } catch (Exception ignored) {
      } finally {
        pr.finish();
      }
    }).start();
  }
}
