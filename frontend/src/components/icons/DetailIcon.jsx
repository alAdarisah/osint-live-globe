// Info-circle glyph for a panel row's "open detail card" button. Only used
// where the row's own headline is already a real link to the source article
// (NewsRow) and cannot double as the detail-card trigger too -- see
// IntelPanel.jsx's own note on why News gets a second button instead of the
// clickable-headline treatment Events and Officials rows use.
export default function DetailIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="7.6" r="1.15" fill="currentColor" />
      <line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
