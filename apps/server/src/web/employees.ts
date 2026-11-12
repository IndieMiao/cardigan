import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AVATAR_LIBRARY,
  activeOwner,
  type Clock,
  createEmployee,
  type EmployeeCommandPorts,
  type EmployeeId,
  type EventId,
  MAX_AVATAR_BYTES,
  parseAvatarReference,
  type Result,
} from "@cardigan/domain";
import {
  fileAvatarStore,
  getRoleVersion,
  listRoleVersions,
  persistEmployeeEffect,
  type ReadRepositories,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import { z } from "zod";
import {
  HttpRejection,
  MAX_JSON_BODY_BYTES,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";

interface EmployeeContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly store: Store;
  readonly project_id: string;
  readonly clock: Clock;
  readonly dataDir: string;
  readonly authorize: () => unknown;
}

const maxBase64 = Math.ceil(MAX_AVATAR_BYTES / 3) * 4;
function boundedEmployeeText(max: number) {
  // Domain limits count trimmed Unicode code points, not UTF-16 code units.
  // Preserve the original string so domain still rejects surrounding controls.
  const length = z.number().max(max);
  return z
    .string()
    .refine(
      (value) => length.safeParse(Array.from(value.trim()).length).success,
    );
}
const employeeInput = z
  .object({
    name: boundedEmployeeText(40),
    title: boundedEmployeeText(40),
    role_id: z.string(),
    bio: boundedEmployeeText(200).optional(),
    avatar: z.string().optional(),
    avatar_file: z.string().min(1).max(maxBase64).optional(),
  })
  .strict();

function owner(
  c: EmployeeContext,
  tx: Pick<ReadRepositories, "members">,
): void {
  const session = c.authorize();
  const member = activeOwner(tx.members.list());
  if (
    c.req.headers.authorization !== undefined ||
    !member ||
    !session ||
    typeof session !== "object" ||
    !("member_id" in session) ||
    session.member_id !== member.id
  )
    throw new HttpRejection(
      403,
      "unauthorized",
      "只有所有者登录后可以创建员工",
    );
}

function must<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new HttpRejection(
    result.error.code === "validation_failed" ? 400 : 409,
    result.error.code,
    result.error.message,
  );
}

/** Only owner sessions reach this transport; the global domain command audits human writes. */
export async function serveEmployees(
  c: EmployeeContext,
  rest: string,
): Promise<boolean> {
  if (rest !== "/employees/options" && rest !== "/employees") return false;
  c.store.uow.read((tx) => owner(c, tx));
  if (rest === "/employees/options") {
    if (c.req.method !== "GET") methodNotAllowed(["GET"]);
    const options = c.store.uow.read((tx) => {
      owner(c, tx);
      const employees = tx.employees.list();
      const roles = new Map(
        listRoleVersions(tx, c.project_id).map((role) => [role.role_id, role]),
      );
      return {
        library: AVATAR_LIBRARY.map(([id, name, source]) => {
          const used = employees.find(
            (employee) => employee.avatar === `library:${id}`,
          );
          return {
            id,
            name,
            source,
            avatar: `/avatars/v1/${id}/head-128.webp`,
            occupied_by: used
              ? { id: used.id, name: used.name, status: used.status }
              : null,
          };
        }),
        roles: [...roles.values()]
          .filter((role) => role.status !== "inactive")
          .map((role) => ({
            role_id: role.role_id,
            display_name: role.display_name,
          })),
      };
    });
    sendJson(c.res, 200, options);
    return true;
  }
  if (c.req.method !== "POST") methodNotAllowed(["POST"]);
  const body = await readJsonBody(c.req, maxBase64 + MAX_JSON_BODY_BYTES);
  c.store.uow.read((tx) => owner(c, tx));
  const key = z
    .string()
    .trim()
    .min(1)
    .max(256)
    .safeParse(c.req.headers["idempotency-key"]);
  const parsed = employeeInput.safeParse(body);
  if (!key.success || !parsed.success)
    throw new HttpRejection(
      400,
      "validation_failed",
      "提交的内容不完整，请刷新页面后重试",
    );
  const { avatar_file, avatar: requestedAvatar, ...fields } = parsed.data;
  if (
    requestedAvatar !== undefined &&
    (avatar_file !== undefined ||
      parseAvatarReference(requestedAvatar)?.kind !== "library")
  )
    throw new HttpRejection(
      400,
      "validation_failed",
      "请选择人物库中的人物，或上传自定义头像，不能同时使用",
    );

  const execute = <T>(operation: (tx: StoreTransactionContext) => T): T => {
    // Check again even on an idempotent replay; body/blob IO may have outlived the session.
    c.store.uow.read((tx) => owner(c, tx));
    return must(
      c.store.runHumanIdempotent(
        {
          project_id: c.project_id,
          key: key.data,
          request: { method: "POST", rest, body },
        },
        (tx) => {
          owner(c, tx);
          return operation(tx);
        },
      ),
    ).value;
  };
  const missing = Symbol("uncached employee creation");
  try {
    const cached = execute(() => {
      throw missing;
    });
    sendJson(c.res, 200, cached);
    return true;
  } catch (error) {
    if (error !== missing) throw error;
  }

  const prepare = (
    tx: Pick<ReadRepositories, "roles" | "employees">,
    ids: EmployeeCommandPorts["ids"],
    avatar: string | undefined,
  ) => {
    const role = getRoleVersion(tx, c.project_id, fields.role_id);
    if (!role || role.status === "inactive")
      throw new HttpRejection(
        400,
        "validation_failed",
        "请选择本项目已启用的角色",
      );
    return must(
      createEmployee(
        tx.employees.list(),
        { kind: "human" },
        {
          name: fields.name,
          title: fields.title,
          role_id: fields.role_id,
          ...(fields.bio === undefined ? {} : { bio: fields.bio }),
          ...(avatar === undefined ? {} : { avatar }),
        },
        { clock: c.clock, ids },
      ),
    );
  };
  c.store.uow.read((tx) => {
    owner(c, tx);
    // Preview the same domain command before blob IO. Discard its effect and
    // use synthetic IDs: failed forms must not allocate IDs or write events.
    prepare(
      tx,
      {
        nextEmployeeId: () => "E-1" as EmployeeId,
        nextEventId: () => "preview" as EventId,
        nextEventSequence: () => 1,
      },
      requestedAvatar,
    );
  });

  let avatar = requestedAvatar;
  if (avatar_file !== undefined) {
    const bytes = Buffer.from(avatar_file, "base64");
    if (bytes.length > MAX_AVATAR_BYTES)
      throw new HttpRejection(
        413,
        "payload_too_large",
        "头像图片不能超过 2 MiB",
      );
    if (bytes.toString("base64") !== avatar_file)
      throw new HttpRejection(400, "validation_failed", "头像文件编码无效");
    try {
      avatar = await fileAvatarStore(c.dataDir).put(bytes);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("头像只支持"))
        throw new HttpRejection(400, "validation_failed", error.message);
      throw new HttpRejection(
        500,
        "avatar_storage_failed",
        "头像保存失败，请重试",
      );
    }
  }
  const created = execute((tx) => {
    // Recheck after asynchronous IO: BEGIN IMMEDIATE serializes the fresh
    // snapshot with CLI and other requests; the preview cannot authorize writes.
    const effect = prepare(tx, tx.global_ids, avatar);
    persistEmployeeEffect(tx, effect);
    const { id, name, role_id } = effect.data;
    return { id, name, role_id };
  });
  sendJson(c.res, 200, created);
  return true;
}
