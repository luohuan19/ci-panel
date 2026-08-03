import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { visualizer } from "rollup-plugin-visualizer";
import { AntDesignVueResolver } from "unplugin-vue-components/resolvers";
import Components from "unplugin-vue-components/vite";
import { defineConfig, type Plugin } from "vite";

// 给开发实例的标签页标题加 [dev]，和生产面板区分开（见 src/tools/devTitle.ts 的说明）。
// 这里改的是应用挂载之前的静态标题：挂载后 services/layout.ts 会用面板设置覆盖它，
// 那边加了同样的前缀。两处都要 —— 登录/安装页面和接口失败时压根走不到覆盖那一步。
// apply: "serve" 保证只在 dev server 生效，vite build 的产物不受影响。
function devTitlePlugin(): Plugin {
  return {
    name: "cip-dev-title",
    apply: "serve",
    transformIndexHtml: (html) => html.replace(/<title>(?!\[dev\])/, "<title>[dev] ")
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      output: {
        manualChunks(path) {
          if (path.includes("node_modules/ant-design-vue/es")) {
            return "ant-es";
          }
          if (path.includes("node_modules/ant-design-vue")) {
            return "ant";
          }
          // zrender 必须和 echarts 待在同一个 chunk 里。两者之间存在循环引用：
          // zrender 的顶层初始化会调到 echarts 的函数，而那个函数又要用 zrender 里
          // 还没初始化完的绑定。同一个 chunk 内 rollup 会把顺序排对，一旦拆成两个
          // chunk 就变成跨 chunk 的暂时性死区，生产构建一加载就抛
          // "hc is not a function"，整个前端连挂载都到不了（dev 模式下不分 chunk，
          // 所以只在生产构建复现）。
          if (path.includes("node_modules/zrender") || path.includes("node_modules/echarts")) {
            return "echart";
          }
          if (path.includes("node_modules/lodash")) {
            return "lodash";
          }
          if (path.includes("node_modules/vue") || path.includes("node_modules/@vue")) {
            return "vue";
          }
          if (path.includes("node_modules/@xterm")) {
            return "xterm";
          }
          if (path.includes("node_modules/@codemirror")) {
            return "codemirror";
          }
          if (path.includes("node_modules/monaco")) {
            return "monaco";
          }
          if (path.includes("node_modules/htmlparser2")) {
            return "htmlparser2";
          }
        }
      }
    }
  },
  server: {
    host: true,
    allowedHosts: true,
    // 低 inotify 上限的机器（fs.inotify.max_user_watches 太小 → ENOSPC）上，
    // 设 CHOKIDAR_USEPOLLING=true 让文件监视改用轮询、不占 inotify watch。默认关闭，不影响他人。
    watch:
      process.env.CHOKIDAR_USEPOLLING === "true" ? { usePolling: true, interval: 300 } : undefined,
    proxy: {
      "/api": {
        target: "http://localhost:23333",
        changeOrigin: true,
        ws: true
      },
      "/upload_files": {
        target: "http://localhost:23333",
        changeOrigin: true
      },
      "/socket.io": {
        target: "ws://localhost:23333",
        ws: true
      }
    }
  },

  plugins: [
    devTitlePlugin(),
    vue(),
    vueJsx(),
    Components({
      resolvers: [
        AntDesignVueResolver({
          importStyle: false // css in js
        })
      ]
    }),
    visualizer({ emitFile: true, filename: "stats.html" })
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@languages": fileURLToPath(new URL("../languages", import.meta.url))
    }
  },
  base: "./"
});
