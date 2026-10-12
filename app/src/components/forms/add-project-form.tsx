import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, Loader2, Search } from "lucide-react";
import { getDesktop } from "@/lib/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchGitRepos } from "../../lib/api";

interface AddProjectFormProps {
  onSubmit: (directory: string) => void;
  onCancel: () => void;
  error?: string | null;
  /** Directories already registered as projects (grayed out) */
  registeredDirs?: Set<string>;
}

export function AddProjectForm({ onSubmit, onCancel, error, registeredDirs }: AddProjectFormProps) {
  const {
    data: repos = [],
    isLoading: loading,
    isError: scanError,
  } = useQuery({ queryKey: ["gitRepos"], queryFn: fetchGitRepos });
  const [choosing, setChoosing] = useState(false);
  const [chooserError, setChooserError] = useState<string>();
  const desktop = getDesktop();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return repos;
    const q = query.toLowerCase();
    return repos.filter((r) => {
      const name = r.split("/").pop()!.toLowerCase();
      const fullLower = r.toLowerCase();
      return name.includes(q) || fullLower.includes(q);
    });
  }, [repos, query]);

  // Reset active index when filter changes
  useEffect(() => {
    setActiveIndex(-1);
  }, [filtered.length, query]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0) return;
    const items = listRef.current?.querySelectorAll(".repo-item");
    if (items?.[activeIndex]) {
      items[activeIndex].scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const handleSelect = (dir: string) => {
    if (registeredDirs?.has(dir)) return;
    onSubmit(dir);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && filtered[activeIndex]) {
        handleSelect(filtered[activeIndex]);
      } else if (query.startsWith("/")) {
        // Allow typing a full path directly
        onSubmit(query.trim());
      }
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
        />
        <Input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search git repos..."
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="pl-8"
        />
      </div>

      {desktop?.capabilities?.localFiles && (
        <Button
          disabled={choosing}
          onClick={async () => {
            setChoosing(true);
            setChooserError(undefined);
            try {
              const directory = await desktop.chooseDirectory();
              if (directory) {
                if (registeredDirs?.has(directory))
                  setChooserError("This Project is already added.");
                else onSubmit(directory);
              }
            } catch {
              setChooserError("Could not open the folder chooser.");
            } finally {
              setChoosing(false);
            }
          }}
        >
          {choosing ? "Choosing…" : "Choose Project folder…"}
        </Button>
      )}
      {chooserError && (
        <p role="alert" className="text-[0.6875rem] text-red-400">
          {chooserError}
        </p>
      )}
      {error && <p className="text-[0.6875rem] text-red-400">{error}</p>}

      <div
        ref={listRef}
        className="max-h-[280px] overflow-y-auto rounded-lg border border-border bg-surface-raised"
      >
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-[0.8125rem]">Scanning for repos...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-6 text-center text-[0.8125rem] text-muted">
            {scanError
              ? "Failed to scan for repos"
              : repos.length === 0
                ? "No git repos found"
                : "No matches"}
          </div>
        ) : (
          filtered.map((dir, i) => {
            const name = dir.split("/").pop() || dir;
            const parent = dir.slice(0, -(name.length + 1));
            const isRegistered = registeredDirs?.has(dir);
            return (
              <button
                key={dir}
                type="button"
                className={`repo-item flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  isRegistered
                    ? "cursor-default opacity-40"
                    : i === activeIndex
                      ? "bg-accent-dim"
                      : "hover:bg-surface-hover"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(dir);
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <GitBranch size={14} strokeWidth={2} className="shrink-0 text-green-400" />
                <div className="min-w-0 flex-1">
                  <div
                    className={`truncate text-[0.8125rem] font-medium ${i === activeIndex ? "text-accent" : "text-text"}`}
                  >
                    {name}
                    {isRegistered && (
                      <span className="ml-1.5 text-[0.6875rem] font-normal text-muted">
                        (added)
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[0.6875rem] text-muted/60">{parent}</div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
