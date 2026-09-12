import { Geist, Geist_Mono } from "next/font/google";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter";
import "./globals.css";
import AppProviders from "@/providers/AppProviders";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "NovelAI Local",
  description: "Local NovelAI image generation interface",
  applicationName: "NovelAI Local",
};

export const viewport = {
  themeColor: "#ffffff",
  colorScheme: "light dark",
};

const bootstrapAppearance = `
  (function () {
    try {
      // 在首屏绘制前固定中转页底色，避免主题和翻译初始化时露出白底。
      if (['/studio/start', '/studio/callback'].includes(window.location.pathname)) {
        document.documentElement.dataset.studioTransition = 'true';
      }
      var userId = window.sessionStorage.getItem('idlecloud.studio-user') || '';
      var scope = window.sessionStorage.getItem('idlecloud.connection') === 'studio'
        ? 'studio:' + (/^[1-9][0-9]*$/.test(userId) ? userId : 'pending') + ':' : '';
      var storedLocale = window.localStorage.getItem(scope + 'novelai-local.locale');
      var locale = storedLocale === 'zh-CN' || storedLocale === 'en-US'
        ? storedLocale
        : 'zh-CN';
      var theme = window.localStorage.getItem(scope + 'themeMode') === 'light' ? 'light' : 'dark';
      document.documentElement.lang = locale;
      document.documentElement.dataset.locale = locale;
      document.documentElement.dataset.theme = theme;
      window.__NOVELAI_LOCAL_LOCALE__ = locale;
    } catch (error) {
      document.documentElement.lang = 'zh-CN';
      document.documentElement.dataset.locale = 'zh-CN';
      document.documentElement.dataset.theme = 'dark';
    }
  })();
`;

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" data-i18n-ready="false" suppressHydrationWarning>
      <head>
        <style>{`html { background: #0d1117; }
          html[data-theme="light"] { background: #f0f4f8; }
          html[data-i18n-ready="false"] body { visibility: hidden; }
          html[data-studio-transition="true"], html[data-studio-transition="true"] body { background: #0d1117 !important; }
          html[data-studio-transition="true"] body { visibility: visible !important; }`}</style>
        <script dangerouslySetInnerHTML={{ __html: bootstrapAppearance }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* 将 Emotion 样式收集到 head，避免 App Router 流式渲染产生 hydration 偏差。 */}
        <AppRouterCacheProvider>
          <AppProviders>
            {children}
          </AppProviders>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
