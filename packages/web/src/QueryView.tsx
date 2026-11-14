import { useMemo } from 'react';
import { tokenize, type Range, type TokenKind } from './query';

interface Props {
  text: string;
  // Parts lit up by hovering a step.
  highlight: Range[];
  // The part the scan is on while the analysis runs, or null.
  scan: Range | null;
  onEdit?: () => void;
}

interface Piece {
  start: number;
  end: number;
  kind: TokenKind;
  hl: boolean;
  scan: boolean;
}

const overlaps = (a: number, b: number, r: Range) => a < r[1] && b > r[0];

// Cut tokens at highlight and scan edges, so each piece is wholly in or out.
function pieces(text: string, highlight: Range[], scan: Range | null): Piece[] {
  const marks = scan ? [...highlight, scan] : highlight;
  const cuts = new Set(marks.flat());
  const out: Piece[] = [];
  for (const t of tokenize(text)) {
    const inner = [...cuts].filter((c) => c > t.start && c < t.end).sort((a, b) => a - b);
    const edges = [t.start, ...inner, t.end];
    for (let i = 0; i < edges.length - 1; i++) {
      const [a, b] = [edges[i], edges[i + 1]];
      out.push({
        start: a,
        end: b,
        kind: t.kind,
        hl: highlight.some((r) => overlaps(a, b, r)),
        scan: !!scan && overlaps(a, b, scan),
      });
    }
  }
  return out;
}

// The query as read-only code: tokens styled, the scanned or hovered part underlined in the accent.
export function QueryView({ text, highlight, scan, onEdit }: Props) {
  const parts = useMemo(() => pieces(text, highlight, scan), [text, highlight, scan]);
  const editable = !!onEdit;
  return (
    <pre
      className={editable ? 'qview editable' : 'qview'}
      aria-label={editable ? 'Analyzed query. Select to edit.' : 'Query being analyzed'}
      role={editable ? 'button' : undefined}
      tabIndex={editable ? 0 : undefined}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (editable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onEdit();
        }
      }}
    >
      <code>
        {parts.map((p) => (
          <span key={p.start} className={['t', p.kind, p.hl && 'hl', p.scan && 'scan'].filter(Boolean).join(' ')}>
            {text.slice(p.start, p.end)}
          </span>
        ))}
      </code>
    </pre>
  );
}

// Read-only code in the same token styles, for the rewritten query.
export function Code({ text }: { text: string }) {
  const parts = useMemo(() => pieces(text, [], null), [text]);
  return (
    <pre className="code">
      <code>
        {parts.map((p) => (
          <span key={p.start} className={`t ${p.kind}`}>
            {text.slice(p.start, p.end)}
          </span>
        ))}
      </code>
    </pre>
  );
}
