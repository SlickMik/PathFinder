import { File, Paths } from 'expo-file-system';

// expo-file-system ships inside the expo package, so persisting the flag here
// avoids adding a native storage dependency that would force a rebuild.
const MARKER_FILE_NAME = 'onboarding-complete-v1';

function markerFile(): File {
  return new File(Paths.document, MARKER_FILE_NAME);
}

/**
 * Whether the user has finished (or skipped) the guided tour before.
 * Fails open to "not completed": if storage is unreadable the tour shows
 * again, which is a minor annoyance rather than a missing introduction.
 */
export function hasCompletedOnboarding(): boolean {
  try {
    return markerFile().exists;
  } catch {
    return false;
  }
}

export function markOnboardingComplete(): void {
  try {
    markerFile().write('done');
  } catch {
    // Non-fatal: the tour will simply be offered again on the next launch.
  }
}
