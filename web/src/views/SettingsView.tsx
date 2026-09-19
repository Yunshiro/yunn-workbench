import PromptSettings from "../components/PromptSettings";
import CreatorProfileSettings from "../components/CreatorProfileSettings";
import ModelProfileSettings from "../components/ModelProfileSettings";

export default function SettingsView({ onConfigChanged }: { onConfigChanged?: () => void }) {
  return (
    <div className="settings fade-in">
      <ModelProfileSettings onConfigChanged={onConfigChanged} />
      <CreatorProfileSettings />
      <PromptSettings onPromptsChanged={onConfigChanged} />
    </div>
  );
}
