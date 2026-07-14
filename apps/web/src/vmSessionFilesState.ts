export function vmSessionFilesCompletionState<T>(
  activeRequest: T | null,
  completedRequest: T
): { ownsActiveRequest: boolean; shouldClearLoading: boolean } {
  const ownsActiveRequest = activeRequest === completedRequest;
  return {
    ownsActiveRequest,
    shouldClearLoading: ownsActiveRequest || activeRequest === null
  };
}
