# Optional product analytics

This change uses the authenticated first-party relay in the shared TheContentForge backend. It measures app opens, allowlisted feature outcomes, recording starts/stops and completed uploads after account opt-in. The server rechecks consent for every event, deduplicates delivery, and sends only controlled metadata to PostHog. No audio, meeting text, names, email, file paths or tokens are sent. Account replacement and withdrawal suppress in-flight analytics.

The recorder checkbox changes the account preference used by other supported apps. A failed preference save leaves this device off and asks the person to retry. There is no session replay in native recorders.

Before distributing a new package, confirm the public privacy disclosure reflects linked account identifiers and product interactions for optional analytics. Build/signing and physical audio capture acceptance are separate from JavaScript test success. The pending ForgeNotes iOS submission is not changed.
