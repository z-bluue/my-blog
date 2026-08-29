/* ============================================================
 * 自建评论组件 (wjh-comments)
 * 存储: GitHub Issues (每篇文章一个 Issue, 评论为 Issue Comments)
 * 登录: 复用站内 /api/auth 的 GitHub OAuth 流程
 * ============================================================ */
(function () {
    'use strict';

    var root = document.getElementById('comments');
    if (!root || !root.classList.contains('wjh-comments')) return;

    var repo = root.getAttribute('data-repo') || 'z-bluue/my-blog';
    var label = root.getAttribute('data-label') || 'blog-comment';
    var pagePath = decodeURIComponent(location.pathname)
        .replace(/index\.html?$/, '')
        .replace(/\/+$/, '') || '/';
    var issueTitle = '评论: ' + pagePath;

    var API = 'https://api.github.com';
    var TOKEN_KEY = 'wjh-gh-comment-token';
    var USER_KEY = 'wjh-gh-comment-user';
    var ISSUE_KEY = 'wjh-gh-comment-issue:' + pagePath;
    var TOKEN_TTL = 7 * 60 * 60 * 1000; // GitHub OAuth App token 约 8 小时有效, 提前 1 小时过期
    var MSG_PREFIX = 'authorization:github:';

    var state = {
        token: null,
        user: null,
        issue: null,
        comments: [],
        posting: false
    };

    var els = {};

    /* ---------- 工具 ---------- */

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }

    function timeAgo(iso) {
        var t = new Date(iso).getTime();
        if (isNaN(t)) return '';
        var diff = Date.now() - t;
        var m = 60 * 1000;
        var h = 60 * m;
        var d = 24 * h;
        if (diff < m) return '刚刚';
        if (diff < h) return Math.floor(diff / m) + ' 分钟前';
        if (diff < d) return Math.floor(diff / h) + ' 小时前';
        if (diff < 30 * d) return Math.floor(diff / d) + ' 天前';
        return new Date(iso).toLocaleDateString('zh-CN');
    }

    function apiJSON(url, opts) {
        opts = opts || {};
        opts.headers = opts.headers || {};
        if (!opts.headers.Accept) opts.headers.Accept = 'application/vnd.github+json';
        return fetch(url, opts).then(function (res) {
            return res.json()
                .catch(function () { return null; })
                .then(function (data) {
                    if (!res.ok) {
                        var err = new Error((data && data.message) || ('GitHub API ' + res.status));
                        err.status = res.status;
                        throw err;
                    }
                    return data;
                });
        });
    }

    function loadScript(src) {
        return new Promise(function (resolve) {
            var s = document.createElement('script');
            var done = false;
            s.src = src;
            s.async = true;
            s.onload = function () { if (!done) { done = true; resolve(true); } };
            s.onerror = function () { if (!done) { done = true; resolve(false); } };
            document.head.appendChild(s);
            setTimeout(function () { if (!done) { done = true; resolve(false); } }, 10000);
        });
    }

    var markdownLib = null;
    function ensureMarkdown() {
        if (!markdownLib) {
            markdownLib = Promise.all([
                loadScript('https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js'),
                loadScript('https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js')
            ]).then(function (results) {
                if (results[0] && results[1] && window.marked && window.DOMPurify) {
                    return { marked: window.marked, purify: window.DOMPurify };
                }
                return null;
            });
        }
        return markdownLib;
    }

    function renderMarkdown(text) {
        return ensureMarkdown().then(function (lib) {
            if (!lib) {
                // CDN 加载失败时的兜底: 转义后按纯文本展示
                return escapeHtml(text).replace(/\n/g, '<br>');
            }
            try {
                var html = lib.marked.parse(text || '');
                return lib.purify.sanitize(html);
            } catch (e) {
                return escapeHtml(text).replace(/\n/g, '<br>');
            }
        });
    }

    /* ---------- 登录状态 ---------- */

    function loadStoredToken() {
        try {
            var raw = localStorage.getItem(TOKEN_KEY);
            if (!raw) return null;
            var obj = JSON.parse(raw);
            if (!obj || !obj.t || Date.now() > obj.exp) {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
                return null;
            }
            return obj.t;
        } catch (e) {
            return null;
        }
    }

    function loadStoredUser() {
        try {
            var raw = localStorage.getItem(USER_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    function fetchUser() {
        if (!state.token) return Promise.resolve(null);
        return apiJSON(API + '/user', {
            headers: { Authorization: 'Bearer ' + state.token }
        }).then(function (u) {
            state.user = {
                login: u.login,
                avatar: u.avatar_url,
                url: u.html_url
            };
            try { localStorage.setItem(USER_KEY, JSON.stringify(state.user)); } catch (e) { /* ignore */ }
            return state.user;
        }).catch(function () {
            return state.user;
        });
    }

    function clearLogin() {
        state.token = null;
        state.user = null;
        try {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
        } catch (e) { /* ignore */ }
        renderUserArea();
        renderEditorState();
    }

    function openOAuth() {
        var popup = window.open('/api/auth', 'wjh-oauth', 'width=820,height=640');
        if (!popup) {
            showError('浏览器拦截了登录窗口，请允许本站弹出窗口后重试。');
        }
    }

    window.addEventListener('message', function (e) {
        var data = e.data;
        if (typeof data !== 'string') return;

        // 登录回调页会先发送 authorizing:github, 等待我们回复来源后回传 token
        if (data === 'authorizing:github') {
            try {
                if (e.source && e.source.postMessage) {
                    e.source.postMessage('authorizing:github:ready', e.origin);
                }
            } catch (err) { /* ignore */ }
            return;
        }

        if (data.indexOf(MSG_PREFIX) === 0) {
            var rest = data.slice(MSG_PREFIX.length);
            var sep = rest.indexOf(':');
            var status = sep > -1 ? rest.slice(0, sep) : '';
            var content = sep > -1 ? rest.slice(sep + 1) : '';
            if (status === 'success') {
                try {
                    var payload = JSON.parse(content);
                    if (payload && payload.token) {
                        state.token = payload.token;
                        try {
                            localStorage.setItem(TOKEN_KEY, JSON.stringify({
                                t: payload.token,
                                exp: Date.now() + TOKEN_TTL
                            }));
                        } catch (err) { /* ignore */ }
                        fetchUser().then(function () {
                            renderUserArea();
                            renderEditorState();
                        });
                    }
                } catch (err) { /* ignore */ }
            } else {
                showError('登录失败，请重试。');
            }
        }
    });

    /* ---------- GitHub Issues 数据 ---------- */

    function findIssueByList() {
        // 通过 label 列表本地匹配标题, 最多翻 3 页 (300 个 Issue)
        var pages = [];
        for (var p = 1; p <= 3; p++) {
            pages.push(
                apiJSON(API + '/repos/' + repo + '/issues?state=all&labels=' +
                    encodeURIComponent(label) + '&per_page=100&page=' + p)
                    .catch(function () { return []; })
            );
        }
        return Promise.all(pages).then(function (lists) {
            for (var i = 0; i < lists.length; i++) {
                var list = lists[i] || [];
                for (var j = 0; j < list.length; j++) {
                    var item = list[j];
                    if (item && !item.pull_request && item.title === issueTitle) return item;
                }
            }
            return null;
        });
    }

    function findIssue() {
        // 优先使用本地缓存的 Issue 编号, 404 时回退到列表查找
        var cached = null;
        try { cached = localStorage.getItem(ISSUE_KEY); } catch (e) { /* ignore */ }
        if (cached && /^\d+$/.test(cached)) {
            return apiJSON(API + '/repos/' + repo + '/issues/' + cached)
                .then(function (issue) {
                    if (issue && !issue.pull_request && issue.title === issueTitle) return issue;
                    return findIssueByList();
                })
                .catch(function () {
                    return findIssueByList();
                });
        }
        return findIssueByList();
    }

    function createIssue() {
        return apiJSON(API + '/repos/' + repo + '/issues', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + state.token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title: issueTitle,
                body: '> 本文评论存档。文章: ' + location.href + '\n\n' +
                    '此 Issue 由自建评论组件自动创建，请勿关闭。',
                labels: [label]
            })
        }).then(function (issue) {
            try { localStorage.setItem(ISSUE_KEY, String(issue.number)); } catch (e) { /* ignore */ }
            return issue;
        });
    }

    function ensureIssue() {
        return findIssue().then(function (issue) {
            if (issue) return issue;
            return createIssue();
        });
    }

    function loadComments() {
        return findIssue().then(function (issue) {
            state.issue = issue;
            if (!issue) return [];
            return apiJSON(API + '/repos/' + repo + '/issues/' + issue.number +
                '/comments?per_page=100').catch(function () { return null; });
        });
    }

    /* ---------- 渲染 ---------- */

    function build() {
        root.innerHTML =
            '<div class="wjh-head">' +
                '<h3 class="wjh-title">评论<span class="wjh-count"></span></h3>' +
                '<div class="wjh-user"></div>' +
            '</div>' +
            '<div class="wjh-list"></div>' +
            '<div class="wjh-editor">' +
                '<textarea class="wjh-textarea" placeholder="说点什么…"></textarea>' +
                '<div class="wjh-bar">' +
                    '<span class="wjh-hint">支持 Markdown · 用 GitHub 账号评论</span>' +
                    '<button class="wjh-btn primary" type="button">发布</button>' +
                '</div>' +
                '<div class="wjh-error" hidden></div>' +
            '</div>';

        els.count = root.querySelector('.wjh-count');
        els.user = root.querySelector('.wjh-user');
        els.list = root.querySelector('.wjh-list');
        els.textarea = root.querySelector('.wjh-textarea');
        els.hint = root.querySelector('.wjh-hint');
        els.submit = root.querySelector('.wjh-btn.primary');
        els.error = root.querySelector('.wjh-error');

        els.submit.addEventListener('click', submit);
        els.textarea.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
        });
        els.textarea.addEventListener('click', function () {
            if (!state.token) openOAuth();
        });
        els.list.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('.wjh-reply') : null;
            if (!btn) return;
            var nick = btn.getAttribute('data-nick') || '';
            els.textarea.value = (els.textarea.value ? els.textarea.value.replace(/\s*$/, '') + '\n' : '') + '@' + nick + ' ';
            els.textarea.focus();
            if (!state.token) openOAuth();
        });
    }

    function renderUserArea() {
        if (!els.user) return;
        if (state.user) {
            els.user.innerHTML =
                '<img class="wjh-avatar" src="' + escapeHtml(state.user.avatar) + '" alt="">' +
                '<a class="wjh-name" href="' + escapeHtml(state.user.url) + '" target="_blank" rel="noopener noreferrer">' +
                    escapeHtml(state.user.login) +
                '</a>' +
                '<button class="wjh-btn" type="button" title="退出登录">退出</button>';
            els.user.querySelector('.wjh-btn').addEventListener('click', clearLogin);
        } else {
            els.user.innerHTML =
                '<button class="wjh-btn" type="button">' +
                    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
                        '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path>' +
                    '</svg>' +
                    '<span>GitHub 登录</span>' +
                '</button>';
            els.user.querySelector('.wjh-btn').addEventListener('click', openOAuth);
        }
    }

    function renderEditorState() {
        if (!els.textarea) return;
        if (state.token) {
            els.textarea.placeholder = '说点什么…';
            els.hint.textContent = '支持 Markdown · 以 ' + (state.user ? state.user.login : 'GitHub 账号') + ' 的身份评论';
        } else {
            els.textarea.placeholder = '点击此处使用 GitHub 账号登录后评论…';
            els.hint.textContent = '支持 Markdown · 无需注册，登录 GitHub 即可评论';
        }
    }

    function renderCount() {
        els.count.textContent = state.comments.length ? '(' + state.comments.length + ')' : '';
    }

    function renderItem(comment) {
        var user = comment.user || {};
        var item = document.createElement('div');
        item.className = 'wjh-item';
        item.innerHTML =
            '<img class="wjh-avatar" src="' + escapeHtml(user.avatar_url || '') + '" alt="" loading="lazy">' +
            '<div class="wjh-main">' +
                '<div class="wjh-meta">' +
                    '<a class="wjh-nick" href="' + escapeHtml(user.html_url || '') + '" target="_blank" rel="noopener noreferrer">' +
                        escapeHtml(user.login || '匿名') +
                    '</a>' +
                    '<span class="wjh-time">' + escapeHtml(timeAgo(comment.created_at)) + '</span>' +
                '</div>' +
                '<div class="wjh-content">' + escapeHtml(comment.body || '') + '</div>' +
                '<button class="wjh-reply" type="button" data-nick="' + escapeHtml(user.login || '') + '">回复</button>' +
            '</div>';
        renderMarkdown(comment.body).then(function (html) {
            var content = item.querySelector('.wjh-content');
            if (content) content.innerHTML = html;
        });
        return item;
    }

    function renderList() {
        if (state.comments.length === 0) {
            els.list.innerHTML = '<div class="wjh-status">还没有评论，来抢沙发吧~</div>';
        } else {
            var frag = document.createDocumentFragment();
            state.comments.forEach(function (c) {
                frag.appendChild(renderItem(c));
            });
            els.list.innerHTML = '';
            els.list.appendChild(frag);
        }
        renderCount();
    }

    function showStatus(text, retry) {
        els.list.innerHTML = '<div class="wjh-status">' + escapeHtml(text) +
            (retry ? '<div><button class="wjh-btn wjh-retry" type="button">重试</button></div>' : '') +
            '</div>';
        var btn = els.list.querySelector('.wjh-retry');
        if (btn) btn.addEventListener('click', initData);
    }

    function showError(text) {
        if (!els.error) return;
        els.error.textContent = text;
        els.error.hidden = false;
        setTimeout(function () { els.error.hidden = true; }, 4000);
    }

    /* ---------- 发布 ---------- */

    function submit() {
        if (state.posting) return;
        var text = els.textarea.value.trim();
        if (!text) {
            showError('评论内容不能为空。');
            return;
        }
        if (!state.token) {
            openOAuth();
            return;
        }
        state.posting = true;
        els.submit.disabled = true;
        els.submit.textContent = '发布中…';

        ensureIssue()
            .then(function (issue) {
                state.issue = issue;
                return apiJSON(API + '/repos/' + repo + '/issues/' + issue.number + '/comments', {
                    method: 'POST',
                    headers: {
                        Authorization: 'Bearer ' + state.token,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ body: text })
                });
            })
            .then(function (comment) {
                els.textarea.value = '';
                state.comments.push(comment);
                var item = renderItem(comment);
                item.classList.add('wjh-item-new');
                if (els.list.querySelector('.wjh-status')) {
                    els.list.innerHTML = '';
                    els.list.appendChild(item);
                } else {
                    els.list.appendChild(item);
                }
                renderCount();
            })
            .catch(function (err) {
                if (err && err.status === 401) {
                    clearLogin();
                    showError('登录已过期，请重新登录后发布。');
                    openOAuth();
                } else if (err && err.status === 403) {
                    showError('没有发布权限或接口限流，请稍后重试。');
                } else {
                    showError((err && err.message) || '发布失败，请重试。');
                }
            })
            .then(function () {
                state.posting = false;
                els.submit.disabled = false;
                els.submit.textContent = '发布';
            });
    }

    /* ---------- 初始化 ---------- */

    function initData() {
        showStatus('<span class="wjh-loading">评论加载中</span>');
        loadComments()
            .then(function (comments) {
                state.comments = Array.isArray(comments) ? comments : [];
                renderList();
            })
            .catch(function (err) {
                showStatus('评论加载失败：' + ((err && err.message) || '未知错误'), true);
            });
    }

    function init() {
        build();
        renderUserArea();
        renderEditorState();
        state.token = loadStoredToken();
        if (state.token) {
            var cachedUser = loadStoredUser();
            if (cachedUser) {
                state.user = cachedUser;
                renderUserArea();
                renderEditorState();
            }
            fetchUser().then(function () {
                renderUserArea();
                renderEditorState();
            });
        }
        initData();
    }

    init();
})();
