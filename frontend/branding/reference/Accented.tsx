/* -----------------------------------------------------------------------------
   Affichez branding kit — reference component. Dependency-free: copy as is.

   Renders the brand's one serif accent word. Mark it with asterisks in your
   copy ("Your *online presence* audit.") and this sets that part in Inria
   Serif italic via the `.accent-serif` class from tokens/tailwind-v4.css.
   -------------------------------------------------------------------------- */

interface AccentedProps {
  /** Copy with the accent word(s) wrapped in asterisks: "Your *online presence* audit." */
  text: string;
}

/**
 * Sets the `*marked*` part of a display heading in the brand's accent face —
 * Inria Serif italic inside an Inter heading, the way affichez.ca writes
 * "Agence *marketing* 360".
 *
 * The marking lives in the dictionary so each language chooses its own word.
 * Unbalanced asterisks render as plain text (markers stripped) rather than
 * italicising half a sentence.
 */
export function Accented({ text }: AccentedProps) {
  const parts = text.split("*");
  if (parts.length === 1) return <>{text}</>;
  if (parts.length % 2 === 0) return <>{parts.join("")}</>;
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <em key={index} className="accent-serif">
            {part}
          </em>
        ) : (
          part
        ),
      )}
    </>
  );
}
