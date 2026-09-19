import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  protected readonly map: Map<string, string>;
  constructor(backing?: Map<string, string>) {
    this.map = backing ?? new Map<string, string>();
  }
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
 * 可注入失败模式的存储：failSet 打开后 setItem 抛错（模拟容量耗尽/权限限制）。
 * 可传入共享底层 Map：两个门面分别注入失败，模拟同一源下不同标签页各自的写入结果。
 */
class FailingStorage extends MemStorage {
  failSet = false;
  override setItem(key: string, value: string): void {
    if (this.failSet) throw new Error('QuotaExceededError: 容量已满，写入被拒绝');
    super.setItem(key, value);
  }
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

/** 提交并断言成功，返回新修订。 */
function mustCommit(sync: RevisionSync, plan: Plan): Revision {
  const r = sync.commit(plan);
  if (!r.ok) throw new Error(`commit 被意外拒绝：${r.error}`);
  return r.revision;
}

function genesisRevision(): Revision {
  return { id: GENESIS_REVISION_ID, parentRevisionIds: [], clientId: 'c', plan: emptyPlan() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeChannel.registry.clear();
});

afterEach(() => {
  FakeChannel.registry.clear();
});

describe('创世与持久化', () => {
  it('空存储以固定 id 的空规划创世修订启动，修订与 head 收敛为单键状态', () => {
    const storage = new MemStorage();
    const sync = openSync(storage, 'c1', rec());
    expect(sync.head.id).toBe(GENESIS_REVISION_ID);
    expect(sync.head.plan).toEqual(emptyPlan());
    // 单键原子状态：head 与修订全集同处一个文档
    const doc = JSON.parse(storage.getItem(STATE_STORAGE_KEY)!);
    expect(doc.version).toBe(2);
    expect(doc.headId).toBe(GENESIS_REVISION_ID);
    expect(doc.revisions).toHaveLength(1);
    expect(doc.revisions[0].id).toBe(GENESIS_REVISION_ID);
    // 旧版双键不再写入
    expect(storage.getItem(REVISIONS_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(HEAD_STORAGE_KEY)).toBeNull();
    sync.destroy();
  });

  it('新会话恢复 head 指向且通过校验的修订', () => {
    const storage = new MemStorage();
    const s1 = openSync(storage, 'c1', rec());
    mustCommit(s1, rootOnlyPlan('x'));
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
    const res = sync.commit(rootOnlyPlan('1'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.revision.id).toBe('r-1'); // 经由注入的 uuid 生成（浏览器环境为 crypto.randomUUID）
    expect(res.revision.parentRevisionIds).toEqual([parent]);
    expect(res.revision.clientId).toBe('c1');
    expect(res.revision.plan.roots).toHaveLength(1);
    expect(sync.head.id).toBe(res.revision.id);
    // 单键状态中 head 与修订全集一致
    const doc = JSON.parse(storage.getItem(STATE_STORAGE_KEY)!);
    expect(doc.headId).toBe(res.revision.id);
    expect(doc.revisions.map((r: Revision) => r.id)).toEqual([parent, res.revision.id]);
    sync.destroy();
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

    mustCommit(s1, rootOnlyPlan('1'));
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
    const a = mustCommit(s1, rootOnlyPlan('1'));
    const b = mustCommit(s1, rootOnlyPlan('2'));
    s1.destroy();

    // 从存储中移除 a 再重新打开（模拟缺口），然后补送 a
    const doc = JSON.parse(storage.getItem(STATE_STORAGE_KEY)!);
    const withoutA = {
      ...doc,
      revisions: doc.revisions.filter((x: Revision) => x.id !== a.id),
    };
    storage.setItem(STATE_STORAGE_KEY, JSON.stringify(withoutA));

    const r2 = rec();
    const ch2 = new FakeChannel('test');
    const s2 = openSync(storage, 'c2', r2, counterUuid('c2'), ch2);
    expect(s2.head.id).toBe(b.id); // head 指针仍指向可用的 b
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
    mustCommit(s1, rootOnlyPlan('L'));
    mustCommit(s2, rootOnlyPlan('R'));
    await flush();

    expect(r1.conflicts.length).toBe(1);
    expect(r2.conflicts.length).toBe(1);
    expect(s1.inConflict).toBe(true);
    expect(s2.inConflict).toBe(true);
    // 两份内容都保留在各自图中
    expect(s1.getRevision(r1.conflicts[0].id)?.plan.roots[0].name).toBe('RR');
    expect(s2.getRevision(r2.conflicts[0].id)?.plan.roots[0].name).toBe('RL');

    // 冲突期间第三方再来一个线性于其自身的修订：双方都挂起，head 不变
    // （第三方自身也因收到 L/R 分叉而处于冲突锁定，其提交被直接拒绝）
    const headBefore1 = s1.head.id;
    const headBefore2 = s2.head.id;
    expect(s3.commit(withAllocPlan('pending')).ok).toBe(false);
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

    mustCommit(s1, rootOnlyPlan('L'));
    mustCommit(s2, rootOnlyPlan('R'));
    await flush();
    expect(s1.inConflict).toBe(true);
    expect(s2.inConflict).toBe(true);

    const remoteRev = r1.conflicts[0];
    // s1 采用外部版本：合并修订同时引用两个版本
    const merged = s1.mergeAndHead(remoteRev.plan, remoteRev.id);
    expect(merged.ok).toBe(true);
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
    const returned = s.commit(rootOnlyPlan('should-not-happen'));
    expect(returned.ok).toBe(false);
    expect(s.head.id).toBe(head);
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
    const merged = s.mergeAndHead(left.plan, mid.id);
    expect(merged.ok).toBe(true);
    s.resume();
    expect(s.inConflict).toBe(true);
    expect(r.conflicts.map((c) => c.id)).toEqual(['mid', 'right']);
    expect(s.head.plan.roots[0].name).toBe('RL');
    s.destroy();
  });

  it('本地状态部分损坏时忽略坏条目并加载好条目', () => {
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
          genesisRevision(),
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

  it('head 指针指向缺失修订时恢复到叶子修订', () => {
    const storage = new MemStorage();
    const leaf: Revision = {
      id: 'leaf',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('1'),
    };
    storage.setItem(
      STATE_STORAGE_KEY,
      JSON.stringify({ version: 2, headId: 'missing', revisions: [genesisRevision(), leaf] }),
    );
    const r = rec();
    const s = openSync(storage, 'c2', r, counterUuid('z'));
    expect(s.head.id).toBe('leaf');
    expect(r.warnings.join(' ')).toContain('head');
    s.destroy();
  });

  it('整个状态不可解析且无双键遗留时忽略并从空规划重新开始', () => {
    const storage = new MemStorage();
    storage.setItem(STATE_STORAGE_KEY, '{not json');
    const r = rec();
    const s = openSync(storage, 'c1', r, counterUuid('z'));
    expect(s.head.id).toBe(GENESIS_REVISION_ID);
    expect(r.warnings.join(' ')).toContain('损坏');
    s.destroy();
  });
});

describe('旧版双键数据迁移', () => {
  it('启动时将双键数据收敛为单键原子状态并清理旧键', () => {
    const storage = new MemStorage();
    const leaf: Revision = {
      id: 'leaf',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('1'),
    };
    storage.setItem(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({ version: 1, revisions: [genesisRevision(), leaf] }),
    );
    storage.setItem(HEAD_STORAGE_KEY, 'leaf');

    const r = rec();
    const s = openSync(storage, 'c2', r, counterUuid('z'));
    expect(s.head.id).toBe('leaf');
    expect(r.warnings.join(' ')).toContain('迁移');

    // 单键状态已写入且 head 与修订全集一致；旧键已清理
    const doc = JSON.parse(storage.getItem(STATE_STORAGE_KEY)!);
    expect(doc.version).toBe(2);
    expect(doc.headId).toBe('leaf');
    expect(doc.revisions.map((x: Revision) => x.id)).toEqual([GENESIS_REVISION_ID, 'leaf']);
    expect(storage.getItem(REVISIONS_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(HEAD_STORAGE_KEY)).toBeNull();
    s.destroy();
  });

  it('旧版 head 指针缺失时先恢复叶子再迁移', () => {
    const storage = new MemStorage();
    const leaf: Revision = {
      id: 'leaf',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('1'),
    };
    storage.setItem(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({ version: 1, revisions: [genesisRevision(), leaf] }),
    );
    // 不写旧版 head 键
    const r = rec();
    const s = openSync(storage, 'c2', r, counterUuid('z'));
    expect(s.head.id).toBe('leaf');
    expect(r.warnings.join(' ')).toContain('head');
    expect(r.warnings.join(' ')).toContain('迁移');
    expect(JSON.parse(storage.getItem(STATE_STORAGE_KEY)!).headId).toBe('leaf');
    s.destroy();
  });

  it('新键与旧键同时存在时以新键为准，下次提交后清理旧键', () => {
    const storage = new MemStorage();
    const newLeaf: Revision = {
      id: 'new-leaf',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('N'),
    };
    const oldLeaf: Revision = {
      id: 'old-leaf',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('O'),
    };
    storage.setItem(
      STATE_STORAGE_KEY,
      JSON.stringify({ version: 2, headId: 'new-leaf', revisions: [genesisRevision(), newLeaf] }),
    );
    storage.setItem(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({ version: 1, revisions: [genesisRevision(), oldLeaf] }),
    );
    storage.setItem(HEAD_STORAGE_KEY, 'old-leaf');

    const r = rec();
    const s = openSync(storage, 'c2', r, counterUuid('z'));
    expect(s.head.id).toBe('new-leaf'); // 新键优先，不回退到旧键
    mustCommit(s, rootOnlyPlan('next'));
    expect(storage.getItem(REVISIONS_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(HEAD_STORAGE_KEY)).toBeNull();
    s.destroy();
  });

  it('新键损坏而旧键可用时从旧键恢复并迁移', () => {
    const storage = new MemStorage();
    const leaf: Revision = {
      id: 'leaf',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('1'),
    };
    storage.setItem(STATE_STORAGE_KEY, '{broken');
    storage.setItem(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({ version: 1, revisions: [genesisRevision(), leaf] }),
    );
    storage.setItem(HEAD_STORAGE_KEY, 'leaf');

    const r = rec();
    const s = openSync(storage, 'c2', r, counterUuid('z'));
    expect(s.head.id).toBe('leaf');
    expect(r.warnings.join(' ')).toContain('损坏');
    expect(r.warnings.join(' ')).toContain('迁移');
    // 损坏的新键已被迁移后的完整状态覆盖
    expect(JSON.parse(storage.getItem(STATE_STORAGE_KEY)!).headId).toBe('leaf');
    s.destroy();
  });

  it('迁移写入失败时保留旧键，下次成功写入时重试迁移', () => {
    const storage = new FailingStorage();
    const leaf: Revision = {
      id: 'leaf',
      parentRevisionIds: [GENESIS_REVISION_ID],
      clientId: 'c',
      plan: rootOnlyPlan('1'),
    };
    storage.setItem(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({ version: 1, revisions: [genesisRevision(), leaf] }),
    );
    storage.setItem(HEAD_STORAGE_KEY, 'leaf');
    storage.failSet = true;

    const r = rec();
    const s = openSync(storage, 'c2', r, counterUuid('z'));
    expect(s.head.id).toBe('leaf'); // 仍从旧数据恢复
    expect(r.warnings.join(' ')).toContain('迁移写入失败');
    expect(storage.getItem(REVISIONS_STORAGE_KEY)).not.toBeNull(); // 旧键保留

    // 存储恢复后，下一次成功提交即完成迁移并清理旧键
    storage.failSet = false;
    mustCommit(s, rootOnlyPlan('2'));
    expect(storage.getItem(REVISIONS_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(HEAD_STORAGE_KEY)).toBeNull();
    const doc = JSON.parse(storage.getItem(STATE_STORAGE_KEY)!);
    expect(doc.headId).toBe(s.head.id);
    expect(doc.revisions.map((x: Revision) => x.id)).toEqual([
      GENESIS_REVISION_ID,
      'leaf',
      s.head.id,
    ]);
    s.destroy();
  });
});

describe('写入失败（可注入失败存储）', () => {
  it('commit 写入失败：保留提交前状态、明确报错、不广播、不留幽灵修订', async () => {
    const storage = new FailingStorage();
    const r1 = rec();
    const r2 = rec();
    const s1 = openSync(storage, 'c1', r1);
    const s2 = openSync(storage, 'c2', r2);
    await flush();
    const headBefore = s1.head.id;

    storage.failSet = true;
    const res = s1.commit(rootOnlyPlan('1'));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('写入失败');
      expect(res.error).toContain('未保存');
    }
    // 内存 head 与修订图保持提交前状态：无幽灵修订
    expect(s1.head.id).toBe(headBefore);
    expect(s1.getRevision('c1-rev-1')).toBeUndefined();
    // 存储仍是失败前的完整状态
    const doc = JSON.parse(storage.getItem(STATE_STORAGE_KEY)!);
    expect(doc.headId).toBe(headBefore);
    expect(doc.revisions).toHaveLength(1);
    // 其他标签页不接收失败修订
    await flush();
    expect(r2.ff).toHaveLength(0);
    expect(r2.conflicts).toHaveLength(0);
    expect(s2.head.id).toBe(headBefore);
    expect(s2.getRevision('c1-rev-1')).toBeUndefined();
    s1.destroy();
    s2.destroy();
  });

  it('连续失败不产生幽灵版本：存储恢复后提交的父指针指向失败前 head', () => {
    const storage = new FailingStorage();
    const r = rec();
    const s = openSync(storage, 'c1', r);
    const headBefore = s.head.id;

    storage.failSet = true;
    expect(s.commit(rootOnlyPlan('A')).ok).toBe(false);
    expect(s.commit(rootOnlyPlan('B')).ok).toBe(false);
    expect(s.head.id).toBe(headBefore);

    storage.failSet = false;
    const ok = mustCommit(s, rootOnlyPlan('C'));
    expect(ok.parentRevisionIds).toEqual([headBefore]); // 失败修订不在父链上
    const doc = JSON.parse(storage.getItem(STATE_STORAGE_KEY)!);
    // 持久化的修订全集只有创世与本次成功提交：无 A/B 幽灵
    expect(doc.revisions.map((x: Revision) => x.id)).toEqual([GENESIS_REVISION_ID, ok.id]);
    expect(doc.headId).toBe(ok.id);
    s.destroy();
  });

  it('合并写入失败时保持冲突锁定，存储恢复后可重试并收敛', async () => {
    const storage = new FailingStorage();
    const r1 = rec();
    const r2 = rec();
    const s1 = openSync(storage, 'c1', r1);
    const s2 = openSync(storage, 'c2', r2);
    await flush();

    mustCommit(s1, rootOnlyPlan('L'));
    mustCommit(s2, rootOnlyPlan('R'));
    await flush();
    expect(s1.inConflict).toBe(true);
    expect(s2.inConflict).toBe(true);
    const remote = r1.conflicts[0];
    const localHead = s1.head.id;

    storage.failSet = true;
    const failed = s1.mergeAndHead(remote.plan, remote.id);
    expect(failed.ok).toBe(false);
    // 冲突锁定保持、head 不变、不产生幽灵合并修订
    expect(s1.inConflict).toBe(true);
    expect(s1.head.id).toBe(localHead);
    expect(s1.getRevision('c1-rev-2')).toBeUndefined();
    await flush();
    // 失败的合并未广播：另一侧仍各自锁定
    expect(s2.inConflict).toBe(true);
    expect(s2.head.plan.roots[0].name).toBe('RR');

    // 存储恢复后重试成功，双方收敛
    storage.failSet = false;
    const retried = s1.mergeAndHead(remote.plan, remote.id);
    expect(retried.ok).toBe(true);
    expect(s1.inConflict).toBe(false);
    s1.resume();
    await flush();
    expect(s2.inConflict).toBe(false);
    expect(s2.head.id).toBe(s1.head.id);
    s1.destroy();
    s2.destroy();
  });

  it('接收侧落盘失败仅提示：修订已由发送方持久化，本地内存状态不回滚', async () => {
    // 同一源下的两个存储门面：发送方写入正常，接收方写入被注入失败
    const backing = new Map<string, string>();
    const st1 = new FailingStorage(backing);
    const st2 = new FailingStorage(backing);
    const r1 = rec();
    const r2 = rec();
    const s1 = openSync(st1, 'c1', r1);
    const s2 = openSync(st2, 'c2', r2);
    await flush();

    // s2 落盘失败（模拟本机权限限制），但 s1 的提交已成功写入共享存储
    st2.failSet = true;
    const sent = mustCommit(s1, rootOnlyPlan('1'));
    await flush();
    // s2 仍正常快进（修订在共享存储中已持久化，刷新后不会丢失）
    expect(r2.ff.map((x) => x.id)).toEqual([sent.id]);
    expect(s2.head.id).toBe(sent.id);
    expect(r2.warnings.join(' ')).toContain('无法写入本地存储');
    // 共享存储中的完整状态不受影响
    const doc = JSON.parse(st1.getItem(STATE_STORAGE_KEY)!);
    expect(doc.headId).toBe(sent.id);
    s1.destroy();
    s2.destroy();
  });
});
