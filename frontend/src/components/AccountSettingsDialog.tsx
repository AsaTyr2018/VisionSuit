import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import { api } from '../lib/api';
import type { User } from '../types/api';

interface AccountSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  token: string;
  user: User;
  onProfileSaved?: (message: string) => void;
  onPasswordChanged?: (message: string) => void;
  onRefreshUser?: () => Promise<void>;
}

type StatusMessage = { type: 'success' | 'error'; message: string } | null;

export const AccountSettingsDialog = ({
  isOpen,
  onClose,
  token,
  user,
  onProfileSaved,
  onPasswordChanged,
  onRefreshUser,
}: AccountSettingsDialogProps) => {
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [profileStatus, setProfileStatus] = useState<StatusMessage>(null);
  const [avatarUploadStatus, setAvatarUploadStatus] = useState<StatusMessage>(null);
  const [passwordStatus, setPasswordStatus] = useState<StatusMessage>(null);
  const [isProfileSubmitting, setIsProfileSubmitting] = useState(false);
  const [isPasswordSubmitting, setIsPasswordSubmitting] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

  const extractMessage = (error: unknown, fallback: string) => {
    if (error instanceof Error) {
      try {
        const parsed = JSON.parse(error.message) as { message?: string } | null;
        if (parsed && typeof parsed.message === 'string' && parsed.message.length > 0) {
          return parsed.message;
        }
      } catch {
        // Ignore JSON parse issues and fall back to the default error message.
      }
      return error.message;
    }
    return fallback;
  };

  useEffect(() => {
    if (!isOpen) {
      setProfileStatus(null);
      setAvatarUploadStatus(null);
      setPasswordStatus(null);
      setIsProfileSubmitting(false);
      setIsPasswordSubmitting(false);
      setIsUploadingAvatar(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      if (avatarInputRef.current) {
        avatarInputRef.current.value = '';
      }
      return;
    }

    setDisplayName(user.displayName);
    setBio(user.bio ?? '');
    setAvatarUrl(user.avatarUrl ?? '');
    setProfileStatus(null);
    setAvatarUploadStatus(null);
    setPasswordStatus(null);
    setIsUploadingAvatar(false);
    if (avatarInputRef.current) {
      avatarInputRef.current.value = '';
    }
  }, [isOpen, user]);

  if (!isOpen) {
    return null;
  }

  const handleAvatarFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setAvatarUploadStatus(null);
    setProfileStatus(null);

    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarUploadStatus({ type: 'error', message: 'Avatar must be 5 MB or smaller.' });
      event.target.value = '';
      return;
    }

    const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowedTypes.has(file.type)) {
      setAvatarUploadStatus({ type: 'error', message: 'Avatar must be a PNG, JPG, or WebP image.' });
      event.target.value = '';
      return;
    }

    setIsUploadingAvatar(true);

    try {
      const response = await api.uploadAvatar(token, user.id, file);
      setAvatarUrl(response.user.avatarUrl ?? '');
      setAvatarUploadStatus({ type: 'success', message: 'Avatar updated successfully.' });

      if (onRefreshUser) {
        try {
          await onRefreshUser();
        } catch (refreshError) {
          console.error('Failed to refresh user after avatar upload', refreshError);
        }
      }
    } catch (error) {
      const message = extractMessage(error, 'Failed to upload avatar.');
      setAvatarUploadStatus({ type: 'error', message });
    } finally {
      setIsUploadingAvatar(false);
      if (avatarInputRef.current) {
        avatarInputRef.current.value = '';
      } else {
        event.target.value = '';
      }
    }
  };

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProfileStatus(null);

    const trimmedName = displayName.trim();
    if (trimmedName.length < 2) {
      setProfileStatus({ type: 'error', message: 'Display name must be at least 2 characters.' });
      return;
    }

    const normalizedBio = bio.trim();
    const nextBio = normalizedBio.length === 0 ? null : normalizedBio;
    const normalizedAvatar = avatarUrl.trim();
    const nextAvatar = normalizedAvatar.length === 0 ? null : normalizedAvatar;

    const currentBio = (user.bio ?? '').trim();
    const currentAvatar = user.avatarUrl ?? null;

    const payload: { displayName?: string; bio?: string | null; avatarUrl?: string | null } = {};

    if (trimmedName !== user.displayName) {
      payload.displayName = trimmedName;
    }

    if (nextBio !== (currentBio.length === 0 ? null : currentBio)) {
      payload.bio = nextBio;
    }

    if (nextAvatar !== currentAvatar) {
      payload.avatarUrl = nextAvatar;
    }

    if (Object.keys(payload).length === 0) {
      setProfileStatus({ type: 'error', message: 'No changes to save.' });
      return;
    }

    setIsProfileSubmitting(true);

    try {
      await api.updateOwnProfile(token, user.id, payload);
      if (onRefreshUser) {
        try {
          await onRefreshUser();
        } catch (refreshError) {
          console.error('Failed to refresh user after profile update', refreshError);
        }
      }
      setProfileStatus({ type: 'success', message: 'Profile updated successfully.' });
      onProfileSaved?.('Profile updated successfully.');
    } catch (error) {
      const message = extractMessage(error, 'Failed to update profile.');
      setProfileStatus({ type: 'error', message });
    } finally {
      setIsProfileSubmitting(false);
    }
  };

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordStatus(null);

    if (currentPassword.length < 8) {
      setPasswordStatus({ type: 'error', message: 'Enter your current password (min. 8 characters).' });
      return;
    }

    if (newPassword.length < 8) {
      setPasswordStatus({ type: 'error', message: 'New password must be at least 8 characters.' });
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordStatus({ type: 'error', message: 'New passwords do not match.' });
      return;
    }

    setIsPasswordSubmitting(true);

    try {
      await api.changePassword(token, user.id, {
        currentPassword,
        newPassword,
        confirmPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordStatus({ type: 'success', message: 'Password updated successfully.' });
      onPasswordChanged?.('Password updated successfully.');
    } catch (error) {
      const message = extractMessage(error, 'Failed to update password.');
      setPasswordStatus({ type: 'error', message });
    } finally {
      setIsPasswordSubmitting(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="account-settings-title">
      <div className="modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal__content modal__content--wide">
        <header className="modal__header">
          <h2 id="account-settings-title">Account settings</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </header>
        <div className="modal__body account-settings">
          <section className="account-settings__section">
            <h3>Profile</h3>
            <p className="account-settings__description">
              Update how other curators see you across explorers, models, and galleries.
            </p>
            <form className="account-settings__form" onSubmit={handleProfileSubmit}>
              <label className="form-field">
                <span>Display name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  minLength={2}
                  maxLength={160}
                  required
                />
              </label>
              <label className="form-field">
                <span>Bio</span>
                <textarea
                  value={bio}
                  onChange={(event) => setBio(event.target.value)}
                  maxLength={600}
                  rows={4}
                  placeholder="Share your focus, specialties, or curator notes."
                />
              </label>
              <label className="form-field">
                <span>Avatar URL</span>
                <input
                  type="url"
                  value={avatarUrl}
                  onChange={(event) => setAvatarUrl(event.target.value)}
                  autoComplete="url"
                  placeholder="https://example.com/avatar.png"
                />
              </label>
              <div className="form-field">
                <span>Upload avatar</span>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleAvatarFileChange}
                  disabled={isUploadingAvatar}
                />
                <p className="account-settings__hint">PNG, JPG, or WebP up to 5&nbsp;MB.</p>
              </div>
              {isUploadingAvatar ? (
                <p className="account-settings__status" role="status">
                  Uploading…
                </p>
              ) : avatarUploadStatus ? (
                <p
                  className={`account-settings__status account-settings__status--${avatarUploadStatus.type}`}
                  role={avatarUploadStatus.type === 'error' ? 'alert' : 'status'}
                >
                  {avatarUploadStatus.message}
                </p>
              ) : null}
              {profileStatus ? (
                <p
                  className={`account-settings__status account-settings__status--${profileStatus.type}`}
                  role={profileStatus.type === 'error' ? 'alert' : 'status'}
                >
                  {profileStatus.message}
                </p>
              ) : null}
              <div className="modal__actions account-settings__actions">
                <button type="button" className="button" onClick={onClose} disabled={isProfileSubmitting}>
                  Cancel
                </button>
                <button type="submit" className="button button--primary" disabled={isProfileSubmitting}>
                  {isProfileSubmitting ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          </section>

          <hr className="account-settings__divider" />

          <section className="account-settings__section">
            <h3>Security</h3>
            <p className="account-settings__description">
              Set a new password using your current credentials. Passwords require at least eight characters.
            </p>
            <form className="account-settings__form" onSubmit={handlePasswordSubmit}>
              <label className="form-field">
                <span>Current password</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  minLength={8}
                  required
                />
              </label>
              <div className="account-settings__grid">
                <label className="form-field">
                  <span>New password</span>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </label>
                <label className="form-field">
                  <span>Confirm new password</span>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </label>
              </div>
              {passwordStatus ? (
                <p
                  className={`account-settings__status account-settings__status--${passwordStatus.type}`}
                  role={passwordStatus.type === 'error' ? 'alert' : 'status'}
                >
                  {passwordStatus.message}
                </p>
              ) : null}
              <div className="modal__actions account-settings__actions">
                <button type="submit" className="button button--primary" disabled={isPasswordSubmitting}>
                  {isPasswordSubmitting ? 'Updating…' : 'Update password'}
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
};
