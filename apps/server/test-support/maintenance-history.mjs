/** C-424: settled inbox and retained GitHub history omitted by the original
 * idle fixture. Synthetic only; every external operation remains a tripwire.
 */
export function seedMaintenanceHistory(store, project, at) {
  const executor = {
    name: "synthetic-github",
    type: "github",
    repo: "synthetic/project",
    workflow: ".github/workflows/check.yml",
    appId: 1,
    installationId: 2,
    privateKeyFile: "/synthetic/never-read",
    botLogin: "synthetic[bot]",
    maxConcurrent: 1,
  };
  store.uow.run((tx) => {
    const insert = store.database.prepare(`INSERT INTO notifications
      (project_id,id,event_id,recipient_kind,assignment_id,card_id,seq,kind,status,attempts,next_attempt_at,doc)
      VALUES (?,?,?,'pm_ops','',?,?,'synthetic','acked',0,NULL,?)`);
    for (const stream of tx.events.listStreams(project).values())
      for (const e of stream) {
        const n = {
          id: `settled-${e.id}`,
          project_id: project,
          event_id: e.id,
          recipient: { kind: "pm_ops" },
          card_id: e.card_id,
          seq: e.seq,
          kind: "synthetic",
          status: "acked",
          attempts: 0,
          created_at: at,
          updated_at: at,
        };
        insert.run(
          project,
          n.id,
          e.id,
          e.card_id ?? null,
          e.seq,
          JSON.stringify(n),
        );
      }
    // One retained terminal check per open card. It is the current attempt,
    // so the normal cleaner must inspect it but must never delete its ref.
    const items = tx.work_items.list(project);
    let serial = 100000;
    for (const card of tx.cards.list(project)) {
      if (["done", "cancelled"].includes(card.status)) continue;
      const item = items.find(
        (w) => w.card_id === card.id && w.kind === "produce",
      );
      if (!item) continue;
      const delivery = `D-${++serial}`;
      const attempt = `history-${card.id}`;
      tx.deliveries.put(project, {
        id: delivery,
        work_item_id: item.id,
        run_id: "R-1",
        kind: "card_completion",
        status: "accepted",
        summary: "Synthetic retained check",
        subject: { kind: "git_head", value: "a".repeat(40) },
        requested_verifiers: [],
        evidence: [],
        attachments: [],
        known_gaps: [],
      });
      const intent = {
        project,
        card: card.id,
        attempt,
        key: attempt,
        startedAt: at,
        executor: executor.name,
        phase: "dispatching",
        finished: true,
        identity: {
          id: serial,
          actor: { login: executor.botLogin },
          path: executor.workflow,
          head_branch: "main",
          html_url: `https://github.com/synthetic/project/actions/runs/${serial}`,
          display_title: `cardigan/${card.id}/${delivery}/${attempt}/merge_check/${"a".repeat(40)}/${"b".repeat(40)}`,
        },
        externalRun: {
          provider: "github",
          run_id: serial,
          run_attempt: 1,
          html_url: `https://github.com/synthetic/project/actions/runs/${serial}`,
          workflow_sha: "c".repeat(40),
        },
        candidate: {
          repo: executor.repo,
          ref: `refs/heads/ci/${card.id}/${delivery}/${attempt}`,
          sha: "a".repeat(40),
          delivery,
        },
      };
      for (const [type, payload] of [
        ["github_check_dispatch", intent],
        [
          "merge_check_finished",
          {
            attempt_id: attempt,
            completion_id: delivery,
            candidate_sha: "a".repeat(40),
            tree_sha: "b".repeat(40),
            status: "passed",
            executor: { name: executor.name, type: "github" },
          },
        ],
      ])
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project, card.id),
          card_id: card.id,
          type,
          payload,
          actor: { kind: "system", project_id: project },
          created_at: at,
        });
    }
  });
  return {
    forProject: () => ({
      status: "enabled",
      executor,
      checks: [],
      env: {},
      totalTimeoutMs: 60000,
    }),
  };
}
