import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Cpu, Eye, EyeSlash, FloppyDisk, PencilSimple, PlugsConnected, Plus, Trash, X } from "@phosphor-icons/react";
import { api } from "../lib/api";
import type { AgentConfigResponse, AgentModelConfig, AgentModelConfigInput, AgentModelConfigType } from "../lib/types";
import { ErrorBanner, Spinner, Tag } from "./ui";

const emptyInput: AgentModelConfigInput = {
  name: "", type: "builtin", providerId: "anthropic", modelId: "", baseUrl: null, apiKey: "",
};

export default function ModelProfileSettings({ onConfigChanged }: { onConfigChanged?: () => void }) {
  const [config, setConfig] = useState<AgentConfigResponse | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<AgentModelConfigInput>(emptyInput);
  const [dirty, setDirty] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setConfig(await api.agentConfig());
    } catch (err) { setError((err as Error).message); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!editingId) return;
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, [editingId]);

  const provider = useMemo(
    () => config?.providers.find((item) => item.id === form.providerId),
    [config, form.providerId],
  );

  function applyForm(patch: Partial<AgentModelConfigInput>) {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
  }

  function editConfig(item: AgentModelConfig) {
    if (dirty && editingId && !window.confirm("当前模型配置有未保存的修改，确定切换吗？")) return;
    setForm({
      name: item.name,
      type: item.type,
      providerId: item.providerId,
      modelId: item.modelId,
      baseUrl: item.baseUrl,
      apiKey: "",
      clearApiKey: false,
    });
    setEditingId(item.id);
    setDirty(false);
    setShowKey(false);
    setNotice(null);
  }

  function newConfig(type: AgentModelConfigType) {
    if (dirty && editingId && !window.confirm("放弃当前模型配置的未保存修改？")) return;
    const firstProvider = config?.providers[0];
    setForm({
      name: type === "openai_compatible" ? "本地模型" : "新模型配置",
      type,
      providerId: type === "builtin" ? firstProvider?.id ?? "anthropic" : "custom-openai",
      modelId: type === "builtin" ? firstProvider?.models[0]?.id ?? firstProvider?.defaultModelId ?? "" : "",
      baseUrl: type === "openai_compatible" ? "http://localhost:11434/v1" : null,
      apiKey: "",
    });
    setEditingId("new");
    setDirty(true);
    setShowKey(false);
    setNotice(null);
  }

  function cancelEditing() {
    if (dirty && !window.confirm("放弃当前模型配置的未保存修改？")) return;
    setEditingId(null);
    setDirty(false);
    setShowKey(false);
  }

  function changeProvider(providerId: string) {
    const next = config?.providers.find((item) => item.id === providerId);
    applyForm({ providerId, modelId: next?.models[0]?.id ?? next?.defaultModelId ?? "" });
  }

  function changeType(type: AgentModelConfigType) {
    const firstProvider = config?.providers[0];
    applyForm(type === "builtin" ? {
      type,
      providerId: firstProvider?.id ?? "anthropic",
      modelId: firstProvider?.models[0]?.id ?? firstProvider?.defaultModelId ?? "",
      baseUrl: null,
      apiKey: "",
      clearApiKey: false,
    } : {
      type,
      providerId: "custom-openai",
      modelId: "",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      clearApiKey: false,
    });
  }

  async function save() {
    if (!editingId) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const saved = editingId === "new"
        ? await api.createAgentConfig(form)
        : await api.updateAgentConfig(editingId, form);
      await load();
      setEditingId(null);
      setDirty(false);
      setShowKey(false);
      setNotice(`模型配置「${saved.name}」已保存。`);
      onConfigChanged?.();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  async function activate(item: AgentModelConfig) {
    try {
      await api.activateAgentConfig(item.id);
      await load();
      setNotice(`已将「${item.name}」设为当前模型。`);
      onConfigChanged?.();
    } catch (err) { setError((err as Error).message); }
  }

  async function duplicate(item: AgentModelConfig) {
    try {
      const copy = await api.duplicateAgentConfig(item.id);
      await load();
      editConfig(copy);
      setNotice("模型配置已复制，请修改名称或连接信息后保存。");
    } catch (err) { setError((err as Error).message); }
  }

  async function remove(item: AgentModelConfig) {
    if (!window.confirm(`删除模型配置「${item.name}」？此操作无法撤销。`)) return;
    try {
      await api.deleteAgentConfig(item.id);
      if (editingId === item.id) setEditingId(null);
      await load();
      setNotice("模型配置已删除。");
      onConfigChanged?.();
    } catch (err) { setError((err as Error).message); }
  }

  async function test(item: AgentModelConfig) {
    setTestingId(item.id); setError(null); setNotice(null);
    try {
      const result = await api.testAgentConfig(item.id);
      setNotice(`${item.name}：${result.message}`);
    } catch (err) { setError((err as Error).message); }
    finally { setTestingId(null); }
  }

  const currentItem = editingId && editingId !== "new" ? config?.configs.find((item) => item.id === editingId) : undefined;
  const canSave = !!form.name.trim() && !!form.modelId.trim() && (form.type === "builtin" || !!form.baseUrl?.trim());

  return (
    <section className="settings-card model-settings">
      <div className="settings-card__head">
        <div><h3>模型配置</h3><p>保存多套供应商和模型连接；Agent 始终使用标记为“当前模型”的一套。</p></div>
        <div className="model-settings__new">
          <button className="btn btn--ghost" onClick={() => newConfig("openai_compatible")}><Plus size={15} />自定义接口</button>
          <button className="btn btn--primary" onClick={() => newConfig("builtin")}><Plus size={15} weight="bold" />内置供应商</button>
        </div>
      </div>

      <div className="profile-cards">
        {config === null && <div className="skeleton" style={{ height: 128, borderRadius: 10 }} />}
        {config?.configs.map((item) => (
          <article className={`profile-card${editingId === item.id ? " profile-card--selected" : ""}${item.isActive ? " profile-card--active" : ""}`} key={item.id}>
            <button className="profile-card__select" onClick={() => editConfig(item)}>
              <span className="profile-card__icon"><Cpu size={20} weight={item.isActive ? "fill" : "regular"} /></span>
              <span className="profile-card__main">
                <strong>{item.name}</strong>
                <small>{item.providerLabel} · {item.modelId}</small>
              </span>
              {item.isActive && <Tag color="blue">当前模型</Tag>}
            </button>
            <div className="profile-card__actions">
              <Tag color={item.configured ? "green" : "yellow"}>{item.configured ? "已配置" : "待认证"}</Tag>
              <button className="btn btn--sm" onClick={() => editConfig(item)}><PencilSimple size={13} />编辑</button>
              {!item.isActive && <button className="btn btn--sm" disabled={!item.configured} title={item.configured ? "" : "请先完成认证配置"} onClick={() => void activate(item)}><Check size={13} />设为当前</button>}
              <button className="btn btn--icon" title="测试连接" disabled={testingId === item.id || !item.configured} onClick={() => void test(item)}>{testingId === item.id ? <Spinner size={13} /> : <PlugsConnected size={14} />}</button>
              <button className="btn btn--icon" title="复制配置" onClick={() => void duplicate(item)}><Copy size={14} /></button>
              <button className="btn btn--icon btn--danger" title="删除配置" disabled={(config?.configs.length ?? 0) <= 1} onClick={() => void remove(item)}><Trash size={14} /></button>
            </div>
          </article>
        ))}
      </div>

      {editingId && (
        <div className="modal-backdrop settings-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancelEditing(); }} role="presentation">
          <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="model-modal-title">
            <header className="modal__head settings-modal__head">
              <span className="settings-modal__icon"><Cpu size={20} /></span>
              <div>
                <h3 className="modal__title" id="model-modal-title">{editingId === "new" ? "新建模型配置" : `编辑「${currentItem?.name ?? form.name}」`}</h3>
                <p>API Key 只保存在本机服务端，前端无法读取已保存的明文。</p>
              </div>
              <button className="btn btn--icon" onClick={cancelEditing} aria-label="关闭模型配置弹窗"><X size={17} /></button>
            </header>

            <div className="modal__body settings-modal__body model-editor">
              <div className="creator-form">
                <label className="field creator-form__wide"><span>配置卡片名称</span><input className="input" value={form.name} onChange={(event) => applyForm({ name: event.target.value })} placeholder="例如：本地 Qwen / OpenAI 主账号" autoFocus /></label>
                <label className="field"><span>配置类型</span><select className="select" value={form.type} onChange={(event) => changeType(event.target.value as AgentModelConfigType)}><option value="builtin">内置供应商</option><option value="openai_compatible">OpenAI 兼容接口</option></select></label>

                {form.type === "builtin" ? <>
                  <label className="field"><span>模型供应商</span><select className="select" value={form.providerId} onChange={(event) => changeProvider(event.target.value)}>{config?.providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                  <label className="field creator-form__wide"><span>模型</span><select className="select" value={form.modelId} onChange={(event) => applyForm({ modelId: event.target.value })}>{provider?.models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select></label>
                </> : <>
                  <label className="field"><span>Base URL</span><input className="input" value={form.baseUrl ?? ""} onChange={(event) => applyForm({ baseUrl: event.target.value })} placeholder="http://localhost:11434/v1" /></label>
                  <label className="field"><span>Model ID</span><input className="input" value={form.modelId} onChange={(event) => applyForm({ modelId: event.target.value })} placeholder="qwen2.5:14b" /></label>
                </>}

                <label className="field creator-form__wide">
                  <span>API Key {currentItem?.hasApiKey && "（留空则保持现有 Key）"}{form.type === "openai_compatible" && "（本地服务可留空）"}</span>
                  <div className="key-input">
                    <input className="input" type={showKey ? "text" : "password"} value={form.apiKey ?? ""} onChange={(event) => applyForm({ apiKey: event.target.value, clearApiKey: false })} placeholder={currentItem?.hasApiKey ? "已配置；输入新 Key 可替换" : "输入 API Key"} autoComplete="off" spellCheck={false} />
                    <button className="btn btn--icon key-input__toggle" type="button" aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeSlash size={16} /> : <Eye size={16} />}</button>
                  </div>
                  {currentItem?.apiKeySource === "environment" && <small>当前由环境变量提供密钥；填写后将仅覆盖这张配置。</small>}
                  {currentItem?.apiKeySource === "profile" && <button className="btn btn--sm model-editor__clear" type="button" onClick={() => applyForm({ apiKey: "", clearApiKey: true })}>清除已保存 Key</button>}
                </label>
              </div>
              {error && <ErrorBanner message={error} />}
            </div>

            <footer className="settings-modal__foot">
              <span>{editingId === "new" ? "新配置" : currentItem?.providerLabel}{dirty ? " · 有未保存修改" : ""}</span>
              <div>
                {editingId !== "new" && <button className="btn btn--ghost" disabled={testingId === editingId || dirty} title={dirty ? "请先保存修改再测试" : ""} onClick={() => currentItem && void test(currentItem)}>{testingId === editingId ? <Spinner size={14} /> : <PlugsConnected size={15} />}测试连接</button>}
                <button className="btn btn--ghost" onClick={cancelEditing}>取消</button>
                <button className="btn btn--primary" disabled={saving || !canSave} onClick={() => void save()}>{saving ? <Spinner size={14} /> : <FloppyDisk size={15} />}保存配置</button>
              </div>
            </footer>
          </section>
        </div>
      )}

      {error && <ErrorBanner message={error} />}
      {notice && <div className="notice-banner">{notice}</div>}
    </section>
  );
}
