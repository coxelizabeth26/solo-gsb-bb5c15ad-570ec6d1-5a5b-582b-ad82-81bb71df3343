// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import stylesCss from './styles.css?raw';
import App from './App';
import { GENESIS_REVISION_ID, Revision } from './lib/revisionStore';
import { emptyPlan } from './lib/model';

/** 从编译后的样式表中取出某条选择器规则的声明文本（用于回归指针事件/层级修复）。 */
function declarationsOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesCss.match(new RegExp(`(?:^|\\})[^{}]*?${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`样式表中缺少规则：${selector}`);
  return match[1];
}

/** 通过 storage 事件投递一个外部标签页写入的修订文档（App 用它模拟跨标签页收到更新）。 */
function postExternalRevisions(revisions: Revision[]): void {
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'ipv4-subnet-planner/revisions/v1',
        newValue: JSON.stringify({ version: 1, revisions }),
      }),
    );
  });
}

let revisionSeq = 0;
/** 基于创世修订分叉出去的外部标签页修订（与本页任意后续编辑互不包含）。 */
function divergedRemote(): Revision {
  revisionSeq += 1;
  return {
    id: `remote-conflict-${revisionSeq}`,
    parentRevisionIds: [GENESIS_REVISION_ID],
    clientId: 'other-tab-client',
    plan: emptyPlan(),
  };
}

/** 载入示例规划并触发一次分叉冲突，返回冲突相关元素。 */
function setupConflict() {
  const utils = render(<App />);

  // 本页先做一次编辑（载入示例），使本页 head 偏离创世修订
  fireEvent.click(screen.getByRole('button', { name: '载入示例' }));

  // 外部标签页基于创世修订提交了互不包含的修改 → 分叉冲突
  postExternalRevisions([divergedRemote()]);

  const dialog = screen.getByRole('alertdialog', { name: '检测到分叉更新' });
  expect(dialog).toBeTruthy();
  return { ...utils, dialog };
}

/** 分配清单表格中指定名称行的行内按钮（名称同时出现在地址空间树中，须限定表格）。 */
function rowButton(rowName: string, name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: /^分配清单/ });
  const table = heading.closest('section')!.querySelector('table')!;
  const rows = within(table as HTMLElement).getAllByRole('row');
  const row = rows.find((r) => r.textContent?.includes(rowName))!;
  return within(row).getByRole('button', { name });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  // BroadcastChannel 在 jsdom 中不存在：App 已对其降级（仅 storage 事件协同）
  vi.stubGlobal('BroadcastChannel', undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('冲突锁定样式：遮罩放行只读入口、Option 121 弹窗位于冲突界面之上', () => {
  it('冲突遮罩本身不拦截指针事件，弹窗本体恢复交互（避免遮蔽下层只读入口）', () => {
    expect(declarationsOf('.conflict-backdrop')).toMatch(/pointer-events:\s*none/);
    expect(declarationsOf('.conflict-backdrop .modal')).toMatch(/pointer-events:\s*auto/);
  });

  it('锁定主区关闭指针事件，但分配清单面板重新开放', () => {
    expect(declarationsOf('.layout.locked')).toMatch(/pointer-events:\s*none/);
    expect(declarationsOf('.layout.locked .panel-unlocked-readonly')).toMatch(
      /pointer-events:\s*auto/,
    );
  });

  it('无类路由弹窗层级高于冲突弹窗层级', () => {
    const conflict = declarationsOf('.conflict-backdrop');
    const csr = declarationsOf('.csr-backdrop');
    const readonly = declarationsOf('.readonly-backdrop');
    const zOf = (decls: string): number => Number(decls.match(/z-index:\s*(\d+)/)![1]);
    expect(zOf(csr)).toBeGreaterThan(zOf(conflict));
    expect(zOf(readonly)).toBeGreaterThan(zOf(conflict));
    expect(zOf(csr)).toBeGreaterThan(zOf(readonly));
  });
});

describe('冲突态入口：锁定编辑但可从子网行打开 Option 121 弹窗', () => {
  it('工具栏只读校验入口同样不被遮罩拦截，弹窗叠在冲突界面之上', () => {
    setupConflict();

    fireEvent.click(screen.getByRole('button', { name: '前缀策略校验' }));

    const readonlyModal = screen.getByRole('heading', { name: '前缀策略校验' }).closest(
      '.modal-backdrop',
    ) as HTMLElement;
    expect(readonlyModal).toBeTruthy();
    expect(readonlyModal.classList.contains('readonly-backdrop')).toBe(true);
    // 冲突弹窗仍在其下方
    expect(screen.getByRole('alertdialog', { name: '检测到分叉更新' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByText('前缀策略校验', { selector: 'h3' })).toBeNull();
    expect(screen.getByRole('alertdialog', { name: '检测到分叉更新' })).toBeTruthy();
  });

  it('冲突期间调整容量/释放/DHCP 池禁用，无类路由可用且能打开弹窗', () => {
    setupConflict();

    // 锁定提示与冲突弹窗同时在
    expect(screen.getByRole('status').textContent).toContain('编辑已锁定');

    const dhcp = rowButton('数据中心-A', 'DHCP 池');
    const resize = rowButton('数据中心-A', '调整容量');
    const release = rowButton('数据中心-A', '释放');
    const classless = rowButton('数据中心-A', '无类路由');

    expect(dhcp.hasAttribute('disabled')).toBe(true);
    expect(resize.hasAttribute('disabled')).toBe(true);
    expect(release.hasAttribute('disabled')).toBe(true);
    expect(classless.hasAttribute('disabled')).toBe(false);

    // 点击被冲突遮罩盖住却仍应可点（修复前遮罩拦截，弹窗不出现）
    fireEvent.click(classless);

    const modal = screen.getByRole('dialog', { name: /DHCP 类无静态路由/ });
    expect(modal).toBeTruthy();
    // 弹窗位于冲突界面之上：z-index 320 > 300，且冲突弹窗仍在（未被关闭）
    expect(screen.getByRole('alertdialog', { name: '检测到分叉更新' })).toBeTruthy();
    expect(within(modal).getByText('10.1.0.0/18')).toBeTruthy();
  });
});

describe('关闭回退：Option 121 弹窗关闭后原冲突与锁定仍然保留', () => {
  it('点关闭仅关闭只读弹窗，冲突弹窗、锁定横幅与锁定状态不变', () => {
    setupConflict();

    fireEvent.click(rowButton('数据中心-A', '无类路由'));
    const modal = screen.getByRole('dialog', { name: /DHCP 类无静态路由/ });

    // 在弹窗内做一次纯本地只读编辑，确认关闭后不影响规划与冲突状态
    fireEvent.change(within(modal).getAllByRole('textbox')[0], {
      target: { value: '0.0.0.0/0,10.1.0.1\n' },
    });
    // 纯本地只读计算即时生成编码结果（不触碰规划与修订）
    expect(within(modal).getByRole('button', { name: '复制十六进制' })).toBeTruthy();

    fireEvent.click(within(modal).getByRole('button', { name: '关闭' }));

    expect(screen.queryByRole('dialog', { name: /DHCP 类无静态路由/ })).toBeNull();
    // 原冲突仍在
    expect(screen.getByRole('alertdialog', { name: '检测到分叉更新' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('编辑已锁定');
    // 编辑仍锁定：无类路由入口仍可再次打开
    expect(rowButton('数据中心-B', '调整容量').hasAttribute('disabled')).toBe(true);
    fireEvent.click(rowButton('数据中心-B', '无类路由'));
    expect(screen.getByRole('dialog', { name: /DHCP 类无静态路由/ })).toBeTruthy();
  });
});

describe('冲突解决流程：选择版本后解除锁定', () => {
  it('保留本页：弹窗关闭、示例规划保留、编辑操作恢复可用', () => {
    setupConflict();

    fireEvent.click(screen.getByRole('button', { name: '保留本页' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // 本页版本（演示规划）内容保留
    const heading = screen.getByRole('heading', { name: /^分配清单/ });
    expect(heading.closest('section')!.textContent).toContain('数据中心-A');
    // 锁定解除：此前禁用的行内编辑按钮恢复
    expect(rowButton('数据中心-A', '调整容量').hasAttribute('disabled')).toBe(false);
    expect(rowButton('数据中心-A', 'DHCP 池').hasAttribute('disabled')).toBe(false);
  });

  it('采用外部：弹窗关闭、规划切换为外部空规划版本，编辑恢复', () => {
    setupConflict();

    fireEvent.click(screen.getByRole('button', { name: '采用外部' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // 外部版本为空规划：演示规划中的子网消失
    expect(screen.queryByText('数据中心-A')).toBeNull();
    expect(screen.getByText(/暂无分配/)).toBeTruthy();
    // 锁定解除：工具栏此前禁用的入口恢复
    expect(screen.getByRole('button', { name: '清空' }).hasAttribute('disabled')).toBe(false);
  });
});
