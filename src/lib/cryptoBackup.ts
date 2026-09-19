/**
 * 加密备份：口令加密的规划导出/导入信封。
 *
 * - 导出：随机 16 字节 salt 与 12 字节 iv，PBKDF2-SHA-256 迭代 200000 次
 *   派生 AES-GCM-256 密钥，加密规划 JSON 后输出版本化 JSON 信封，
 *   salt / iv / ciphertext 均为 Base64；
 * - 导入：仅接受该信封。字段或 Base64 非法、版本不支持、口令错误、
 *   密文被篡改（GCM 认证失败）一律拒绝；解密出的明文仍须通过
 *   现有 Plan 完整校验（parsePlanJson）才返回；
 * - 口令与派生密钥只存在于单次调用的栈帧内，绝不写入任何持久化存储。
 */
import { Plan, parsePlanJson, serializePlan } from './model';

export const BACKUP_FORMAT = 'ipv4-subnet-planner/encrypted-backup';
export const BACKUP_VERSION = 1 as const;
export const PBKDF2_ITERATIONS = 200_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

/** 防御性上限：拒绝会让标签页长时间卡死的恶意迭代数。 */
const MAX_PBKDF2_ITERATIONS = 5_000_000;
/** AES-GCM 认证标签长度（密文至少包含一个完整标签）。 */
const GCM_TAG_BYTES = 16;

/** 版本化 JSON 信封的线格式。 */
export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  kdf: {
    name: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    /** Base64，解码后 16 字节 */
    salt: string;
  };
  cipher: {
    name: 'AES-GCM';
    /** Base64，解码后 12 字节 */
    iv: string;
  };
  /** Base64，AES-GCM 密文（末尾含 16 字节认证标签） */
  ciphertext: string;
}

interface ParsedEnvelope {
  iterations: number;
  salt: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('当前环境不支持 Web Crypto API（需要 localhost 或 HTTPS 等安全上下文）');
  }
  return subtle;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 严格 Base64 解码：字符集、长度、填充任一不合法即返回 null。 */
function base64ToBytes(b64: string): Uint8Array | null {
  if (b64.length === 0 || b64.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 解析并校验信封：任何字段缺失、类型或 Base64 非法、版本不支持都抛出中文错误。 */
function parseEnvelope(text: string): ParsedEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('加密备份解析失败：文件不是合法 JSON');
  }
  if (!isRecord(raw)) throw new Error('加密备份格式错误：顶层应为对象');
  if (raw.format !== BACKUP_FORMAT) {
    throw new Error('不是本应用的加密备份文件（format 字段不匹配）');
  }
  if (raw.version !== BACKUP_VERSION) {
    throw new Error(`不支持的加密备份版本：${String(raw.version)}`);
  }

  const kdf = raw.kdf;
  if (!isRecord(kdf)) throw new Error('加密备份格式错误：缺少 kdf 对象');
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
    throw new Error('加密备份格式错误：不支持的密钥派生参数');
  }
  if (
    typeof kdf.iterations !== 'number' ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < 1 ||
    kdf.iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error('加密备份格式错误：kdf.iterations 非法');
  }
  if (typeof kdf.salt !== 'string') throw new Error('加密备份格式错误：缺少 kdf.salt');
  const salt = base64ToBytes(kdf.salt);
  if (!salt || salt.length !== SALT_BYTES) {
    throw new Error('加密备份格式错误：kdf.salt 不是合法的 Base64（应为 16 字节）');
  }

  const cipher = raw.cipher;
  if (!isRecord(cipher)) throw new Error('加密备份格式错误：缺少 cipher 对象');
  if (cipher.name !== 'AES-GCM') {
    throw new Error('加密备份格式错误：不支持的加密算法');
  }
  if (typeof cipher.iv !== 'string') throw new Error('加密备份格式错误：缺少 cipher.iv');
  const iv = base64ToBytes(cipher.iv);
  if (!iv || iv.length !== IV_BYTES) {
    throw new Error('加密备份格式错误：cipher.iv 不是合法的 Base64（应为 12 字节）');
  }

  if (typeof raw.ciphertext !== 'string') {
    throw new Error('加密备份格式错误：缺少 ciphertext');
  }
  const ciphertext = base64ToBytes(raw.ciphertext);
  if (!ciphertext || ciphertext.length < GCM_TAG_BYTES) {
    throw new Error('加密备份格式错误：ciphertext 不是合法的 Base64 或长度过短');
  }

  return { iterations: kdf.iterations, salt, iv, ciphertext };
}

/** PBKDF2-SHA-256 派生 AES-GCM-256 密钥；密钥不可导出，随调用结束即被丢弃。 */
async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 用口令加密任意明文，返回版本化 JSON 信封（每次调用生成全新随机 salt 与 iv）。 */
export async function encryptBackup(plaintext: string, password: string): Promise<string> {
  const subtle = getSubtle();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const envelope: BackupEnvelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
    },
    cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) },
    ciphertext: bytesToBase64(ciphertext),
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * 解密信封并返回明文。口令错误或密文被篡改时 GCM 认证失败，
 * 两者在密码学上不可区分，统一报错拒绝。
 */
export async function decryptBackup(text: string, password: string): Promise<string> {
  const envelope = parseEnvelope(text);
  const key = await deriveKey(password, envelope.salt, envelope.iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await getSubtle().decrypt(
      { name: 'AES-GCM', iv: envelope.iv },
      key,
      envelope.ciphertext,
    );
  } catch {
    throw new Error('解密失败：口令错误或备份数据已被篡改');
  }
  return new TextDecoder().decode(plaintext);
}

/** 导出：序列化当前规划并加密为信封字符串。 */
export async function exportPlanBackup(plan: Plan, password: string): Promise<string> {
  return encryptBackup(serializePlan(plan), password);
}

/** 导入：解密信封并通过现有 Plan 完整校验；任一环节失败都抛出错误，不产生任何状态变更。 */
export async function importPlanBackup(text: string, password: string): Promise<Plan> {
  const plaintext = await decryptBackup(text, password);
  return parsePlanJson(plaintext);
}
