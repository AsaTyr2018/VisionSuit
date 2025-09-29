import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import type { CuratorApplication } from '../types/api';

const formatter = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

interface CuratorApplicationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (message: string) => Promise<void>;
  isSubmitting: boolean;
  application: CuratorApplication | null;
  error?: string | null;
}

export const CuratorApplicationDialog = ({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting,
  application,
  error,
}: CuratorApplicationDialogProps) => {
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setMessage('');
    setLocalError(null);
  }, [isOpen, application?.status]);

  if (!isOpen) {
    return null;
  }

  const status = application?.status ?? null;
  const submittedAt = application?.createdAt ? formatter.format(new Date(application.createdAt)) : null;
  const decidedAt = application?.decidedAt ? formatter.format(new Date(application.decidedAt)) : null;
  const decisionNote = application?.decisionReason?.trim() ? application.decisionReason.trim() : null;
  const decidedBy = application?.decidedBy?.displayName ?? null;
  const canSubmit = status === null || status === 'REJECTED';
  const displayError = localError ?? error ?? null;

  const statusSummary = useMemo(() => {
    if (status === 'PENDING') {
      return 'Your curator application is in the review queue. The admin team will reach out once a decision is made.';
    }
    if (status === 'APPROVED') {
      return 'Your curator application has been approved. Refresh the dashboard to unlock upload and curation tools.';
    }
    if (status === 'REJECTED') {
      return 'Your previous curator application was reviewed. Update your message with more context before trying again.';
    }
    return 'Share your motivation for joining the curator team. Include focus areas, moderation experience, or showcase links.';
  }, [status]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || isSubmitting) {
      return;
    }

    const trimmed = message.trim();
    if (trimmed.length < 40) {
      setLocalError('Describe your experience or goals in at least 40 characters.');
      return;
    }

    try {
      await onSubmit(trimmed);
      setMessage('');
      setLocalError(null);
    } catch (submitError) {
      setLocalError(submitError instanceof Error ? submitError.message : 'Application submission failed.');
    }
  };

  return (
    <div className="modal curator-application-dialog" role="dialog" aria-modal="true" aria-labelledby="curator-application-title">
      <div className="modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal__content">
        <header className="modal__header">
          <h2 id="curator-application-title">Curator application</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </header>
        <div className="modal__body curator-application-dialog__body">
          <p className="curator-application-dialog__summary">{statusSummary}</p>

          {status === 'PENDING' ? (
            <section className="curator-application-dialog__panel" aria-live="polite">
              <h3>Application received</h3>
              <p>
                Submitted {submittedAt ? <strong>{submittedAt}</strong> : 'recently'}. You can close this window and continue browsing while we review
                your request.
              </p>
              <p className="curator-application-dialog__note">Need to tweak something? Reach out to support to update pending requests.</p>
            </section>
          ) : null}

          {status === 'APPROVED' ? (
            <section className="curator-application-dialog__panel" aria-live="polite">
              <h3>Approved</h3>
              <p>
                Decision posted {decidedAt ? <strong>{decidedAt}</strong> : 'recently'}
                {decidedBy ? <> by <strong>{decidedBy}</strong></> : null}.
              </p>
              {decisionNote ? <p className="curator-application-dialog__note">{decisionNote}</p> : null}
              <p>Reload the dashboard or sign back in to see curator menus.</p>
            </section>
          ) : null}

          {status === 'REJECTED' ? (
            <section className="curator-application-dialog__panel" aria-live="polite">
              <h3>Feedback</h3>
              <p>
                Reviewed {decidedAt ? <strong>{decidedAt}</strong> : 'recently'}
                {decidedBy ? <> by <strong>{decidedBy}</strong></> : null}.
              </p>
              {decisionNote ? <p className="curator-application-dialog__note">{decisionNote}</p> : null}
            </section>
          ) : null}

          {canSubmit ? (
            <form className="curator-application-dialog__form" onSubmit={handleSubmit} noValidate>
              <label className="form-field">
                <span>Why should we promote you to curator?</span>
                <textarea
                  rows={5}
                  value={message}
                  onChange={(event) => setMessage(event.currentTarget.value)}
                  placeholder="Share your moderation experience, curator focus, or portfolio links."
                  disabled={isSubmitting}
                  required
                />
              </label>
              {displayError ? <p className="form-error">{displayError}</p> : null}
              <div className="modal__actions">
                <button type="button" className="button" onClick={onClose} disabled={isSubmitting}>
                  Close
                </button>
                <button type="submit" className="button button--primary" disabled={isSubmitting}>
                  {isSubmitting ? 'Submitting…' : status === 'REJECTED' ? 'Reapply' : 'Submit application'}
                </button>
              </div>
            </form>
          ) : null}

          {!canSubmit && status !== 'PENDING' ? (
            <div className="modal__actions">
              <button type="button" className="button button--primary" onClick={onClose}>
                Got it
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
