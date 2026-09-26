import { memo } from "react";

// ---------------------------------------------------------------------------
// Winamp skin text primitives.
// Adapted from webamp (MIT, see NOTICE.md): renders text using the classic
// Winamp TEXT.BMP sprite glyphs via the `.character-<charCode>` classes in
// the vendored skin CSS. No Redux/store dependency.
// ---------------------------------------------------------------------------

function deburrChar(char: string): string {
  return char
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export const characterClassName = (char: string | number): string =>
  `character-${deburrChar(char.toString()).charCodeAt(0)}`;

export const Character = memo(function Character({
  char,
  className,
}: {
  char: string | number;
  className?: string;
}) {
  return (
    <span className={`${className || ""} character ${characterClassName(char)}`.trim()}>
      {char}
    </span>
  );
});

export const CharacterString = memo(function CharacterString({
  text,
}: {
  text: string;
}) {
  return (
    <>
      {text.split("").map((char, i) => (
        <Character key={i} char={char} />
      ))}
    </>
  );
});

// --- Marquee helpers (same math as webamp's Marquee) -------------------------

export const MARQUEE_SEPARATOR = "  ***  ";
export const MARQUEE_CHAR_WIDTH = 5;
export const MARQUEE_MAX_LENGTH = 31;

const mod = (n: number, m: number): number => ((n % m) + m) % m;

export const marqueeIsLong = (text: string): boolean =>
  text.length >= MARQUEE_MAX_LENGTH;

export const marqueeStepOffset = (text: string, step: number): number => {
  if (!marqueeIsLong(text)) return 0;
  const stepOffsetWidth = step * MARQUEE_CHAR_WIDTH;
  const stringLength = (text.length + MARQUEE_SEPARATOR.length) * MARQUEE_CHAR_WIDTH;
  return mod(stepOffsetWidth, stringLength);
};

export const marqueeLoopText = (text: string): string =>
  marqueeIsLong(text)
    ? `${text}${MARQUEE_SEPARATOR}${text}`
    : text.padEnd(MARQUEE_MAX_LENGTH, " ");
