import { useEffect, useRef, useState } from 'react';
import { api, type Incident, type PlatformActionSummary } from './api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Notifications. Polling-only (no WebSocket —
 * not required by the kickoff brief, and a persistent connection is not worth the added complexity for a
 * v0.1 console). This hook invents no new backend concept and stores no notification history anywhere: it
 * re-fetches the SAME already-real, already-tested `/api/incidents` and `/api/actions` responses this app
 * uses elsewhere, and surfaces items that are newly present since the previous poll. Dismissing a
 * notification only clears it from this component's own in-memory "seen" set for the current tab — it
 * never claims to have acknowledged the underlying incident/action (that remains the real, separate
 * `incident.acknowledge`/approval actions elsewhere in this app).
 */
const POLL_INTERVAL_MS = 20_000;

export interface Notification {
  readonly id: string;
  readonly kind: 'incident' | 'approval-requested';
  readonly severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  readonly summary: string;
  readonly href: string;
}

function incidentToNotification(i: Incident): Notification {
  return { id: `incident:${i.signature}`, kind: 'incident', severity: i.severity, summary: i.summary, href: '/incidents' };
}
function heldActionToNotification(a: PlatformActionSummary): Notification {
  return { id: `approval:${a.platform_action_id}`, kind: 'approval-requested', severity: 'HIGH', summary: `Action ${a.platform_action_id} is awaiting approval`, href: `/actions/${encodeURIComponent(a.platform_action_id)}` };
}

/** Returns the current live notification list, plus how many are "new" (not yet seen in this tab) so the
 * sidebar can show an unread-style badge without a persisted read/unread store anywhere. */
export function useNotifications(canSeeIncidents: boolean, canSeeActions: boolean) {
  const [items, setItems] = useState<readonly Notification[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const [unseenCount, setUnseenCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      const requests: Promise<readonly Notification[]>[] = [];
      if (canSeeIncidents) requests.push(api.incidents().then(p => p.items.map(incidentToNotification)).catch(() => []));
      if (canSeeActions) requests.push(api.actions({ limit: 200 }).then(p => p.items.filter(a => a.state === 'HELD').map(heldActionToNotification)).catch(() => []));
      Promise.all(requests).then(groups => {
        if (cancelled) return;
        const flat = groups.flat();
        setItems(flat);
        const newOnes = flat.filter(n => !seenRef.current.has(n.id));
        setUnseenCount(newOnes.length);
      });
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [canSeeIncidents, canSeeActions]);

  const markAllSeen = () => { for (const i of items) seenRef.current.add(i.id); setUnseenCount(0); };
  return { items, unseenCount, markAllSeen };
}
