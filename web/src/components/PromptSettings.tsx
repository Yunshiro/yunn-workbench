import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowCounterClockwise, Code, FloppyDisk, PencilSimple, ShieldCheck } from "@phosphor-icons/react";
import { api } from "../lib/api";
import type { PromptConfigResponse, PromptKey } from "../lib/types";
import { ErrorBanner, Spinner, Tag } from "./ui";

const PROMPT_META: { key: PromptKey; label: string; description: string }[] = [
  { key: "ideate", label: "找选题", description: "从素材中生成推文或长文选题" },
  { key: "summarize", label: "摘要", description: "提炼核心观点、引用和数据" },
  { key: "evaluate", label: "价值评估", description: "判断素材是否值得创作" },
  { key: "cluster", label: "聚类趋势", description: "从多条素材中发现主题与趋势" },
  { key: "common", label: "通用规则", description: "注入所有任务的共用要求" },
  { key: "system", label: "系统提示词", description: "定义 Agent 的整体角色和行为边界" },
];

const SAFE_EXAMPLES: Record<PromptKey, string[]> = {
  ideate: ["优先寻找反直觉、有争议的角度", "避免纯新闻复述，要给出明确判断", "选题尽量适合单条中文推文"],
  summarize: ["优先保留数据和原始引用", "用通俗中文解释专业术语", "突出对内容创作者有用的信息"],
  evaluate: ["可信度比新颖度更重要", "营销软文应当降低评分", "重点判断是否具有讨论价值"],
  cluster: ["优先识别正在升温的新趋势", "相似主题不要过度拆分", "指出不同来源之间的冲突"],
  common: ["表达直接，不要使用空泛套话", "不确定的信息要明确标注", "优先使用中文输出"],
  system: ["保持审慎，不要迎合用户结论", "重要判断需要说明依据", "表达简洁并给出可执行建议"],
};

