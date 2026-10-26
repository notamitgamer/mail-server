package dev.amit.mail;

import android.animation.ValueAnimator;
import android.content.Context;
import android.content.Intent;
import android.graphics.Camera;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.net.MailTo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.Display;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.webkit.JavascriptInterface;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.graphics.PathParser;
import com.getcapacitor.BridgeActivity;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
  public static volatile boolean visible = false;
  private static String pending = "";
  private FrameLayout splash;
  private long splashAt;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setStatusBarColor(0xFF141316);
    getWindow().setNavigationBarColor(0xFF141316);

    // Request highest refresh rate (e.g. 120 Hz)
    Display display = getWindowManager().getDefaultDisplay();
    Display.Mode cur = display.getMode();
    Display.Mode best = cur;
    for (Display.Mode m : display.getSupportedModes()) {
      if (m.getPhysicalWidth() == cur.getPhysicalWidth() && m.getPhysicalHeight() == cur.getPhysicalHeight()
          && m.getRefreshRate() > best.getRefreshRate()) {
        best = m;
      }
    }
    WindowManager.LayoutParams lp = getWindow().getAttributes();
    lp.preferredDisplayModeId = best.getModeId();
    lp.preferredRefreshRate = best.getRefreshRate();
    getWindow().setAttributes(lp);

    getBridge().getWebView().addJavascriptInterface(new Native(), "MailNative");

    // Capacitor core has no back handling without @capacitor/app, so back used to close the app from anywhere.
    // Ask the web app to close its top layer (mail view / sidebar); leave the app only when nothing is open.
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override
      public void handleOnBackPressed() {
        getBridge().getWebView().evaluateJavascript(
            "(window.__layerBack&&window.__layerBack())===true",
            v -> {
              if (!"true".equals(v)) finish();
            });
      }
    });
    handleIntent(getIntent());
    showSplash();
  }

  @Override
  public void onResume() {
    super.onResume();
    visible = true;
    getBridge().getWebView().post(() ->
        getBridge().getWebView().evaluateJavascript("window.__nativeResume&&window.__nativeResume()", null));
  }

  @Override
  public void onPause() {
    visible = false;
    super.onPause();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    handleIntent(intent);
    getBridge().getWebView().post(() ->
        getBridge().getWebView().evaluateJavascript("window.__nativePending&&window.__nativePending()", null));
  }

  /** Turns notification taps, mailto links, or share intents into JSON for the web client. */
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
        if (mt.getTo() != null) {
          for (String s : mt.getTo().split("[,;]")) {
            if (!s.trim().isEmpty()) to.put(s.trim());
          }
        }
        o = new JSONObject().put("kind", "compose").put("to", to)
            .put("subject", mt.getSubject() == null ? "" : mt.getSubject())
            .put("body", mt.getBody() == null ? "" : mt.getBody());
      } else if (Intent.ACTION_SEND.equals(a)) {
        String text = i.getStringExtra(Intent.EXTRA_TEXT);
        String subj = i.getStringExtra(Intent.EXTRA_SUBJECT);
        o = new JSONObject().put("kind", "compose").put("to", new JSONArray())
            .put("subject", subj == null ? "" : subj)
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

  /**
   * Builds and displays the origami fold splash screen from ^ and M components.
   */
  private void showSplash() {
    splash = new FrameLayout(this);
    splash.setBackgroundColor(0xFF141316);

    // Centered container holding the animated icon view and brand title
    LinearLayout centerLayout = new LinearLayout(this);
    centerLayout.setOrientation(LinearLayout.VERTICAL);
    centerLayout.setGravity(Gravity.CENTER);

    final OrigamiSplashView iconView = new OrigamiSplashView(this);
    int size = (int) (140 * getResources().getDisplayMetrics().density);
    centerLayout.addView(iconView, new LinearLayout.LayoutParams(size, size));

    splash.addView(centerLayout, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

    // Footer pinned to the bottom: brand name plus the same credit as the sign-in page
    final float dp = getResources().getDisplayMetrics().density;
    final LinearLayout footer = new LinearLayout(this);
    footer.setOrientation(LinearLayout.VERTICAL);
    footer.setGravity(Gravity.CENTER_HORIZONTAL);
    footer.setAlpha(0f);
    footer.setTranslationY(12f);

    final TextView tvBrand = new TextView(this);
    tvBrand.setText("Mailbox");
    tvBrand.setTextSize(18f);
    tvBrand.setTextColor(0xFFE5E1E6);
    tvBrand.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
    tvBrand.setGravity(Gravity.CENTER);
    footer.addView(tvBrand, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    final TextView tvCredit = new TextView(this);
    tvCredit.setText("Mailbox UI built on SmartMail by ThemePixels (MIT licence).\n"
        + "Edited and maintained by notamitgamer.\n\n"
        + "\u00A9 2026\u2013present notamitgamer \u00B7 mail.amit.is-a.dev");
    tvCredit.setTextSize(12f);
    tvCredit.setTextColor(0xFF938F99);
    tvCredit.setGravity(Gravity.CENTER);
    tvCredit.setLineSpacing(0f, 1.3f);
    LinearLayout.LayoutParams creditParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    creditParams.topMargin = (int) (10 * dp);
    footer.addView(tvCredit, creditParams);

    FrameLayout.LayoutParams footerParams = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
    footerParams.bottomMargin = (int) (32 * dp);
    footerParams.leftMargin = (int) (24 * dp);
    footerParams.rightMargin = (int) (24 * dp);
    splash.addView(footer, footerParams);

    addContentView(splash, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    // Start Timeline Animator (0.0f -> 1.0f)
    ValueAnimator animator = ValueAnimator.ofFloat(0f, 1f);
    animator.setDuration(1200);
    animator.addUpdateListener(animation -> {
      float p = (float) animation.getAnimatedValue();
      iconView.setProgress(p);

      // Fade in brand caption as the flap completes its fold
      if (p >= 0.65f) {
        float bp = Math.min(1f, (p - 0.65f) / 0.25f);
        footer.setAlpha(bp);
        footer.setTranslationY((1f - bp) * 12f);
      } else {
        footer.setAlpha(0f);
      }
    });
    animator.start();

    splashAt = SystemClock.uptimeMillis();
    splash.postDelayed(this::hideSplash, 6000); // Fail-safe fallback timeout
  }

  private void hideSplash() {
    final View v = splash;
    if (v == null) return;
    splash = null;
    long wait = Math.max(0, 1150 - (SystemClock.uptimeMillis() - splashAt)); // Wait for fold completion
    v.postDelayed(() -> v.animate()
        .alpha(0f)
        .scaleX(1.04f)
        .scaleY(1.04f)
        .setDuration(260)
        .setInterpolator(new DecelerateInterpolator())
        .withEndAction(() -> {
          if (v.getParent() instanceof ViewGroup) {
            ((ViewGroup) v.getParent()).removeView(v);
          }
        }).start(), wait);
  }

  /**
   * Custom hardware-accelerated 3D Origami Vector View.
   * Renders the exact SVG path data for the pocket M and flap ^.
   */
  private static class OrigamiSplashView extends View {
    // Exact SVG paths extracted from icon-512.svg
    private static final String PATH_DATA_POCKET =
        "M0 0 C1.5 1.29 1.5 1.29 3.03 2.61 C6.82 5.87 10.68 9.04 14.56 12.19 C15.26 12.75 15.95 13.31 16.66 13.89 " +
        "C21.14 17.52 25.65 21.09 30.19 24.62 C35.27 28.59 40.21 32.68 45.1 36.87 C49.61 40.71 54.24 44.38 58.91 48.02 " +
        "C63.34 51.47 67.69 54.99 72.02 58.55 C75.69 61.57 79.38 64.57 83.06 67.56 C83.76 68.13 84.45 68.69 85.17 69.27 " +
        "C89.54 72.82 93.93 76.35 98.33 79.86 C101.12 82.1 103.9 84.36 106.68 86.62 C112.95 91.73 119.24 96.79 125.62 101.75 " +
        "C128.93 104.33 132.18 106.97 135.41 109.66 C136.54 110.6 136.54 110.6 137.69 111.56 C139.15 112.78 140.6 114 142.05 115.23 " +
        "C149.44 121.47 149.44 121.47 158.44 124.5 C166.5 123.37 172.34 118.41 178.38 113.25 C179.88 111.99 181.39 110.72 182.89 109.46 " +
        "C183.97 108.55 183.97 108.55 185.06 107.63 C187.36 105.7 189.7 103.81 192.06 101.94 C196.32 98.55 200.54 95.12 204.75 91.69 " +
        "C209.77 87.59 214.83 83.55 219.94 79.56 C226.62 74.35 233.15 68.96 239.68 63.56 C248.83 56 258.05 48.54 267.33 41.14 " +
        "C270.12 38.9 272.9 36.64 275.68 34.37 C281.44 29.68 287.21 25.02 293.06 20.44 C298.12 16.48 303.16 12.5 308.19 8.5 " +
        "C309.14 7.74 309.14 7.74 310.12 6.97 C312.88 4.76 315.53 2.54 318 0 C319.46 2.93 319.14 5.51 319.15 8.78 " +
        "C319.15 9.48 319.15 10.19 319.16 10.92 C319.17 13.29 319.17 15.67 319.18 18.04 C319.18 19.74 319.19 21.44 319.2 23.14 " +
        "C319.21 27.76 319.22 32.38 319.23 37.01 C319.24 39.9 319.24 42.79 319.25 45.68 C319.27 54.73 319.28 63.77 319.29 72.82 " +
        "C319.3 83.25 319.33 93.69 319.37 104.12 C319.4 112.19 319.41 120.26 319.42 128.33 C319.42 133.15 319.43 137.96 319.45 142.78 " +
        "C319.48 147.32 319.48 151.85 319.47 156.39 C319.47 158.05 319.48 159.71 319.49 161.37 C319.59 173.92 318.22 183.56 309.29 193.02 " +
        "C303.77 197.79 296.77 201.11 289.43 201.14 C288.49 201.15 287.55 201.15 286.58 201.16 C285.54 201.16 284.5 201.16 283.43 201.16 " +
        "C282.33 201.17 281.23 201.17 280.1 201.18 C276.39 201.19 272.68 201.2 268.97 201.21 C267 201.22 265.02 201.22 263.05 201.23 " +
        "C254.4 201.26 245.75 201.29 237.11 201.3 C234.86 201.31 232.6 201.31 230.35 201.32 C216.36 201.35 202.37 201.38 188.37 201.39 " +
        "C185.13 201.4 181.89 201.4 178.65 201.41 C177.44 201.41 177.44 201.41 176.21 201.41 C163.17 201.43 150.13 201.47 137.09 201.52 " +
        "C123.7 201.57 110.31 201.6 96.91 201.61 C89.4 201.61 81.88 201.62 74.37 201.66 C67.96 201.7 61.56 201.71 55.15 201.7 " +
        "C51.89 201.69 48.62 201.7 45.36 201.73 C18.67 201.94 18.67 201.94 8.81 193.02 C1.68 185.8 -1.12 176.92 -1.13 167 " +
        "C-1.13 166.3 -1.13 165.59 -1.13 164.87 C-1.14 162.51 -1.13 160.15 -1.13 157.79 C-1.13 156.1 -1.13 154.4 -1.13 152.71 " +
        "C-1.14 148.12 -1.14 143.52 -1.13 138.93 C-1.13 134.12 -1.13 129.32 -1.14 124.52 C-1.14 116.45 -1.14 108.39 -1.13 100.32 " +
        "C-1.12 90.99 -1.13 81.65 -1.13 72.32 C-1.14 64.31 -1.14 56.31 -1.13 48.3 C-1.13 43.51 -1.13 38.73 -1.14 33.94 " +
        "C-1.14 29.45 -1.14 24.95 -1.13 20.45 C-1.13 18.8 -1.13 17.15 -1.13 15.49 C-1.14 13.24 -1.13 10.99 -1.13 8.74 " +
        "C-1.13 7.48 -1.13 6.22 -1.13 4.92 C-1 2 -1 2 0 0 Z";

    private static final String PATH_DATA_FLAP =
        "M0 0 C1.09 -0 2.19 -0.01 3.31 -0.01 C6.99 -0.02 10.66 -0.01 14.33 -0 C16.96 -0.01 19.59 -0.01 22.22 -0.02 " +
        "C28.62 -0.02 35.03 -0.02 41.44 -0.02 C46.64 -0.01 51.85 -0.01 57.06 -0.01 C57.8 -0.01 58.54 -0.01 59.3 -0.01 " +
        "C60.81 -0.02 62.31 -0.02 63.82 -0.02 C77.94 -0.02 92.06 -0.02 106.18 -0 C118.29 0 130.4 0 142.52 -0.01 " +
        "C156.58 -0.02 170.65 -0.02 184.72 -0.02 C186.22 -0.01 187.72 -0.01 189.22 -0.01 C190.32 -0.01 190.32 -0.01 191.45 -0.01 " +
        "C196.65 -0.01 201.85 -0.01 207.05 -0.02 C213.39 -0.02 219.73 -0.02 226.07 -0.01 C229.3 -0.01 232.53 -0.01 235.77 -0.01 " +
        "C239.27 -0.02 242.78 -0.01 246.29 0 C247.82 -0.01 247.82 -0.01 249.38 -0.01 C254.74 0.02 259.2 0.48 264.27 2.25 " +
        "C260.9 6.55 257.4 9.97 253.02 13.25 C251.78 14.21 250.53 15.17 249.29 16.13 C248.63 16.63 247.98 17.14 247.31 17.66 " +
        "C243.74 20.45 240.26 23.36 236.77 26.25 C231.66 30.49 226.51 34.67 221.27 38.75 C214.61 43.94 208.1 49.31 201.59 54.69 " +
        "C192.44 62.25 183.22 69.72 173.94 77.11 C171.15 79.35 168.37 81.61 165.59 83.88 C159.31 89 152.98 94.07 146.59 99.07 " +
        "C139.4 104.69 132.34 110.48 125.27 116.25 C122.5 114.96 120.22 113.55 117.87 111.6 C117.24 111.08 116.6 110.56 115.94 110.02 " +
        "C115.27 109.46 114.59 108.89 113.9 108.32 C112.45 107.13 111 105.94 109.56 104.75 C108.83 104.16 108.11 103.57 107.37 102.96 " +
        "C104.39 100.53 101.36 98.17 98.33 95.82 C91.65 90.6 85.12 85.22 78.59 79.82 C69.44 72.26 60.22 64.79 50.94 57.4 " +
        "C48.15 55.16 45.37 52.89 42.59 50.63 C36.88 45.97 31.15 41.35 25.33 36.82 C19.39 32.18 13.57 27.42 7.76 22.61 " +
        "C4.08 19.57 0.39 16.54 -3.33 13.54 C-4.07 12.95 -4.81 12.35 -5.57 11.74 C-6.98 10.61 -8.4 9.47 -9.82 8.34 " +
        "C-14.62 4.47 -14.62 4.47 -15.73 2.25 C-10.7 -0.45 -5.55 -0.02 0 0 Z";

    private final Path pocketPath;
    private final Path flapPath;
    private final Paint pocketPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint flapPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint gleamPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private final Camera camera = new Camera();
    private final Matrix matrix3D = new Matrix();

    private float progress = 0f;

    public OrigamiSplashView(Context context) {
      super(context);
      setLayerType(LAYER_TYPE_HARDWARE, null);

      // Parse exact SVG path data
      Path rawPocket = PathParser.createPathFromPathData(PATH_DATA_POCKET);
      Path rawFlap = PathParser.createPathFromPathData(PATH_DATA_FLAP);

      // Apply SVG translate offsets (from original vector viewBox 512x512)
      pocketPath = new Path();
      Matrix m1 = new Matrix();
      m1.postTranslate(97f, 167f);
      rawPocket.transform(m1, pocketPath);

      flapPath = new Path();
      Matrix m2 = new Matrix();
      m2.postTranslate(131.728f, 143.746f);
      rawFlap.transform(m2, flapPath);

      pocketPaint.setStyle(Paint.Style.FILL);
      pocketPaint.setColor(0xFFCFBBFE);

      flapPaint.setStyle(Paint.Style.FILL);
      flapPaint.setColor(0xFFCFBBFE);

      gleamPaint.setStyle(Paint.Style.FILL);
    }

    public void setProgress(float p) {
      this.progress = Math.max(0f, Math.min(1f, p));
      invalidate();
    }

    private static float easeOutCubic(float x) {
      return 1f - (float) Math.pow(1f - x, 3);
    }

    private static float easeInOutQuad(float x) {
      return x < 0.5f ? 2f * x * x : 1f - (float) Math.pow(-2f * x + 2f, 2) / 2f;
    }

    @Override
    protected void onDraw(Canvas canvas) {
      super.onDraw(canvas);

      final float viewW = getWidth();
      final float viewH = getHeight();
      if (viewW <= 0 || viewH <= 0) return;

      // Coordinate scaling from 512x512 canvas
      final float scale = viewW / 512f;
      final float hingeX = 256f * scale;
      final float hingeY = 143.75f * scale;

      // ==========================================
      // PHASE 1 & 2: Disassembled Entry & Convergence (0.00 -> 0.55)
      // ==========================================
      if (progress < 0.55f) {
        float pNorm = Math.min(1f, progress / 0.50f);
        float eased = easeOutCubic(pNorm);

        // Pocket M enters from +45dp below
        float mOffsetY = (1f - eased) * (45f * getResources().getDisplayMetrics().density);
        pocketPaint.setAlpha((int) (eased * 255));

        canvas.save();
        canvas.translate(0, mOffsetY);
        canvas.scale(scale, scale);
        canvas.drawPath(pocketPath, pocketPaint);
        canvas.restore();

        // Chevron ^ enters flipped upright (-180deg) from -50dp above
        float flapOffsetY = (1f - eased) * (-50f * getResources().getDisplayMetrics().density);
        flapPaint.setAlpha((int) (eased * 255));
        flapPaint.setColor(0xFF9A81D4); // Soft backface lighting tone

        canvas.save();
        canvas.translate(0, flapOffsetY);
        camera.save();
        camera.rotateX(-180f);
        camera.getMatrix(matrix3D);
        camera.restore();

        matrix3D.preTranslate(-hingeX, -hingeY);
        matrix3D.postTranslate(hingeX, hingeY);
        canvas.concat(matrix3D);

        canvas.scale(scale, scale);
        canvas.drawPath(flapPath, flapPaint);
        canvas.restore();
      }
      // ==========================================
      // PHASE 3: 3D Fold of the ^ Part Over M (0.55 -> 0.88)
      // ==========================================
      else if (progress <= 0.88f) {
        float foldNorm = (progress - 0.55f) / 0.33f;
        float foldEase = easeInOutQuad(foldNorm);

        // Pocket is stationary at center
        pocketPaint.setAlpha(255);
        canvas.save();
        canvas.scale(scale, scale);
        canvas.drawPath(pocketPath, pocketPaint);
        canvas.restore();

        // 3D rotation from -180deg to 0deg (no overshoot bounce)
        float rotX = -180f + (foldEase * 180f);
        flapPaint.setAlpha(255);

        // Shading based on orientation
        if (rotX < -90f) {
          flapPaint.setColor(0xFF9A81D4);
        } else {
          flapPaint.setColor(0xFFCFBBFE);
        }

        canvas.save();
        camera.save();
        camera.rotateX(rotX);
        camera.getMatrix(matrix3D);
        camera.restore();

        matrix3D.preTranslate(-hingeX, -hingeY);
        matrix3D.postTranslate(hingeX, hingeY);
        canvas.concat(matrix3D);

        canvas.scale(scale, scale);
        canvas.drawPath(flapPath, flapPaint);
        canvas.restore();
      }
      // ==========================================
      // PHASE 4: Sealed Icon & Minimal Seam Gleam (0.88 -> 1.00)
      // ==========================================
      else {
        pocketPaint.setAlpha(255);
        flapPaint.setAlpha(255);
        flapPaint.setColor(0xFFCFBBFE);

        // Draw flat resting pocket and flap
        canvas.save();
        canvas.scale(scale, scale);
        canvas.drawPath(pocketPath, pocketPaint);
        canvas.drawPath(flapPath, flapPaint);
        canvas.restore();

        // Minimal linear gleam along the fold seam
        float settleNorm = (progress - 0.88f) / 0.12f;
        float gleamAlpha = (float) Math.sin(settleNorm * Math.PI) * 0.75f;
        if (gleamAlpha > 0f) {
          int alpha = (int) (gleamAlpha * 255);
          LinearGradient gleamGrad = new LinearGradient(
              hingeX - 80f * scale, hingeY, hingeX + 80f * scale, hingeY,
              new int[]{0x00FFFFFF, Color.argb(alpha, 255, 255, 255), 0x00FFFFFF},
              new float[]{0f, 0.5f, 1f},
              Shader.TileMode.CLAMP);
          gleamPaint.setShader(gleamGrad);
          canvas.drawRect(hingeX - 80f * scale, hingeY - (1.5f * scale), hingeX + 80f * scale, hingeY + (1.5f * scale), gleamPaint);
        }
      }
    }
  }

  /** Called from the web app as window.MailNative.* */
  private class Native {
    @JavascriptInterface
    public String takePending() {
      String p = pending;
      pending = "";
      return p;
    }

    @JavascriptInterface
    public void hideSplash() {
      runOnUiThread(MainActivity.this::hideSplash);
    }

    @JavascriptInterface
    public void haptic(String kind) {
      final int c = "heavy".equals(kind) ? HapticFeedbackConstants.LONG_PRESS
          : "success".equals(kind) ? (Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.CONTEXT_CLICK)
          : HapticFeedbackConstants.CLOCK_TICK;
      runOnUiThread(() -> getBridge().getWebView().performHapticFeedback(c, HapticFeedbackConstants.FLAG_IGNORE_GLOBAL_SETTING));
    }

    /** Build number of the installed app (the release workflow sets it to the run number). */
    @JavascriptInterface
    public int versionCode() {
      try {
        android.content.pm.PackageInfo pi = MainActivity.this.getPackageManager().getPackageInfo(MainActivity.this.getPackageName(), 0);
        return (int) (Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode);
      } catch (Exception e) {
        return 0;
      }
    }

    /** Opens a release download in the browser; only this repo's GitHub URLs are allowed. */
    @JavascriptInterface
    public void openUrl(String u) {
      if (u == null || !u.startsWith("https://github.com/notamitgamer/mail-server/")) return;
      runOnUiThread(() -> MainActivity.this.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))));
    }

    /**
     * Saves an attachment (base64) into the Downloads folder and offers to open it. A WebView cannot download a
     * blob itself. Needs Android 10+ (no storage permission is required there); returns false otherwise.
     */
    @JavascriptInterface
    public boolean saveFile(String name, String mime, String base64) {
      if (Build.VERSION.SDK_INT < 29 || base64 == null) return false;
      try {
        String safe = (name == null ? "" : name).replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
        if (safe.isEmpty()) safe = "attachment";
        final String type = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
        byte[] data = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        android.content.ContentResolver cr = MainActivity.this.getContentResolver();
        android.content.ContentValues v = new android.content.ContentValues();
        v.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, safe);
        v.put(android.provider.MediaStore.Downloads.MIME_TYPE, type);
        v.put(android.provider.MediaStore.Downloads.IS_PENDING, 1);
        final Uri uri = cr.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) return false;
        try (java.io.OutputStream os = cr.openOutputStream(uri)) {
          if (os == null) return false;
          os.write(data);
        }
        v.clear();
        v.put(android.provider.MediaStore.Downloads.IS_PENDING, 0);
        cr.update(uri, v, null, null);
        if (!"application/vnd.android.package-archive".equals(type)) { // never launch an installer from a mail
          runOnUiThread(() -> {
            try {
              MainActivity.this.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
                  .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) { // no app can open it: it is still in Downloads
            }
          });
        }
        return true;
      } catch (Exception e) {
        return false;
      }
    }

    /** Clear notification badges when inbox has no unread messages. */
    @JavascriptInterface
    public void setUnread(int n) {
      if (n <= 0) NotificationManagerCompat.from(MainActivity.this).cancelAll();
    }
  }
}
