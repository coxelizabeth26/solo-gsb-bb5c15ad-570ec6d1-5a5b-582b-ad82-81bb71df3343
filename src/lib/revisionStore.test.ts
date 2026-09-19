import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GENESIS_REVISION_ID,
  HEAD_STORAGE_KEY,
  REVISIONS_STORAGE_KEY,
  STATE_STORAGE_KEY,
  Revision,
  RevisionSync,
  isAncestor,
  parseRevision,
  relationOf,
} from './revisionStore';
import { Plan, emptyPlan } from './model';

// ---- 测试替身 ----

class MemStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/**
 * 可注入的失败存储：setItem/removeItem 按配额（QuotaExceededError 风格）
 * 或被 shouldFail 回调拒绝（权限限制/隐私模式风格），用于复现写盘失败。
 */
class FailingStorage extends MemStorage {
  constructor(
    private readonly shouldFail: (key: string, value: string) => boolean,
    private readonly message = 'QuotaExceededError',
  ) {
    super();
  }
  override setItem(key: string, value: string): void {
    if (this.shouldFail(key, value)) {
      const err = new Error(this.message);
      err.name = 'QuotaExceededError';
      throw err;
    }
    super.setItem(key, value);
  }
}

/** 读取单键原子状态文档。 */
function readState(storage: Storage): { version: number; headId: string; revisions: Revision[] } {
  return JSON.parse(storage.getItem(STATE_STORAGE_KEY)!);
}

type Message = { data: unknown };
class FakeChannel {
  static registry = new Map<string, Set<FakeChannel>>();
  onmessage: ((ev: Message) => void) | null = null;
  constructor(public readonly name: string) {
    if (!FakeChannel.registry.has(name)) FakeChannel.registry.set(name, new Set());
    FakeChannel.registry.get(name)!.add(this);
  }
  postMessage(data: unknown): void {
    for (const other of FakeChannel.registry.get(this.name)!) {
      if (other === this) continue;
      const target = other;
      queueMicrotask(() => target.onmessage?.({ data }));
    }
  }
  close(): void {
    FakeChannel.registry.get(this.name)?.delete(this);
  }
}

function counterUuid(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function rootOnlyPlan(id: string): Plan {
  return {
    version: 1,
    roots: [{ id: `root-${id}`, name: `R${id}`, cidr: '10.0.0.0/8' }],
    allocations: [],
  };
}

function withAllocPlan(id: string): Plan {
  return {
    version: 1,
    roots: [{ id: 'root-1', name: 'R1', cidr: '10.0.0.0/8' }],
    allocations: [
      { id: `alloc-${id}`, name: `A${id}`, kind: 'subnet', prefix: 24, cidr: '10.0.0.0/24' },
    ],
  };
}

interface Recorders {
  ff: Revision[];
  conflicts: Revision[];
  warnings: string[];
}

function openSync(
  storage: Storage,
  clientId: string,
  rec: Recorders,
  uuid: () => string = counterUuid(`${clientId}-rev`),
  channel?: FakeChannel,
): RevisionSync {
  return RevisionSync.open(
    {
      onFastForward: (r) => rec.ff.push(r),
      onConflict: (r) => rec.conflicts.push(r),
      onWarning: (m) => rec.warnings.push(m),
    },
    {
      storage,
      channel: (channel ?? new FakeChannel('test')) as unknown as BroadcastChannel,
      clientId,
      uuid,
    },
  );
}

function rec(): Recorders {
  return { ff: [], conflicts: [], warnings: [] };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeChannel.registry.clear();
});

afterEach(() => {
  FakeChannel.registry.clear();
});

