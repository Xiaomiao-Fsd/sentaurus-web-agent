import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { cn } from "../../lib/ui.js";
import { Button } from "./Button.js";

export type ToastKind = "success" | "error" | "info";

export type ToastMessage = {
  id: string;
  kind: ToastKind;
  text: string;
};

type ToastContextValue = {
  notify: (kind: ToastKind, text: string) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((kind: ToastKind, text: string) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    setToasts((current) => [...current.slice(-3), { id, kind, text }]);
    window.setTimeout(() => dismiss(id), 4500);
  }, [dismiss]);

  const value = useMemo(() => ({ dismiss, notify }), [dismiss, notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.kind] || TriangleAlert;
          return (
            <div className={cn("toast-card", `toast-card--${toast.kind}`)} key={toast.id}>
              <Icon aria-hidden="true" />
              <span>{toast.text}</span>
              <Button aria-label="Dismiss notification" className="toast-dismiss" onClick={() => dismiss(toast.id)} size="icon" variant="ghost">
                <X aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) {
    return {
      notify: () => undefined,
      dismiss: () => undefined
    } satisfies ToastContextValue;
  }
  return value;
}
