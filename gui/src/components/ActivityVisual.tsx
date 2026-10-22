import type { ActivityKind } from '../lib/api';

/**
 * ActivityVisual — the heart of Ronin Code.
 *
 * While the agent works, activity is communicated ONLY visually:
 * an ambient, breathing presence plus a small motif per kind of work.
 * There is deliberately no text here — no labels, no status lines.
 */

function ReadingMotif() {
  return (
    <div className="motif motif--reading">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="tile" style={{ animationDelay: `${i * 0.14}s` }}>
          <span className="tile-scan" style={{ animationDelay: `${i * 0.28}s` }} />
          <span className="tile-line" style={{ width: `${78 - i * 7}%` }} />
          <span className="tile-line tile-line--short" style={{ width: `${54 - i * 4}%` }} />
          <span className="tile-line" style={{ width: `${66 - i * 6}%` }} />
          <span className="tile-line tile-line--short" style={{ width: `${40 - i * 3}%` }} />
          <span className="tile-line" style={{ width: `${58 - i * 5}%` }} />
        </span>
      ))}
    </div>
  );
}

function WritingMotif() {
  return (
    <div className="motif motif--writing">
      {[88, 64, 76, 46, 70].map((w, i) => (
        <span key={i} className="write-row">
          <span
            className="write-fill"
            style={{ width: `${w}%`, animationDelay: `${i * 0.32}s` }}
          />
        </span>
      ))}
    </div>
  );
}

function EditingMotif() {
  return (
    <div className="motif motif--editing">
      {[78, 52, 84, 60, 72].map((w, i) => (
        <span key={i} className="edit-row">
          <span className="edit-line" style={{ width: `${w}%` }} />
          {(i === 1 || i === 3) && <span className="edit-sweep" style={{ animationDelay: `${i * 0.35}s` }} />}
        </span>
      ))}
    </div>
  );
}

function TerminalMotif() {
  return (
    <div className="motif motif--terminal">
      <span className="term-chrome">
        <i /> <i /> <i />
      </span>
      <span className="term-eq">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => (
          <span
            key={i}
            className="eq-bar"
            style={{ animationDelay: `${i * 0.11}s`, animationDuration: `${0.7 + (i % 3) * 0.18}s` }}
          />
        ))}
      </span>
    </div>
  );
}

function SearchingMotif() {
  return (
    <div className="motif motif--searching">
      <span className="radar">
        <span className="radar-sweep" />
        <span className="radar-ring" />
        <span className="radar-ring radar-ring--outer" />
        <span className="radar-dot radar-dot--a" />
        <span className="radar-dot radar-dot--b" />
      </span>
      <span className="search-tiles">
        {[0, 1, 2].map((i) => (
          <span key={i} className="tile tile--mini" style={{ animationDelay: `${i * 0.18}s` }}>
            <span className="tile-line" style={{ width: '70%' }} />
            <span className="tile-line tile-line--short" style={{ width: '44%' }} />
          </span>
        ))}
      </span>
    </div>
  );
}

function PlanningMotif() {
  return (
    <div className="motif motif--planning">
      {[0, 1, 2].map((i) => (
        <span key={i} className="plan-step" style={{ animationDelay: `${i * 0.45}s` }}>
          <span className="plan-node" style={{ animationDelay: `${i * 0.45}s` }} />
          <span className="plan-bar" style={{ width: `${72 - i * 12}%`, animationDelay: `${i * 0.45}s` }} />
        </span>
      ))}
      <span className="plan-link" />
    </div>
  );
}

function ReviewingMotif() {
  return (
    <div className="motif motif--reviewing">
      <span className="review-beam" />
      {[76, 54, 68, 44].map((w, i) => (
        <span key={i} className="review-row">
          <span className="review-line" style={{ width: `${w}%` }} />
          <span className="review-check" style={{ animationDelay: `${-2.45 + i * 0.38}s` }} />
        </span>
      ))}
    </div>
  );
}

function ThinkingMotif() {
  return (
    <div className="motif motif--thinking">
      <span className="think-core" />
      <span className="orbit orbit--a"><i /></span>
      <span className="orbit orbit--b"><i /></span>
      <span className="orbit orbit--c"><i /></span>
    </div>
  );
}

const MOTIFS: Record<ActivityKind, () => JSX.Element> = {
  planning: PlanningMotif,
  thinking: ThinkingMotif,
  reading: ReadingMotif,
  writing: WritingMotif,
  editing: EditingMotif,
  terminal: TerminalMotif,
  searching: SearchingMotif,
  reviewing: ReviewingMotif,
};

export default function ActivityVisual({ kinds }: { kinds: ActivityKind[] }) {
  const unique = Array.from(new Set(kinds));
  const shown = unique.length > 0 ? unique : (['thinking'] as ActivityKind[]);

  return (
    <div className="activity" aria-hidden="true">
      <div className="activity-orb">
        <span className="orb-halo" />
        <span className="orb-core" />
        <span className="orb-particle orb-particle--1" />
        <span className="orb-particle orb-particle--2" />
        <span className="orb-particle orb-particle--3" />
      </div>
      <div className="activity-motifs">
        {shown.map((kind) => {
          const Motif = MOTIFS[kind];
          return (
            <div key={kind} className={`activity-motif activity-motif--${kind}`}>
              <Motif />
            </div>
          );
        })}
      </div>
    </div>
  );
}
