import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { User } from '../types/api';

export type AsyncActionResult = { ok: true } | { ok: false; message: string };

type UserCreationStep = 'account' | 'profile' | 'review';

interface UserCreationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    email: string;
    displayName: string;
    password: string;
    role: User['role'];
    bio?: string;
  }) => Promise<AsyncActionResult>;
  isSubmitting: boolean;
  initialRole?: User['role'];
}

interface UserCreationState {
  email: string;
  displayName: string;
  role: User['role'];
  password: string;
  confirmPassword: string;
  bio: string;
}

const passwordFromCrypto = () => {
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const array = new Uint32Array(4);
    window.crypto.getRandomValues(array);
    return Array.from(array)
      .map((value) => value.toString(36))
      .join('')
      .slice(0, 12);
  }

  return Math.random().toString(36).slice(-12);
};

export const UserCreationDialog = ({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting,
  initialRole = 'CURATOR',
}: UserCreationDialogProps) => {
  const [currentStep, setCurrentStep] = useState<UserCreationStep>('account');
  const [formState, setFormState] = useState<UserCreationState>({
    email: '',
    displayName: '',
    role: initialRole,
    password: '',
    confirmPassword: '',
    bio: '',
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setCurrentStep('account');
    setFormState({
      email: '',
      displayName: '',
      role: initialRole,
      password: '',
      confirmPassword: '',
      bio: '',
    });
    setError(null);
  }, [isOpen, initialRole]);

  const steps = useMemo(
    () => [
      { id: 'account', label: 'Account basics', description: 'Email, name, and permissions' },
      { id: 'profile', label: 'Security & profile', description: 'Password and optional bio' },
      { id: 'review', label: 'Review', description: 'Confirm the new account' },
    ] as { id: UserCreationStep; label: string; description: string }[],
    [],
  );

  if (!isOpen) {
    return null;
  }

  const stepIndex = steps.findIndex((entry) => entry.id === currentStep);
  const canGoBack = stepIndex > 0 && !isSubmitting;
  const isFinalStep = currentStep === 'review';

  const handleGeneratePassword = () => {
    if (isSubmitting) {
      return;
    }
    const generated = passwordFromCrypto();
    setFormState((previous) => ({
      ...previous,
      password: generated,
      confirmPassword: generated,
    }));
  };

  const goToStep = (step: UserCreationStep) => {
    if (isSubmitting) {
      return;
    }
    setError(null);
    setCurrentStep(step);
  };

  const validateAccountStep = () => {
    const trimmedEmail = formState.email.trim();
    const trimmedName = formState.displayName.trim();

    if (!trimmedEmail || !trimmedName) {
      setError('Provide at least an email address and display name to continue.');
      return false;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('The email address looks invalid.');
      return false;
    }

    setError(null);
    return true;
  };

  const validateProfileStep = () => {
    if (!formState.password) {
      setError('Set an initial password or generate one automatically.');
      return false;
    }

    if (formState.password !== formState.confirmPassword) {
      setError('Password confirmation does not match.');
      return false;
    }

    if (formState.password.length < 8) {
      setError('Passwords should be at least 8 characters long.');
      return false;
    }

    setError(null);
    return true;
  };

  const handleNext = () => {
    if (currentStep === 'account') {
      if (validateAccountStep()) {
        setCurrentStep('profile');
      }
      return;
    }

    if (currentStep === 'profile') {
      if (validateProfileStep()) {
        setCurrentStep('review');
      }
      return;
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    if (!isFinalStep) {
      handleNext();
      return;
    }

    if (!validateAccountStep() || !validateProfileStep()) {
      return;
    }

    setError(null);
    const payload = {
      email: formState.email.trim(),
      displayName: formState.displayName.trim(),
      password: formState.password,
      role: formState.role,
      bio: formState.bio.trim() ? formState.bio.trim() : undefined,
    };

    const result = await onSubmit(payload);
    if (!result.ok) {
      setError(result.message || 'Account could not be created. Check the status banner for details.');
      return;
    }

    onClose();
  };

  return (
    <div
      className="modal user-creation-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-creation-title"
      aria-describedby="user-creation-steps"
    >
      <div className="modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal__content user-creation-dialog__content">
        <header className="modal__header">
          <h2 id="user-creation-title">Create a new account</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close dialog" disabled={isSubmitting}>
            ×
          </button>
        </header>
        <div className="user-creation-dialog__steps" id="user-creation-steps">
          {steps.map((step, index) => {
            const isActive = step.id === currentStep;
            const isComplete = index < stepIndex;
            return (
              <button
                key={step.id}
                type="button"
                className={`user-creation-dialog__step${isActive ? ' user-creation-dialog__step--active' : ''}${
                  isComplete ? ' user-creation-dialog__step--complete' : ''
                }`}
                onClick={() => goToStep(step.id)}
                disabled={isSubmitting || (!isActive && !isComplete)}
                aria-current={isActive ? 'step' : undefined}
              >
                <span className="user-creation-dialog__step-index">{index + 1}</span>
                <span className="user-creation-dialog__step-label">
                  <strong>{step.label}</strong>
                  <small>{step.description}</small>
                </span>
              </button>
            );
          })}
        </div>
        <form className="modal__body user-creation-dialog__body" onSubmit={handleSubmit}>
          {currentStep === 'account' ? (
            <div className="user-creation-dialog__section">
              <p className="user-creation-dialog__hint">
                Start with the basics—VisionSuit needs a unique email, a public-facing display name, and the right permission
                level.
              </p>
              <label className="form-field">
                <span>Email</span>
                <input
                  type="email"
                  value={formState.email}
                  onChange={(event) => setFormState((previous) => ({ ...previous, email: event.target.value }))}
                  autoComplete="email"
                  required
                  disabled={isSubmitting}
                />
              </label>
              <label className="form-field">
                <span>Display name</span>
                <input
                  value={formState.displayName}
                  onChange={(event) => setFormState((previous) => ({ ...previous, displayName: event.target.value }))}
                  autoComplete="name"
                  required
                  disabled={isSubmitting}
                />
              </label>
              <label className="form-field">
                <span>Role</span>
                <select
                  value={formState.role}
                  onChange={(event) =>
                    setFormState((previous) => ({ ...previous, role: event.target.value as User['role'] }))
                  }
                  disabled={isSubmitting}
                >
                  <option value="USER">Member — community access</option>
                  <option value="CURATOR">Curator — content curation & uploads</option>
                  <option value="ADMIN">Admin — full platform access</option>
                </select>
              </label>
            </div>
          ) : null}

          {currentStep === 'profile' ? (
            <div className="user-creation-dialog__section">
              <p className="user-creation-dialog__hint">
                Set a strong password or let VisionSuit generate one instantly. Add an optional bio to personalise the profile.
              </p>
              <div className="user-creation-dialog__password-row">
                <label className="form-field">
                  <span>Password</span>
                  <input
                    type="password"
                    value={formState.password}
                    onChange={(event) => setFormState((previous) => ({ ...previous, password: event.target.value }))}
                    autoComplete="new-password"
                    required
                    disabled={isSubmitting}
                  />
                </label>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={handleGeneratePassword}
                  disabled={isSubmitting}
                >
                  Generate secure password
                </button>
              </div>
              <label className="form-field">
                <span>Confirm password</span>
                <input
                  type="password"
                  value={formState.confirmPassword}
                  onChange={(event) => setFormState((previous) => ({ ...previous, confirmPassword: event.target.value }))}
                  autoComplete="new-password"
                  required
                  disabled={isSubmitting}
                />
              </label>
              <label className="form-field">
                <span>Bio (optional)</span>
                <textarea
                  rows={3}
                  value={formState.bio}
                  onChange={(event) => setFormState((previous) => ({ ...previous, bio: event.target.value }))}
                  disabled={isSubmitting}
                />
              </label>
            </div>
          ) : null}

          {currentStep === 'review' ? (
            <div className="user-creation-dialog__section">
              <p className="user-creation-dialog__hint">
                Double-check everything before provisioning the account. You can jump back to adjust details instantly.
              </p>
              <dl className="user-creation-dialog__summary">
                <div>
                  <dt>Email</dt>
                  <dd>{formState.email.trim()}</dd>
                </div>
                <div>
                  <dt>Display name</dt>
                  <dd>{formState.displayName.trim()}</dd>
                </div>
                <div>
                  <dt>Role</dt>
                  <dd>
                    {formState.role === 'ADMIN'
                      ? 'Admin — full access'
                      : formState.role === 'CURATOR'
                        ? 'Curator — uploads & curation'
                        : 'Member — community access'}
                  </dd>
                </div>
                <div>
                  <dt>Password</dt>
                  <dd>{'•'.repeat(Math.max(8, formState.password.length))}</dd>
                </div>
                <div>
                  <dt>Bio</dt>
                  <dd>{formState.bio.trim() || <span className="user-creation-dialog__empty">No bio provided</span>}</dd>
                </div>
              </dl>
            </div>
          ) : null}

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="modal__actions">
            <button type="button" className="button" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            {canGoBack ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => goToStep(steps[Math.max(0, stepIndex - 1)].id)}
                disabled={isSubmitting}
              >
                Back
              </button>
            ) : null}
            {!isFinalStep ? (
              <button type="button" className="button button--primary" onClick={handleNext} disabled={isSubmitting}>
                Continue
              </button>
            ) : (
              <button type="submit" className="button button--primary" disabled={isSubmitting}>
                {isSubmitting ? 'Creating account…' : 'Create account'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
