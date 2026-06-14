import { redirect } from 'next/navigation';

// AIart4never Studio is a desktop app shell; the Tauri window loads /studio
// directly. The marketing landing page was removed in the M0 strip, so the
// web root simply forwards to the studio.
export default function RootPage() {
  redirect('/studio');
}
