'use strict'

function visibilityChoices(access) {
  const orgs = Array.isArray(access?.organizations) ? access.organizations : []
  const org = orgs.length === 1 && typeof orgs[0]?.id === 'string' && typeof orgs[0]?.name === 'string' ? orgs[0] : null
  return { orgId: org?.id || null, choices: [['private', 'Private'], ...(org ? [
    ['tcf_internal', 'Organization — ' + org.name], ['project', 'Project access'], ['shared_users', 'Selected people'],
  ] : [])] }
}

if (typeof module !== 'undefined') module.exports = { visibilityChoices }
if (typeof window !== 'undefined') window.forgeNotesFiling = { visibilityChoices }
