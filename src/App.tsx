import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Allocation,
  Plan,
  RootBlock,
  emptyPlan,
  newId,
  parsePlanJson,
  serializePlan,
  validateAllocation,
  validateRoots,
} from './lib/model';
import {
  BatchSubnetRequest,
  MigrationPlan,
  allocationsFromBatchPlan,
  applyMigration,
  findLowestSlot,
  planBatchSubnets,
  planMigration,
} from './lib/planner';
import { cidrToString, parseCidr, prefixForHosts } from './lib/ip';
import {
  CHANNEL_NAME,
  Revision,
  RevisionSync,
} from './lib/revisionStore';
import { exportPlanBackup, importPlanBackup } from './lib/cryptoBackup';
import Toolbar from './components/Toolbar';
import RootsPanel from './components/RootsPanel';
import TreeView from './components/TreeView';
import AllocationsPanel from './components/AllocationsPanel';
import NewAllocationForm from './components/NewAllocationForm';
import MigrationModal from './components/MigrationModal';
import PrefixPolicyModal from './components/PrefixPolicyModal';
import AddressAuditModal from './components/AddressAuditModal';
import RouteSummaryModal from './components/RouteSummaryModal';
import ConflictModal from './components/ConflictModal';
import CryptoBackupModal from './components/CryptoBackupModal';
import BatchApplyModal from './components/BatchApplyModal';
import PlanDiffModal from './components/PlanDiffModal';
import ClasslessRouteModal from './components/ClasslessRouteModal';

interface MigrationRequest {
  title: string;
  plan: MigrationPlan;
  /** 确认后整批原子应用的下一个规划 */
  next: Plan;
}

function demoPlan(): Plan {
  const roots: RootBlock[] = [
    { id: newId('root'), name: '生产骨干', cidr: '10.0.0.0/8' },
    { id: newId('root'), name: '办公网', cidr: '192.168.0.0/16' },
  ];
  const mk = (name: string, cidr: string, kind: Allocation['kind'], note?: string): Allocation => ({
    id: newId('alloc'),
    name,
    kind,
    prefix: parseCidr(cidr)!.prefix,
    cidr,
    note,
  });
  return {
    version: 1,
    roots,
    allocations: [
      mk('核心交换区', '10.0.0.0/16', 'reserved', '预留扩容'),
      mk('数据中心-A', '10.1.0.0/18', 'subnet'),
      mk('数据中心-B', '10.1.64.0/18', 'subnet'),
      mk('办公有线', '192.168.0.0/22', 'subnet'),
      mk('办公无线', '192.168.4.0/22', 'subnet'),
      mk('访客网络', '192.168.8.0/24', 'subnet'),
    ],
  };
}

