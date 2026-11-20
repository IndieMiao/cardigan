import {
  type Actor,
  builtinCardTemplatesForFlow,
  type CardTemplate,
  type Clock,
  canManageRoles,
  employeeNameKey,
  latestCardTemplate,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { parseRoleMarkdown, type RoleMarkdown } from "@cardigan/roles";
import {
  hashRequest,
  listRoleVersions,
  persistEmployeeEffect,
  persistRoleEffect,
  type ReadRepositories,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import { previewPorts } from "./preview-ports.js";
import {
  employeePlans,
  must,
  type Profiles,
  profile,
  RoleDocumentError,
  rolePlan,
  roleSource,
  templatePlan,
} from "./role-document-plan.js";

export { RoleDocumentError };

interface Context {
  store: Store;
  project_id: string;
  actor: Actor;
  clock: Clock;
  profiles: () => Profiles;
  /** Transport credential/owner check, including before serving an idempotent replay. */
  authorize: (
    tx: Pick<ReadRepositories, "members">,
    employees: boolean,
  ) => void;
}
function authorize(
  c: Context,
  tx: Pick<ReadRepositories, "members">,
  doc: RoleMarkdown,
) {
  if (!canManageRoles(c.actor, c.project_id))
    throw new RoleDocumentError("forbidden_tool", "只有同项目的人可以管理角色");
  c.authorize(tx, !!doc.employees?.length);
}
function evaluate(
  c: Context,
  doc: RoleMarkdown,
  tx: ReadRepositories,
  expected?: string,
  writer?: StoreTransactionContext,
) {
  authorize(c, tx, doc);
  const { project_id, actor } = c;
  const roles = new Map(
    listRoleVersions(tx, project_id).map((r) => [r.role_id, r]),
  );
  const profiles = c.profiles();
  // Load template command state only for documents with a template section.
  const state = doc.template ? loadCommandState(tx, project_id) : undefined;
  const flow = state?.project_preferences?.find(
    (p) => p.id === project_id,
  )?.flow_version;
  let source: CardTemplate | undefined, target: CardTemplate | undefined;
  if (doc.template && state) {
    const templates = [
      ...(state.card_templates ?? []),
      ...builtinCardTemplatesForFlow(flow),
    ];
    source = latestCardTemplate(
      templates,
      doc.template.from ?? doc.template.id,
    );
    target = latestCardTemplate(templates, doc.template.id);
  }
  const employees = doc.employees?.length ? tx.employees.list() : [];
  const referencedRoles = new Set([
    doc.role_id,
    ...(roles.has(doc.role_id) || !doc.based_on ? [] : [doc.based_on]),
    ...(source?.work_items.map((w) => w.role_id) ?? []),
  ]);
  const base = roleSource(doc, roles, profiles);
  const profileRefs = new Set([
    doc.launch_profile ?? base?.launch_profile_ref,
    ...(doc.employees ?? []).map((e) => e.launch_profile),
  ]);
  const snapshot = hashRequest({
    base,
    project_id,
    doc,
    roles: [...referencedRoles].map((k) => [k, roles.get(k)?.version]),
    source,
    target,
    flow,
    profiles: [...profileRefs]
      .filter((ref): ref is string => ref !== undefined)
      .map((ref) => [ref, profile(profiles, ref)?.harness]),
    employees: employees.filter((e) =>
      doc.employees?.some(
        (input) =>
          (e.status === "active" &&
            employeeNameKey(input.name) === employeeNameKey(e.name)) ||
          (input.avatar && e.avatar === input.avatar),
      ),
    ),
  });
  if (expected !== undefined && snapshot !== expected)
    throw new RoleDocumentError(
      "stale_target",
      "文件或相关配置已变化，请重新预览",
    );
  const preview = previewPorts(c.clock.now());
  const role = rolePlan(
    doc,
    roles.get(doc.role_id),
    base,
    profiles,
    actor,
    project_id,
    preview,
  );
  const template =
    doc.template && state
      ? templatePlan(
          doc.template,
          role.result,
          source,
          target,
          state,
          actor,
          preview,
        )
      : undefined;
  const staff = employeePlans(doc, role.result, employees, profiles, preview);
  const ids = new Map<string, string>();
  if (writer) {
    const ports = { clock: c.clock, ids: writer.ids };
    if (role.changed)
      persistRoleEffect(writer, project_id, role.command(ports));
    if (template?.changed)
      persistEffect(writer, project_id, template.command(ports));
    for (const item of staff)
      if (item.changed) {
        const effect = item.command(writer.global_ids);
        persistEmployeeEffect(writer, effect);
        ids.set(item.preview.name, effect.data.id);
      }
  }
  return {
    snapshot,
    role: role.preview,
    template: template?.preview ?? null,
    employees: staff.map(({ preview: p }) => ({
      ...p,
      id: ids.get(p.name) ?? p.id,
    })),
  };
}
export function previewRoleDocument(c: Context, markdown: string) {
  const doc = parseRoleMarkdown(markdown);
  return c.store.uow.read((tx) => evaluate(c, doc, tx));
}
export function applyRoleDocument(
  c: Context,
  markdown: string,
  snapshot: string,
  key: string,
) {
  const doc = parseRoleMarkdown(markdown);
  if (!key.trim() || key.length > 256 || !/^[a-f0-9]{64}$/u.test(snapshot))
    throw new RoleDocumentError(
      "validation_failed",
      "应用需要幂等键和预览快照",
    );
  c.store.uow.read((tx) => authorize(c, tx, doc));
  return must(
    c.store.runHumanIdempotent(
      {
        project_id: c.project_id,
        key,
        request: { operation: "applyRoleDocument", markdown, snapshot },
      },
      (tx) => evaluate(c, doc, tx, snapshot, tx),
    ),
  ).value;
}
