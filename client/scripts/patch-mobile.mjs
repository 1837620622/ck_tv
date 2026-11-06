#!/usr/bin/env node
/* eslint-disable no-console -- 命令行工具，结果输出到终端 */
// 给 `tauri android init` / `tauri ios init` 生成的工程打补丁。
//
//   node scripts/patch-mobile.mjs android
//   node scripts/patch-mobile.mjs ios
//
// 为什么需要：src-tauri/gen/ 不进仓库，CI 每次构建都会重新生成。生成的工程用的是 Tauri 自带的
// 默认图标（蓝黄两个圆环），也不处理状态栏，所以：
//   安卓  1. 把 src-tauri/icons/android/ 里的 CKTV 图标覆盖进去（含自适应图标和深色底）
//         2. 换掉 MainActivity：网页内容避开状态栏、导航栏、刘海和输入法，状态栏图标用浅色；
//            提供 window.CKTVNative（setFullscreen / supportsPip / enterPip），全屏横屏藏系统栏；画中画走 Activity
//         3. 主题改成深色、窗口底色 #060A13：启动时不再闪白，和启动页颜色一致
//   iOS   把 src-tauri/icons/ios/ 里的图标放进 AppIcon.appiconset，并写好 Contents.json
//
// 生成的工程和预期不一样（找不到文件）时直接失败，不会悄悄打出带默认图标的安装包。

import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 窗口底色，和 src-tauri/src/window.rs 的 BACKGROUND、启动页的 --bg-0 一致 */
export const BACKGROUND_HEX = '#060A13';

/* ---------------- 通用 ---------------- */

function fail(message) {
  throw new Error(message);
}

