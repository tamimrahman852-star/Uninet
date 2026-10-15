'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/layouts/AppShell';
import { PostCard } from '@/components/shared/PostCard';
import { StoryBar } from '@/components/shared/StoryBar';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useAuthStore } from '@/store/authStore';
import { supabase } from '@/utils/supabaseClient';
import { displayName, type Post, type PostComment, type Story } from '@/utils/types';

const PAGE_SIZE = 10;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const POST_SELECT = '*, author:profiles(username, full_name, avatar_url)';

async function uploadImage(userId: string, file: File): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from('feed-media').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(error.message);
  return supabase.storage.from('feed-media').getPublicUrl(path).data.publicUrl;
}

export default function FeedPage() {
  const session = useAuthStore((s) => s.session);
  const profile = useAuthStore((s) => s.profile);
  const userId = session?.user.id ?? '';

  const [posts, setPosts] = useState<Post[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const attachLikes = useCallback(
    async (rows: Post[]): Promise<Post[]> => {
      if (rows.length === 0 || !userId) return rows;
      const { data } = await supabase
        .from('post_likes')
        .select('post_id')
        .eq('user_id', userId)
        .in('post_id', rows.map((p) => p.id));
      const liked = new Set((data ?? []).map((r) => r.post_id as string));
      return rows.map((p) => ({ ...p, liked_by_me: liked.has(p.id) }));
    },
    [userId],
  );

  const loadPosts = useCallback(
    async (before?: string) => {
      let query = supabase.from('posts').select(POST_SELECT).order('created_at', { ascending: false }).limit(PAGE_SIZE);
      if (before) query = query.lt('created_at', before);
      const { data, error: queryError } = await query;
      if (queryError) {
        setError('Could not load the feed. Please try again.');
        return;
      }
      const rows = await attachLikes((data ?? []) as unknown as Post[]);
      setPosts((prev) => (before ? [...prev, ...rows] : rows));
      setHasMore(rows.length === PAGE_SIZE);
    },
    [attachLikes],
  );

  const loadStories = useCallback(async () => {
    const { data } = await supabase
      .from('stories')
      .select('id, user_id, media_url, caption, created_at, author:profiles(username, full_name, avatar_url)')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(40);
    setStories((data ?? []) as unknown as Story[]);
  }, []);

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    void Promise.all([loadPosts(), loadStories()]).finally(() => setLoading(false));
  }, [userId, loadPosts, loadStories]);

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  function onPickFiles(list: FileList | null) {
    if (!list) return;
    const accepted = Array.from(list).filter((f) => f.type.startsWith('image/') && f.size <= MAX_IMAGE_BYTES);
    if (accepted.length < list.length) setError('Only images up to 8 MB are allowed.');
    setFiles((prev) => [...prev, ...accepted].slice(0, MAX_IMAGES));
    if (fileInput.current) fileInput.current.value = '';
  }

  async function publish() {
    const text = body.trim();
    if ((!text && files.length === 0) || !userId) return;
    setPublishing(true);
    setError(null);
    try {
      const mediaUrls = await Promise.all(files.map((f) => uploadImage(userId, f)));
      const { data, error: insertError } = await supabase
        .from('posts')
        .insert({ user_id: userId, body: text, media_urls: mediaUrls })
        .select(POST_SELECT)
        .single();
      if (insertError || !data) throw new Error(insertError?.message ?? 'Could not publish');
      setPosts((prev) => [{ ...(data as unknown as Post), liked_by_me: false }, ...prev]);
      setBody('');
      setFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish the post.');
    } finally {
      setPublishing(false);
    }
  }

  async function toggleLike(post: Post) {
    const liked = !post.liked_by_me;
    setPosts((prev) =>
      prev.map((p) => (p.id === post.id ? { ...p, liked_by_me: liked, like_count: Math.max(0, p.like_count + (liked ? 1 : -1)) } : p)),
    );
    const { error: likeError } = liked
      ? await supabase.from('post_likes').insert({ post_id: post.id, user_id: userId })
      : await supabase.from('post_likes').delete().eq('post_id', post.id).eq('user_id', userId);
    if (likeError) {
      setPosts((prev) => prev.map((p) => (p.id === post.id ? post : p))); // roll back
    }
  }

  async function deletePost(post: Post) {
    if (!window.confirm('Delete this post?')) return;
    const { error: deleteError } = await supabase.from('posts').delete().eq('id', post.id).eq('user_id', userId);
    if (!deleteError) setPosts((prev) => prev.filter((p) => p.id !== post.id));
  }

  async function loadComments(postId: string): Promise<PostComment[]> {
    const { data } = await supabase
      .from('post_comments')
      .select('id, post_id, user_id, body, created_at, author:profiles(username, full_name, avatar_url)')
      .eq('post_id', postId)
      .order('created_at', { ascending: true })
      .limit(100);
    return (data ?? []) as unknown as PostComment[];
  }

  async function addComment(postId: string, text: string): Promise<PostComment | null> {
    const { data, error: insertError } = await supabase
      .from('post_comments')
      .insert({ post_id: postId, user_id: userId, body: text })
      .select('id, post_id, user_id, body, created_at, author:profiles(username, full_name, avatar_url)')
      .single();
    if (insertError || !data) return null;
    return data as unknown as PostComment;
  }

  async function createStory(file: File, caption: string) {
    if (!file.type.startsWith('image/') || file.size > MAX_IMAGE_BYTES) {
      setError('Stories must be images up to 8 MB.');
      return;
    }
    try {
      const url = await uploadImage(userId, file);
      const { error: insertError } = await supabase.from('stories').insert({ user_id: userId, media_url: url, caption: caption || null });
      if (insertError) throw new Error(insertError.message);
      await loadStories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish the story.');
    }
  }

  const name = displayName(
    profile ? { username: profile.username, full_name: profile.full_name, avatar_url: profile.avatar_url } : null,
    session?.user.email ?? 'You',
  );

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl space-y-4">
        <StoryBar stories={stories} onCreate={createStory} />

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex gap-3">
            <Avatar src={profile?.avatar_url} name={name} />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={5000}
              rows={3}
              placeholder={`What's on your mind, ${name.split(' ')[0]}?`}
              className="flex-1 resize-none rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-800"
            />
          </div>
          {previews.length > 0 && (
            <div className="mt-3 grid grid-cols-4 gap-2">
              {previews.map((url, index) => (
                <div key={url} className="relative aspect-square overflow-hidden rounded-lg">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    aria-label="Remove image"
                    onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                    className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-xs text-white"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex items-center justify-between">
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => onPickFiles(e.target.files)} />
            <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()} disabled={files.length >= MAX_IMAGES}>
              🖼️ Photo
            </Button>
            <Button size="sm" loading={publishing} disabled={!body.trim() && files.length === 0} onClick={() => void publish()}>
              Post
            </Button>
          </div>
        </section>

        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-10 text-brand-600">
            <Spinner className="h-7 w-7" />
          </div>
        ) : (
          <>
            {posts.length === 0 && <p className="py-10 text-center text-slate-500">No posts yet. Share the first one!</p>}
            {posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                currentUserId={userId}
                onToggleLike={(p) => void toggleLike(p)}
                onDelete={(p) => void deletePost(p)}
                loadComments={loadComments}
                addComment={addComment}
              />
            ))}
            {hasMore && posts.length > 0 && (
              <div className="flex justify-center">
                <Button variant="secondary" onClick={() => void loadPosts(posts[posts.length - 1]?.created_at)}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
