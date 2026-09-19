import { useMemo, useState } from 'react';
import { Allocation } from '../lib/model';
import { longToIpv4, parseCidr } from '../lib/ip';
import { usableRangeOf } from '../lib/dhcp';
import { HostLineStatus, formatHostsText, planStaticHosts } from '../lib/staticHosts';

interface Props {
  alloc: Allocation;
  onClose: () => void;
}

const STATUS_LABEL: Record<HostLineStatus, string> = {
  ok: '✓ 已安置',
  invalid: '非法',
  nospace: '空间不足',
};

const STATUS_BADGE: Record<HostLineStatus, string> = {
  ok: 'mig-kept',
  invalid: 'mig-moved',
  nospace: 'mig-failed',
};

/**
 * 静态主机地址编排弹窗：逐行填写「主机名 IPv4地址|auto」，
 * 先整体预留合法指定地址，再按输入顺序把 auto 安置到最低可用主机地址。
 * 纯本地计算，不修改规划与历史；任一行非法或空间不足时禁止导出。
 */
export default function StaticHostsModal({ alloc, onClose }: Props) {
  const subnet = useMemo(() => parseCidr(alloc.cidr)!, [alloc.cidr]);
  const usable = usableRangeOf(subnet);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);

  const plan = useMemo(() => planStaticHosts(subnet, text), [subnet, text]);
  const hostsText = plan.ok ? formatHostsText(plan) : '';
  const okCount = plan.lines.filter((l) => l.status === 'ok').length;

  const copyResult = async () => {
    try {
      await navigator.clipboard.writeText(hostsText);
    } catch {
      // 剪贴板 API 不可用（如非安全上下文）时回退
      const ta = document.createElement('textarea');
      ta.value = hostsText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  const downloadHosts = () => {
    const blob = new Blob([`${hostsText}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `static-hosts-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>静态主机地址编排：{alloc.name}</h3>
        <p className="muted">
          子网 <code>{alloc.cidr}</code>，可用主机范围{' '}
          <code>
            {longToIpv4(usable.start)} - {longToIpv4(usable.end)}
          </code>
          {subnet.prefix <= 30
            ? '（已自动排除网络地址与广播地址）'
            : '（/' + subnet.prefix + ' 按可用主机规则不排除任何地址）'}
          。每行填写一台主机：<code>主机名 IPv4地址</code> 或 <code>主机名 auto</code>。
          系统先整体预留所有合法指定地址，再按输入顺序把 auto 安置到最低可用主机地址，
          前序 auto 不会抢占后续行指定的地址。纯本地计算，不修改规划与历史。
        </p>
        <label className="field">
          <span>主机清单（每行一台，空行忽略）</span>
          <textarea
            autoFocus
            rows={6}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCopied(false);
            }}
            placeholder={'例如：\ngateway 10.0.0.1\nweb-01 auto\ndb-01 auto'}
            spellCheck={false}
          />
        </label>

        {plan.lines.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>主机名</th>
                  <th>指定地址</th>
                  <th>编排结果</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {plan.lines.map((l) => (
                  <tr
                    key={l.row}
                    className={
                      l.status === 'ok'
                        ? undefined
                        : l.status === 'nospace'
                          ? 'mig-failed'
                          : 'mig-moved'
                    }
                  >
                    <td className="muted">{l.row}</td>
                    <td>{l.hostname ? <strong>{l.hostname}</strong> : <span className="muted">—</span>}</td>
                    <td>
                      {l.mode === 'auto' ? (
                        <span className="muted">auto</span>
                      ) : (
                        <code>{l.input}</code>
                      )}
                    </td>
                    <td>
                      {l.addr !== null ? (
                        <code>{longToIpv4(l.addr)}</code>
                      ) : (
                        <span className="muted">{l.reason}</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[l.status]}`} title={l.reason ?? undefined}>
                        {STATUS_LABEL[l.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {plan.lines.some((l) => l.status !== 'ok') && (
          <ul className="errors batch-errors">
            {plan.lines
              .filter((l) => l.status !== 'ok')
              .map((l) => (
                <li key={l.row}>
                  第 {l.row} 行{l.hostname ? `（${l.hostname}）` : ''}：{l.reason}
                </li>
              ))}
          </ul>
        )}

        {plan.ok && (
          <div className="dhcp-result">
            <div className="dhcp-result-head">
              <span>hosts 文本共 {okCount} 行 · 按地址升序</span>
            </div>
            <textarea readOnly rows={Math.min(Math.max(okCount, 2), 10)} value={hostsText} />
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="btn"
            disabled={!plan.ok}
            title={plan.ok ? '复制 hosts 文本到剪贴板' : '存在非法或空间不足的行，禁止导出'}
            onClick={copyResult}
          >
            {copied ? '已复制 ✓' : '复制 hosts 文本'}
          </button>
          <button
            className="btn primary"
            disabled={!plan.ok}
            title={plan.ok ? '下载按地址排序的 hosts 文件' : '存在非法或空间不足的行，禁止导出'}
            onClick={downloadHosts}
          >
            下载 hosts 文件
          </button>
        </div>
      </div>
    </div>
  );
}
