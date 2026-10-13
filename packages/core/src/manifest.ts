/**
 * 插件签名 manifest —— 供应链防线：安装单元 = 签名的能力声明。
 *
 * ed25519 via node:crypto，零依赖。升级时用 diffCapabilities 展示权限变化
 * （"此版本新增 fs.write、移除 net"），默认最小授权——像手机 OS 的权限变更提示。
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export interface PluginManifest {
  /** 插件全名，如 'community/dsh-plugin-pr-review' */
  name: string;
  version: string;
  /** 能力声明：安装后要求的权限（fs.read / fs.write / net / shell ...） */
  capabilities: string[];
  /** 插件包内容哈希（sha256 hex，对插件产物计算） */
  contentHash: string;
  tarball: string;
}

export interface SigningKeyPair {
  /** SPKI DER, base64 */
  publicKey: string;
  /** PKCS8 DER, base64 */
  privateKey: string;
}

export interface CapabilityDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
}

/** 稳定序列化：键与能力列表排序，保证同内容 → 同字节 → 同签名 */
export function canonicalManifest(m: PluginManifest): string {
  return JSON.stringify({
    name: m.name,
    version: m.version,
    capabilities: [...m.capabilities].sort(),
    contentHash: m.contentHash,
    tarball: m.tarball,
  });
}

/** manifest 本身的 sha256（用于指纹展示 / 索引去重） */
export function hashManifest(m: PluginManifest): string {
  return createHash('sha256').update(canonicalManifest(m)).digest('hex');
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

function keyFrom(base64: string, kind: 'public' | 'private'): KeyObject {
  const der = Buffer.from(base64, 'base64');
  return kind === 'public'
    ? createPublicKey({ key: der, format: 'der', type: 'spki' })
    : createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** 签名（私钥）—— 对 canonical 序列化做 ed25519 签名，返回 base64 */
export function signManifest(m: PluginManifest, privateKeyBase64: string): string {
  return cryptoSign(null, Buffer.from(canonicalManifest(m), 'utf8'), keyFrom(privateKeyBase64, 'private')).toString(
    'base64',
  );
}

/** 验签（公钥）—— 内容或签名被篡改即 false；密钥格式异常也返回 false 而非抛错 */
export function verifyManifest(m: PluginManifest, signatureBase64: string, publicKeyBase64: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalManifest(m), 'utf8'),
      keyFrom(publicKeyBase64, 'public'),
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

/** 能力 diff：升级审查的核心信息 */
export function diffCapabilities(oldCaps: string[], newCaps: string[]): CapabilityDiff {
  const oldSet = new Set(oldCaps);
  const newSet = new Set(newCaps);
  return {
    added: newCaps.filter((c) => !oldSet.has(c)).sort(),
    removed: oldCaps.filter((c) => !newSet.has(c)).sort(),
    unchanged: newCaps.filter((c) => oldSet.has(c)).sort(),
  };
}

/** 人类可读的能力 diff（CLI / 升级确认对话框直接用） */
export function renderCapabilityDiff(name: string, fromVersion: string, toVersion: string, d: CapabilityDiff): string[] {
  const lines = [`${name}  ${fromVersion} → ${toVersion}`];
  if (d.added.length > 0) lines.push(`  + ${d.added.join(', ')} （新增权限，需要重新授权）`);
  if (d.removed.length > 0) lines.push(`  - ${d.removed.join(', ')} （移除权限）`);
  if (d.added.length === 0 && d.removed.length === 0) lines.push('  权限无变化');
  return lines;
}

// ---------------------------------------------------------------------------
// 信任注册表 —— 从"单密钥验签"升级为完整的信任模型：
// 发布者 → 多密钥（轮换）→ 退休（retiredAt，历史可回溯）→ 吊销（密钥级 / 制品级）。
// ---------------------------------------------------------------------------

export interface TrustedKey {
  id: string;
  publicKey: string;
  createdAt: string;
  /** 退休时间：此后的验签不再接受该密钥（区别于吊销——历史签名仍可按 at 溯源验证） */
  retiredAt?: string;
}

export interface PublisherEntry {
  publisher: string;
  keys: TrustedKey[];
  /** 已吊销的密钥 ID（立即失效） */
  revokedKeyIds?: string[];
  /** 已吊销的制品（manifest 指纹或内容哈希，hex） */
  revokedHashes?: string[];
}

export interface VerifyDecision {
  ok: boolean;
  reason?: 'unknown-publisher' | 'no-active-key' | 'revoked-key' | 'revoked-artifact' | 'bad-signature';
  /** 验签通过时命中的密钥 ID */
  keyId?: string;
}

export class TrustRegistry {
  private byName = new Map<string, PublisherEntry>();
  private revokedHashes = new Set<string>();

  constructor(entries: PublisherEntry[] = []) {
    for (const e of entries) {
      this.byName.set(e.publisher, e);
      for (const h of e.revokedHashes ?? []) this.revokedHashes.add(h);
    }
  }

  /**
   * 验证一个带签名的 manifest（publisher 取 name 中 '/' 之前的部分）。
   * at 支持回溯判定："安装那一刻它是否可信"——退休前的旧密钥在历史时间点仍然有效。
   */
  verify(m: PluginManifest, signature: string, opts: { at?: number } = {}): VerifyDecision {
    const at = opts.at ?? Date.now();
    if (this.revokedHashes.has(hashManifest(m)) || this.revokedHashes.has(m.contentHash)) {
      return { ok: false, reason: 'revoked-artifact' };
    }
    const publisher = m.name.split('/')[0];
    const entry = this.byName.get(publisher);
    if (!entry) return { ok: false, reason: 'unknown-publisher' };

    const revokedKeys = new Set(entry.revokedKeyIds ?? []);
    const candidates = entry.keys.filter((k) => {
      if (revokedKeys.has(k.id)) return false;
      if (k.retiredAt && Date.parse(k.retiredAt) <= at) return false;
      return true;
    });
    if (candidates.length === 0) return { ok: false, reason: 'no-active-key' };

    for (const k of candidates) {
      if (verifyManifest(m, signature, k.publicKey)) return { ok: true, keyId: k.id };
    }
    return { ok: false, reason: 'bad-signature' };
  }
}
