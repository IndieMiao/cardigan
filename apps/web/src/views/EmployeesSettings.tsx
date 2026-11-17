import { useCallback, useRef, useState } from "react";
import {
  ApiError,
  type CardiganClient,
  type CreateEmployeeInput,
  describeWriteError,
  type EmployeeOptions,
} from "../api.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { SelectControl } from "../components/ui/select-control.js";
import { Textarea } from "../components/ui/textarea.js";
import { employeeCopy as copy } from "../employee-copy.js";
import { useResource } from "../useResource.js";

export function EmployeesSettings({
  client,
  projectId,
  initialRole = "",
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  initialRole?: string;
  revision?: number;
}) {
  const load = useCallback(
    () => client.employeeOptions(projectId),
    [client, projectId],
  );
  const options = useResource(load, revision);
  const [message, setMessage] = useState("");
  const [version, setVersion] = useState(0);
  return (
    <section
      className="employee-settings"
      aria-labelledby="employee-settings-title"
    >
      <h2 id="employee-settings-title">{copy.heading}</h2>
      <p>{copy.description}</p>
      <RequestFeedback message={message} />
      <RequestFeedback
        {...options}
        retry={options.reload}
        pendingMessage={copy.loading}
      />
      {options.data && (
        <EmployeeForm
          key={`${initialRole}:${version}`}
          client={client}
          projectId={projectId}
          options={options.data}
          initialRole={initialRole}
          refresh={options.reload}
          onCreated={(name, id) => {
            setMessage(copy.created(name, id));
            setVersion((v) => v + 1);
            options.reload();
          }}
        />
      )}
    </section>
  );
}

function EmployeeForm({
  client,
  projectId,
  options,
  initialRole,
  refresh,
  onCreated,
}: {
  client: CardiganClient;
  projectId: string;
  options: EmployeeOptions;
  initialRole: string;
  refresh: () => void;
  onCreated: (name: string, id: string) => void;
}) {
  const [mode, setMode] = useState<"library" | "custom">("library");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState(initialRole);
  const [bio, setBio] = useState("");
  const [upload, setUpload] = useState<string>();
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const fileVersion = useRef(0);
  const keys = useRef(new Map<string, string>());
  const choice = options.library.find((item) => item.id === selected);
  const visible = options.library.filter((item) =>
    `${item.name} ${item.source}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const sources = [...new Set(visible.map((item) => item.source))];
  const switchMode = (next: "library" | "custom") => {
    setMode(next);
    setSelected("");
    setUpload(undefined);
    setFileError("");
    setReading(false);
    fileVersion.current++;
  };
  const readFile = (file: File | undefined) => {
    const current = ++fileVersion.current;
    setUpload(undefined);
    setFileError("");
    setReading(false);
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setFileError(copy.uploadTooLarge);
      return;
    }
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      if (current !== fileVersion.current) return;
      setReading(false);
      if (typeof reader.result !== "string") {
        setFileError(copy.uploadFailed);
        return;
      }
      setUpload(reader.result.slice(reader.result.indexOf(",") + 1));
    };
    reader.onerror = () => {
      if (current === fileVersion.current) {
        setReading(false);
        setFileError(copy.uploadFailed);
      }
    };
    reader.readAsDataURL(file);
  };
  return (
    <form
      className="employee-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending.current || reading || fileError) return;
        if (mode === "library" && (!choice || choice.occupied_by)) {
          setError(copy.choosePerson);
          return;
        }
        sending.current = true;
        setBusy(true);
        setError("");
        const input: CreateEmployeeInput = {
          name,
          title,
          role_id: role,
          bio,
          ...(mode === "library"
            ? { avatar: `library:${selected}` }
            : upload === undefined
              ? {}
              : { avatar_file: upload }),
        };
        const signature = JSON.stringify(input);
        const key = keys.current.get(signature) ?? crypto.randomUUID();
        keys.current.set(signature, key);
        try {
          const employee = await client.createEmployee(projectId, input, key);
          keys.current.delete(signature);
          onCreated(employee.name, employee.id);
        } catch (cause) {
          setError(describeWriteError(cause));
          if (cause instanceof ApiError && cause.code === "validation_failed")
            refresh();
        } finally {
          sending.current = false;
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy}>
        <legend>{copy.source}</legend>
        <div className="employee-mode">
          <label>
            <input
              type="radio"
              name="employee-mode"
              checked={mode === "library"}
              onChange={() => switchMode("library")}
            />
            {copy.library}
          </label>
          <label>
            <input
              type="radio"
              name="employee-mode"
              checked={mode === "custom"}
              onChange={() => switchMode("custom")}
            />
            {copy.custom}
          </label>
        </div>
        {mode === "library" ? (
          <>
            <label className="employee-search">
              {copy.search}
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="employee-library">
              {sources.map((source) => (
                <section key={source} aria-label={source}>
                  <h3>{source}</h3>
                  <div className="employee-grid">
                    {visible
                      .filter((item) => item.source === source)
                      .map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          className="employee-person"
                          disabled={item.occupied_by !== null}
                          aria-pressed={selected === item.id}
                          onClick={() => {
                            setSelected(item.id);
                            setName(item.name);
                            setError("");
                          }}
                        >
                          <img
                            src={item.avatar}
                            alt=""
                            width={64}
                            height={64}
                            loading="lazy"
                          />
                          <span>{item.name}</span>
                          {item.occupied_by && (
                            <small>
                              {copy.occupied(
                                item.occupied_by.name,
                                item.occupied_by.id,
                                item.occupied_by.status === "inactive",
                              )}
                            </small>
                          )}
                        </button>
                      ))}
                  </div>
                </section>
              ))}
              {visible.length === 0 && <p>{copy.emptySearch}</p>}
            </div>
          </>
        ) : (
          <label>
            {copy.avatar}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              onChange={(event) => readFile(event.target.files?.[0])}
            />
            <small>{copy.uploadHint}</small>
          </label>
        )}
        {reading && <p role="status">{copy.reading}</p>}
        <RequestFeedback error={fileError} />
      </fieldset>
      <fieldset className="employee-fields" disabled={busy}>
        {mode === "library" && choice && (
          <img
            className="employee-preview"
            src={choice.avatar}
            alt={choice.name}
            width={64}
            height={64}
          />
        )}
        <label>
          {copy.name}
          <input
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {copy.title}
          <input
            value={title}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          {copy.role}
          <SelectControl
            value={role}
            required
            onValueChange={(event) => setRole(event)}
          >
            <option value="">{copy.chooseRole}</option>
            {options.roles.map((item) => (
              <option key={item.role_id} value={item.role_id}>
                {item.display_name}（{item.role_id}）
              </option>
            ))}
          </SelectControl>
        </label>
        {options.roles.length === 0 && <p>{copy.noRoles}</p>}
        <label>
          {copy.bio}
          <Textarea
            value={bio}
            rows={3}
            onChange={(event) => setBio(event.target.value)}
          />
        </label>
      </fieldset>
      <RequestFeedback error={error} />
      <div>
        <button
          type="submit"
          disabled={
            busy || reading || Boolean(fileError) || options.roles.length === 0
          }
        >
          {busy ? copy.submitting : copy.submit}
        </button>
      </div>
    </form>
  );
}