export default function PromptSettings({ onPromptsChanged }: { onPromptsChanged?: () => void }) {
  const [config, setConfig] = useState<PromptConfigResponse | null>(null);
  const [activeKey, setActiveKey] = useState<PromptKey>("ideate");
  const [mode, setMode] = useState<"safe" | "advanced">("safe");
  const [draft, setDraft] = useState("");
  const [instructionDraft, setInstructionDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const result = await api.promptConfig();
      setConfig(result);
      setDraft(result.prompts[activeKey]);
      setInstructionDraft(result.instructions[activeKey]);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeKey]);

  useEffect(() => { void load(); }, [load]);

  const meta = PROMPT_META.find((item) => item.key === activeKey)!;
  const savedValue = config?.prompts[activeKey] ?? "";
  const savedInstruction = config?.instructions[activeKey] ?? "";
  const templateDirty = draft !== savedValue;
  const instructionDirty = instructionDraft !== savedInstruction;
  const isDirty = mode === "safe" ? instructionDirty : templateDirty;
  const isTemplateCustomized = config ? config.prompts[activeKey] !== config.defaults[activeKey] : false;
  const isCustomized = isTemplateCustomized || !!savedInstruction;
  const variables = config?.contracts[activeKey].requiredVariables ?? [];
  const requiredFields = config?.contracts[activeKey].requiredFields ?? [];
  const missingVariables = useMemo(
    () => variables.filter((variable) => !draft.includes(variable)),
    [draft, variables],
  );
  const missingFields = useMemo(
    () => requiredFields.filter((field) => !draft.includes(`"${field}"`)),
    [draft, requiredFields],
  );

  function selectPrompt(key: PromptKey) {
    if (key === activeKey) return;
    if (isDirty && !window.confirm("当前修改尚未保存，确定放弃修改？")) return;
    setActiveKey(key);
    setDraft(config?.prompts[key] ?? "");
    setInstructionDraft(config?.instructions[key] ?? "");
    setNotice(null);
    setError(null);
  }

  function switchMode(nextMode: "safe" | "advanced") {
    if (nextMode === mode) return;
    if (isDirty && !window.confirm("当前修改尚未保存，确定切换编辑模式？")) return;
    setMode(nextMode);
    setDraft(savedValue);
    setInstructionDraft(savedInstruction);
    setError(null);
    setNotice(null);
  }

  async function handleSave() {
    if (mode === "advanced" && !draft.trim()) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = mode === "safe"
        ? await api.savePromptInstruction(activeKey, instructionDraft)
        : await api.savePrompt(activeKey, draft);
      setConfig(result);
      setDraft(result.prompts[activeKey]);
      setInstructionDraft(result.instructions[activeKey]);
      setNotice(mode === "safe" ? `已保存「${meta.label}」的补充要求` : `已保存「${meta.label}」高级模板`);
      onPromptsChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    const target = mode === "safe" ? "清空补充要求" : "恢复为项目默认模板";
    if (!window.confirm(`确定要${target}？`)) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = mode === "safe"
        ? await api.resetPromptInstruction(activeKey)
        : await api.resetPrompt(activeKey);
      setConfig(result);
      setDraft(result.prompts[activeKey]);
      setInstructionDraft(result.instructions[activeKey]);
      setNotice(mode === "safe" ? `已清空「${meta.label}」的补充要求` : `已恢复「${meta.label}」默认模板`);
      onPromptsChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function addExample(example: string) {
    setInstructionDraft((current) => current.trim() ? `${current.trim()}\n${example}` : example);
  }

  return (
    <section className="settings-card prompt-settings">
      <div className="settings-card__head">
        <div><h3>功能提示词</h3><p>安全配置用于调整内容偏好；变量与输出协议由系统保护。</p></div>
        <PencilSimple size={18} color="var(--accent)" />
      </div>

      <div className="prompt-editor">
        <nav className="prompt-nav" aria-label="提示词类型">
          {PROMPT_META.map((item) => {
            const customized = config && (config.prompts[item.key] !== config.defaults[item.key] || !!config.instructions[item.key]);
            return (
              <button key={item.key} type="button" className={`prompt-nav__item${activeKey === item.key ? " prompt-nav__item--active" : ""}`} onClick={() => selectPrompt(item.key)}>
                <span>{item.label}</span>{customized && <i />}
              </button>
            );
          })}
        </nav>

        <div className="prompt-editor__main">
          <div className="prompt-editor__title">
            <div><strong>{meta.label}</strong><span>{meta.description}</span></div>
            <Tag color={isCustomized ? "blue" : "gray"}>{isCustomized ? "已自定义" : "默认"}</Tag>
          </div>

          <div className="prompt-mode-switch" role="group" aria-label="提示词编辑模式">
            <button type="button" className={mode === "safe" ? "is-active" : ""} onClick={() => switchMode("safe")}><ShieldCheck size={15} />安全配置</button>
            <button type="button" className={mode === "advanced" ? "is-active" : ""} onClick={() => switchMode("advanced")}><Code size={15} />高级模板</button>
          </div>

          {mode === "safe" ? (
            <div className="prompt-safe-editor">
              <div className="prompt-safe-editor__intro">
                <ShieldCheck size={19} weight="fill" />
                <div><strong>放心修改，不会破坏功能</strong><span>系统会自动保留素材变量、输出格式和程序依赖字段。</span></div>
              </div>
              <label className="field">
                <span>你希望 Agent 额外遵守什么要求？</span>
                <textarea className="prompt-safe-textarea input" value={instructionDraft} onChange={(event) => setInstructionDraft(event.target.value)} placeholder="不填写则使用默认行为。你可以描述关注角度、判断标准、表达风格或需要避免的内容。" aria-label={`${meta.label}补充要求`} />
              </label>
              <div className="prompt-examples">
                <span>点击添加示例</span>
                <div>{SAFE_EXAMPLES[activeKey].map((example) => <button type="button" key={example} onClick={() => addExample(example)}>+ {example}</button>)}</div>
              </div>
              {(variables.length > 0 || requiredFields.length > 0) && (
                <div className="prompt-locked">
                  <strong>系统已锁定</strong>
                  {variables.length > 0 && <span>{variables.length} 个运行变量</span>}
                  {requiredFields.length > 0 && <span>{requiredFields.length} 个输出字段</span>}
                  <small>这些内容由系统维护，无需手动填写。</small>
                </div>
              )}
            </div>
          ) : (
            <div className="prompt-advanced-editor">
              <div className="prompt-warning prompt-warning--advanced">高级模板会直接影响任务运行。保存前系统会检查必需变量和输出字段，但仍建议只在了解模板结构时修改。</div>
              {variables.length > 0 && <div className="prompt-variables"><span>必需变量</span>{variables.map((variable) => <code key={variable}>{variable}</code>)}</div>}
              {requiredFields.length > 0 && <div className="prompt-variables prompt-fields"><span>必需输出字段</span>{requiredFields.map((field) => <code key={field}>{field}</code>)}</div>}
              <textarea className="prompt-textarea" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} aria-label={`${meta.label}高级模板`} />
              {missingVariables.length > 0 && <div className="prompt-warning">缺少变量 {missingVariables.join("、")}，无法保存。</div>}
              {missingFields.length > 0 && <div className="prompt-warning">缺少输出字段 {missingFields.join("、")}，无法保存。</div>}
            </div>
          )}

          <div className="prompt-actions">
            <span>{(mode === "safe" ? instructionDraft : draft).length.toLocaleString()} 字符{isDirty ? " · 尚未保存" : ""}</span>
            <div className="toolbar__spacer" />
            <button className="btn btn--ghost" type="button" onClick={handleReset} disabled={saving || (mode === "safe" ? !savedInstruction : !isTemplateCustomized)}>
              <ArrowCounterClockwise size={15} />{mode === "safe" ? "清空要求" : "恢复默认"}
            </button>
            <button className="btn btn--primary" type="button" onClick={handleSave} disabled={saving || !isDirty || (mode === "advanced" && (!draft.trim() || missingVariables.length > 0 || missingFields.length > 0))}>
              {saving ? <Spinner /> : <FloppyDisk size={15} weight="bold" />}{mode === "safe" ? "保存配置" : "保存模板"}
            </button>
          </div>
        </div>
      </div>

      {error && <div className="prompt-message"><ErrorBanner message={error} /></div>}
      {notice && <div className="notice-banner prompt-message">{notice}</div>}
    </section>
  );
}
