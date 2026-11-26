/** The host-verified signing context of one running producer (C-500). */
export interface SigningScope {
  project: string;
  worker_uid: number;
  machine: string;
  card: string;
  assignment: string;
  run: string;
  platform: "android" | "ios";
}
