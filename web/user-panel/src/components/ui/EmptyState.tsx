export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state-title">{title}</div>
      {body ? <div>{body}</div> : null}
    </div>
  );
}