export default function App() {
  const [plan, setPlan] = useState<Plan>(emptyPlan);
  const [past, setPast] = useState<Plan[]>([]);
  const [future, setFuture] = useState<Plan[]>([]);
  const [migration, setMigration] = useState<MigrationRequest | null>(null);
  const [resizeTarget, setResizeTarget] = useState<Allocation | null>(null);
  const [prefixPolicyOpen, setPrefixPolicyOpen] = useState(false);
  const [addressAuditOpen, setAddressAuditOpen] = useState(false);
  const [routeSummaryOpen, setRouteSummaryOpen] = useState(false);
  const [planDiffOpen, setPlanDiffOpen] = useState(false);
  const [backupExportOpen, setBackupExportOpen] = useState(false);
  const [backupImport, setBackupImport] = useState<{ name: string; text: string } | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [classlessRouteTarget, setClasslessRouteTarget] = useState<Allocation | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ local: Revision; remote: Revision } | null>(null);
  const [ready, setReady] = useState(false);

  const syncRef = useRef<RevisionSync | null>(null);
  const planRef = useRef<Plan>(plan);
  planRef.current = plan;
  // 撤销/重做需在“先落盘后改界面”的前提下读取栈内容，用 ref 保留同步镜像。
  const pastRef = useRef<Plan[]>(past);
  pastRef.current = past;
  const futureRef = useRef<Plan[]>(future);
  futureRef.current = future;
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 6000);
  }, []);

  /**
   * 尝试发布修订：只有修订完整落盘后才更新界面规划与撤销/重做历史并返回成功。
   * 写入失败（配额耗尽/权限受限）时保留提交前规划、显示明确错误并返回 false，
   * 绝不产生刷新即丢的幽灵版本，也不会向其他标签页广播（广播由 sync 内部完成）。
   */
  const commit = useCallback(
    (next: Plan): boolean => {
      const sync = syncRef.current;
      if (sync?.inConflict) return false; // 冲突期间禁止规划编辑
      if (!sync) {
        // 无持久化后端（启动前/SSR）：仅更新界面，保持历史行为。
        const current = planRef.current;
        setPast((p) => [...p, current]);
        setFuture([]);
        setPlan(next);
        planRef.current = next;
        return true;
      }
      const result = sync.commit(next);
      if (!result.ok) {
        showToast(result.message);
        return false;
      }
      const current = planRef.current;
      setPast((p) => [...p, current]);
      setFuture([]);
      setPlan(next);
      planRef.current = next;
      return true;
    },
    [showToast],
  );

  const undo = useCallback(() => {
    const sync = syncRef.current;
    if (!sync || sync.inConflict) return;
    if (pastRef.current.length === 0) return;
    const prev = pastRef.current[pastRef.current.length - 1];
    const result = sync.commit(prev); // 撤销同样发布为一个新修订
    if (!result.ok) {
      showToast(result.message);
      return; // 落盘失败：保留当前规划与撤销/重做栈
    }
    const current = planRef.current;
    const nextFuture = [current, ...futureRef.current];
    setFuture(nextFuture);
    futureRef.current = nextFuture;
    setPlan(prev);
    planRef.current = prev;
    const nextPast = pastRef.current.slice(0, -1);
    setPast(nextPast);
    pastRef.current = nextPast;
  }, [showToast]);

  const redo = useCallback(() => {
    const sync = syncRef.current;
    if (!sync || sync.inConflict) return;
    if (futureRef.current.length === 0) return;
    const next = futureRef.current[0];
    const result = sync.commit(next); // 重做同样发布为一个新修订
    if (!result.ok) {
      showToast(result.message);
      return; // 落盘失败：保留当前规划与撤销/重做栈
    }
    const current = planRef.current;
    const nextPast = [...pastRef.current, current];
    setPast(nextPast);
    pastRef.current = nextPast;
    setPlan(next);
    planRef.current = next;
    const nextFuture = futureRef.current.slice(1);
    setFuture(nextFuture);
    futureRef.current = nextFuture;
  }, [showToast]);

  // ---- 启动：恢复 head 修订并接入跨标签页广播 ----
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channel = null;
    }
    const uuid = (): string =>
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    // clientId 必须按标签页隔离：存在共享 localStorage 会让所有标签页误判为同一客户端。
    let clientId: string;
    try {
      clientId = window.sessionStorage.getItem('ipv4-subnet-planner/client-id') || uuid();
      window.sessionStorage.setItem('ipv4-subnet-planner/client-id', clientId);
    } catch {
      clientId = uuid();
    }

    const sync = RevisionSync.open(
      {
        onFastForward: (rev) => {
          // 外部更新可快进：作为一次可撤销变更并入本页历史。
          // （此回调由 sync 在状态完整落盘成功后触发，无需再判失败。）
          const current = planRef.current;
          setPast((p) => [...p, current]);
          pastRef.current = [...pastRef.current, current];
          setFuture([]);
          futureRef.current = [];
          setPlan(rev.plan);
          planRef.current = rev.plan;
          setMigration(null); // 基于旧规划的待确认迁移已过期
          setConflict(null); // 可能是冲突期间收到双父合并修订后的自动消解
          showToast('已自动同步其他标签页的更新（可用撤销回到本页此前状态）');
        },
        onConflict: (rev) => {
          setConflict({ local: sync.head, remote: rev });
          setMigration(null);
          showToast('检测到与其他标签页的分叉更新，请选择合并方式；冲突期间编辑已锁定');
        },
        onWarning: (msg) => showToast(msg),
      },
      { storage, channel, clientId, uuid },
    );
    syncRef.current = sync;
    setPlan(sync.head.plan);
    planRef.current = sync.head.plan;
    setReady(true);

    return () => {
      sync.destroy();
      syncRef.current = null;
    };
  }, [showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  /** 冲突解决：生成同时引用本地与外部两个版本的合并修订并继续广播。 */
  const resolveConflict = useCallback(
    (choice: 'local' | 'remote') => {
      const sync = syncRef.current;
      const cur = conflictRef.current;
      if (!sync || !cur) return;
      const current = planRef.current;
      const chosen = choice === 'local' ? cur.local.plan : cur.remote.plan;
      // 合并修订必须先完整落盘：失败时保持冲突锁定与原规划，不清空冲突弹窗。
      const result = sync.mergeAndHead(chosen, cur.remote.id);
      if (!result.ok) {
        showToast(result.message);
        return;
      }
      // 合并是一次显式变更：选择外部版本时合并前状态可一次撤销回来；
      // 选择保留本页时内容未变（仅合并修订图），不入历史栈。
      if (chosen !== current) {
        setPast((p) => [...p, current]);
        pastRef.current = [...pastRef.current, current];
        setFuture([]);
        futureRef.current = [];
        setPlan(chosen);
        planRef.current = chosen;
      }
      setConflict(null);
      showToast(choice === 'local' ? '已保留本页版本并合并修订图' : '已采用外部版本并合并修订图');
      // 重新判定冲突期间挂起的其他外部修订（可能再次快进或再次冲突）。
      sync.resume();
    },
    [showToast],
  );

  /** 根网段或容量变更的统一入口：先预演，全部可保留则直接应用，否则弹窗确认 */
  const requestMigration = useCallback(
    (title: string, nextRoots: RootBlock[], nextAllocs: Allocation[]) => {
      if (syncRef.current?.inConflict) return;
      const plan = planRef.current;
      const mig = planMigration(nextRoots, nextAllocs);
      const next: Plan = {
        ...plan,
        roots: nextRoots,
        allocations: applyMigration(nextAllocs, mig),
      };
      if (mig.ok && mig.items.every((i) => i.status === 'kept')) {
        if (commit(next)) showToast('已应用：所有分配均可原位保留');
      } else {
        setMigration({ title, plan: mig, next });
      }
    },
    [commit, showToast],
  );

  // ---- 根网段 ----
  const addRoot = useCallback(
    (name: string, cidr: string): string[] => {
      const plan = planRef.current;
      const root: RootBlock = { id: newId('root'), name: name.trim(), cidr: cidr.trim() };
      const errors = validateRoots([...plan.roots, root]);
      if (errors.length > 0) return errors;
      const normalized = { ...root, cidr: cidrToString(parseCidr(root.cidr)!) };
      if (!commit({ ...plan, roots: [...plan.roots, normalized] })) {
        return ['保存失败：本地存储写入失败，本次添加未生效，请清理浏览器存储后重试'];
      }
      return [];
    },
    [commit],
  );

  const editRoot = useCallback(
    (id: string, name: string, cidr: string): string[] => {
      const plan = planRef.current;
      const nextRoots = plan.roots.map((r) =>
        r.id === id ? { ...r, name: name.trim(), cidr: cidr.trim() } : r,
      );
      const errors = validateRoots(nextRoots);
      if (errors.length > 0) return errors;
      const normalized = nextRoots.map((r) => ({
        ...r,
        cidr: cidrToString(parseCidr(r.cidr)!),
      }));
      requestMigration(`调整根网段「${name.trim()}」`, normalized, plan.allocations);
      return [];
    },
    [requestMigration],
  );

  const removeRoot = useCallback(
    (id: string) => {
      const plan = planRef.current;
      const root = plan.roots.find((r) => r.id === id);
      if (!root) return;
      const nextRoots = plan.roots.filter((r) => r.id !== id);
      requestMigration(`删除根网段「${root.name}」(${root.cidr})`, nextRoots, plan.allocations);
    },
    [requestMigration],
  );

  // ---- 分配 ----
  const addReservation = useCallback(
    (name: string, cidr: string, note: string): string[] => {
      const plan = planRef.current;
      const candidate = { name: name.trim(), cidr: cidr.trim() };
      const errors = validateAllocation(plan, candidate);
      if (errors.length > 0) return errors;
      const parsed = parseCidr(candidate.cidr)!;
      const alloc: Allocation = {
        id: newId('alloc'),
        name: candidate.name,
        kind: 'reserved',
        prefix: parsed.prefix,
        cidr: cidrToString(parsed),
        note: note.trim() || undefined,
      };
      if (!commit({ ...plan, allocations: [...plan.allocations, alloc] })) {
        return ['保存失败：本地存储写入失败，本次保留段未生效，请清理浏览器存储后重试'];
      }
      return [];
    },
    [commit],
  );

  const requestSubnet = useCallback(
    (name: string, hosts: number, rootId: string, note: string): string[] => {
      const plan = planRef.current;
      const errors: string[] = [];
      if (!name.trim()) errors.push('名称不能为空');
      if (!Number.isInteger(hosts) || hosts < 1) errors.push('主机数必须为不小于 1 的整数');
      if (errors.length > 0) return errors;
      let prefix: number;
      try {
        prefix = prefixForHosts(hosts);
      } catch (e) {
        return [(e as Error).message];
      }
      const roots = plan.roots
        .filter((r) => rootId === 'auto' || r.id === rootId)
        .map((r) => parseCidr(r.cidr)!);
      if (roots.length === 0) return ['尚未定义任何根网段'];
      const occupied = plan.allocations.map((a) => parseCidr(a.cidr)!);
      const slot = findLowestSlot(roots, occupied, prefix);
      if (!slot) {
        return [`地址空间不足：没有可容纳 ${hosts} 台主机（/${prefix}）的空闲块`];
      }
      const alloc: Allocation = {
        id: newId('alloc'),
        name: name.trim(),
        kind: 'subnet',
        prefix,
        cidr: cidrToString(slot),
        note: note.trim() || undefined,
      };
      if (!commit({ ...plan, allocations: [...plan.allocations, alloc] })) {
        return ['保存失败：本地存储写入失败，本次申请未生效，请清理浏览器存储后重试'];
      }
      return [];
    },
    [commit],
  );

  /**
   * 批量申请：先对全部行做预演（按顺序逐行计算最小前缀并在指定/全部根网段
   * 寻找最低可用地址，前序行计入占用）。任一行非法或空间不足即拒绝、不改变规划；
   * 全部通过后以一次可撤销修订原子加入。
   */
  const requestBatchSubnets = useCallback(
    (requests: BatchSubnetRequest[]): string[] => {
      const plan = planRef.current;
      const batch = planBatchSubnets(plan, requests);
      if (!batch.ok) {
        return batch.lines
          .filter((l) => l.status !== 'ok')
          .map((l) => `第 ${l.row} 行${l.name ? `（${l.name}）` : ''}：${l.reason}`);
      }
      const added = allocationsFromBatchPlan(batch);
      if (!commit({ ...plan, allocations: [...plan.allocations, ...added] })) {
        return ['保存失败：本地存储写入失败，整批申请均未生效，请清理浏览器存储后重试'];
      }
      showToast(`批量申请已原子加入 ${added.length} 项分配（可一次撤销）`);
      return [];
    },
    [commit, showToast],
  );

  const releaseAllocation = useCallback(
    (id: string) => {
      const plan = planRef.current;
      if (commit({ ...plan, allocations: plan.allocations.filter((a) => a.id !== id) })) {
        showToast('已释放，相邻空闲伙伴块已自动合并');
      }
    },
    [commit, showToast],
  );

  const resizeAllocation = useCallback(
    (id: string, hosts: number): string[] => {
      const plan = planRef.current;
      const alloc = plan.allocations.find((a) => a.id === id);
      if (!alloc) return ['分配不存在'];
      if (!Number.isInteger(hosts) || hosts < 1) return ['主机数必须为不小于 1 的整数'];
      const prefix = prefixForHosts(hosts);
      if (prefix === alloc.prefix) return [`新容量与当前相同（/${prefix}），无需调整`];
      const nextAllocs = plan.allocations.map((a) => (a.id === id ? { ...a, prefix } : a));
      setResizeTarget(null);
      requestMigration(
        `调整「${alloc.name}」容量：/${alloc.prefix} → /${prefix}（${hosts} 台主机）`,
        plan.roots,
        nextAllocs,
      );
      return [];
    },
    [requestMigration],
  );

  // ---- 导入导出 ----
  const exportPlan = useCallback(() => {
    const blob = new Blob([serializePlan(planRef.current)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subnet-plan-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importPlan = useCallback(
    (text: string) => {
      try {
        const imported = parsePlanJson(text);
        if (commit(imported)) showToast('规划导入成功');
      } catch (e) {
        showToast((e as Error).message);
      }
    },
    [commit, showToast],
  );

  // ---- 加密备份 ----
  /** 加密导出：成功后下载信封文件；口令只经由此调用传入，绝不落盘。 */
  const submitExportBackup = useCallback(
    async (password: string): Promise<string | null> => {
      try {
        const envelope = await exportPlanBackup(planRef.current, password);
        const blob = new Blob([envelope], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `subnet-plan-backup-${new Date().toISOString().slice(0, 10)}.enc.json`;
        a.click();
        URL.revokeObjectURL(url);
        setBackupExportOpen(false);
        showToast('加密备份已导出（口令未保存，请妥善保管）');
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
    [showToast],
  );

  /** 加密导入：解密并通过 Plan 完整校验后才作为一次可撤销修订提交；任何失败都保持当前规划不变。 */
  const submitImportBackup = useCallback(
    async (password: string): Promise<string | null> => {
      if (!backupImport) return '没有待导入的备份文件';
      try {
        const imported = await importPlanBackup(backupImport.text, password);
        if (!commit(imported)) {
          // commit 已显示明确错误；同时在弹窗内提示，保持当前规划不被替换。
          return '保存失败：本地存储写入失败，导入未生效，请清理浏览器存储后重试';
        }
        setBackupImport(null);
        showToast('加密备份导入成功');
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
    [backupImport, commit, showToast],
  );

  const loadDemo = useCallback(() => commit(demoPlan()), [commit]);
  const resetPlan = useCallback(() => commit(emptyPlan()), [commit]);

  const locked = conflict !== null;

  return (
    <div className="app">
      <Toolbar
        canUndo={past.length > 0 && !locked}
        canRedo={future.length > 0 && !locked}
        locked={locked}
        onUndo={undo}
        onRedo={redo}
        onExport={exportPlan}
        onImport={importPlan}
        onExportBackup={() => setBackupExportOpen(true)}
        onImportBackup={(name, text) => setBackupImport({ name, text })}
        onLoadDemo={loadDemo}
        onReset={resetPlan}
        onPrefixPolicy={() => setPrefixPolicyOpen(true)}
        onAddressAudit={() => setAddressAuditOpen(true)}
        onRouteSummary={() => setRouteSummaryOpen(true)}
        onPlanDiff={() => setPlanDiffOpen(true)}
      />

      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast.split('\n').map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {locked && (
        <div className="lock-banner" role="status">
          ⚠ 检测到其他标签页的分叉更新，冲突解决前规划编辑已锁定（仍可导出与执行只读校验）。
        </div>
      )}

      <main className={`layout${locked ? ' locked' : ''}`} aria-busy={locked}>
        <aside className="sidebar">
          <RootsPanel
            roots={plan.roots}
            allocations={plan.allocations}
            onAdd={addRoot}
            onEdit={editRoot}
            onRemove={removeRoot}
          />
          <NewAllocationForm
            roots={plan.roots}
            onAddReservation={addReservation}
            onRequestSubnet={requestSubnet}
            onOpenBatch={() => setBatchOpen(true)}
          />
        </aside>

        <section className="content">
          <TreeView
            roots={plan.roots}
            allocations={plan.allocations}
            onRelease={releaseAllocation}
            onResize={(a) => setResizeTarget(a)}
          />
          <AllocationsPanel
            plan={plan}
            locked={locked}
            onRelease={releaseAllocation}
            onResize={(a) => setResizeTarget(a)}
            onOpenClasslessRoute={(a) => setClasslessRouteTarget(a)}
          />
        </section>
      </main>

      {resizeTarget && !locked && (
        <div className="modal-backdrop" onClick={() => setResizeTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>调整容量：{resizeTarget.name}</h3>
            <p className="muted">
              当前 {resizeTarget.cidr}。输入新的可用主机数，系统将预演迁移。
            </p>
            <ResizeForm
              onSubmit={(hosts) => resizeAllocation(resizeTarget.id, hosts)}
              onCancel={() => setResizeTarget(null)}
            />
          </div>
        </div>
      )}

      {migration && !locked && (
        <MigrationModal
          title={migration.title}
          plan={migration.plan}
          onConfirm={() => {
            if (commit(migration.next)) {
              setMigration(null);
              showToast('迁移已整批原子应用');
            }
            // 失败时错误已提示，保留提交前规划与迁移弹窗，允许重试或取消
          }}
          onCancel={() => setMigration(null)}
        />
      )}

      {batchOpen && !locked && (
        <BatchApplyModal
          plan={plan}
          onSubmit={requestBatchSubnets}
          onClose={() => setBatchOpen(false)}
        />
      )}

      {prefixPolicyOpen && (
        <PrefixPolicyModal
          allocations={plan.allocations}
          onClose={() => setPrefixPolicyOpen(false)}
        />
      )}

      {addressAuditOpen && (
        <AddressAuditModal plan={plan} onClose={() => setAddressAuditOpen(false)} />
      )}

      {routeSummaryOpen && (
        <RouteSummaryModal plan={plan} onClose={() => setRouteSummaryOpen(false)} />
      )}

      {planDiffOpen && (
        <PlanDiffModal plan={plan} onClose={() => setPlanDiffOpen(false)} />
      )}

      {backupExportOpen && (
        <CryptoBackupModal
          mode="export"
          onSubmit={submitExportBackup}
          onClose={() => setBackupExportOpen(false)}
        />
      )}

      {backupImport && (
        <CryptoBackupModal
          mode="import"
          fileName={backupImport.name}
          onSubmit={submitImportBackup}
          onClose={() => setBackupImport(null)}
        />
      )}

      {classlessRouteTarget && (
        <ClasslessRouteModal
          alloc={classlessRouteTarget}
          onClose={() => setClasslessRouteTarget(null)}
        />
      )}

      {conflict && (
        <ConflictModal
          local={conflict.local.plan}
          remote={conflict.remote.plan}
          onChooseLocal={() => resolveConflict('local')}
          onChooseRemote={() => resolveConflict('remote')}
        />
      )}

      {!ready && <div className="boot-veil">正在恢复本地规划…</div>}
    </div>
  );
}

function ResizeForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (hosts: number) => string[];
  onCancel: () => void;
}) {
  const [hosts, setHosts] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const errs = onSubmit(Number(hosts));
        setErrors(errs);
      }}
    >
      <label className="field">
        <span>新主机数</span>
        <input
          autoFocus
          type="number"
          min={1}
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
          placeholder="例如 500"
        />
      </label>
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((er, i) => (
            <li key={i}>{er}</li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn primary">
          预演迁移
        </button>
      </div>
    </form>
  );
}
