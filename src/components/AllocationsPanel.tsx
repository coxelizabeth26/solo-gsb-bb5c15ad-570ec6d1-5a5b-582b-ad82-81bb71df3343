import { useState } from 'react';
import { Allocation, Plan } from '../lib/model';
import { broadcastOf, contains, longToIpv4, parseCidr, usableHosts } from '../lib/ip';
import DhcpPoolModal from './DhcpPoolModal';
import ReverseDnsModal from './ReverseDnsModal';
import StaticHostsModal from './StaticHostsModal';

interface Props {
  plan: Plan;
  /** 冲突锁定：仅只读工具（含无类路由）可用，调整容量/释放禁用 */
  locked?: boolean;
  onRelease: (id: string) => void;
  onResize: (alloc: Allocation) => void;
  /** 类无静态路由入口提升到 App 层渲染：冲突锁定期间仍可使用（纯本地只读） */
  onOpenClasslessRoute: (alloc: Allocation) => void;
}

export default function AllocationsPanel({
  plan,
  locked = false,
  onRelease,
  onResize,
  onOpenClasslessRoute,
}: Props) {
  const [dhcpTarget, setDhcpTarget] = useState<Allocation | null>(null);
  const [rdnsTarget, setRdnsTarget] = useState<Allocation | null>(null);
  const [hostsTarget, setHostsTarget] = useState<Allocation | null>(null);
  const rootOf = (alloc: Allocation) => {
    const ac = parseCidr(alloc.cidr);
    if (!ac) return '—';
    const root = plan.roots.find((r) => {
      const rc = parseCidr(r.cidr);
      return rc && contains(rc, ac);
    });
    return root ? root.name : '—';
  };

  const sorted = [...plan.allocations].sort((a, b) => {
    const ca = parseCidr(a.cidr);
    const cb = parseCidr(b.cidr);
    return (ca?.base ?? 0) - (cb?.base ?? 0);
  });

  return (
    <section className={`panel${locked ? ' panel-unlocked-readonly' : ''}`}>
      <h2>分配清单（{plan.allocations.length}）</h2>
      {sorted.length === 0 ? (
        <p className="muted">暂无分配。可在左侧按主机数申请子网，或创建命名保留段。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>CIDR</th>
                <th>网络地址</th>
                <th>广播地址</th>
                <th>可用主机</th>
                <th>所属根网段</th>
                <th>备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => {
                const c = parseCidr(a.cidr)!;
                return (
                  <tr key={a.id}>
                    <td><strong>{a.name}</strong></td>
                    <td>
                      <span className={`badge ${a.kind}`}>
                        {a.kind === 'reserved' ? '保留段' : '子网'}
                      </span>
                    </td>
                    <td><code>{a.cidr}</code></td>
                    <td><code>{longToIpv4(c.base)}</code></td>
                    <td><code>{longToIpv4(broadcastOf(c))}</code></td>
                    <td>{usableHosts(c.prefix).toLocaleString()}</td>
                    <td>{rootOf(a)}</td>
                    <td className="muted">{a.note ?? '—'}</td>
                    <td>
                      <span className="row-actions inline">
                        {a.kind === 'subnet' && (
                          <>
                            <button
                              className="btn small"
                              disabled={locked}
                              title={locked ? '冲突锁定期间不可用' : undefined}
                              onClick={() => setDhcpTarget(a)}
                            >
                              DHCP 池
                            </button>
                            <button
                              className="btn small"
                              title="纯本地只读，冲突锁定期间亦可使用"
                              onClick={() => onOpenClasslessRoute(a)}
                            >
                              无类路由
                            </button>
                            <button
                              className="btn small"
                              disabled={locked}
                              title={locked ? '冲突锁定期间不可用' : undefined}
                              onClick={() => setRdnsTarget(a)}
                            >
                              反向 DNS
                            </button>
                            <button
                              className="btn small"
                              disabled={locked}
                              title={locked ? '冲突锁定期间不可用' : undefined}
                              onClick={() => setHostsTarget(a)}
                            >
                              静态主机
                            </button>
                          </>
                        )}
                        <button
                          className="btn small"
                          disabled={locked}
                          title={locked ? '冲突锁定期间编辑已锁定' : undefined}
                          onClick={() => onResize(a)}
                        >
                          调整容量
                        </button>
                        <button
                          className="btn small danger"
                          disabled={locked}
                          title={locked ? '冲突锁定期间编辑已锁定' : undefined}
                          onClick={() => {
                            if (window.confirm(`释放「${a.name}」(${a.cidr})？`)) onRelease(a.id);
                          }}
                        >
                          释放
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {dhcpTarget && (
        <DhcpPoolModal alloc={dhcpTarget} onClose={() => setDhcpTarget(null)} />
      )}
      {rdnsTarget && (
        <ReverseDnsModal alloc={rdnsTarget} onClose={() => setRdnsTarget(null)} />
      )}
      {hostsTarget && (
        <StaticHostsModal alloc={hostsTarget} onClose={() => setHostsTarget(null)} />
      )}
    </section>
  );
}
