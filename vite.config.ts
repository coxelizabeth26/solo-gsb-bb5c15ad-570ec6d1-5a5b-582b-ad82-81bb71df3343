/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    // 测试环境中保留 styles.css 原文：默认 CSS 管线会把样式文件转成注入模块，
    // 冲突流程组件测试需要通过 styles.css?raw 读取指针事件与层级规则做回归断言。
    {
      name: 'css-raw-for-tests',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!source.endsWith('.css?raw') || !importer) return null;
        const importerPath = importer.split('?')[0].replace(/^file:\/\//, '');
        const filePath = resolve(dirname(importerPath), source.slice(0, -'?raw'.length));
        // 虚拟 id：\0 前缀阻止其他插件处理；.txt 后缀避开 Vite 内置 CSS 管线的
        // isCSSRequest 匹配（\.(css)(?:$|\?)），否则加载结果仍会被替换成空模块。
        return `\0test-raw-css:${filePath}.txt`;
      },
      load(id) {
        if (!id.startsWith('\0test-raw-css:')) return null;
        const filePath = id.slice('\0test-raw-css:'.length, -'.txt'.length);
        const css = readFileSync(filePath, 'utf8');
        return `export default ${JSON.stringify(css)};`;
      },
    },
  ],
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  test: {
    environment: 'node',
    // 组件/DOM 测试使用 jsdom；其余规划引擎测试保持 node 环境
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    // 受限环境（如容器内）worker 线程可能创建失败：统一用子进程且不并行
    pool: 'forks',
    fileParallelism: false,
  },
});