describe('创世与持久化', () => {
  it('空存储以固定 id 的空规划创世修订启动并持久化为单键原子状态', () => {
    const storage = new MemStorage();
    const sync = openSync(storage, 'c1', rec());
    expect(sync.head.id).toBe(GENESIS_REVISION_ID);
    expect(sync.head.plan).toEqual(emptyPlan());
    const state = readState(storage);
    expect(state.version).toBe(2);
    expect(state.headId).toBe(GENESIS_REVISION_ID);
    expect(state.revisions).toHaveLength(1);
    expect(state.revisions[0].id).toBe(GENESIS_REVISION_ID);
    // 单键形态：旧版双键不存在
    expect(storage.getItem(REVISIONS_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(HEAD_STORAGE_KEY)).toBeNull();
    sync.destroy();
  });

  it('新会话恢复 head 指向且通过校验的修订', () => {
    const storage = new MemStorage();
    const s1 = openSync(storage, 'c1', rec());
    s1.commit(rootOnlyPlan('x'));
    const headId = s1.head.id;
    s1.destroy();

    const rec2 = rec();
    const s2 = openSync(storage, 'c2', rec2, counterUuid('c2-rev'));
    expect(s2.head.id).toBe(headId);
    expect(s2.head.plan.roots[0].cidr).toBe('10.0.0.0/8');
    expect(rec2.warnings).toHaveLength(0);
    s2.destroy();
  });

  it('commit 使用随机 id、记录父修订与 clientId、携带完整 Plan', () => {
    const storage = new MemStorage();
    const sync = openSync(storage, 'c1', rec(), counterUuid('r'));
    const parent = sync.head.id;
    const result = sync.commit(rootOnlyPlan('1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rev = result.revision;
    expect(rev.id).toBe('r-1'); // 经由注入的 uuid 生成（浏览器环境为 crypto.randomUUID）
    expect(rev.parentRevisionIds).toEqual([parent]);
    expect(rev.clientId).toBe('c1');
    expect(rev.plan.roots).toHaveLength(1);
    expect(sync.head.id).toBe(rev.id);
    sync.destroy();
  });
});

describe('旧版双键数据迁移', () => {
  it('新键缺失时迁移 revisions/v1 + head/v1 为单键状态，head 保持一致并清理旧键', () => {
    const storage = new MemStorage();
    const genesis: Revision = {
      id: GENESIS_REVISION_ID,
      parentRevisionIds: [],
      clientId: 'c',
      plan: emptyPlan(),
    };
    const leaf: Revision = {
      id: 'leaf',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('1'),
    };
    storage.setItem(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({ version: 1, revisions: [genesis, leaf] } satisfies {
        version: 1;
        revisions: Revision[];
      }),
    );
    storage.setItem(HEAD_STORAGE_KEY, 'leaf');

    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('m'));
    expect(s.head.id).toBe('leaf');
    const state = readState(storage);
    expect(state.version).toBe(2);
    expect(state.headId).toBe('leaf');
    expect(state.revisions.map((x) => x.id)).toEqual([GENESIS_REVISION_ID, 'leaf']);
    // 旧键在迁移成功后清理
    expect(storage.getItem(REVISIONS_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(HEAD_STORAGE_KEY)).toBeNull();
    expect(r.warnings.join(' ')).toContain('迁移');
    s.destroy();
  });

  it('新键存在时优先使用新键，不读取也不删除残留旧键', () => {
    const storage = new MemStorage();
    const oldLeaf: Revision = {
      id: 'old-leaf',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('old'),
    };
    storage.setItem(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        revisions: [
          { id: GENESIS_REVISION_ID, parentRevisionIds: [], clientId: 'c', plan: emptyPlan() },
          oldLeaf,
        ],
      }),
    );
    storage.setItem(HEAD_STORAGE_KEY, 'old-leaf');

    storage.setItem(
      STATE_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        headId: 'new-leaf',
        revisions: [
          { id: GENESIS_REVISION_ID, parentRevisionIds: [], clientId: 'c2', plan: emptyPlan() },
          {
            id: 'new-leaf',
            parentRevisionIds: [GENESIS_REVISION_ID],
            clientId: 'c2',
            plan: rootOnlyPlan('new'),
          },
        ],
      }),
    );

    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('m'));
    expect(s.head.id).toBe('new-leaf');
    // 旧键保留（不被迁移路径触碰）
    expect(storage.getItem(HEAD_STORAGE_KEY)).toBe('old-leaf');
    expect(r.warnings).toHaveLength(0);
    s.destroy();
  });

  it('迁移时旧 head 缺失/损坏，恢复到叶子修订后再迁移', () => {
    const storage = new MemStorage();
    storage.setItem(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        revisions: [
          { id: GENESIS_REVISION_ID, parentRevisionIds: [], clientId: 'c', plan: emptyPlan() },
          {
            id: 'leaf',
            parentRevisionIds: [GENESIS_REVISION_ID],
            clientId: 'c',
            plan: rootOnlyPlan('1'),
          },
        ],
      }),
    );
    // 不写 head
    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('m'));
    expect(s.head.id).toBe('leaf');
    expect(readState(storage).headId).toBe('leaf');
    expect(storage.getItem(REVISIONS_STORAGE_KEY)).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/head|迁移/);
    s.destroy();
  });

  it('迁移后提交的新修订写入新键，不再触碰旧键', () => {
    const storage = new MemStorage();
    storage.setItem(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        revisions: [
          { id: GENESIS_REVISION_ID, parentRevisionIds: [], clientId: 'c', plan: emptyPlan() },
        ],
      }),
    );
    storage.setItem(HEAD_STORAGE_KEY, GENESIS_REVISION_ID);

    const s = openSync(storage, 'c1', rec(), counterUuid('m'));
    expect(storage.getItem(REVISIONS_STORAGE_KEY)).toBeNull();
    const result = s.commit(rootOnlyPlan('after'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = readState(storage);
    expect(state.headId).toBe(result.revision.id);
    expect(state.revisions).toHaveLength(2);
    s.destroy();
  });
});

