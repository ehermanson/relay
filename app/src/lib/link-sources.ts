import {
  siBitbucket,
  siConfluence,
  siDynatrace,
  siFigma,
  siGithub,
  siGitlab,
  siJira,
  siLinear,
  siNotion,
  siNpm,
  siSentry,
} from "simple-icons";

/**
 * Recognized link sources. A URL matching one renders as a chip (logo +
 * short identifier) instead of a raw URL. To support a new service, append a
 * `LinkSource` to `LINK_SOURCES` — rendering picks it up automatically.
 */
export interface LinkSource {
  id: string;
  /** Service name, shown in the chip tooltip. */
  name: string;
  /** 24×24 SVG path (simple-icons shape). */
  iconPath: string;
  /** Brand color, only when it reads on both light and dark backgrounds. */
  color?: string;
  /** Returns the short identifier to display, or null when the URL isn't this source's. */
  match: (url: URL) => string | null;
}

export interface LinkSourceMatch {
  source: LinkSource;
  identifier: string;
}

function segments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

function hostIs(url: URL, domain: string): boolean {
  const host = url.hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

/** "Some-Page-Title" / "Some+Page+Title" → "Some Page Title". */
function slugToTitle(slug: string): string {
  return slug.replace(/[-+_]+/g, " ").trim();
}

const shortSha = (sha: string) => sha.slice(0, 7);
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
// github.com/<first>/… paths that are site pages, not repositories.
const GITHUB_RESERVED_OWNERS = new Set([
  "settings",
  "orgs",
  "organizations",
  "marketplace",
  "features",
  "login",
  "notifications",
  "topics",
  "sponsors",
  "apps",
  "enterprise",
  "pricing",
  "search",
  "explore",
  "collections",
  "trending",
  "about",
  "security",
  "site",
  "users",
  "codespaces",
  "copilot",
  "pulls",
  "issues",
]);

const github: LinkSource = {
  id: "github",
  name: "GitHub",
  iconPath: siGithub.path,
  match(url) {
    if (
      url.hostname.toLowerCase() !== "github.com" &&
      url.hostname.toLowerCase() !== "www.github.com"
    ) {
      return null;
    }
    const [owner, repo, kind, ref, ...rest] = segments(url);
    if (!owner || !repo || GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    if (!kind) return `${owner}/${repo}`;
    switch (kind) {
      case "pull":
      case "issues":
      case "discussions":
        return ref && /^\d+$/.test(ref) ? `${repo}#${ref}` : null;
      case "commit":
        return ref ? `${repo}@${shortSha(ref)}` : null;
      case "releases":
        return ref === "tag" && rest[0] ? `${repo} ${rest[0]}` : null;
      case "blob":
      case "tree":
        return rest.length > 0 ? rest[rest.length - 1] : ref ? `${repo}@${ref}` : null;
      case "actions":
        return ref === "runs" && rest[0] ? `${repo} run ${rest[0]}` : null;
      default:
        return null;
    }
  },
};

const gitlab: LinkSource = {
  id: "gitlab",
  name: "GitLab",
  iconPath: siGitlab.path,
  color: `#${siGitlab.hex}`,
  match(url) {
    if (!url.hostname.toLowerCase().includes("gitlab")) return null;
    const parts = segments(url);
    const dash = parts.indexOf("-");
    const projectPath = dash === -1 ? parts : parts.slice(0, dash);
    const project = projectPath[projectPath.length - 1];
    if (!project || projectPath.length < 2) return null;
    if (dash === -1) return projectPath.join("/");
    const [kind, ref] = parts.slice(dash + 1);
    if (!ref) return null;
    if (kind === "merge_requests" && /^\d+$/.test(ref)) return `${project}!${ref}`;
    if ((kind === "issues" || kind === "work_items") && /^\d+$/.test(ref))
      return `${project}#${ref}`;
    if (kind === "commit") return `${project}@${shortSha(ref)}`;
    if (kind === "pipelines" && /^\d+$/.test(ref)) return `${project} pipeline ${ref}`;
    if (kind === "jobs" && /^\d+$/.test(ref)) return `${project} job ${ref}`;
    return null;
  },
};

const bitbucket: LinkSource = {
  id: "bitbucket",
  name: "Bitbucket",
  iconPath: siBitbucket.path,
  color: "#2684FF",
  match(url) {
    if (!hostIs(url, "bitbucket.org")) return null;
    const [workspace, repo, kind, ref] = segments(url);
    if (!workspace || !repo) return null;
    if (!kind) return `${workspace}/${repo}`;
    if (kind === "pull-requests" && ref && /^\d+$/.test(ref)) return `${repo}#${ref}`;
    if (kind === "commits" && ref) return `${repo}@${shortSha(ref)}`;
    return null;
  },
};

const jira: LinkSource = {
  id: "jira",
  name: "Jira",
  iconPath: siJira.path,
  color: "#2684FF",
  match(url) {
    const host = url.hostname.toLowerCase();
    if (!hostIs(url, "atlassian.net") && !host.includes("jira")) return null;
    const parts = segments(url);
    const browse = parts.indexOf("browse");
    if (browse !== -1 && JIRA_KEY_RE.test(parts[browse + 1] ?? "")) return parts[browse + 1];
    const selected = url.searchParams.get("selectedIssue");
    if (selected && JIRA_KEY_RE.test(selected)) return selected;
    return null;
  },
};

const confluence: LinkSource = {
  id: "confluence",
  name: "Confluence",
  iconPath: siConfluence.path,
  color: "#2684FF",
  match(url) {
    const host = url.hostname.toLowerCase();
    const parts = segments(url);
    const isConfluence =
      (hostIs(url, "atlassian.net") && parts[0] === "wiki") || host.includes("confluence");
    if (!isConfluence) return null;
    const pages = parts.indexOf("pages");
    // /wiki/spaces/KEY/pages/123456/Page+Title
    if (pages !== -1 && /^\d+$/.test(parts[pages + 1] ?? "")) {
      const slug = parts[pages + 2];
      return slug ? slugToTitle(slug) : `Page ${parts[pages + 1]}`;
    }
    const spaces = parts.indexOf("spaces");
    if (spaces !== -1 && parts[spaces + 1]) return `Space ${parts[spaces + 1]}`;
    return null;
  },
};

const sentry: LinkSource = {
  id: "sentry",
  name: "Sentry",
  iconPath: siSentry.path,
  match(url) {
    if (!hostIs(url, "sentry.io")) return null;
    // <org>.sentry.io/issues/123/ or sentry.io/organizations/<org>/issues/123/
    const parts = segments(url);
    const issues = parts.indexOf("issues");
    const id = issues === -1 ? undefined : parts[issues + 1];
    return id && /^\d+$/.test(id) ? `Issue ${id}` : null;
  },
};

const linear: LinkSource = {
  id: "linear",
  name: "Linear",
  iconPath: siLinear.path,
  color: `#${siLinear.hex}`,
  match(url) {
    if (!hostIs(url, "linear.app")) return null;
    // linear.app/<team>/issue/ENG-123/optional-slug
    const parts = segments(url);
    const issue = parts.indexOf("issue");
    const key = issue === -1 ? undefined : parts[issue + 1];
    if (key && JIRA_KEY_RE.test(key.toUpperCase())) return key.toUpperCase();
    const project = parts.indexOf("project");
    const slug = project === -1 ? undefined : parts[project + 1];
    // Project slugs end in a hex id: "my-project-3f2a1b".
    if (slug) return slugToTitle(slug.replace(/-[a-f0-9]{6,}$/, ""));
    return null;
  },
};

const figma: LinkSource = {
  id: "figma",
  name: "Figma",
  iconPath: siFigma.path,
  color: `#${siFigma.hex}`,
  match(url) {
    if (!hostIs(url, "figma.com")) return null;
    const [kind, key, name] = segments(url);
    if (!["file", "design", "board", "proto", "slides"].includes(kind ?? "") || !key) return null;
    return name ? slugToTitle(name) : "Figma file";
  },
};

const notion: LinkSource = {
  id: "notion",
  name: "Notion",
  iconPath: siNotion.path,
  match(url) {
    if (!hostIs(url, "notion.so") && !hostIs(url, "notion.site")) return null;
    const parts = segments(url);
    const last = parts[parts.length - 1];
    if (!last) return null;
    // "Page-Title-<32 hex>" — bare-id pages carry no title.
    const match = /^(.*?)-?[a-f0-9]{32}$/.exec(last);
    if (!match) return null;
    return match[1] ? slugToTitle(match[1]) : "Notion page";
  },
};

const npm: LinkSource = {
  id: "npm",
  name: "npm",
  iconPath: siNpm.path,
  color: `#${siNpm.hex}`,
  match(url) {
    if (!hostIs(url, "npmjs.com")) return null;
    const parts = segments(url);
    if (parts[0] !== "package" || !parts[1]) return null;
    return parts[1].startsWith("@") && parts[2] ? `${parts[1]}/${parts[2]}` : parts[1];
  },
};

const dynatrace: LinkSource = {
  id: "dynatrace",
  name: "Dynatrace",
  iconPath: siDynatrace.path,
  color: `#${siDynatrace.hex}`,
  match(url) {
    if (!url.hostname.toLowerCase().includes("dynatrace")) return null;
    // Dashboard names aren't in the URL, so show a short id.
    const label = (id: string) => `Dashboard ${id.slice(0, 8)}`;
    // Platform: <env>.apps.dynatrace.com/ui/apps/dynatrace.dashboards/dashboard/<id>
    const parts = segments(url);
    const dashboard = parts.indexOf("dashboard");
    if (dashboard !== -1 && parts[dashboard - 1]?.includes("dashboards") && parts[dashboard + 1]) {
      return label(parts[dashboard + 1]);
    }
    // Classic: <env>.live.dynatrace.com/#dashboard;gtf=-2h;id=<id> (also /e/<env>/ on Managed)
    const hash = url.hash.replace(/^#/, "");
    if (hash.startsWith("dashboard;") || hash.startsWith("dashboard/")) {
      const id = /(?:^|;)id=([^;&]+)/.exec(hash)?.[1];
      return id ? label(id) : null;
    }
    return null;
  },
};

export const LINK_SOURCES: readonly LinkSource[] = [
  github,
  gitlab,
  bitbucket,
  jira,
  confluence,
  sentry,
  linear,
  figma,
  notion,
  npm,
  dynatrace,
];

export function matchLinkSource(
  href: string,
  sources: readonly LinkSource[] = LINK_SOURCES,
): LinkSourceMatch | null {
  if (!/^https?:\/\//i.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  for (const source of sources) {
    const identifier = source.match(url);
    if (identifier) return { source, identifier };
  }
  return null;
}

/**
 * True when a link's visible text is just its URL (a pasted/autolinked URL),
 * as opposed to author-chosen label text that should be preserved.
 */
export function isBareLink(text: string, href: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  return text.trim().length > 0 && normalize(text) === normalize(href);
}
