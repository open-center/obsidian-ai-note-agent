import { App, requireApiVersion } from "obsidian";
import type { ProviderConfig } from "./llm";

/**
 * API key 的存储。
 *
 * Obsidian 1.11.4+ 提供 app.secretStorage（系统级密钥存储，不写入 data.json，也不会被仓库同步工具同步）。
 * 有它时，API key 存在密钥存储里，data.json 只保存一个引用 ID（apiKeySecret）；
 * 更早的版本没有该接口，退回到原来的 data.json 明文存储。
 *
 * 用运行时特性检测访问 secretStorage，保证在 minAppVersion（1.7.2）以上的所有版本都能正常工作。
 */

interface SecretStorageLike {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
}

export function getSecretStorage(app: App): SecretStorageLike | null {
  if (!requireApiVersion("1.11.4")) return null;
  const storage = (app as unknown as { secretStorage?: SecretStorageLike }).secretStorage;
  return storage && typeof storage.getSecret === "function" && typeof storage.setSecret === "function" ? storage : null;
}

/** 密钥 ID：小写字母、数字和连字符 */
export function secretIdFor(p: ProviderConfig): string {
  return `ai-note-agent-${p.id.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
}

/** 读取提供商的 API key（优先密钥存储，其次 data.json 中的旧值） */
export function readApiKey(app: App, p: ProviderConfig): string {
  const storage = getSecretStorage(app);
  if (storage && p.apiKeySecret) return storage.getSecret(p.apiKeySecret) ?? "";
  return p.apiKey;
}

/** 写入提供商的 API key。返回是否存进了密钥存储。 */
export function writeApiKey(app: App, p: ProviderConfig, value: string): boolean {
  const storage = getSecretStorage(app);
  if (!storage) {
    p.apiKey = value;
    return false;
  }
  // 保留已有的引用（包括旧版 notewright-*），复制旧设置后仍能读取和更新原密钥。
  const id = p.apiKeySecret || secretIdFor(p);
  storage.setSecret(id, value);
  p.apiKeySecret = id;
  p.apiKey = "";
  return true;
}

/** 删除提供商时清空它在密钥存储里的值（SecretStorage 没有删除接口，写入空字符串） */
export function clearApiKey(app: App, p: ProviderConfig): void {
  const storage = getSecretStorage(app);
  if (storage && p.apiKeySecret) storage.setSecret(p.apiKeySecret, "");
}

/** 返回一份带有真实 API key 的副本，只在发起请求时使用，不会被保存 */
export function withApiKey(app: App, p: ProviderConfig): ProviderConfig {
  return { ...p, apiKey: readApiKey(app, p) };
}

/**
 * 把 data.json 里的明文 API key 迁移到密钥存储。
 * 返回是否发生了迁移（调用方据此决定是否保存设置）。
 */
export function migrateApiKeys(app: App, providers: ProviderConfig[]): boolean {
  if (!getSecretStorage(app)) return false;
  let changed = false;
  for (const p of providers) {
    if (!p.apiKey) continue;
    try {
      writeApiKey(app, p, p.apiKey);
      changed = true;
    } catch (e) {
      // 写入密钥存储失败时保留原值，不影响插件加载
      console.warn(`[AI Note Agent] Could not move the API key of "${p.name}" to secret storage`, e);
    }
  }
  return changed;
}

/** 当前环境下 API key 的存储位置说明 */
export function keyStorageDescription(app: App, pluginId: string): string {
  return getSecretStorage(app)
    ? "API key 保存在 Obsidian 的系统密钥存储中，不会写入插件的 data.json，也不会被仓库同步工具同步。在另一台设备上使用时，需要在那台设备上重新填写一次 API key。"
    : `API key 以明文保存在 ${app.vault.configDir}/plugins/${pluginId}/data.json 中（当前 Obsidian 版本低于 1.11.4，不支持系统密钥存储）。如果你同步或公开仓库，请注意不要泄露该文件。`;
}