/** 读 PNG 的宽高（IHDR 块固定在第 16～23 字节） */
export function pngSize(file) {
  const head = readFileSync(file).subarray(0, 24);
  const signature = '89504e470d0a1a0a';
  if (head.length < 24 || head.subarray(0, 8).toString('hex') !== signature) {
    fail(`不是 PNG 文件：${file}`);
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** 在目录里递归找文件名等于 name 的文件 */
function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

/* ---------------- 安卓 ---------------- */

/** 替换后的 MainActivity。package 沿用生成的那一行，其它内容固定。 */
export function mainActivitySource(packageName) {
  return `package ${packageName}

import android.app.PictureInPictureParams
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

// 由 client/scripts/patch-mobile.mjs 生成。gen/ 目录每次构建都会重新生成，改这里没有用，要改那个脚本。
//
// 1. 状态栏、导航栏透明，图标用浅色，配合深色界面。
// 2. 网页内容不画到状态栏、导航栏、刘海和输入法下面：把这些区域的大小作为内边距加在内容外层。
//    安卓 15 起应用一律全面屏显示，系统 WebView 又不一定把这些区域告诉网页，
//    所以在原生层统一处理，所有安卓版本上的排版都一样。
// 3. 给网页一个原生接口 window.CKTVNative：
//    - setFullscreen(true/false)：播放器全屏时横屏、隐藏系统栏
//    - supportsPip() / enterPip() / isInPip()：系统 WebView 通常没有 HTML 画中画，改走 Activity 画中画
class MainActivity : TauriActivity() {
  private var immersive = false
  private var content: View? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    window.decorView.setBackgroundColor(BACKGROUND)
    val root = findViewById<View>(android.R.id.content)
    content = root
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      if (immersive) {
        view.setPadding(0, 0, 0, 0)
      } else {
        val bars = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      }
      WindowInsetsCompat.CONSUMED
    }
    attachBridgeWhenReady()
  }

  // WebView 由 Rust 在 onCreate 之后才创建：等它出现在界面里，再注册原生接口（下一次打开页面起生效）
  private fun attachBridgeWhenReady() {
    val decor = window.decorView
    decor.viewTreeObserver.addOnGlobalLayoutListener(
      object : ViewTreeObserver.OnGlobalLayoutListener {
        override fun onGlobalLayout() {
          val webView = findWebView(decor) ?: return
          decor.viewTreeObserver.removeOnGlobalLayoutListener(this)
          webView.addJavascriptInterface(NativeBridge(), "CKTVNative")
        }
      },
    )
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        val found = findWebView(view.getChildAt(index))
        if (found != null) return found
      }
    }
    return null
  }

  // 不能叫 setImmersive：Activity 自己有这个方法
  private fun applyFullscreen(on: Boolean) {
    immersive = on
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    if (on) {
      controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }
    content?.let { ViewCompat.requestApplyInsets(it) }
  }

  private fun deviceSupportsPip(): Boolean {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
  }

  private fun requestPip(): Boolean {
    if (!deviceSupportsPip()) return false
    return try {
      val params = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(16, 9))
        .build()
      enterPictureInPictureMode(params)
    } catch (_: Exception) {
      false
    }
  }

  // 给网页用的原生接口：全屏和画中画。任何页面调用都没有危害。
  inner class NativeBridge {
    @JavascriptInterface
    fun setFullscreen(on: Boolean) {
      runOnUiThread { applyFullscreen(on) }
    }

    @JavascriptInterface
    fun supportsPip(): Boolean {
      return deviceSupportsPip()
    }

    @JavascriptInterface
    fun isInPip(): Boolean {
      return Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode
    }

    // JavascriptInterface 在后台线程调用：要等 UI 线程跑完再把结果返回给网页
    @JavascriptInterface
    fun enterPip(): Boolean {
      if (!deviceSupportsPip()) return false
      val done = CountDownLatch(1)
      val ok = AtomicBoolean(false)
      runOnUiThread {
        try {
          ok.set(requestPip())
        } finally {
          done.countDown()
        }
      }
      return try {
        done.await(2, TimeUnit.SECONDS) && ok.get()
      } catch (_: InterruptedException) {
        false
      }
    }
  }

  private companion object {
    // 和启动页、窗口底色一致（${BACKGROUND_HEX}）
    val BACKGROUND = Color.rgb(6, 10, 19)
  }
}
`;
}

/** 深色主题：窗口底色和启动页一致，状态栏、导航栏透明 */
export function themeSource(styleName) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 client/scripts/patch-mobile.mjs 生成：深色底，启动时不闪白 -->
<resources>
    <style name="${styleName}" parent="Theme.Material3.Dark.NoActionBar">
        <item name="android:windowBackground">@color/cktv_background</item>
        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>
        <item name="android:windowLightStatusBar">false</item>
    </style>
</resources>
`;
}

export function patchAndroid({
  genDir = join(ROOT, 'src-tauri/gen/android'),
  iconsDir = join(ROOT, 'src-tauri/icons/android'),
} = {}) {
  const res = join(genDir, 'app/src/main/res');
  const javaDir = join(genDir, 'app/src/main/java');
  if (!existsSync(res) || !existsSync(javaDir)) {
    fail(`没有找到安卓工程（${genDir}），先运行 tauri android init`);
  }
  if (!existsSync(join(iconsDir, 'mipmap-xxxhdpi/ic_launcher.png'))) {
    fail(`没有找到安卓图标（${iconsDir}），先运行 tauri icon`);
  }

  // 1. 图标：整个目录覆盖进去（mipmap-*、mipmap-anydpi-v26 自适应图标、values 里的底色）
  cpSync(iconsDir, res, { recursive: true, force: true });

  // 2. MainActivity
  const activity = findFile(javaDir, 'MainActivity.kt');
  if (!activity) fail(`没有找到 MainActivity.kt（${javaDir}）`);
  const packageLine = readFileSync(activity, 'utf8').match(
    /^package\s+([\w.]+)/m
  );
  if (!packageLine) fail(`MainActivity.kt 里没有 package 声明：${activity}`);
  writeFileSync(activity, mainActivitySource(packageLine[1]));

  // 2b. AndroidManifest：打开系统画中画（HTML PiP 在系统 WebView 里通常不可用）
  const manifest = join(genDir, 'app/src/main/AndroidManifest.xml');
  const manifestPatched = patchAndroidManifest(manifest);

  // 3. 主题和颜色：values 和 values-night 都改成深色
  writeFileSync(
    join(res, 'values/cktv_colors.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="cktv_background">#FF${BACKGROUND_HEX.slice(1)}</color>
</resources>
`
  );
  const themes = ['values/themes.xml', 'values-night/themes.xml']
    .map((path) => join(res, path))
    .filter((path) => existsSync(path));
  if (themes.length === 0) fail(`没有找到主题文件（${res}/values/themes.xml）`);
  for (const path of themes) {
    const name = readFileSync(path, 'utf8').match(/<style\s+name="([^"]+)"/);
    if (!name) fail(`主题文件里没有 <style name="…">：${path}`);
    writeFileSync(path, themeSource(name[1]));
  }

  return {
    activity,
    themes,
    manifest: manifestPatched,
    icons: readdirSync(iconsDir).length,
  };
}

