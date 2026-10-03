import { useEffect, useState } from 'react';

import { useAuth } from '@/context/auth';
import { ADMIN_ONLY_NOTICE } from '@/lib/admin-gate';
import {
  cleanBusinessSettings,
  type BusinessSettings,
  updateBusinessSettings,
  watchBusinessSettings,
} from '@/lib/business-settings';
import { NoticeModal } from '@/pages/bread-types';

/**
 * The business details printed on every receipt.
 *
 * Same edit-mode / review-then-confirm workflow as every other dashboard-owned
 * list (Bread Types, Areas & Trucks, Agents) — one editing pattern across the
 * whole dashboard, not two. It matters more here than it looks: these three
 * strings go straight onto printed paper, and a typo in the contact number is
 * only noticed by a customer trying to ring it.
 *
 * Unlike those pages there is nothing to add, remove or reorder — one document
 * with three fields — so a "change" is just a field whose saved value differs,
 * and the review lists them one per field.
 */

const BLANK_DRAFT: BusinessSettings = { name: '', contactNumber: '', receiptEndingMessage: '' };

const FIELDS: { key: keyof BusinessSettings; label: string }[] = [
  { key: 'name', label: 'Business name' },
  { key: 'contactNumber', label: 'Contact number' },
  { key: 'receiptEndingMessage', label: 'Receipt ending message' },
];

function isValidDraft(draft: BusinessSettings) {
  return (
    draft.name.trim().length > 0 &&
    draft.contactNumber.trim().length > 0 &&
    draft.receiptEndingMessage.trim().length > 0
  );
}

type Change = { key: keyof BusinessSettings; label: string; from: string; to: string };

export function SettingsPage() {
  const { isAdmin } = useAuth();

  // undefined = still loading; null = doc doesn't exist yet (first time here).
  const [settings, setSettings] = useState<BusinessSettings | null | undefined>(undefined);
  useEffect(() => watchBusinessSettings(setSettings), []);

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<BusinessSettings>(BLANK_DRAFT);
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loading = settings === undefined;

  function enterEditMode() {
    if (!isAdmin) {
      setNotice(ADMIN_ONLY_NOTICE);
      return;
    }
    setDraft(settings ?? BLANK_DRAFT);
    setEditMode(true);
  }

  function discardChanges() {
    setEditMode(false);
    setReviewing(false);
  }

  // Compared against what will actually be *stored*, not what was typed — see
  // cleanBusinessSettings. Retyping the same text with a stray trailing space
  // is not a change, and shouldn't be listed as one.
  const cleaned = cleanBusinessSettings(draft);
  const saved = settings ?? BLANK_DRAFT;
  const changes: Change[] = FIELDS.flatMap((field) =>
    cleaned[field.key] === saved[field.key]
      ? []
      : [{ key: field.key, label: field.label, from: saved[field.key], to: cleaned[field.key] }],
  );

  function handleReviewClick() {
    if (changes.length === 0) {
      setNotice('No changes to review.');
      return;
    }
    setReviewing(true);
  }

  async function handleConfirm() {
    // The account can be demoted by another administrator while this page sits
    // open in edit mode. The rules would refuse the write anyway; catching it
    // here says why, instead of "could not save".
    if (!isAdmin) {
      setReviewing(false);
      setNotice(ADMIN_ONLY_NOTICE);
      return;
    }
    setSubmitting(true);
    try {
      await updateBusinessSettings(draft);
      const count = changes.length;
      discardChanges();
      setNotice(`${count} change${count === 1 ? '' : 's'} saved.`);
    } catch {
      setNotice('Could not save. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dashboard-page-fade">
      <div className="page-header">
        <h1>Settings</h1>
        <div className="page-header-actions">
          {editMode ? (
            <>
              <button type="button" className="btn-secondary" onClick={discardChanges} disabled={submitting}>
                Discard changes
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleReviewClick}
                disabled={!isValidDraft(draft) || submitting}>
                Review changes
              </button>
            </>
          ) : (
            <button type="button" className="btn-secondary" onClick={enterEditMode} disabled={loading}>
              Edit
            </button>
          )}
        </div>
      </div>

      {notice && <NoticeModal message={notice} onClose={() => setNotice(null)} />}

      <p className="hint catalog-hint" style={{ textAlign: 'left' }}>
        These appear on every printed receipt: the business name at the top, the contact number near the bottom, and
        the ending message last — on every receipt, a sale or a return alike.
      </p>

      {loading ? (
        <p className="hint">Loading…</p>
      ) : editMode ? (
        <div className="settings-form">
          <label className="field">
            <span>Business name</span>
            <input
              type="text"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Contact number</span>
            <input
              type="text"
              value={draft.contactNumber}
              onChange={(event) => setDraft((current) => ({ ...current, contactNumber: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Receipt ending message</span>
            <textarea
              rows={4}
              value={draft.receiptEndingMessage}
              onChange={(event) =>
                setDraft((current) => ({ ...current, receiptEndingMessage: event.target.value }))
              }
            />
            <span className="hint" style={{ textAlign: 'left', fontWeight: 400 }}>
              Press Enter for a new line — each line prints centred on its own line. A line longer than the paper
              (32 characters) wraps by itself.
            </span>
          </label>
        </div>
      ) : (
        <div className="settings-form">
          <SettingsRow label="Business name" value={settings?.name} />
          <SettingsRow label="Contact number" value={settings?.contactNumber} />
          <SettingsRow label="Receipt ending message" value={settings?.receiptEndingMessage} multiline />
        </div>
      )}

      {reviewing && (
        <ReviewChangesModal
          changes={changes}
          submitting={submitting}
          onConfirm={() => void handleConfirm()}
          onClose={() => setReviewing(false)}
        />
      )}
    </div>
  );
}

function SettingsRow({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string | undefined;
  multiline?: boolean;
}) {
  return (
    <div className="settings-row">
      <span className="settings-row-label">{label}</span>
      {/* pre-wrap so the saved line breaks show here as they will on the
          receipt — HTML would otherwise collapse them into one line and the
          page would disagree with the paper. */}
      <span style={multiline ? { whiteSpace: 'pre-wrap' } : undefined}>{value || '—'}</span>
    </div>
  );
}

function ReviewChangesModal({
  changes,
  submitting,
  onConfirm,
  onClose,
}: {
  changes: Change[];
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wide" onClick={(event) => event.stopPropagation()}>
        <h2>Review changes</h2>

        <p className="modal-warning">
          Every receipt printed from now on uses these. Receipts already printed are unaffected, and a phone picks the
          new details up the next time it has signal.
        </p>

        <div className="review-list">
          {changes.map((change) => (
            <div key={change.key} className="review-item">
              <h3>{change.label}</h3>
              {/* Stacked rather than "old → new" on one line: the ending
                  message runs to several lines and would be unreadable
                  squeezed beside its own replacement. */}
              <div className="review-value">
                {change.from ? <s>{change.from}</s> : <em>Not set</em>}
                <span>{change.to}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Close
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm} disabled={submitting}>
            {submitting ? 'Saving…' : `Confirm ${changes.length} change${changes.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
