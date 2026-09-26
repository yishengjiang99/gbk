\version "2.24.0"
% Ground-truth OCR fixture: C major scale, ascending and descending (E4-E5).
%
% Why this melody: the recognizer's staff-line peak detection merges line
% peaks when many noteheads cluster in adjacent staff positions (their ink
% bridges the projection peaks, biasing line centers and breaking staff-line
% suppression). A scale spreads noteheads evenly across all staff positions
% (each line/space used 1-2 times), which is what the current conservative
% recognizer can handle. C major, 4/4, all quarter notes (the recognizer
% assumes C major and quarter-note timing).
%
% Rendered with: lilypond --png -dresolution=200 -o c-scale c-scale.ly
% That single command emits BOTH c-scale.png and c-scale.midi from this
% one source, which is what guarantees the pair matches by construction.
% Afterwards the .midi is renamed to .mid and the PNG is cropped to its
% ink bounds plus a wide margin (a tight crop trips the recognizer's
% staff-spacing clamp, which expects photo-like framing).
\header {
  tagline = ##f
}
\paper {
  indent = 0
  page-count = 1
  top-margin = 18\mm
  bottom-margin = 18\mm
  left-margin = 18\mm
  right-margin = 18\mm
}
melody = {
  \clef treble
  \key c \major
  \time 4/4
  % Stemless noteheads: the current recognizer's notehead filter rejects
  % tall head+stem components, so the fixture uses stemless quarters.
  \omit Stem
  % Slightly smaller noteheads: the recognizer's notehead size window
  % (area <= 0.95 * spacing^2) is tuned for smaller heads than LilyPond's
  % default, so shrink two steps to land inside it.
  \override NoteHead.font-size = #-2
  e'4 f' g' a' | b' c'' d'' e'' | d'' c'' b' a' | g' f' e'
  \bar "|."
}
\score {
  \new Staff \melody
  \layout { }
  \midi { \tempo 4 = 100 }
}
