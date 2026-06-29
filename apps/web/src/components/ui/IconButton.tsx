import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { Button, type ButtonProps } from "./Button.js";

type IconButtonProps = Omit<ButtonProps, "children" | "leftIcon" | "rightIcon" | "size"> & {
  icon: ComponentType<LucideProps>;
  label: string;
};

export function IconButton({ icon: Icon, label, title, ...props }: IconButtonProps) {
  return (
    <Button aria-label={label} size="icon" title={title || label} {...props}>
      <Icon aria-hidden="true" />
    </Button>
  );
}
