"use client";

/* -----------------------------------------------------------------------------
   Affichez branding kit — reference component: the brand button, all six
   variants at the three brand sizes.

   To use: copy into your app, then supply four things —
     1. `@radix-ui/react-slot` and `class-variance-authority` (npm install).
     2. `@/lib/utils` -> your own `cn()` class-merge helper.
     3. `@/components/ui/spinner` -> your own loading spinner (or delete the
        `loading` prop entirely).
     4. The colour/radius utilities below come from
        branding/tokens/tailwind-v4.css — load it first or they resolve to
        nothing.
   -------------------------------------------------------------------------- */


import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

/**
 * The affichez.ca button: a 10px-radius rectangle in Inter semibold — never a
 * pill. Orange is the one main action on a screen; everything beside it is
 * black-on-white so the orange keeps its meaning.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[color:var(--color-ring)] disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        // Primary - orange fill, white text; hover lifts to the site's
        // lighter orange, press sinks to the deep one.
        primary:
          "bg-primary text-white hover:bg-primary-hover active:bg-primary-deep",
        // Secondary - white with a black edge: the neutral partner to the
        // orange CTA.
        secondary:
          "bg-white text-ink border border-ink/25 hover:border-ink hover:bg-sand",
        // Dark - black fill, for emphasis on sand or lavender bands.
        dark: "bg-ink text-white hover:bg-ink/85",
        // Ghost - transparent, sand on hover
        ghost: "bg-transparent text-ink hover:bg-sand",
        // Link - underlined text
        link: "bg-transparent text-ink underline-offset-4 hover:underline rounded-none px-0 py-0 h-auto",
        // Danger
        danger:
          "bg-[color:var(--color-danger)] text-white hover:brightness-110",
      },
      size: {
        sm: "h-9 px-4 text-sm",
        md: "h-10 px-5 text-md",
        lg: "h-12 px-6 text-md",
      },
      block: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
      block: false,
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      block,
      asChild = false,
      loading,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, block, className }))}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <>
            {/* The button's own label already says what's happening, so the
                spinner stays silent to assistive tech. */}
            <Spinner size="xs" label={null} />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
