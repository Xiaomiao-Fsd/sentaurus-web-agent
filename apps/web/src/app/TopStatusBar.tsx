import { Activity, Bot, Clock3, DatabaseZap, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Server, Sparkles } from "lucide-react";
import { Button } from "../components/ui/Button.js";
import { StatusPill, type StatusTone } from "../components/ui/StatusPill.js";

type TopStatusBarProps = {
  health: string;
  vmOnline: boolean | null;
  vmLoading: boolean;
  vmChecked: boolean;
  workerRunning: boolean | null;
  agentChecked: boolean;
  vmAgentStreamState: string;
  llmConfigured: boolean | null;
  clockSkewOk: boolean | null;
  clockSkewWarning: boolean;
  clockSkewLabel: string;
  vmTime?: string;
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  mobileLeftPanelOpen: boolean;
  mobileRightPanelOpen: boolean;
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
  onOpenMobileLeftPanel: () => void;
  onOpenMobileRightPanel: () => void;
};

function statusTone(ok: boolean | null | undefined, warning = false): StatusTone {
  if (ok === true) return "good";
  if (warning || ok === false) return "warn";
  return "idle";
}

export function TopStatusBar({
  agentChecked,
  clockSkewLabel,
  clockSkewOk,
  clockSkewWarning,
  health,
  leftPanelCollapsed,
  llmConfigured,
  mobileLeftPanelOpen,
  mobileRightPanelOpen,
  onOpenMobileLeftPanel,
  onOpenMobileRightPanel,
  onToggleLeftPanel,
  onToggleRightPanel,
  rightPanelCollapsed,
  vmAgentStreamState,
  vmChecked,
  vmLoading,
  vmOnline,
  vmTime,
  workerRunning
}: TopStatusBarProps) {
  const apiOk = health.endsWith("OK");
  const agentLabel = workerRunning ? "Agent Running" : agentChecked ? "Agent Stopped" : `Agent ${vmAgentStreamState}`;

  return (
    <header className="app-topbar top-status-bar">
      <Button
        aria-controls="session-sidebar"
        aria-expanded={!leftPanelCollapsed}
        className="desktop-panel-toggle"
        leftIcon={leftPanelCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        onClick={onToggleLeftPanel}
        variant="outline"
      >
        {leftPanelCollapsed ? "Show sessions" : "Hide sessions"}
      </Button>
      <Button
        aria-controls="session-sidebar"
        aria-expanded={mobileLeftPanelOpen}
        className="mobile-panel-trigger"
        leftIcon={<PanelLeftOpen aria-hidden="true" />}
        onClick={onOpenMobileLeftPanel}
        variant="outline"
      >
        Sessions
      </Button>
      <div className="brand-lockup">
        <span className="brand-mark"><Sparkles aria-hidden="true" /></span>
        <div>
          <strong>Sentaurus VM Agent</strong>
          <small>VM-local LLM / SSH relay / Safe TCAD workspace</small>
        </div>
      </div>
      <div className="top-status-actions">
        <StatusPill icon={DatabaseZap} label={`API ${health}`} tone={apiOk ? "good" : "warn"} />
        <StatusPill
          icon={Server}
          label={`VM ${vmLoading ? "Checking" : vmOnline ? "Online" : vmChecked ? "Offline" : "Unchecked"}`}
          pulse={vmLoading}
          tone={statusTone(vmOnline, vmLoading)}
        />
        <StatusPill icon={Bot} label={agentLabel} tone={statusTone(workerRunning)} />
        <StatusPill
          icon={Activity}
          label={`LLM ${llmConfigured ? "Configured" : "Pending"}`}
          tone={statusTone(llmConfigured, llmConfigured === false)}
        />
        <StatusPill
          icon={Clock3}
          label={`Clock ${clockSkewLabel}`}
          title={vmTime ? `VM time: ${vmTime}` : undefined}
          tone={statusTone(clockSkewOk, clockSkewWarning)}
        />
        <Button
          aria-controls="inspector-panel"
          aria-expanded={!rightPanelCollapsed}
          className="desktop-panel-toggle"
          leftIcon={rightPanelCollapsed ? <PanelRightOpen aria-hidden="true" /> : <PanelRightClose aria-hidden="true" />}
          onClick={onToggleRightPanel}
          variant="outline"
        >
          {rightPanelCollapsed ? "Show details" : "Hide details"}
        </Button>
      </div>
      <Button
        aria-controls="inspector-panel"
        aria-expanded={mobileRightPanelOpen}
        className="mobile-panel-trigger"
        leftIcon={<PanelRightOpen aria-hidden="true" />}
        onClick={onOpenMobileRightPanel}
        variant="outline"
      >
        Details
      </Button>
    </header>
  );
}
