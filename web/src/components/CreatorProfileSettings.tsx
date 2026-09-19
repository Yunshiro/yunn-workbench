import { useCallback, useEffect, useState } from "react";
import { Brain, Check, Copy, FloppyDisk, PencilSimple, Plus, Trash, UserCircle, X } from "@phosphor-icons/react";
import { api } from "../lib/api";
import type { CreatorProfile, MemoryFact } from "../lib/types";
import { ErrorBanner, Spinner, Tag } from "./ui";

const emptyProfile: CreatorProfile = {
  id: "", cardName: "未命名画像", isActive: false, name: "", domains: [], audience: "", goals: "", tone: "", avoidTopics: [],
  outputPreferences: { platforms: [], language: "zh", length: "" }, version: 1, createdAt: 0, updatedAt: 0,
};

const splitTags = (value: string) => value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);

export default function CreatorProfileSettings() {
  const [profiles, setProfiles] = useState<CreatorProfile[] | null>(null);
  const [profile, setProfile] = useState<CreatorProfile>(emptyProfile);
  const [domainsInput, setDomainsInput] = useState("");
  const [avoidTopicsInput, setAvoidTopicsInput] = useState("");
  const [platformsInput, setPlatformsInput] = useState("");
  const [memories, setMemories] = useState<MemoryFact[]>([]);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [activeTab, setActiveTab] = useState<"profile" | "memory">("profile");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyProfile = useCallback((next: CreatorProfile) => {
    setProfile(next);
    setDomainsInput(next.domains.join("，"));
    setAvoidTopicsInput(next.avoidTopics.join("，"));
    setPlatformsInput((next.outputPreferences.platforms ?? []).join("，"));
    setDirty(false);
  }, []);

  const load = useCallback(async (preferredId?: string) => {
    try {
      setError(null);
      const nextProfiles = await api.listCreatorProfiles();
      setProfiles(nextProfiles);
      const selected = nextProfiles.find((item) => item.id === preferredId)
        ?? nextProfiles.find((item) => item.isActive)
        ?? nextProfiles[0];
      if (selected) {
        applyProfile(selected);
        setMemories(await api.listMemories(selected.id));
      }
    } catch (err) {
      setError((err as Error).message);
      setProfiles([]);
    }
  }, [applyProfile]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!editingId) return;
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, [editingId]);

  async function editProfile(next: CreatorProfile) {
    if (next.id === editingId) return;
    if (dirty && !window.confirm("当前画像有未保存的修改，确定切换吗？")) return;
    applyProfile(next);
    setEditingId(next.id);
    setActiveTab("profile");
    setNotice(null);
    try {
      setMemories(await api.listMemories(next.id));
    } catch (err) { setError((err as Error).message); }
  }

  function profileInput() {
    return {
      cardName: profile.cardName,
      name: profile.name,
      domains: splitTags(domainsInput),
      audience: profile.audience,
      goals: profile.goals,
      tone: profile.tone,
      avoidTopics: splitTags(avoidTopicsInput),
      outputPreferences: { ...profile.outputPreferences, platforms: splitTags(platformsInput) },
    };
  }

  async function saveProfile() {
    if (!editingId) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const saved = editingId === "new"
        ? await api.createCreatorProfile(profileInput())
        : await api.saveCreatorProfile(editingId, profileInput());
      applyProfile(saved);
      setProfiles((current) => {
        if (!current) return [saved];
        return current.some((item) => item.id === saved.id)
          ? current.map((item) => item.id === saved.id ? saved : item)
          : [...current, saved];
      });
      setNotice(`画像「${saved.cardName}」已保存，新任务会使用当前启用的画像。`);
      setEditingId(null);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  function createProfile() {
    applyProfile({
      ...emptyProfile,
      cardName: `新画像 ${(profiles?.length ?? 0) + 1}`,
      outputPreferences: { ...emptyProfile.outputPreferences },
    });
    setMemories([]);
    setMemoryDraft("");
    setEditingId("new");
    setActiveTab("profile");
    setDirty(true);
    setError(null);
    setNotice(null);
  }

  async function activateProfile(target: CreatorProfile) {
    if (dirty && target.id === profile.id) await saveProfile();
    try {
      await api.activateCreatorProfile(target.id);
      await load(target.id);
      setNotice(`已将「${target.cardName}」设为当前画像。`);
    } catch (err) { setError((err as Error).message); }
  }

  async function duplicateProfile(target: CreatorProfile) {
    try {
      const copy = await api.duplicateCreatorProfile(target.id);
      await load(copy.id);
      setEditingId(copy.id);
      setActiveTab("profile");
      setNotice("画像及其长期记忆已复制，可继续修改名称和内容。");
    } catch (err) { setError((err as Error).message); }
  }

  async function removeProfile(target: CreatorProfile) {
    if (!window.confirm(`删除画像「${target.cardName}」及其长期记忆？此操作无法撤销。`)) return;
    try {
      await api.deleteCreatorProfile(target.id);
      if (editingId === target.id) setEditingId(null);
      await load();
      setNotice("画像已删除。");
    } catch (err) { setError((err as Error).message); }
  }

  async function addMemory() {
    if (!memoryDraft.trim() || !profile.id) return;
    try {
      const memory = await api.createMemory(memoryDraft.trim(), "preference", profile.id);
      setMemoryDraft("");
      setMemories((current) => [memory, ...current.filter((item) => item.id !== memory.id)]);
    } catch (err) { setError((err as Error).message); }
  }

  async function setMemoryStatus(memory: MemoryFact, status: MemoryFact["status"]) {
    try {
      const updated = await api.updateMemory(memory.id, { status });
      setMemories((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (err) { setError((err as Error).message); }
  }

  async function removeMemory(memory: MemoryFact) {
    if (!window.confirm(`删除这条记忆？\n${memory.content}`)) return;
    try {
      await api.deleteMemory(memory.id);
      setMemories((current) => current.filter((item) => item.id !== memory.id));
    } catch (err) { setError((err as Error).message); }
  }

  const change = (patch: Partial<CreatorProfile>) => {
    setProfile((current) => ({ ...current, ...patch }));
    setDirty(true);
  };

  function cancelEditing() {
    const original = profiles?.find((item) => item.id === profile.id);
    if (dirty && !window.confirm("放弃当前画像的未保存修改？")) return;
    if (original) applyProfile(original);
    setEditingId(null);
    setActiveTab("profile");
    setNotice(null);
  }

  return (
    <section className="settings-card creator-settings">
      <div className="settings-card__head">
        <div><h3>创作者画像</h3><p>创建多套写作身份；Agent 始终使用标记为“当前画像”的一套。</p></div>
        <button className="btn btn--primary" onClick={createProfile}><Plus size={15} weight="bold" />新建画像</button>
      </div>

      <div className="profile-cards">
        {profiles === null && <div className="skeleton" style={{ height: 128, borderRadius: 10 }} />}
        {profiles?.map((item) => (
          <article className={`profile-card${editingId === item.id ? " profile-card--selected" : ""}${item.isActive ? " profile-card--active" : ""}`} key={item.id}>
            <button className="profile-card__select" onClick={() => void editProfile(item)}>
              <span className="profile-card__icon"><UserCircle size={20} weight={item.isActive ? "fill" : "regular"} /></span>
              <span className="profile-card__main">
                <strong>{item.cardName}</strong>
                <small>{item.domains.length > 0 ? item.domains.slice(0, 3).join(" · ") : "尚未设置创作领域"}</small>
              </span>
              {item.isActive && <Tag color="blue">当前画像</Tag>}
            </button>
            <div className="profile-card__actions">
              <button className="btn btn--sm" onClick={() => void editProfile(item)}><PencilSimple size={13} />编辑</button>
              {!item.isActive && <button className="btn btn--sm" onClick={() => void activateProfile(item)}><Check size={13} />设为当前</button>}
              <button className="btn btn--icon" title="复制画像" onClick={() => void duplicateProfile(item)}><Copy size={14} /></button>
              <button className="btn btn--icon btn--danger" title="删除画像" disabled={(profiles?.length ?? 0) <= 1} onClick={() => void removeProfile(item)}><Trash size={14} /></button>
            </div>
          </article>
        ))}
      </div>

      {editingId && (
        <div className="modal-backdrop settings-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancelEditing(); }} role="presentation">
          <section className="modal settings-modal settings-modal--large" role="dialog" aria-modal="true" aria-labelledby="profile-modal-title">
            <header className="modal__head settings-modal__head">
              <span className="settings-modal__icon"><Brain size={20} /></span>
              <div>
                <h3 className="modal__title" id="profile-modal-title">{editingId === "new" ? "新建创作者画像" : `编辑「${profile.cardName}」`}</h3>
                <p>{profile.isActive ? "这是当前生效的画像。" : "保存后可在卡片列表中设为当前画像。"}</p>
              </div>
              <button className="btn btn--icon" onClick={cancelEditing} aria-label="关闭画像编辑弹窗"><X size={17} /></button>
            </header>

            <nav className="settings-modal__tabs" aria-label="画像编辑内容">
              <button className={activeTab === "profile" ? "is-active" : ""} onClick={() => setActiveTab("profile")}>基本画像</button>
              <button className={activeTab === "memory" ? "is-active" : ""} onClick={() => setActiveTab("memory")} disabled={editingId === "new"} title={editingId === "new" ? "请先保存画像，再添加长期记忆" : ""}>长期记忆</button>
            </nav>

            <div className="modal__body settings-modal__body">
              {activeTab === "profile" ? (
                <div className="creator-form">
                  <label className="field creator-form__wide"><span>画像卡片名称</span><input className="input" value={profile.cardName} onChange={(e) => change({ cardName: e.target.value })} placeholder="例如：AI 产品观察者" autoFocus /></label>
                  <label className="field"><span>创作者称呼</span><input className="input" value={profile.name} onChange={(e) => change({ name: e.target.value })} placeholder="例如：Cookie" /></label>
                  <label className="field"><span>创作领域（逗号分隔）</span><input className="input" value={domainsInput} onChange={(e) => { setDomainsInput(e.target.value); setDirty(true); }} placeholder="AI Agent，个人效率，独立开发" /></label>
                  <label className="field creator-form__wide"><span>目标读者</span><textarea className="input" value={profile.audience} onChange={(e) => change({ audience: e.target.value })} placeholder="读者是谁、具备什么背景、关心什么问题" /></label>
                  <label className="field creator-form__wide"><span>创作目标</span><textarea className="input" value={profile.goals} onChange={(e) => change({ goals: e.target.value })} placeholder="希望内容带来什么结果" /></label>
                  <label className="field"><span>表达风格</span><input className="input" value={profile.tone} onChange={(e) => change({ tone: e.target.value })} placeholder="直接、具体、有判断" /></label>
                  <label className="field"><span>避免主题（逗号分隔）</span><input className="input" value={avoidTopicsInput} onChange={(e) => { setAvoidTopicsInput(e.target.value); setDirty(true); }} /></label>
                  <label className="field"><span>常用平台</span><input className="input" value={platformsInput} onChange={(e) => { setPlatformsInput(e.target.value); setDirty(true); }} placeholder="公众号，X，小红书" /></label>
                  <label className="field"><span>篇幅偏好</span><input className="input" value={profile.outputPreferences.length ?? ""} onChange={(e) => change({ outputPreferences: { ...profile.outputPreferences, length: e.target.value } })} placeholder="例如：1500–2500 字" /></label>
                </div>
              ) : (
                <div className="memory-panel">
                  <div className="memory-head"><div><h3>「{profile.cardName}」的长期记忆</h3><p>每张画像的记忆相互隔离；复制画像时会同时复制记忆。</p></div></div>
                  <div className="memory-add">
                    <input className="input" value={memoryDraft} onChange={(e) => setMemoryDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addMemory(); }} placeholder="例如：更喜欢有真实案例和反方观点的选题" />
                    <button className="btn" onClick={() => void addMemory()} disabled={!memoryDraft.trim()}><Plus size={15} />添加并启用</button>
                  </div>
                  <div className="memory-list">
                    {memories.length === 0 && <div className="provider-list__empty">这张画像还没有长期记忆</div>}
                    {memories.map((memory) => (
                      <div className="memory-row" key={memory.id}>
                        <div><div>{memory.content}</div><small>{memory.category} · {memory.sourceType === "topic_confirmation" ? "来自选题确认" : "手动添加"}</small></div>
                        <Tag color={memory.status === "active" ? "green" : memory.status === "candidate" ? "yellow" : "gray"}>{memory.status === "active" ? "已启用" : memory.status === "candidate" ? "待确认" : "已停用"}</Tag>
                        {memory.status !== "active" && <button className="btn btn--sm" onClick={() => void setMemoryStatus(memory, "active")}><Check size={13} />启用</button>}
                        {memory.status === "active" && <button className="btn btn--sm" onClick={() => void setMemoryStatus(memory, "disabled")}>停用</button>}
                        <button className="btn btn--icon btn--danger" onClick={() => void removeMemory(memory)} aria-label="删除记忆"><Trash size={14} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {error && <ErrorBanner message={error} />}
            </div>

            <footer className="settings-modal__foot">
              <span>{editingId === "new" ? "尚未保存" : `画像版本 v${profile.version}`}{dirty ? " · 有未保存修改" : ""}</span>
              <div>
                <button className="btn btn--ghost" onClick={cancelEditing}>取消</button>
                <button className="btn btn--primary" onClick={() => void saveProfile()} disabled={saving || !profile.cardName.trim()}>{saving ? <Spinner /> : <FloppyDisk size={15} />}保存画像</button>
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
