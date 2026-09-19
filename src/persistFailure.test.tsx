// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { GENESIS_REVISION_ID, Revision, STATE_STORAGE_KEY } from './lib/revisionStore';
import { emptyPlan } from './lib/model';

/** 注入失败存储：localStorage/sessionStorage 的 setItem 抛 QuotaExceededError。 */
function failStorageWrites() {
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('容量已满，写入被拒绝', 'QuotaExceededError');
  });
}

/** 通过新版单键 storage 事件投递一个外部标签页写入的完整状态。 */
function postExternalState(revisions: Revision[], headId?: string): void {
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: STATE_STORAGE_KEY,
        newValue: JSON.stringify({
          version: 2,
          headId: headId ?? revisions[revisions.length - 1].id,
          revisions,
        }),
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

function storedState(): { version: number; headId: string; revisions: Revision[] } {
  return JSON.parse(window.localStorage.getItem(STATE_STORAGE_KEY)!);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  // BroadcastChannel 在 jsdom 中不存在：App 已对其降级（仅 storage 事件协同）
  vi.stubGlobal('BroadcastChannel', undefined);
  // 「清空」需确认：一律确认
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  // jsdom 的 File 未实现 text()：用 FileReader 补齐（导入 JSON 走该路径）
  if (!File.prototype.text) {
    File.prototype.text = function (this: File): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    };
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('写入失败：普通编辑保留提交前规划并显示明确错误', () => {
  it('载入示例落盘失败：界面不更新、无历史记录、存储无残留，恢复后可重试', () => {
    const spy = failStorageWrites(); // 从启动即失败（含创世落盘）
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '载入示例' }));

    // 规划保持提交前状态（空规划），未产生历史记录（无幽灵版本）
    expect(screen.queryByText('数据中心-A')).toBeNull();
    expect(screen.getByRole('button', { name: /撤销/ }).hasAttribute('disabled')).toBe(true);
    // 明确错误提示
    expect(screen.getByRole('alert').textContent).toContain('未保存');
    // 存储中没有写入任何状态
    expect(window.localStorage.getItem(STATE_STORAGE_KEY)).toBeNull();

    // 存储恢复后重试成功：修订全集只有创世与本次成功提交
    spy.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: '载入示例' }));
    expect(screen.getAllByText('数据中心-A').length).toBeGreaterThan(0);
    expect(storedState().revisions).toHaveLength(2);
  });

  it('撤销/重做落盘失败：历史栈与规划保持原样，不产生幽灵版本', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '载入示例' }));
    expect(screen.getAllByText('数据中心-A').length).toBeGreaterThan(0);

    const spy = failStorageWrites();
    // 清空失败：规划保持示例内容
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(screen.getAllByText('数据中心-A').length).toBeGreaterThan(0);
    expect(screen.getByRole('alert').textContent).toContain('未保存');
    // 撤销同样失败：历史栈不被消费，规划不变
    fireEvent.click(screen.getByRole('button', { name: /撤销/ }));
    expect(screen.getAllByText('数据中心-A').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /撤销/ }).hasAttribute('disabled')).toBe(false);
    spy.mockRestore();

    // 存储恢复：撤销 → 空规划，重做 → 示例规划
    fireEvent.click(screen.getByRole('button', { name: /撤销/ }));
    expect(screen.queryByText('数据中心-A')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /重做/ }));
    expect(screen.getAllByText('数据中心-A').length).toBeGreaterThan(0);

    // 持久化的修订链：创世、示例、撤销（空）、重做（示例）——失败操作不留痕迹
    const state = storedState();
    expect(state.revisions).toHaveLength(4);
    expect(state.headId).toBe(state.revisions[3].id);
  });

  it('导入落盘失败：当前规划不被替换，恢复后重导成功', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '载入示例' }));
    expect(screen.getAllByText('数据中心-A').length).toBeGreaterThan(0);

    const input = document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;
    const imported = JSON.stringify({ version: 1, roots: [], allocations: [] });
    const file = () => new File([imported], 'plan.json', { type: 'application/json' });

    const spy = failStorageWrites();
    // FileReader 异步读取：等待导入流程完成
    fireEvent.change(input, { target: { files: [file()] } });
    const alert = await screen.findByRole('alert');
    // 导入未生效：仍是示例规划，且提示明确错误
    expect(alert.textContent).toContain('未保存');
    expect(screen.getAllByText('数据中心-A').length).toBeGreaterThan(0);
    spy.mockRestore();

    fireEvent.change(input, { target: { files: [file()] } });
    // 重导成功：规划被替换为空规划
    await screen.findByText(/暂无分配/);
    expect(screen.queryByText('数据中心-A')).toBeNull();
  });
});

describe('写入失败：冲突合并保持冲突锁定', () => {
  it('合并落盘失败：冲突弹窗与锁定保持，存储恢复后重试可解决', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '载入示例' }));

    // 外部标签页基于创世修订提交了互不包含的修改 → 分叉冲突
    postExternalState([divergedRemote()]);
    expect(screen.getByRole('alertdialog', { name: '检测到分叉更新' })).toBeTruthy();

    const spy = failStorageWrites();
    fireEvent.click(screen.getByRole('button', { name: '保留本页' }));
    // 合并修订未落盘：冲突锁定保持，规划不变，提示明确错误
    expect(screen.getByRole('alertdialog', { name: '检测到分叉更新' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('编辑已锁定');
    expect(screen.getAllByText('数据中心-A').length).toBeGreaterThan(0);
    expect(screen.getByRole('alert').textContent).toContain('未保存');
    spy.mockRestore();

    // 存储恢复后重试：冲突解决、锁定解除、示例规划保留
    fireEvent.click(screen.getByRole('button', { name: '保留本页' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getAllByText('数据中心-A').length).toBeGreaterThan(0);
  });
});
