import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/ui.js";

const buttonVariants = cva("ui-button", {
  variants: {
    variant: {
      default: "ui-button--default",
      outline: "ui-button--outline",
      secondary: "ui-button--secondary",
      ghost: "ui-button--ghost",
      link: "ui-button--link",
      destructive: "ui-button--destructive"
    },
    size: {
      default: "ui-button--size-default",
      sm: "ui-button--size-sm",
      lg: "ui-button--size-lg",
      icon: "ui-button--size-icon"
    }
  },
  defaultVariants: {
    variant: "default",
    size: "default"
  }
});

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
    leftIcon?: ReactNode;
    rightIcon?: ReactNode;
  };

export function Button({
  className,
  children,
  disabled,
  loading = false,
  leftIcon,
  rightIcon,
  size,
  type = "button",
  variant,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      type={type}
      {...props}
    >
      {loading ? <Loader2 aria-hidden="true" className="ui-button__spinner" /> : leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}
