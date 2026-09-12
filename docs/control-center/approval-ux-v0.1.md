# Approval UX v0.1

## The pattern every consequential mutation follows

```
submit -> real backend response -> refetch -> render authoritative state
```

Never an optimistic flip to `APPROVED`, `PROMOTED`, `ROLLED_BACK`, `ENABLED`, or `ACTIVE` before the real
response returns. Proven for:

- Action approval/termination (`ActionDetail.tsx`; `tests/e2e/actions-and-approval.spec.ts`).
- Tool enable (`Tools.tsx`; `tests/e2e/stale-state.spec.ts` delays the real response and confirms the
  DISABLED badge is still shown until it arrives).
- Improvement approve/promote/rollback (`ImprovementDetail.tsx`; `tests/control-center/improvement
  -lineage.test.ts`, `tests/e2e/improvements.spec.ts`).
- Incident acknowledgment (`Incidents.tsx`; `tests/e2e/stale-state.spec.ts`).
- Credential rotation (`Identities.tsx`; `tests/e2e/credential-leakage.spec.ts`).

## Confirmation

Every consequential action requires an explicit two-step confirm (`confirming` state + a "Confirm ..."
button), never a single click. A reason is required where the backend requires one (action termination).

## Environment identity

The environment banner (`DEVELOPMENT`/`STAGING`/`PRODUCTION`) is real backend state
(`GET /api/session/me`'s `environment` field, from `TNA_CONTROL_CENTER_ENVIRONMENT`) — never a frontend
constant. An unconfigured deployment fails toward `development` (the least-reassuring label), never toward
`production`. High-risk confirmation dialogs (action approval, tool enable, improvement promotion) name the
real environment explicitly in their confirm text, so a reviewer cannot mistake a production approval for a
staging one.

## Role boundary is server-side

Hiding an Approve/Terminate/Promote/Rollback button for a role that lacks the permission is UX. The actual
control is `authorizeClientPermission()` on the real HTTP route — proven directly by sending the mutating
request as an unprivileged role and observing a real 403 even with a valid session and correct CSRF token
(`tests/control-center/security.test.ts`, `role-matrix.test.ts`).
