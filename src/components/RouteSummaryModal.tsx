import { ReactNode, useMemo, useState } from 'react';
import { Plan } from '../lib/model';
import { cidrToString, contains, parseCidr } from '../lib/ip';
import {
  SummaryResult,
  formatSummaryReport,
  planRouteSummary,
  selectableSubnets,
  validateMaxEntries,
} from '../lib/routeSummary';

interface Props {
  plan: Plan;
  onClose: () => void;
}

type PickRow =
  | { kind: 'subnet'; id: string; name: string; cidr: string; note?: string }
  | { kind: 'reserved'; name: string; cidr: string; note?: string };

interface PickGroup {
  rootId: string;
  rootName: string;
  rootCidr: string;
  subnetIds: string[];
  rows: PickRow[];
}

/**
 * 路由汇总弹窗：勾选子网、填写最多路由条数后生成全局最优汇总方案。
 * 方案必须覆盖全部已选子网、不跨根网段、不覆盖任何未选分配；
 * 上限内优先最少额外覆盖空闲地址，代价相同优先更少条目，再按网络地址排序；
 * 无法满足时给出最少所需条数。
 * 纯本地只读计算：不修改规划、不产生修订历史，冲突锁定期间亦可使用。
 */
export default function RouteSummaryModal({ plan, onClose }: Props) {
  const subnets = useMemo(() => selectableSubnets(plan), [plan]);
  const validIds = useMemo(() => new Set(subnets.map((s) => s.target.alloc.id)), [subnets]);

  // 按根网段分组：子网可勾选；命名保留段以禁用行展示（它们是放大时不可覆盖的障碍）。
  const groups = useMemo<PickGroup[]>(() => {
    const map = new Map<string, PickGroup>();
    for (const r of plan.roots) {
      map.set(r.id, {
        rootId: r.id,
        rootName: r.name,
        rootCidr: r.cidr,
        subnetIds: [],
        rows: [],
      });
    }
    const pushRow = (rootId: string, row: PickRow) => map.get(rootId)?.rows.push(row);
    for (const a of plan.allocations) {
      const cidr = parseCidr(a.cidr);
      if (!cidr) continue;
      const root = plan.roots.find((r) => {
        const rc = parseCidr(r.cidr);
        return rc !== null && contains(rc, cidr);
      });
      if (!root) continue;
      if (a.kind === 'subnet') {
        map.get(root.id)?.subnetIds.push(a.id);
        pushRow(root.id, { kind: 'subnet', id: a.id, name: a.name, cidr: a.cidr, note: a.note });
      } else {
        pushRow(root.id, { kind: 'reserved', name: a.name, cidr: a.cidr, note: a.note });
      }
    }
    const out = [...map.values()].filter((g) => g.rows.length > 0);
    for (const g of out) {
      g.rows.sort((x, y) => {
        const cx = parseCidr(x.cidr)!;
        const cy = parseCidr(y.cidr)!;
        return cx.base - cy.base || cx.prefix - cy.prefix;
      });
    }
    return out;
  }, [plan]);

  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [maxText, setMaxText] = useState('8');
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [copied, setCopied] = useState(false);

  // 规划变更后清理可能失效的勾选
  const checkedSet = useMemo(
    () => new Set([...checked].filter((id) => validIds.has(id))),
    [checked, validIds],
  );

  const toggle = (id: string) => {
    const next = new Set(checkedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
    setResult(null);
  };

  const toggleGroup = (g: PickGroup, on: boolean) => {
    const next = new Set(checkedSet);
    for (const id of g.subnetIds) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setChecked(next);
    setResult(null);
  };

  const toggleAll = (on: boolean) => {
    setChecked(new Set(on ? subnets.map((s) => s.target.alloc.id) : []));
    setResult(null);
  };

  const allOn = subnets.length > 0 && checkedSet.size === subnets.length;

  const run = () => {
    const errs: string[] = [];
    const maxEntries = validateMaxEntries(maxText);
    if (typeof maxEntries === 'string') errs.push(maxEntries);
    if (checkedSet.size === 0) errs.push('请至少勾选一个子网');
    setCopied(false);
    if (errs.length > 0) {
      setErrors(errs);
      setResult(null);
      return;
    }
    setErrors([]);
    setResult(planRouteSummary(plan, [...checkedSet], maxEntries as number));
  };

  const report = result ? formatSummaryReport(result) : '';

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      // 剪贴板 API 不可用（如非安全上下文）时回退
      const ta = document.createElement('textarea');
      ta.value = report;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  return (
    <div className="modal-backdrop readonly-backdrop" onClick={onClose}>
      <div className="modal wide summary-modal" onClick={(e) => e.stopPropagation()}>
        <h3>路由汇总</h3>
        <p className="muted">
          勾选需要汇总的<strong>子网分配</strong>（命名保留段不可选），填写最多路由条数后生成方案。
          以 CIDR 树全局优化：必须覆盖全部已选子网、<strong>不得跨根网段</strong>、
          <strong>不得覆盖任何未选分配</strong>；上限内优先<strong>最少额外覆盖空闲地址</strong>，
          代价相同时优先<strong>更少条目</strong>，再按网络地址排序；无法满足时给出最少所需条数。
          纯本地只读计算，不修改规划与历史，冲突锁定期间仍可使用。
        </p>

        {subnets.length === 0 ? (
          <p className="muted">当前规划中没有可勾选的子网分配。</p>
        ) : (
          <>
            <div className="dhcp-result-head">
              <label className="summary-select-all">
                <input
                  type="checkbox"
                  checked={allOn}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
                全选（已选 {checkedSet.size} / {subnets.length}）
              </label>
              <label className="summary-cap">
                最多路由条数
                <input
                  type="number"
                  min={1}
                  max={256}
                  value={maxText}
                  onChange={(e) => {
                    setMaxText(e.target.value);
                    setResult(null);
                  }}
                  style={{ width: 80, marginLeft: 8 }}
                />
              </label>
            </div>
            <div className="table-wrap summary-pick-wrap">
              <table>
                <tbody>
                  {groups.map((g) => {
                    const onCount = g.subnetIds.filter((id) => checkedSet.has(id)).length;
                    const groupOn = g.subnetIds.length > 0 && onCount === g.subnetIds.length;
                    return (
                      <RootPickGroup
                        key={g.rootId}
                        rootName={g.rootName}
                        rootCidr={g.rootCidr}
                        onCount={onCount}
                        total={g.subnetIds.length}
                        groupOn={groupOn}
                        onToggleGroup={(on) => toggleGroup(g, on)}
                      >
                        {g.rows.map((row) =>
                          row.kind === 'subnet' ? (
                            <SubnetPickRow
                              key={row.id}
                              name={row.name}
                              cidr={row.cidr}
                              note={row.note}
                              checked={checkedSet.has(row.id)}
                              onToggle={() => toggle(row.id)}
                            />
                          ) : (
                            <ReservedPickRow
                              key={`rv-${row.cidr}-${row.name}`}
                              name={row.name}
                              cidr={row.cidr}
                              note={row.note}
                            />
                          ),
                        )}
                      </RootPickGroup>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {errors.length > 0 && (
          <ul className="errors">
            {errors.map((er, i) => (
              <li key={i}>{er}</li>
            ))}
          </ul>
        )}

        {result && (
          <div className="dhcp-result">
            <div className="dhcp-result-head">
              {result.feasible ? (
                <span>
                  方案 {result.totalEntries} 条（上限 {result.maxEntries}）· 覆盖子网{' '}
                  {result.selectedCount} 个 · 额外覆盖空闲地址 {result.totalExtraFree} 个
                </span>
              ) : (
                <span className="summary-infeasible">
                  无法在 {result.maxEntries} 条内完成：最少需要 {result.minimumEntries} 条
                </span>
              )}
              <button className="btn small" onClick={copyReport} disabled={!result}>
                {copied ? '已复制 ✓' : '复制文本报告'}
              </button>
            </div>

            {!result.feasible ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>根网段</th>
                      <th>已选子网数</th>
                      <th>最少所需条数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.groups.map((g) => (
                      <tr key={g.root.id} className="mig-moved">
                        <td>
                          <strong>{g.root.name}</strong> <code>{g.root.cidr}</code>
                        </td>
                        <td>{g.selected.length}</td>
                        <td>
                          <strong>{g.minimumEntries}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>根网段</th>
                      <th>汇总 CIDR</th>
                      <th>覆盖的已选子网</th>
                      <th className="summary-num">子网数</th>
                      <th className="summary-num">额外覆盖空闲地址</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.groups.flatMap((g) =>
                      g.entries.map((e, i) => {
                        const seq = result.entries.indexOf(e) + 1;
                        return (
                          <tr key={`${e.cidr.base}-${e.cidr.prefix}`}>
                            <td className="muted">{seq}</td>
                            <td>
                              {i === 0 ? (
                                <>
                                  <strong>{g.root.name}</strong>
                                  <div className="muted">
                                    <code>{g.root.cidr}</code>
                                  </div>
                                </>
                              ) : (
                                <span className="muted">〃</span>
                              )}
                            </td>
                            <td>
                              <code className="summary-cidr">{cidrToString(e.cidr)}</code>
                            </td>
                            <td className="summary-covered">
                              {e.covered.map((t) => (
                                <div key={t.alloc.id} className="summary-covered-item">
                                  {t.alloc.name} <code>{cidrToString(t.cidr)}</code>
                                </div>
                              ))}
                            </td>
                            <td className="summary-num">{e.covered.length}</td>
                            <td className="summary-num">
                              <strong>{e.extraFreeAddresses}</strong>
                            </td>
                          </tr>
                        );
                      }),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={run} disabled={subnets.length === 0}>
            生成汇总方案
          </button>
        </div>
      </div>
    </div>
  );
}

function RootPickGroup({
  rootName,
  rootCidr,
  onCount,
  total,
  groupOn,
  onToggleGroup,
  children,
}: {
  rootName: string;
  rootCidr: string;
  onCount: number;
  total: number;
  groupOn: boolean;
  onToggleGroup: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <>
      <tr className="summary-root-row">
        <td colSpan={3}>
          <label>
            <input
              type="checkbox"
              checked={groupOn}
              ref={(el) => {
                if (el) el.indeterminate = !groupOn && onCount > 0;
              }}
              onChange={(e) => onToggleGroup(e.target.checked)}
              disabled={total === 0}
            />
            <strong>{rootName}</strong> <code>{rootCidr}</code>
            <span className="muted">
              {' '}
              （{onCount}/{total}）
            </span>
          </label>
        </td>
      </tr>
      {children}
    </>
  );
}

function SubnetPickRow({
  name,
  cidr,
  note,
  checked,
  onToggle,
}: {
  name: string;
  cidr: string;
  note?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className={checked ? 'summary-picked' : undefined}>
      <td className="summary-check-col">
        <input type="checkbox" checked={checked} onChange={onToggle} />
      </td>
      <td>
        <span className="badge subnet">子网</span> <strong>{name}</strong>
        {note ? <span className="muted"> — {note}</span> : null}
      </td>
      <td>
        <code>{cidr}</code>
      </td>
    </tr>
  );
}

function ReservedPickRow({
  name,
  cidr,
  note,
}: {
  name: string;
  cidr: string;
  note?: string;
}) {
  return (
    <tr className="summary-reserved-row">
      <td className="summary-check-col">
        <input type="checkbox" disabled checked={false} />
      </td>
      <td>
        <span className="badge reserved">保留段</span> {name}
        {note ? <span className="muted"> — {note}</span> : null}
        <span className="muted">（不可选，汇总 CIDR 不得覆盖）</span>
      </td>
      <td>
        <code>{cidr}</code>
      </td>
    </tr>
  );
}
