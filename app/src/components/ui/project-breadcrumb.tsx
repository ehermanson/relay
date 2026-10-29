/**
 * Breadcrumb dropdown for navigating between project subpages
 * (Overview, Plans, Tasks, Skills, Chats, Settings).
 *
 * Replaces the plain text link in chat headers with a dropdown menu,
 * making project subpages accessible from anywhere within a project.
 */

import { useContext } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  ChevronDown,
  Cog,
  LayoutList,
  ListChecks,
  MessageSquare,
  ScrollText,
  Zap,
} from "lucide-react";
import { Menu } from "./menu";
import { ProjectContext } from "@/context/project-context";

// ── Types ────────────────────────────────────────────────────────────

interface ProjectBreadcrumbProps {
  projectId: string;
  label: string;
  mobile?: boolean;
}

// ── Component ────────────────────────────────────────────────────────

export function ProjectBreadcrumb({ projectId, label, mobile = false }: ProjectBreadcrumbProps) {
  const navigate = useNavigate();
  const ctx = useContext(ProjectContext);

  const planCount = ctx?.artifacts.plans.length ?? 0;
  const taskCount = ctx?.artifacts.tasks?.length ?? 0;
  const skillCount = ctx?.artifacts.skills.length ?? 0;

  const items: {
    label: string;
    icon: typeof BookOpen;
    to: string;
    count?: number;
    /** Only show this item if count > 0 */
    requireCount?: boolean;
  }[] = [
    { label: "Overview", icon: LayoutList, to: `/projects/${projectId}` },
    { label: "Plans", icon: ScrollText, to: `/projects/${projectId}/plans`, count: planCount },
    {
      label: "Tasks",
      icon: ListChecks,
      to: `/projects/${projectId}/tasks`,
      count: taskCount,
      requireCount: true,
    },
    {
      label: "Skills",
      icon: Zap,
      to: `/projects/${projectId}/skills`,
      count: skillCount,
      requireCount: true,
    },
    {
      label: "Chats",
      icon: MessageSquare,
      to: `/projects/${projectId}/chats`,
    },
    { label: "Settings", icon: Cog, to: `/projects/${projectId}/settings` },
  ];

  const visibleItems = items.filter((item) => !item.requireCount || (item.count && item.count > 0));

  return (
    <Menu.Root>
      <Menu.Trigger
        className={
          mobile
            ? "inline-flex min-w-0 max-w-full items-center gap-0.5 text-[0.6875rem] font-medium text-muted transition-colors hover:text-text"
            : "hidden items-center gap-1 text-[0.8125rem] font-medium text-muted transition-colors hover:text-text sm:inline-flex"
        }
      >
        {label}
        <ChevronDown size={mobile ? 10 : 10} strokeWidth={2.5} className="shrink-0 opacity-50" />
      </Menu.Trigger>
      <Menu.Content side="bottom" align="start" sideOffset={4}>
        {visibleItems.map((item) => (
          <Menu.Item key={item.to} onClick={() => void navigate({ to: item.to })}>
            <item.icon size={13} className="text-muted" />
            <span className="flex-1">{item.label}</span>
            {item.count != null && item.count > 0 && (
              <span className="text-[0.6875rem] tabular-nums text-muted/50">{item.count}</span>
            )}
          </Menu.Item>
        ))}
      </Menu.Content>
    </Menu.Root>
  );
}
