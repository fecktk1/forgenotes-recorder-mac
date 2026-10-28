// First-party, authenticated analytics relay. The database owns account consent,
// stable identity, the durable outbox and PostHog retries. No recording content.
;(function (root) {
  function createAnalytics({ rpc, platform, version }) {
    let allowed = false, identity = null, generation = 0
    const sessionId = globalThis.crypto?.randomUUID?.()
    const features = {
      'forgenotes-create-session': 'meeting_created', 'forgenotes-finalize-session': 'meeting_submitted',
      'forgenotes-import-transcript': 'transcript_imported', 'forgenotes-ingest-url': 'url_import_requested',
      'forgenotes-qa-create': 'question_submitted', 'forgenotes-export-notion': 'notion_export_requested',
    }
    const events = new Set(['app_opened','recording_started','recording_stopped','recording_failed','upload_completed','upload_failed','notes_action_succeeded','notes_action_failed'])
    async function capture(event, properties = {}) {
      if (!allowed || !identity || !events.has(event)) return
      const safe = { app_version: version, ...(sessionId ? { $session_id: sessionId } : {}) }
      if (Object.values(features).includes(properties.feature)) safe.feature = properties.feature
      for (const key of ['duration_ms','status_code']) if (Number.isFinite(properties[key]) && properties[key] >= 0) safe[key] = properties[key]
      try { await rpc('capture_product_event', { p_event: event, p_properties: safe, p_platform: platform, p_application: `forgenotes_${platform}`, p_event_id: globalThis.crypto.randomUUID() }, identity) } catch { /* never block capture/upload */ }
    }
    return {
      enabled: () => allowed,
      async identify(id) {
        if (identity === id) return allowed
        const revision = ++generation; allowed = false; identity = id
        if (!id) return false
        try {
          const result = await rpc('get_product_analytics_consent', {}, identity)
          if (revision !== generation) return false
          allowed = result?.allowed === true
          if (allowed) void capture('app_opened')
        } catch { /* no consent, no analytics */ }
        return allowed
      },
      async setEnabled(value) {
        const revision = ++generation; allowed = false
        const result = await rpc('set_product_analytics_consent', { p_allowed: value === true, p_decided_at: new Date().toISOString(), p_policy_version: 2 }, identity)
        if (revision === generation) allowed = result === true
        return allowed
      },
      reset() { generation++; allowed = false; identity = null },
      capture,
      async operation(name, run) {
        const started = Date.now(), feature = features[name], revision = generation
        try {
          const value = await run()
          if (feature && revision === generation) void capture(value?.error ? 'notes_action_failed' : 'notes_action_succeeded', { feature, duration_ms: Date.now() - started })
          return value
        } catch (error) {
          if (feature && revision === generation) void capture('notes_action_failed', { feature, duration_ms: Date.now() - started, status_code: Number(error.httpStatus) || 0 })
          throw error
        }
      },
    }
  }
  if (typeof module !== 'undefined') module.exports = { createAnalytics }
  else root.FnAnalytics = { createAnalytics }
})(globalThis)