describe('修订图祖先判定', () => {
  it('线性链上祖先/后代判定正确', () => {
    const revs = new Map<string, Revision>();
    const put = (id: string, parents: string[]) =>
      revs.set(id, { id, parentRevisionIds: parents, clientId: 'c', plan: emptyPlan() });
    put(GENESIS_REVISION_ID, []);
    put('a', [GENESIS_REVISION_ID]);
    put('b', ['a']);
    put('c', ['b']);
    expect(isAncestor(GENESIS_REVISION_ID, 'c', revs)).toBe(true);
    expect(isAncestor('a', 'c', revs)).toBe(true);
    expect(isAncestor('c', 'a', revs)).toBe(false);
    expect(isAncestor('b', 'b', revs)).toBe(true);
    expect(relationOf('a', 'c', revs)).toBe('fast-forward');
    expect(relationOf('c', 'a', revs)).toBe('stale');
    expect(relationOf('b', 'b', revs)).toBe('same');
  });

  it('两个共同祖先的兄弟分支互不为祖先 → 分叉', () => {
    const revs = new Map<string, Revision>();
    const put = (id: string, parents: string[]) =>
      revs.set(id, { id, parentRevisionIds: parents, clientId: 'c', plan: emptyPlan() });
    put(GENESIS_REVISION_ID, []);
    put('base', [GENESIS_REVISION_ID]);
    put('left', ['base']);
    put('right', ['base']);
    expect(relationOf('left', 'right', revs)).toBe('diverged');
    expect(relationOf('right', 'left', revs)).toBe('diverged');
  });

  it('合并修订同时是两个分支的后代', () => {
    const revs = new Map<string, Revision>();
    const put = (id: string, parents: string[]) =>
      revs.set(id, { id, parentRevisionIds: parents, clientId: 'c', plan: emptyPlan() });
    put(GENESIS_REVISION_ID, []);
    put('base', [GENESIS_REVISION_ID]);
    put('left', ['base']);
    put('right', ['base']);
    put('merge', ['left', 'right']);
    expect(isAncestor('left', 'merge', revs)).toBe(true);
    expect(isAncestor('right', 'merge', revs)).toBe(true);
    expect(relationOf('right', 'merge', revs)).toBe('fast-forward');
    expect(relationOf('left', 'merge', revs)).toBe('fast-forward');
  });

  it('父链缺失（被裁剪）时不能证明祖先 → 保守判为分叉', () => {
    const revs = new Map<string, Revision>();
    revs.set('x', { id: 'x', parentRevisionIds: ['gone'], clientId: 'c', plan: emptyPlan() });
    revs.set('y', { id: 'y', parentRevisionIds: ['gone'], clientId: 'c', plan: emptyPlan() });
    expect(relationOf('x', 'y', revs)).toBe('diverged');
  });
});

