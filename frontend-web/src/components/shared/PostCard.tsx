'use client';

import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { displayName, timeAgo, type Post, type PostComment } from '@/utils/types';

interface PostCardProps {
  post: Post;
  currentUserId: string;
  onToggleLike: (post: Post) => void;
  onDelete: (post: Post) => void;
  loadComments: (postId: string) => Promise<PostComment[]>;
  addComment: (postId: string, body: string) => Promise<PostComment | null>;
}

export function PostCard({ post, currentUserId, onToggleLike, onDelete, loadComments, addComment }: PostCardProps) {
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<PostComment[]>([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [commentCount, setCommentCount] = useState(post.comment_count);

  async function toggleComments() {
    const next = !showComments;
    setShowComments(next);
    if (next && comments.length === 0) {
      setLoadingComments(true);
      setComments(await loadComments(post.id));
      setLoadingComments(false);
    }
  }

  async function submitComment() {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    const created = await addComment(post.id, body);
    setPosting(false);
    if (created) {
      setComments((prev) => [...prev, created]);
      setCommentCount((n) => n + 1);
      setDraft('');
    }
  }

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="flex items-center gap-3">
        <Avatar src={post.author?.avatar_url} name={displayName(post.author)} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{displayName(post.author)}</p>
          <p className="text-xs text-slate-500">
            {post.author?.username ? `@${post.author.username} · ` : ''}
            {timeAgo(post.created_at)}
          </p>
        </div>
        {post.user_id === currentUserId && (
          <button type="button" className="text-sm text-slate-400 hover:text-red-600" onClick={() => onDelete(post)}>
            Delete
          </button>
        )}
      </header>

      {post.body && <p className="mt-3 whitespace-pre-wrap break-words text-[15px]">{post.body}</p>}

      {post.media_urls.length > 0 && (
        <div className={`mt-3 grid gap-1 overflow-hidden rounded-lg ${post.media_urls.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {post.media_urls.map((url) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={url} src={url} alt="" loading="lazy" className="max-h-96 w-full object-cover" />
          ))}
        </div>
      )}

      <footer className="mt-3 flex items-center gap-4 border-t border-slate-100 pt-2 text-sm dark:border-slate-800">
        <button
          type="button"
          onClick={() => onToggleLike(post)}
          className={`flex items-center gap-1 rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800 ${post.liked_by_me ? 'font-semibold text-brand-600' : 'text-slate-600'}`}
          aria-pressed={post.liked_by_me}
        >
          {post.liked_by_me ? '👍' : '👍🏻'} {post.like_count}
        </button>
        <button type="button" onClick={() => void toggleComments()} className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800">
          💬 {commentCount}
        </button>
      </footer>

      {showComments && (
        <div className="mt-3 space-y-3">
          {loadingComments && <p className="text-sm text-slate-500">Loading comments…</p>}
          {comments.map((comment) => (
            <div key={comment.id} className="flex gap-2">
              <Avatar src={comment.author?.avatar_url} name={displayName(comment.author)} size={28} />
              <div className="rounded-2xl bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800">
                <span className="font-semibold">{displayName(comment.author)}</span>
                <p className="whitespace-pre-wrap break-words">{comment.body}</p>
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submitComment();
                }
              }}
              maxLength={1000}
              placeholder="Write a comment…"
              className="h-9 flex-1 rounded-full border border-slate-300 bg-white px-4 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900"
            />
            <Button size="sm" loading={posting} onClick={() => void submitComment()} disabled={!draft.trim()}>
              Post
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
