import { useMemo, useState } from 'react';
import { Plan } from '../lib/model';
import {
  BatchSubnetRequest,
  planBatchSubnets,
} from '../lib/planner';

interface Props {
  plan: Plan;
  /** 确认提交：整批原子加入；返回错误信息（非空表示提交被拒绝且规划未改变） */
  onSubmit: (requests: BatchSubnetRequest[]) => string[];
  onClose: () => void;
}

interface Row {
  name: string;
  hosts: string;
  rootId: string;
  note: string;
}

const emptyRow = (): Row => ({ name: '', hosts: '', rootId: 'auto', note: '' });

const STATUS_LABEL = {
  ok: '可安置',
  invalid: '非法',
  nospace: '空间不足',
} as const;

/**
 * 批量申请弹窗：逐行填写名称、主机数、可选根网段与备注，
 * 按输入顺序实时预演每行最小前缀与最低可用地址；任一行非法或空间不足时禁止提交。
 */
export default function BatchApplyModal({ plan, onSubmit, onClose }: Props) {
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow(), emptyRow()]);
  const [errors, setErrors] = useState<string[]>([]);

  const patch = (i: number, key: keyof Row, value: string) => {
    setErrors([]);
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  };
  const addRow = () => setRows((cur) => [...cur, emptyRow()]);
  const removeRow = (i: number) =>
    setRows((cur) => (cur.length <= 1 ? cur : cur.filter((_, idx) => idx !== i)));

  // 完全空白的行视为“未填写”忽略；填写了任意字段但不完整的行参与预演并报错。
  const requests: BatchSubnetRequest[] = rows
    .map((r, i) => ({
      row: i + 1,
      name: r.name.trim(),
      hosts: Number(r.hosts),
      rootId: r.rootId,
      note: r.note,
      filled: r.name.trim() !== '' || r.hosts.trim() !== '' || r.note.trim() !== '',
    }))
    .filter((r) => r.filled)
    .map(({ row, name, hosts, rootId, note }) => ({ row, name, hosts, rootId, note }));

  const preview = useMemo(
    () => planBatchSubnets(plan, requests),
    // 请求内容随行编辑变化；plan 可能因多标签页同步变化
    [plan, rows],
  );
  // 行号（1 起，含空白行）→ 预演结果
  const byRow = new Map(preview.lines.map((l) => [l.row, l]));
  const okCount = preview.lines.filter((l) => l.status === 'ok').length;

  const submit = () => {
    if (requests.length === 0) {
      setErrors(['请至少填写一行分配（名称与主机数）']);
      return;
    }
    const errs = onSubmit(requests);
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide batch-modal" onClick={(e) => e.stopPropagation()}>
        <h3>批量申请子网</h3>
        <p className="muted">
          逐行填写分配名称、所需主机数、根网段（可自动选择）与备注。系统按行序为每行计算最小前缀，
          并在指定/全部根网段中寻找最低可用地址；前序行会占用空间，后序行自动避开。
          任一行非法或空间不足时无法提交，规划不会改变；全部通过后整批作为一次可撤销修订加入。
        </p>
        <div className="table-wrap batch-table-wrap">
          <table>
            <thead>
              <tr>
                <th className="col-row">#</th>
                <th className="col-name">名称</th>
                <th className="col-hosts">主机数</th>
                <th className="col-root">根网段</th>
                <th className="col-cidr">预分配 CIDR</th>
                <th className="col-cap">可用主机</th>
                <th className="col-note">备注</th>
                <th className="col-status">结果</th>
                <th className="col-del" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const line = byRow.get(i + 1);
                return (
                  <tr key={i} className={line && line.status !== 'ok' ? `mig-${line.status === 'nospace' ? 'failed' : 'moved'}` : undefined}>
                    <td className="col-row muted">{i + 1}</td>
                    <td className="col-name">
                      <input
                        value={r.name}
                        onChange={(e) => patch(i, 'name', e.target.value)}
                        placeholder="如 数据中心-C"
                        aria-label={`第 ${i + 1} 行名称`}
                      />
                    </td>
                    <td className="col-hosts">
                      <input
                        value={r.hosts}
                        onChange={(e) => patch(i, 'hosts', e.target.value)}
                        type="number"
                        min={1}
                        placeholder="如 500"
                        aria-label={`第 ${i + 1} 行主机数`}
                      />
                    </td>
                    <td className="col-root">
                      <select
                        value={r.rootId}
                        onChange={(e) => patch(i, 'rootId', e.target.value)}
                        aria-label={`第 ${i + 1} 行根网段`}
                      >
                        <option value="auto">自动</option>
                        {plan.roots.map((root) => (
                          <option key={root.id} value={root.id}>
                            {root.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="col-cidr">
                      {line?.cidr ? <code>{line.cidr}</code> : <span className="muted">—</span>}
                    </td>
                    <td className="col-cap">
                      {line?.capacity != null ? line.capacity.toLocaleString() : <span className="muted">—</span>}
                    </td>
                    <td className="col-note">
                      <input
                        value={r.note}
                        onChange={(e) => patch(i, 'note', e.target.value)}
                        placeholder="可选"
                        aria-label={`第 ${i + 1} 行备注`}
                      />
                    </td>
                    <td className="col-status">
                      {line ? (
                        line.status === 'ok' ? (
                          <span className="badge mig-kept" title={line.rootName ? `落位根网段：${line.rootName}` : undefined}>
                            ✓ {STATUS_LABEL.ok}
                          </span>
                        ) : (
                          <span className={`badge mig-${line.status === 'nospace' ? 'failed' : 'moved'}`} title={line.reason}>
                            {STATUS_LABEL[line.status]}
                          </span>
                        )
                      ) : (
                        <span className="muted">空行忽略</span>
                      )}
                    </td>
                    <td className="col-del">
                      <button
                        type="button"
                        className="btn small danger"
                        onClick={() => removeRow(i)}
                        disabled={rows.length <= 1}
                        aria-label={`删除第 ${i + 1} 行`}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {preview.lines.some((l) => l.status !== 'ok') && (
          <ul className="errors batch-errors">
            {preview.lines
              .filter((l) => l.status !== 'ok')
              .map((l) => (
                <li key={l.row}>
                  第 {l.row} 行{l.name ? `（${l.name}）` : ''}：{l.reason}
                </li>
              ))}
          </ul>
        )}

        <div className="batch-foot">
          <button type="button" className="btn" onClick={addRow}>
            ＋ 增加一行
          </button>
          <span className="muted batch-summary">
            {requests.length === 0
              ? '尚未填写有效行'
              : `已填写 ${requests.length} 行 · 可安置 ${okCount} 行 · ${requests.length - okCount} 行待修正`}
          </span>
        </div>

        {errors.length > 0 && (
          <ul className="errors">
            {errors.map((er, i) => (
              <li key={i}>{er}</li>
            ))}
          </ul>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!preview.ok || requests.length === 0}
            title={!preview.ok ? '存在非法或空间不足的行，禁止提交' : '整批原子加入（一次可撤销修订）'}
            onClick={submit}
          >
            提交批量申请（{okCount} 项）
          </button>
        </div>
      </div>
    </div>
  );
}
