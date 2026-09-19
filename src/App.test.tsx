import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import App from './App';
import BatchApplyModal from './components/BatchApplyModal';
import StaticHostsModal from './components/StaticHostsModal';
import RouteSummaryModal from './components/RouteSummaryModal';
import PlanDiffModal from './components/PlanDiffModal';
import { Allocation, Plan } from './lib/model';

describe('App 冒烟测试', () => {
  it('组件树可整体渲染', () => {
    const html = renderToString(createElement(App));
    expect(html).toContain('IPv4 子网规划台');
    expect(html).toContain('根网段');
    expect(html).toContain('地址空间树');
    expect(html).toContain('新建分配');
    expect(html).toContain('批量申请');
    expect(html).toContain('前缀策略校验');
    expect(html).toContain('路由汇总');
    expect(html).toContain('规划差异报告');
    expect(html).toContain('加密导出');
    expect(html).toContain('加密导入');
  });
});

describe('StaticHostsModal 冒烟测试', () => {
  const alloc: Allocation = {
    id: 'a1',
    name: '办公有线',
    kind: 'subnet',
    prefix: 24,
    cidr: '192.168.0.0/24',
  };

  it('弹窗渲染且初始禁止导出', () => {
    const html = renderToString(
      createElement(StaticHostsModal, { alloc, onClose: () => undefined }),
    );
    expect(html).toContain('静态主机地址编排');
    expect(html).toContain('主机名 IPv4地址');
    // 初始无有效行：复制与下载均禁用
    expect(html).toMatch(/disabled[^>]*>\s*复制 hosts 文本/);
    expect(html).toMatch(/disabled[^>]*>\s*下载 hosts 文件/);
  });
});

describe('BatchApplyModal 冒烟测试', () => {
  const plan: Plan = {
    version: 1,
    roots: [{ id: 'r1', name: '生产', cidr: '10.0.0.0/24' }],
    allocations: [],
  };

  it('弹窗渲染行编辑表格与禁止提交的初始状态', () => {
    const html = renderToString(
      createElement(BatchApplyModal, {
        plan,
        onSubmit: () => [],
        onClose: () => undefined,
      }),
    );
    expect(html).toContain('批量申请子网');
    expect(html).toContain('空行忽略');
    expect(html).toContain('尚未填写有效行');
    // 初始无有效行：提交按钮禁用
    expect(html).toMatch(/disabled[^>]*>\s*提交批量申请/);
  });
});

describe('RouteSummaryModal 冒烟测试', () => {
  const plan: Plan = {
    version: 1,
    roots: [{ id: 'r1', name: '生产', cidr: '10.0.0.0/16' }],
    allocations: [
      { id: 'a1', name: '子网甲', kind: 'subnet', prefix: 24, cidr: '10.0.0.0/24' },
      { id: 'a2', name: '保留乙', kind: 'reserved', prefix: 24, cidr: '10.0.1.0/24' },
    ],
  };

  it('弹窗渲染：子网可勾选、保留段标注为不可选、初始无结果', () => {
    const html = renderToString(
      createElement(RouteSummaryModal, { plan, onClose: () => undefined }),
    );
    expect(html).toContain('路由汇总');
    expect(html).toContain('最多路由条数');
    expect(html).toContain('子网甲');
    // 命名保留段展示但标注不可选
    expect(html).toContain('保留乙');
    expect(html).toContain('不可选，汇总 CIDR 不得覆盖');
    expect(html).toContain('生成汇总方案');
  });
});

describe('PlanDiffModal 冒烟测试', () => {
  const plan: Plan = {
    version: 1,
    roots: [{ id: 'r1', name: '生产', cidr: '10.0.0.0/16' }],
    allocations: [{ id: 'a1', name: '子网甲', kind: 'subnet', prefix: 24, cidr: '10.0.0.0/24' }],
  };

  it('弹窗渲染：文件选择与生成入口，初始无结果且生成按钮禁用', () => {
    const html = renderToString(
      createElement(PlanDiffModal, { plan, onClose: () => undefined }),
    );
    expect(html).toContain('规划差异报告');
    expect(html).toContain('选择基线文件');
    expect(html).toContain('尚未选择基线文件');
    expect(html).toMatch(/disabled[^>]*>\s*生成差异报告/);
  });
});
