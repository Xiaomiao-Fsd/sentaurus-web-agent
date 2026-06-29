import { Loader2 } from "lucide-react";
import { cn } from "../../lib/ui.js";

type SpinnerProps = {
  className?: string;
  label?: string;
};

export function Spinner({ className, label = "Loading" }: SpinnerProps) {
  return <Loader2 aria-label={label} className={cn("ui-spinner", className)} />;
}