describe('跨标签页广播同步', () => {
  it('外部线性更新自动快进，本页内容被更新', async () => {
    const storage = new MemStorage();
    const r1 = rec();
    const r2 = rec();
    const s1 = openSync(storage, 'c1', r1);
    const s2 = openSync(storage, 'c2', r2);
    await flush();

    s1.commit(rootOnlyPlan('1'));
    await flush();

    expect(r2.ff).toHaveLength(1);
    expect(s2.head.plan.roots).toHaveLength(1);
    expect(s2.head.id).toBe(s1.head.id);
    s1.destroy();
    s2.destroy();
  });

  it('乱序补链后收到的祖先修订（过时更新）被忽略', () => {
    // 场景：s2 通过共享存储直接拿到 genesis、a、b（head=b），但修订 a 的广播
    // 此刻才到达——a 已是当前 head 的祖先，应判 stale 忽略。
    const storage = new MemStorage();
    const r1 = rec();
    const s1 = openSync(storage, 'c1', r1, counterUuid('c1'));
    const ra = s1.commit(rootOnlyPlan('1'));
    const rb = s1.commit(rootOnlyPlan('2'));
    expect(ra.ok && rb.ok).toBe(true);
    const a = (ra as { ok: true; revision: Revision }).revision;
    const b = (rb as { ok: true; revision: Revision }).revision;
    s1.destroy();

    // 从存储中移除 a 再重新打开（模拟缺口），然后补送 a
    const state = readState(storage);
    const withoutA = {
      ...state,
      revisions: state.revisions.filter((x: Revision) => x.id !== a.id),
    };
    storage.setItem(STATE_STORAGE_KEY, JSON.stringify(withoutA));

    const r2 = rec();
    const ch2 = new FakeChannel('test');
    const s2 = openSync(storage, 'c2', r2, counterUuid('c2'), ch2);
    expect(s2.head.id).toBe(b.id); // b 是唯一叶子，head 恢复到 b
    const warnings = r2.warnings.length;

    (s2 as unknown as { ingest(rev: Revision): void }).ingest(a);
    expect(s2.head.id).toBe(b.id);
    expect(r2.ff).toHaveLength(0); // 祖先修订：stale 忽略，不快进
    expect(r2.conflicts).toHaveLength(0);
    expect(r2.warnings).toHaveLength(warnings);
    s2.destroy();
  });

  it('双方互不为祖先：保留两份并进入冲突，冲突期间挂起后续修订', async () => {
    const storage = new MemStorage();
    const r1 = rec();
    const r2 = rec();
    const r3 = rec();
    const s1 = openSync(storage, 'c1', r1);
    const s2 = openSync(storage, 'c2', r2);
    const s3 = openSync(storage, 'c3', r3);
    await flush();

    // s1、s2 基于同一 head 各自提交 → 互相判定为分叉
    s1.commit(rootOnlyPlan('L'));
    s2.commit(rootOnlyPlan('R'));
    await flush();

    expect(r1.conflicts.length).toBe(1);
    expect(r2.conflicts.length).toBe(1);
    expect(s1.inConflict).toBe(true);
    expect(s2.inConflict).toBe(true);
    // 两份内容都保留在各自图中
    expect(s1.getRevision(r1.conflicts[0].id)?.plan.roots[0].name).toBe('RR');
    expect(s2.getRevision(r2.conflicts[0].id)?.plan.roots[0].name).toBe('RL');

    // 冲突期间第三方再来一个线性于其自身的修订：双方都挂起，head 不变
    const headBefore1 = s1.head.id;
    const headBefore2 = s2.head.id;
    s3.commit(withAllocPlan('pending'));
    await flush();
    expect(s1.head.id).toBe(headBefore1);
    expect(s2.head.id).toBe(headBefore2);
    expect(s1.inConflict).toBe(true);
    s1.destroy();
    s2.destroy();
    s3.destroy();
  });

  it('用户选择后生成双父合并修订并广播，另一侧快进收敛', async () => {
    const storage = new MemStorage();
    const r1 = rec();
    const r2 = rec();
    const s1 = openSync(storage, 'c1', r1);
    const s2 = openSync(storage, 'c2', r2);
    await flush();

    s1.commit(rootOnlyPlan('L'));
    s2.commit(rootOnlyPlan('R'));
    await flush();
    expect(s1.inConflict).toBe(true);
    expect(s2.inConflict).toBe(true);

    const remoteRev = r1.conflicts[0];
    // s1 采用外部版本：合并修订同时引用两个版本
    const mergeResult = s1.mergeAndHead(remoteRev.plan, remoteRev.id);
    expect(mergeResult.ok).toBe(true);
    const merge = s1.head;
    expect(merge.parentRevisionIds).toHaveLength(2);
    expect(merge.parentRevisionIds).toContain(remoteRev.id);

    // resume 重新判定挂起队列（此处只有已成为祖先的 remote）
    s1.resume();
    expect(s1.inConflict).toBe(false);

    await flush();
    // s2：合并修订是其 head（right）与冲突版本（left）的共同后代 → 自动消解并快进
    expect(s2.inConflict).toBe(false);
    expect(s2.head.id).toBe(merge.id);
    expect(s2.head.plan).toEqual(remoteRev.plan);
    s1.destroy();
    s2.destroy();
  });

  it('冲突期间收到双父合并修订时自动消解，无需再次弹窗', () => {
    const storage = new MemStorage();
    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('m'));
    const genesis = s.head.id;
    const ingest = (rev: Revision) =>
      (s as unknown as { ingest(rev: Revision): void }).ingest(rev);

    // 外部两个兄弟修订先后到达：第一个线性快进，第二个造成分叉冲突
    const local: Revision = {
      id: 'local',
      parentRevisionIds: [genesis],
      clientId: 'c2',
      plan: rootOnlyPlan('Local'),
    };
    const remote: Revision = {
      id: 'remote',
      parentRevisionIds: [genesis],
      clientId: 'c3',
      plan: rootOnlyPlan('Remote'),
    };
    ingest(local);
    expect(s.inConflict).toBe(false);
    expect(s.head.id).toBe('local');
    ingest(remote);
    expect(s.inConflict).toBe(true);

    // 某个标签页已提交同时引用 local/remote 的合并修订
    const merge: Revision = {
      id: 'merge',
      parentRevisionIds: ['local', 'remote'],
      clientId: 'c2',
      plan: remote.plan,
    };
    ingest(merge);
    expect(s.inConflict).toBe(false);
    expect(s.head.id).toBe('merge');
    expect(r.ff.map((f) => f.id)).toEqual(['local', 'merge']);
    s.destroy();
  });

  it('冲突期间 commit 被拒绝，不会在锁定时发布修订', () => {
    const storage = new MemStorage();
    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('m'));
    const genesis = s.head.id;
    const ingest = (rev: Revision) =>
      (s as unknown as { ingest(rev: Revision): void }).ingest(rev);

    ingest({ id: 'a', parentRevisionIds: [genesis], clientId: 'c2', plan: rootOnlyPlan('A') });
    ingest({ id: 'b', parentRevisionIds: [genesis], clientId: 'c3', plan: rootOnlyPlan('B') });
    expect(s.inConflict).toBe(true);
    const head = s.head.id;
    const stateBefore = storage.getItem(STATE_STORAGE_KEY);
    const result = s.commit(rootOnlyPlan('should-not-happen'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('conflict-locked');
    expect(s.head.id).toBe(head);
    // 冲突拒绝不产生幽灵版本：存储与图均无新增修订
    expect(storage.getItem(STATE_STORAGE_KEY)).toBe(stateBefore);
    expect(readState(storage).revisions.some((x) => x.plan.roots[0]?.name === 'Rshould-not-happen'))
      .toBe(false);
    s.destroy();
  });
});

