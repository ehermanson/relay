import { ExternalLink } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";

const SUPPORTED_PROVIDERS = [
  {
    provider: "claude" as const,
    name: "Claude Code",
    description: "Anthropic's agentic coding tool — works right in your terminal.",
    url: "https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview",
  },
  {
    provider: "codex" as const,
    name: "Codex CLI",
    description: "OpenAI's open-source coding agent for the terminal.",
    url: "https://developers.openai.com/codex/cli",
  },
  {
    provider: "antigravity" as const,
    name: "Antigravity CLI",
    description: "Google's agentic coding CLI, with Gemini and other models.",
    url: "https://antigravity.google/docs/cli",
  },
];

export function NoProvidersLanding() {
  return (
    <div className="flex h-full items-center justify-center bg-bg p-6">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-[1.25rem] font-semibold tracking-tight text-text-bright">
            No coding agents found
          </h1>
          <p className="text-[0.8125rem] text-muted">
            Relay needs at least one CLI provider installed to get started. Install one of the
            following and restart Relay.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {SUPPORTED_PROVIDERS.map(({ provider, name, description, url }) => (
            <div key={provider} className="rounded-xl border border-border bg-surface p-5">
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg">
                  <ProviderLogo provider={provider} className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-[0.875rem] font-semibold text-text-bright">{name}</div>
                  <div className="text-[0.75rem] text-muted">{description}</div>
                </div>
              </div>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[0.75rem] text-accent hover:underline"
              >
                Learn more
                <ExternalLink size={11} />
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