/** 给主 Activity 打开系统画中画，并保留方向/尺寸变化时不重建 Activity */
export function patchAndroidManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    fail(`没有找到 AndroidManifest.xml（${manifestPath}）`);
  }
  let xml = readFileSync(manifestPath, 'utf8');
  if (!/<activity\b[^>]*>/i.test(xml)) {
    fail(`AndroidManifest.xml 里没有 <activity>：${manifestPath}`);
  }

  const ensureAttr = (tag, name, value) => {
    const re = new RegExp(`\\s${name}="[^"]*"`);
    if (re.test(tag)) return tag.replace(re, ` ${name}="${value}"`);
    return tag.replace(/>$/, ` ${name}="${value}">`);
  };

  xml = xml.replace(/<activity\b[^>]*>/i, (tag) => {
    let next = tag;
    next = ensureAttr(next, 'android:supportsPictureInPicture', 'true');
    next = ensureAttr(next, 'android:resizeableActivity', 'true');
    // 已有 configChanges 就补齐需要的项；没有就写一份常用的
    if (/android:configChanges="/i.test(next)) {
      next = next.replace(/android:configChanges="([^"]*)"/i, (_m, current) => {
        const set = new Set(
          String(current)
            .split('|')
            .map((part) => part.trim())
            .filter(Boolean)
        );
        for (const item of [
          'orientation',
          'screenSize',
          'screenLayout',
          'smallestScreenSize',
          'keyboardHidden',
        ]) {
          set.add(item);
        }
        return `android:configChanges="${Array.from(set).join('|')}"`;
      });
    } else {
      next = ensureAttr(
        next,
        'android:configChanges',
        'orientation|screenSize|screenLayout|smallestScreenSize|keyboardHidden'
      );
    }
    return next;
  });

  writeFileSync(manifestPath, xml);
  return manifestPath;
}

/* ---------------- iOS ---------------- */

/**
 * AppIcon 每一格对应的文件。文件名是 `tauri icon` 生成的名字；
 * iPhone 和 iPad 同尺寸的格子各用一份（带 -1 的是 iPad 那份）。
 */
export const IOS_ICON_SLOTS = [
  ['iphone', '20x20', '2x', 'AppIcon-20x20@2x.png'],
  ['iphone', '20x20', '3x', 'AppIcon-20x20@3x.png'],
  ['iphone', '29x29', '2x', 'AppIcon-29x29@2x.png'],
  ['iphone', '29x29', '3x', 'AppIcon-29x29@3x.png'],
  ['iphone', '40x40', '2x', 'AppIcon-40x40@2x.png'],
  ['iphone', '40x40', '3x', 'AppIcon-40x40@3x.png'],
  ['iphone', '60x60', '2x', 'AppIcon-60x60@2x.png'],
  ['iphone', '60x60', '3x', 'AppIcon-60x60@3x.png'],
  ['ipad', '20x20', '1x', 'AppIcon-20x20@1x.png'],
  ['ipad', '20x20', '2x', 'AppIcon-20x20@2x-1.png'],
  ['ipad', '29x29', '1x', 'AppIcon-29x29@1x.png'],
  ['ipad', '29x29', '2x', 'AppIcon-29x29@2x-1.png'],
  ['ipad', '40x40', '1x', 'AppIcon-40x40@1x.png'],
  ['ipad', '40x40', '2x', 'AppIcon-40x40@2x-1.png'],
  ['ipad', '76x76', '1x', 'AppIcon-76x76@1x.png'],
  ['ipad', '76x76', '2x', 'AppIcon-76x76@2x.png'],
  ['ipad', '83.5x83.5', '2x', 'AppIcon-83.5x83.5@2x.png'],
  ['ios-marketing', '1024x1024', '1x', 'AppIcon-512@2x.png'],
];