describe('存储写入失败（配额耗尽/权限限制）：先落盘后改内存，失败修订不外泄', () => {
  it('commit 写入失败：head 不切换、修订不入库不入图、不广播，返回明确错误', async () => {
    const storage = new MemStorage();
    const r = rec();
    const ch = new FakeChannel('test');
    const posted: unknown[] = [];
    const origPost = ch.postMessage.bind(ch);
    ch.postMessage = (data: unknown) => {
      posted.push(data);
      origPost(data);
    };
    const s = openSync(storage, 'c1', r, counterUuid('m'), ch);
    const beforeState = storage.getItem(STATE_STORAGE_KEY);
    const beforeHead = s.head.id;
    await flush();
    const postedBaseline = posted.length; // openSync 创世修订会广播一次

    // 此后所有新状态写入都失败（配额耗尽）
    const realSet = MemStorage.prototype.setItem;
    vi.spyOn(storage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === STATE_STORAGE_KEY) {
        const err = new Error('QuotaExceededError: 存储空间不足');
        err.name = 'QuotaExceededError';
        throw err;
      }
      realSet.call(storage, key, value);
    });

    const result = s.commit(rootOnlyPlan('fail'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('storage-error');
      expect(result.message).toContain('本地存储');
    }
    // 内存状态完全回滚：head 未切换、图中没有失败修订
    expect(s.head.id).toBe(beforeHead);
    expect(s.getRevision('m-1')).toBeUndefined();
    // 存储保持提交前内容（原子替换从未发生）
    expect(storage.getItem(STATE_STORAGE_KEY)).toBe(beforeState);
    // 失败修订未广播（创世广播之外没有新消息）
    await flush();
    expect(posted).toHaveLength(postedBaseline);
    s.destroy();
  });

  it('commit 失败后下一次成功提交仍正常（回滚不污染图，无幽灵版本）', async () => {
    const storage = new MemStorage();
    const r = rec();
    const ch = new FakeChannel('test');
    const posted: unknown[] = [];
    const origPost = ch.postMessage.bind(ch);
    ch.postMessage = (data: unknown) => {
      posted.push(data);
      origPost(data);
    };
    const s = openSync(storage, 'c1', r, counterUuid('m'), ch);
    const beforeHead = s.head.id;
    await flush();
    const postedBaseline = posted.length; // openSync 创世修订会广播一次

    let failNext = true;
    const spy = vi.spyOn(storage, 'setItem');
    spy.mockImplementation((key: string, value: string) => {
      if (key === STATE_STORAGE_KEY && failNext) {
        const err = new Error('denied');
        err.name = 'SecurityError';
        throw err;
      }
      MemStorage.prototype.setItem.call(storage, key, value);
    });

    const failed = s.commit(rootOnlyPlan('dropped'));
    expect(failed.ok).toBe(false);
    expect(s.head.id).toBe(beforeHead);

    failNext = false;
    const ok = s.commit(rootOnlyPlan('kept'));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(s.head.id).toBe(ok.revision.id);
      expect(ok.revision.parentRevisionIds).toEqual([GENESIS_REVISION_ID]); // 父版本是创世，不含幽灵
      expect(readState(storage).headId).toBe(ok.revision.id);
    }
    await flush();
    // 只有成功的一次被广播（创世广播之外仅一条）
    expect(posted).toHaveLength(postedBaseline + 1);
    expect((posted[postedBaseline] as { revision: Revision }).revision.plan.roots[0].name).toBe(
      'Rkept',
    );
    s.destroy();
  });

  it('mergeAndHead 写入失败：保持冲突锁定与原 head，不广播合并修订', async () => {
    const storage = new MemStorage();
    const r = rec();
    const ch = new FakeChannel('test');
    const posted: unknown[] = [];
    const origPost = ch.postMessage.bind(ch);
    ch.postMessage = (data: unknown) => {
      posted.push(data);
      origPost(data);
    };
    const s = openSync(storage, 'c1', r, counterUuid('m'), ch);
    const genesis = s.head.id;
    const ingest = (rev: Revision) =>
      (s as unknown as { ingest(rev: Revision): void }).ingest(rev);
    ingest({ id: 'a', parentRevisionIds: [genesis], clientId: 'c2', plan: rootOnlyPlan('A') });
    ingest({ id: 'b', parentRevisionIds: [genesis], clientId: 'c3', plan: rootOnlyPlan('B') });
    expect(s.inConflict).toBe(true);
    const beforeHead = s.head.id;
    const postedBeforeConflict = posted.length;

    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    });

    const result = s.mergeAndHead(rootOnlyPlan('merge'), 'b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('storage-error');
    // 冲突锁定保留，head 未切换
    expect(s.inConflict).toBe(true);
    expect(s.head.id).toBe(beforeHead);
    await flush();
    expect(posted).toHaveLength(postedBeforeConflict);
    s.destroy();
  });

  it('外部修订 ingest 落盘失败：不切换 head、不触发快进/冲突，无幽灵节点', () => {
    const storage = new MemStorage();
    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('m'));
    const genesis = s.head.id;
    const ingest = (rev: Revision) =>
      (s as unknown as { ingest(rev: Revision): void }).ingest(rev);
    const warningsBefore = r.warnings.length;

    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    });

    ingest({ id: 'ff', parentRevisionIds: [genesis], clientId: 'c2', plan: rootOnlyPlan('FF') });
    expect(s.head.id).toBe(genesis);
    expect(r.ff).toHaveLength(0);
    expect(r.conflicts).toHaveLength(0);
    expect(s.getRevision('ff')).toBeUndefined();
    expect(r.warnings.length).toBeGreaterThan(warningsBefore);
    expect(r.warnings[r.warnings.length - 1]).toContain('本地存储');

    // 恢复存储后，同一修订可以正常 ingest（没有“半提交”残留阻止重试）
    vi.restoreAllMocks();
    ingest({ id: 'ff', parentRevisionIds: [genesis], clientId: 'c2', plan: rootOnlyPlan('FF') });
    expect(s.head.id).toBe('ff');
    expect(r.ff.map((f) => f.id)).toEqual(['ff']);
    s.destroy();
  });

  it('冲突期间外部合并修订落盘失败：保持冲突锁定，不触发自动消解', () => {
    const storage = new MemStorage();
    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('m'));
    const genesis = s.head.id;
    const ingest = (rev: Revision) =>
      (s as unknown as { ingest(rev: Revision): void }).ingest(rev);
    ingest({ id: 'local', parentRevisionIds: [genesis], clientId: 'c2', plan: rootOnlyPlan('L') });
    ingest({ id: 'remote', parentRevisionIds: [genesis], clientId: 'c3', plan: rootOnlyPlan('R') });
    expect(s.inConflict).toBe(true);

    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError: 写入被拒绝');
    });
    const merge: Revision = {
      id: 'merge',
      parentRevisionIds: ['local', 'remote'],
      clientId: 'c2',
      plan: rootOnlyPlan('M'),
    };
    ingest(merge);
    expect(s.inConflict).toBe(true);
    expect(s.head.id).toBe('local');
    expect(s.getRevision('merge')).toBeUndefined();
    expect(r.ff.map((f) => f.id)).toEqual(['local']); // 仅此前成功的快进
    s.destroy();
  });

  it('空存储启动时创世写入失败：给出明确警告，提交持续失败但不产生幽灵版本', () => {
    const storage = new FailingStorage(() => true, 'SecurityError');
    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('g'));
    expect(s.head.id).toBe(GENESIS_REVISION_ID);
    expect(r.warnings.join(' ')).toContain('本地存储');
    // 存储中确实什么都没有
    expect(storage.getItem(STATE_STORAGE_KEY)).toBeNull();

    const result = s.commit(rootOnlyPlan('x'));
    expect(result.ok).toBe(false);
    expect(s.head.id).toBe(GENESIS_REVISION_ID);
    s.destroy();
  });

  it('迁移旧版双键时新键写入失败：保留旧键不删除，并给出明确错误', () => {
    const backing = new Map<string, string>();
    backing.set(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        revisions: [
          { id: GENESIS_REVISION_ID, parentRevisionIds: [], clientId: 'c', plan: emptyPlan() },
        ],
      }),
    );
    backing.set(HEAD_STORAGE_KEY, GENESIS_REVISION_ID);
    const storage: Storage = {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (k) => (backing.has(k) ? backing.get(k)! : null),
      key: (i) => [...backing.keys()][i] ?? null,
      removeItem: (k) => backing.delete(k),
      setItem: (k, v) => {
        if (k === STATE_STORAGE_KEY) throw new Error('QuotaExceededError');
        backing.set(k, v);
      },
    };
    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('m'));
    expect(s.head.id).toBe(GENESIS_REVISION_ID);
    // 迁移失败：旧键原样保留，新键不存在
    expect(storage.getItem(REVISIONS_STORAGE_KEY)).not.toBeNull();
    expect(storage.getItem(HEAD_STORAGE_KEY)).toBe(GENESIS_REVISION_ID);
    expect(storage.getItem(STATE_STORAGE_KEY)).toBeNull();
    expect(r.warnings.join(' ')).toContain('本地存储');
    s.destroy();
  });
});

