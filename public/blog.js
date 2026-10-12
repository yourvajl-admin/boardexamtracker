const postsContainer = document.querySelector('#blog-posts');
const blogStatus = document.querySelector('#blog-status');
const loadMoreButton = document.querySelector('#blog-load-more');
let loadedPosts = 0;

function formatPostDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-PH', { dateStyle: 'long' }).format(date);
}

function makePostCard(post) {
  const article = document.createElement('article');
  article.className = 'blog-post-card';
  article.id = `post-${post.id}`;
  const top = document.createElement('div');
  top.className = 'blog-post-topline';
  const label = document.createElement('span');
  const date = document.createElement('time');
  label.textContent = 'BOARD EXAM UPDATE';
  date.dateTime = new Date(post.updatedAt).toISOString();
  date.textContent = formatPostDate(post.updatedAt);
  top.append(label, date);
  article.append(top);
  if (post.imageUrl) {
    const image = document.createElement('img');
    image.className = 'blog-post-image';
    image.src = post.imageUrl;
    image.alt = `${post.title} photo`;
    image.loading = 'lazy';
    image.decoding = 'async';
    article.append(image);
  }
  const title = document.createElement('h2');
  title.textContent = post.title;
  const body = document.createElement('p');
  body.className = 'blog-post-body';
  body.textContent = post.body;
  const share = document.createElement('a');
  share.className = 'blog-post-anchor';
  share.href = `#post-${encodeURIComponent(post.id)}`;
  share.textContent = 'Link to post';
  article.append(title, body, share);
  return article;
}

async function loadPosts() {
  loadMoreButton.disabled = true;
  loadMoreButton.textContent = 'Loading…';
  try {
    const response = await fetch(`/api/blog/posts?offset=${loadedPosts}`, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Posts could not be loaded. Please try again.');
    data.posts.forEach((post) => postsContainer.append(makePostCard(post)));
    loadedPosts += data.posts.length;
    blogStatus.textContent = loadedPosts
      ? `${loadedPosts} ${loadedPosts === 1 ? 'post' : 'posts'} published.`
      : 'There are no posts yet. Check back for updates.';
    loadMoreButton.hidden = !data.hasMore;
    if (data.hasMore) loadMoreButton.innerHTML = 'Load more posts <span aria-hidden="true">↓</span>';
    if (window.location.hash.startsWith('#post-')) {
      requestAnimationFrame(() => document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView());
    }
  } catch (error) {
    blogStatus.textContent = error.message;
    loadMoreButton.hidden = loadedPosts === 0;
  } finally {
    loadMoreButton.disabled = false;
    if (loadMoreButton.hidden) loadMoreButton.textContent = 'Load more posts';
  }
}

loadMoreButton.addEventListener('click', loadPosts);
document.querySelector('.menu-toggle').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const navigation = document.querySelector('#primary-nav');
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  navigation.classList.toggle('open', open);
});
document.querySelector('#primary-nav').addEventListener('click', (event) => {
  if (!event.target.closest('a')) return;
  document.querySelector('#primary-nav').classList.remove('open');
  document.querySelector('.menu-toggle').setAttribute('aria-expanded', 'false');
});

loadPosts();
