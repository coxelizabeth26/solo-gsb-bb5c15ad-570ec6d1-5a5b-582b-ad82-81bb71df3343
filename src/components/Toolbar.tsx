import { useRef } from 'react';

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  /** 多标签页分叉冲突解决期间锁定一切会修改规划的操作 */
  locked?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onImport: (text: string) => void;
  onExportBackup: () => void;
  onImportBackup: (fileName: string, text: string) => void;
  onLoadDemo: () => void;
  onReset: () => void;
  onPrefixPolicy: () => void;
  onAddressAudit: () => void;
  onRouteSummary: () => void;
  onPlanDiff: () => void;
}

export default function Toolbar(props: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const backupFileRef = useRef<HTMLInputElement>(null);
  const locked = props.locked ?? false;

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    props.onImport(text);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleBackupFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    props.onImportBackup(file.name, text);
    if (backupFileRef.current) backupFileRef.current.value = '';
  };

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-icon">⌗</span>
        <h1>IPv4 子网规划台</h1>
      </div>
      <div className="toolbar-actions">
        <button className="btn" onClick={props.onUndo} disabled={!props.canUndo} title="Ctrl/Cmd+Z">
          ↩ 撤销
        </button>
        <button className="btn" onClick={props.onRedo} disabled={!props.canRedo} title="Ctrl/Cmd+Shift+Z">
          ↪ 重做
        </button>
        <span className="divider" />
        <button className="btn" onClick={props.onPrefixPolicy} title="对当前所有子网分配有序执行 prefix-list（不修改规划）">
          前缀策略校验
        </button>
        <button
          className="btn"
          onClick={props.onAddressAudit}
          title="粘贴多行「ISO 时间, IPv4, MAC, 有效秒数」观测，审计同 IP 不同 MAC 的有效区间重叠（只读，不修改规划）"
        >
          地址观测冲突审计
        </button>
        <button
          className="btn"
          onClick={props.onRouteSummary}
          title="勾选子网并限定最多路由条数，以 CIDR 树生成不跨根网段、不覆盖未选分配的最优汇总方案（只读，不修改规划）"
        >
          路由汇总
        </button>
        <button
          className="btn"
          onClick={props.onPlanDiff}
          title="导入「导出 JSON」生成的基线文件，按分配 id 对比当前规划并计算地址差集（只读，不修改规划）"
        >
          规划差异报告
        </button>
        <span className="divider" />
        <button className="btn" onClick={props.onExport}>
          导出 JSON
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={locked} title={locked ? '冲突解决前不可导入' : undefined}>
          导入 JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
        <button className="btn" onClick={props.onExportBackup} title="用口令加密导出当前规划（PBKDF2-SHA-256 + AES-GCM-256）">
          加密导出
        </button>
        <button className="btn" onClick={() => backupFileRef.current?.click()} disabled={locked} title={locked ? '冲突解决前不可导入' : '选择加密备份文件并输入口令解密导入'}>
          加密导入
        </button>
        <input
          ref={backupFileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => void handleBackupFile(e.target.files?.[0])}
        />
        <span className="divider" />
        <button className="btn" onClick={props.onLoadDemo} disabled={locked}>
          载入示例
        </button>
        <button
          className="btn danger"
          disabled={locked}
          title={locked ? '冲突解决前不可清空' : undefined}
          onClick={() => {
            if (window.confirm('确定清空当前规划？（可撤销）')) props.onReset();
          }}
        >
          清空
        </button>
      </div>
    </header>
  );
}
