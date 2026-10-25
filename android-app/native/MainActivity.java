package dev.amit.mail;

import android.content.Intent;
import android.net.MailTo;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.Display;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.animation.OvershootInterpolator;
import android.webkit.JavascriptInterface;
import android.widget.FrameLayout;
import android.widget.ImageView;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.BridgeActivity;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
  static volatile boolean visible = false;
  private static String pending = "";
  private FrameLayout splash;
  private long splashAt;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setStatusBarColor(0xFF141316);
    getWindow().setNavigationBarColor(0xFF141316);

    // Ask for the highest refresh rate at the current resolution (120 Hz).
    Display display = getWindowManager().getDefaultDisplay();
    Display.Mode cur = display.getMode();
    Display.Mode best = cur;
    for (Display.Mode m : display.getSupportedModes()) {
      if (m.getPhysicalWidth() == cur.getPhysicalWidth() && m.getPhysicalHeight() == cur.getPhysicalHeight()
          && m.getRefreshRate() > best.getRefreshRate()) best = m;
    }
    WindowManager.LayoutParams lp = getWindow().getAttributes();
    lp.preferredDisplayModeId = best.getModeId();
    lp.preferredRefreshRate = best.getRefreshRate();
    getWindow().setAttributes(lp);

    getBridge().getWebView().addJavascriptInterface(new Native(), "MailNative");
    handleIntent(getIntent());
    showSplash();
  }

  @Override protected void onResume() { super.onResume(); visible = true; }
  @Override protected void onPause() { visible = false; super.onPause(); }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    handleIntent(intent);
    getBridge().getWebView().post(() ->
        getBridge().getWebView().evaluateJavascript("window.__nativePending&&window.__nativePending()", null));
  }

  /** Turns a notification tap, a mailto: link or a shared text into a small JSON the web app picks up. */
  private void handleIntent(Intent i) {
    if (i == null) return;
    try {
      JSONObject o = null;
      String a = i.getAction();
      if (i.hasExtra("mailId")) {
        o = new JSONObject().put("kind", "mail").put("id", i.getStringExtra("mailId"))
            .put("t", i.getStringExtra("mailToken")).put("reply", i.getBooleanExtra("reply", false));
      } else if ((Intent.ACTION_SENDTO.equals(a) || Intent.ACTION_VIEW.equals(a)) && i.getData() != null
          && "mailto".equals(i.getData().getScheme())) {
        MailTo mt = MailTo.parse(i.getData().toString());
        JSONArray to = new JSONArray();
        if (mt.getTo() != null) for (String s : mt.getTo().split("[,;]")) if (!s.trim().isEmpty()) to.put(s.trim());
        o = new JSONObject().put("kind", "compose").put("to", to).put("subject", mt.getSubject() == null ? "" : mt.getSubject())
            .put("body", mt.getBody() == null ? "" : mt.getBody());
      } else if (Intent.ACTION_SEND.equals(a)) {
        String text = i.getStringExtra(Intent.EXTRA_TEXT);
        String subj = i.getStringExtra(Intent.EXTRA_SUBJECT);
        o = new JSONObject().put("kind", "compose").put("to", new JSONArray()).put("subject", subj == null ? "" : subj)
            .put("body", text == null ? "" : text);
      }
      if (o != null) {
        pending = o.toString();
        i.replaceExtras(new Bundle());
        i.setData(null);
        i.setAction(Intent.ACTION_MAIN);
      }
    } catch (Exception ignored) {
    }
  }

  private void showSplash() {
    splash = new FrameLayout(this);
    splash.setBackgroundColor(0xFF141316);
    ImageView iv = new ImageView(this);
    iv.setImageResource(R.mipmap.ic_launcher);
    int s = (int) (96 * getResources().getDisplayMetrics().density);
    splash.addView(iv, new FrameLayout.LayoutParams(s, s, Gravity.CENTER));
    addContentView(splash, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    iv.setAlpha(0f);
    iv.setScaleX(0.7f);
    iv.setScaleY(0.7f);
    iv.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(500).setInterpolator(new OvershootInterpolator(1.4f)).start();
    splashAt = SystemClock.uptimeMillis();
    splash.postDelayed(this::hideSplash, 6000); // never get stuck
  }

  private void hideSplash() {
    final View v = splash;
    if (v == null) return;
    splash = null;
    long wait = Math.max(0, 800 - (SystemClock.uptimeMillis() - splashAt)); // let the animation finish
    v.postDelayed(() -> v.animate().alpha(0f).scaleX(1.06f).scaleY(1.06f).setDuration(280).withEndAction(() -> {
      if (v.getParent() instanceof ViewGroup) ((ViewGroup) v.getParent()).removeView(v);
    }).start(), wait);
  }

  /** Called from the web app as window.MailNative.* */
  private class Native {
    @JavascriptInterface public String takePending() { String p = pending; pending = ""; return p; }

    @JavascriptInterface public void hideSplash() { runOnUiThread(MainActivity.this::hideSplash); }

    @JavascriptInterface public void haptic(String kind) {
      final int c = "heavy".equals(kind) ? HapticFeedbackConstants.LONG_PRESS
          : "success".equals(kind) ? (Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.CONTEXT_CLICK)
          : HapticFeedbackConstants.CLOCK_TICK;
      runOnUiThread(() -> getBridge().getWebView().performHapticFeedback(c, HapticFeedbackConstants.FLAG_IGNORE_GLOBAL_SETTING));
    }

    /** Nothing unread: clear leftover notifications so the icon badge goes away. */
    @JavascriptInterface public void setUnread(int n) {
      if (n <= 0) NotificationManagerCompat.from(MainActivity.this).cancelAll();
    }
  }
}
