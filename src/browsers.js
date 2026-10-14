/**
 * `browsers = ["chromium"]`: what a headless browser needs from the sandbox
 * beyond files and the network, per role and only when the role says so.
 *
 * Measured on macOS with Playwright's Chromium headless shell (build 1208), as
 * the kernel saw it under the default profile:
 *
 *   - the browser process starts by registering a Mach service named
 *     `org.chromium.Chromium.MachPortRendezvousServer.<its pid>`, and dies at
 *     once when that is refused (`bootstrap_check_in ... Permission denied
 *     (1100)`, FATAL in base/apple/mach_port_rendezvous_mac.cc);
 *   - every child it starts (GPU, network, renderer) then looks that same
 *     service up to receive its ports, and loops forever when the lookup is
 *     refused: over a thousand refusals in forty seconds, no page.
 *
 * Those two, with that one prefix, are all it took: with them the browser
 * started, rendered and navigated through seisin's proxy, and the other Mach
 * services it reached for (configd, the window server, analytics) stayed
 * refused without stopping it. So that is all a preset grants. Never a bare
 * `mach-register`: a name is registered in the bootstrap namespace other
 * processes look names up in, and an open grant would let the role stand up a
 * service under any name.
 *
 * The prefix is the browser's bundle id, which is why the preset is named for
 * the build. Chrome and Chrome for Testing use their own (`com.google.Chrome`,
 * `com.google.chrome.for.testing`) and also need a unix socket for their
 * process singleton, measured and not granted here: they are not presets yet.
 */
export const BROWSERS = {
  chromium: {
    // The browser registers it; its children look it up.
    register: ["org.chromium.Chromium.MachPortRendezvousServer."],
    lookup: ["org.chromium.Chromium.MachPortRendezvousServer."],
  },
};

/** A Mach name prefix as the profile may carry it: no quotes, no spaces, ends in a dot. */
export const MACH_PREFIX = /^[A-Za-z0-9][A-Za-z0-9.-]*\.$/;

/** The Mach names a role's browsers need registered and looked up, de-duplicated. */
export function machOf(role) {
  const names = (role?.browsers ?? []).map((b) => BROWSERS[b]).filter(Boolean);
  return {
    register: [...new Set(names.flatMap((b) => b.register))],
    lookup: [...new Set(names.flatMap((b) => b.lookup))],
  };
}

/** The preset whose register prefix this Mach name falls under, or null. */
export function browserFor(name) {
  return Object.keys(BROWSERS).find((b) => BROWSERS[b].register.some((p) => name.startsWith(p))) ?? null;
}