/** 一格应有的像素边长：20x20 @3x → 60 */
export function expectedPixels(size, scale) {
  return Math.round(Number.parseFloat(size) * Number.parseInt(scale, 10));
}

export function iosContentsJson() {
  return `${JSON.stringify(
    {
      images: IOS_ICON_SLOTS.map(([idiom, size, scale, filename]) => ({
        filename,
        idiom,
        scale,
        size,
      })),
      info: { author: 'xcode', version: 1 },
    },
    null,
    2
  )}\n`;
}

/** 找到 AppIcon.appiconset：生成的工程里通常在 Assets.xcassets 下面 */
function findAppIconSet(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name === 'AppIcon.appiconset') return full;
    // 跳过构建产物和依赖，避免在大目录里乱找
    if (['build', 'DerivedData', 'Pods', 'node_modules'].includes(entry.name)) {
      continue;
    }
    const hit = findAppIconSet(full);
    if (hit) return hit;
  }
  return null;
}

export function patchIos({
  genDir = join(ROOT, 'src-tauri/gen/apple'),
  iconsDir = join(ROOT, 'src-tauri/icons/ios'),
} = {}) {
  if (!existsSync(genDir)) {
    fail(`没有找到 iOS 工程（${genDir}），先运行 tauri ios init`);
  }
  const iconSet = findAppIconSet(genDir);
  if (!iconSet) fail(`没有找到 AppIcon.appiconset（${genDir}）`);

  // 先全部检查，再动文件：缺一个或尺寸不对就失败
  for (const [, size, scale, filename] of IOS_ICON_SLOTS) {
    const source = join(iconsDir, filename);
    if (!existsSync(source)) fail(`缺少 iOS 图标：${source}`);
    const want = expectedPixels(size, scale);
    const { width, height } = pngSize(source);
    if (width !== want || height !== want) {
      fail(`${filename} 应为 ${want}×${want}，实际 ${width}×${height}`);
    }
  }

  // 删掉模板自带、我们不用的图标文件，资源里只留 Contents.json 引用的那些
  const ours = new Set(IOS_ICON_SLOTS.map((slot) => slot[3]));
  for (const name of readdirSync(iconSet)) {
    const path = join(iconSet, name);
    if (name.endsWith('.png') && !ours.has(name) && statSync(path).isFile()) {
      rmSync(path);
    }
  }
  for (const [, , , filename] of IOS_ICON_SLOTS) {
    cpSync(join(iconsDir, filename), join(iconSet, filename));
  }
  writeFileSync(join(iconSet, 'Contents.json'), iosContentsJson());

  return { iconSet, icons: IOS_ICON_SLOTS.length };
}

/* ---------------- 命令行 ---------------- */

function main(args) {
  const [target] = args;
  if (target === 'android') {
    const result = patchAndroid();
    console.log(
      `✓ 安卓工程已打补丁：图标 ${result.icons} 项，${basename(
        result.activity
      )}，主题 ${result.themes.length} 个`
    );
  } else if (target === 'ios') {
    const result = patchIos();
    console.log(
      `✓ iOS 工程已打补丁：${result.icons} 个图标 → ${result.iconSet}`
    );
  } else {
    console.error('用法：node scripts/patch-mobile.mjs android|ios');
    process.exit(2);
  }
}

const runDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