describe('损坏快照', () => {
  it('parseRevision 拒绝结构损坏与未通过 Plan 校验的快照', () => {
    expect(parseRevision(null).ok).toBe(false);
    expect(parseRevision({ id: 'x' }).ok).toBe(false);
    const badPlan: Revision = {
      id: 'x',
      parentRevisionIds: [],
      clientId: 'c',
      plan: { version: 1, roots: [], allocations: [] } as unknown as Plan,
    };
    // 空规划合法
    expect(parseRevision(badPlan).ok).toBe(true);
    const invalid: Revision = {
      id: 'y',
      parentRevisionIds: [],
      clientId: 'c',
      plan: {
        version: 1,
        roots: [{ id: 'r', name: 'R', cidr: '10.0.0.0/8' }],
        allocations: [
          { id: 'a', name: 'A', kind: 'subnet', prefix: 24, cidr: '192.168.0.0/24' },
        ],
      },
    };
    const result = parseRevision(invalid);
    expect(result.ok).toBe(false);
  });

  it('收到损坏广播时忽略并提示，不改变 head', async () => {
    const storage = new MemStorage();
    const r = rec();
    const s = openSync(storage, 'c1', r);
    const before = s.head.id;
    const sender = new FakeChannel('test');
    await flush();
    sender.postMessage({ type: 'revision', revision: { id: 'broken' } });
    await flush();
    expect(s.head.id).toBe(before);
    expect(r.warnings.join(' ')).toContain('损坏');
    s.destroy();
    sender.close();
  });

  it('用户合并后挂起修订仍分叉时再次提示冲突，不按时间覆盖', () => {
    const storage = new MemStorage();
    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('m'));
    const genesis = s.head.id;
    const ingest = (rev: Revision) =>
      (s as unknown as { ingest(rev: Revision): void }).ingest(rev);

    const left: Revision = {
      id: 'left',
      parentRevisionIds: [genesis],
      clientId: 'c2',
      plan: rootOnlyPlan('L'),
    };
    const mid: Revision = {
      id: 'mid',
      parentRevisionIds: [genesis],
      clientId: 'c3',
      plan: rootOnlyPlan('M'),
    };
    const right: Revision = {
      id: 'right',
      parentRevisionIds: [genesis],
      clientId: 'c4',
      plan: rootOnlyPlan('R'),
    };
    ingest(left); // 线性快进
    ingest(mid); // → 分叉冲突
    ingest(right); // 冲突期间挂起
    expect(r.conflicts.map((c) => c.id)).toEqual(['mid']);

    // 用户选择保留本页（left 的内容），生成引用 left/mid 的合并修订；
    // right 与该合并仍互为分叉，resume 后必须再次冲突而不是按时间覆盖。
    s.mergeAndHead(left.plan, mid.id);
    s.resume();
    expect(s.inConflict).toBe(true);
    expect(r.conflicts.map((c) => c.id)).toEqual(['mid', 'right']);
    expect(s.head.plan.roots[0].name).toBe('RL');
    s.destroy();
  });

  it('本地文档部分损坏时忽略坏条目并加载好条目', () => {
    const storage = new MemStorage();
    const good: Revision = {
      id: 'good',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('1'),
    };
    storage.setItem(
      STATE_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        headId: 'good',
        revisions: [
          { id: GENESIS_REVISION_ID, parentRevisionIds: [], clientId: 'c', plan: emptyPlan() },
          good,
          { id: 'bad', plan: null },
        ],
      }),
    );
    const r = rec();
    const s = openSync(storage, 'c2', r, counterUuid('z'));
    expect(s.head.id).toBe('good');
    expect(r.warnings.join(' ')).toContain('损坏');
    s.destroy();
  });

  it('head 指针丢失时恢复到叶子修订', () => {
    const storage = new MemStorage();
    const genesis: Revision = {
      id: GENESIS_REVISION_ID,
      parentRevisionIds: [],
      clientId: 'c',
      plan: emptyPlan(),
    };
    const leaf: Revision = {
      id: 'leaf',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('1'),
    };
    storage.setItem(
      STATE_STORAGE_KEY,
      JSON.stringify({ version: 2, headId: null, revisions: [genesis, leaf] }),
    );
    // 不写有效 head
    const r = rec();
    const s = openSync(storage, 'c2', r, counterUuid('z'));
    expect(s.head.id).toBe('leaf');
    expect(r.warnings.join(' ')).toContain('head');
    s.destroy();
  });

  it('整个文档不可解析时忽略并从空规划重新开始', () => {
    const storage = new MemStorage();
    storage.setItem(STATE_STORAGE_KEY, '{not json');
    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('z'));
    expect(s.head.id).toBe(GENESIS_REVISION_ID);
    expect(r.warnings.join(' ')).toContain('损坏');
    s.destroy();
  });
});
