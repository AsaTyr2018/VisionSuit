import { useCallback, useMemo, useState } from 'react';
import type { FormEvent, ChangeEvent } from 'react';

import type { AssetComment } from '../types/api';

interface CommentSectionProps {
  anchorId: string;
  title?: string;
  comments: AssetComment[];
  isLoading: boolean;
  isSubmitting?: boolean;
  error?: string | null;
  onRetry?: () => Promise<void> | void;
  onSubmit?: (content: string) => Promise<void>;
  onToggleLike?: (comment: AssetComment) => Promise<void> | void;
  likeMutationId?: string | null;
  canComment: boolean;
  canLike: boolean;
  emptyLabel?: string;
}

const formatTimestamp = (value: string) =>
  new Date(value).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

export const CommentSection = ({
  anchorId,
  title = 'Comments',
  comments,
  isLoading,
  isSubmitting = false,
  error,
  onRetry,
  onSubmit,
  onToggleLike,
  likeMutationId,
  canComment,
  canLike,
  emptyLabel = 'No comments yet.',
}: CommentSectionProps) => {
  const [draft, setDraft] = useState('');
  const disableForm = !canComment || !onSubmit;
  const placeholder = disableForm
    ? 'Sign in to join the conversation.'
    : 'Share your feedback with the community…';

  const sortedComments = useMemo(
    () => [...comments].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [comments],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!onSubmit || disableForm) {
        return;
      }

      const trimmed = draft.trim();
      if (!trimmed) {
        return;
      }

      try {
        await onSubmit(trimmed);
        setDraft('');
      } catch (submissionError) {
        // Parent component surfaces a detailed error message; keep the draft for editing.
        console.warn('Comment submission failed:', submissionError);
      }
    },
    [disableForm, draft, onSubmit],
  );

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
  }, []);

  const handleRetry = useCallback(() => {
    try {
      const result = onRetry?.();
      if (result && typeof result.then === 'function') {
        void result;
      }
    } catch (retryError) {
      console.warn('Comment reload failed:', retryError);
    }
  }, [onRetry]);

  return (
    <section id={anchorId} className="comment-section" aria-live="polite">
      <div className="comment-section__header">
        <h4>{title}</h4>
        {onRetry ? (
          <button type="button" className="comment-section__refresh" onClick={handleRetry} disabled={isLoading}>
            Refresh
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="comment-section__error" role="alert">
          {error}
        </p>
      ) : null}
      {isLoading ? <p className="comment-section__status">Loading comments…</p> : null}
      {!isLoading && sortedComments.length === 0 ? (
        <p className="comment-section__empty">{emptyLabel}</p>
      ) : null}
      {!isLoading && sortedComments.length > 0 ? (
        <ul className="comment-section__list">
          {sortedComments.map((comment) => {
            const createdLabel = formatTimestamp(comment.createdAt);
            const isEdited = comment.updatedAt !== comment.createdAt;
            const isMutating = likeMutationId === comment.id;
            const likeActionLabel = comment.viewerHasLiked ? 'Remove like from comment' : 'Like comment';
            const likeCountLabel = comment.likeCount === 1 ? '1 like' : `${comment.likeCount} likes`;
            const likeButtonLabel = canLike ? `${likeActionLabel} (${likeCountLabel})` : 'Sign in to like comments';

            return (
              <li key={comment.id} className="comment-section__item">
                <header className="comment-section__item-header">
                  <div>
                    <span className="comment-section__author">{comment.author.displayName}</span>
                    <time dateTime={comment.createdAt}>{createdLabel}</time>
                    {isEdited ? <span className="comment-section__edited">Edited</span> : null}
                  </div>
                  <button
                    type="button"
                    className={`comment-section__like${comment.viewerHasLiked ? ' comment-section__like--active' : ''}`}
                    onClick={() => {
                      if (!onToggleLike) {
                        return;
                      }
                      void onToggleLike(comment);
                    }}
                    disabled={!canLike || !onToggleLike || isMutating}
                    aria-pressed={comment.viewerHasLiked}
                    aria-label={likeButtonLabel}
                    title={likeButtonLabel}
                  >
                    <span aria-hidden="true">♥</span>
                    <span aria-hidden="true">{comment.likeCount}</span>
                    <span className="sr-only">{likeCountLabel}</span>
                  </button>
                </header>
                <p className="comment-section__content">{comment.content}</p>
              </li>
            );
          })}
        </ul>
      ) : null}
      <form className="comment-section__form" onSubmit={handleSubmit}>
        <label className="comment-section__input">
          <span className="sr-only">Add a comment</span>
          <textarea
            value={draft}
            onChange={handleChange}
            placeholder={placeholder}
            disabled={disableForm || isSubmitting}
            rows={3}
          />
        </label>
        <div className="comment-section__form-footer">
          {!canComment ? <p className="comment-section__hint">Sign in to comment.</p> : null}
          <button type="submit" disabled={disableForm || isSubmitting}>
            {isSubmitting ? 'Posting…' : 'Post comment'}
          </button>
        </div>
      </form>
    </section>
  );
};
