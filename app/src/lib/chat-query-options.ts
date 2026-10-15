import { queryOptions, type QueryFunctionContext } from "@tanstack/react-query";
import {
  fetchInstanceSummary,
  fetchInstanceGitStatus,
  fetchInstanceDiff,
  fetchProjectSuggestions,
} from "@/lib/api";

// QueryCache retains callbacks until GC. Module-level query functions read IDs
// from query keys, so they cannot retain a Chat render's history/props closure.
function querySummary({
  queryKey,
}: QueryFunctionContext<readonly ["instance-summary", string | null | undefined]>) {
  return fetchInstanceSummary(queryKey[1]!);
}
function queryGitStatus({
  queryKey,
}: QueryFunctionContext<readonly ["instance-git-status", string]>) {
  return fetchInstanceGitStatus(queryKey[1]);
}
function queryDiff({
  queryKey,
}: QueryFunctionContext<readonly ["instanceDiff", string | undefined]>) {
  return fetchInstanceDiff(queryKey[1]!);
}
function querySuggestions({
  queryKey,
}: QueryFunctionContext<readonly ["project-suggestions", string | null | undefined]>) {
  return queryKey[1] ? fetchProjectSuggestions(queryKey[1]) : Promise.resolve([]);
}

export function chatSummaryQueryOptions(id: string | null | undefined) {
  return queryOptions({ queryKey: ["instance-summary", id] as const, queryFn: querySummary });
}
export function chatGitStatusQueryOptions(id: string) {
  return queryOptions({ queryKey: ["instance-git-status", id] as const, queryFn: queryGitStatus });
}
export function chatDiffQueryOptions(id: string | undefined) {
  return queryOptions({ queryKey: ["instanceDiff", id] as const, queryFn: queryDiff });
}
export function chatSuggestionsQueryOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: ["project-suggestions", id] as const,
    queryFn: querySuggestions,
  });
}
