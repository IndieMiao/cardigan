import type { EmployeeRepository } from "./employee.js";
import type {
  Assignment,
  Attachment,
  Card,
  Cursor,
  Decision,
  Delivery,
  DeliveryEvidence,
  DeliverySubject,
  Event,
  HumanAction,
  Machine,
  Review,
  RoleReference,
  Run,
  TimelineEntry,
  WorkItem,
} from "./entities.js";
import type { Result } from "./errors.js";
import type {
  AssignmentId,
  AttachmentId,
  CardId,
  DecisionId,
  DeliveryId,
  EventId,
  HumanActionId,
  Id,
  MachineId,
  ProjectId,
  ReadableIdKind,
  ReviewId,
  RunId,
  TimelineEntryId,
  WorkItemId,
} from "./ids.js";
import type { ProjectPreferences } from "./preferences.js";
import type { CardTemplate } from "./templates.js";

export type { Clock } from "./clock.js";
// Implementations allocate within the same transaction as the entity changes.
export interface IdAllocator {
  next<K extends ReadableIdKind>(project_id: ProjectId, kind: K): Id<K>;
  nextTimelineEntryId(project_id: ProjectId, card_id: CardId): TimelineEntryId;
  nextEventId(): EventId;
  nextEventSequence(project_id: ProjectId, card_id?: CardId): number;
  nextAttachmentId(project_id: ProjectId): AttachmentId;
}
export interface DeliveryVerifier {
  verify(
    subject: DeliverySubject,
    assignment: Assignment,
    previous?: Delivery,
  ): Promise<Result<readonly DeliveryEvidence[]>>;
}
export interface AttachmentStore {
  put(
    sha256: string,
    content: Uint8Array,
  ): Promise<{ readonly storage_path: string }>;
  get(sha256: string): Promise<Uint8Array | undefined>;
}
// IDs are project-local, including entities without a card_id (standing/project scope).
export interface Repository<Entity, Key> {
  get(project_id: ProjectId, key: Key): Entity | undefined;
  list(project_id: ProjectId): readonly Entity[];
  put(project_id: ProjectId, entity: Entity): void;
}
export interface EventRepository {
  append(project_id: ProjectId, event: Event): void;
  // An absent card selects the project-level stream, not all card streams.
  listAfter(
    project_id: ProjectId,
    card_id: CardId | undefined,
    since_seq: number,
  ): readonly Event[];
}
export interface Repositories {
  readonly project_preferences: Repository<ProjectPreferences, ProjectId>;
  readonly card_templates: Repository<
    CardTemplate,
    Pick<CardTemplate, "id" | "version">
  >;
  readonly cards: Repository<Card, CardId>;
  readonly work_items: Repository<WorkItem, WorkItemId>;
  readonly assignments: Repository<Assignment, AssignmentId>;
  readonly runs: Repository<Run, RunId>;
  readonly timeline: Repository<TimelineEntry, TimelineEntryId>;
  readonly deliveries: Repository<Delivery, DeliveryId>;
  readonly reviews: Repository<Review, ReviewId>;
  readonly decisions: Repository<Decision, DecisionId>;
  readonly human_actions: Repository<HumanAction, HumanActionId>;
  readonly attachments: Repository<Attachment, AttachmentId>;
  readonly roles: Repository<
    RoleReference,
    Pick<RoleReference, "role_id" | "role_version">
  >;
  readonly machines: Repository<Machine, MachineId>;
  readonly cursors: Repository<
    Cursor,
    Pick<Cursor, "assignment_id" | "card_id">
  >;
  readonly events: EventRepository;
}
/** Trusted write-transaction proof: neither startup intent nor unreleased physical hold. */
export type UnreservedAssignment = (
  project: ProjectId,
  assignment: AssignmentId,
) => boolean;
export interface TransactionContext extends Repositories {
  readonly unreservedAssignment?: UnreservedAssignment;
  /** Read-only host deployment records of a SHA in the control plane's other projects. */
  readonly platformDeployments?: (
    project: ProjectId,
    sha: string,
  ) => readonly Event[];
  readonly read_machine_placement?: import("./machine-placement.js").ReadMachinePlacement;
  readonly test_review_trust?: import("./test-review.js").TestReviewTrust;
  readonly employees?: EmployeeRepository;
  readonly members?: import("./member.js").MemberRepository;
  readonly ids: IdAllocator;
}
export interface UnitOfWork {
  // Synchronous SQLite boundary. Do external verification/file IO before entering it.
  run<T>(operation: (transaction: TransactionContext) => T): T;
}
