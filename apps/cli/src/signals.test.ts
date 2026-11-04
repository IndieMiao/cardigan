import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import type { SignalHost, SpawnedChild } from "./io.js";
import {
  FORWARDED_SIGNALS,
  forwardSignals,
  IGNORED_SIGNALS,
} from "./signals.js";

function recordingHost(): SignalHost & { emit(signal: string): void } {
  const emitter = new EventEmitter();
  return {
    on: (signal, listener) => emitter.on(signal, listener),
    off: (signal, listener) => emitter.off(signal, listener),
    emit: (signal) => {
      emitter.emit(signal);
    },
  };
}

function recordingChild(): SpawnedChild & { signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = [];
  return {
    pid: 1234,
    exit: new Promise<number>(() => {}),
    kill: (signal) => {
      signals.push(signal);
    },
    signals,
  };
}

describe("forwardSignals", () => {
  test("ignores SIGINT and SIGQUIT while the child runs", () => {
    const host = recordingHost();
    const child = recordingChild();
    forwardSignals(child, host);

    for (const signal of IGNORED_SIGNALS) {
      host.emit(signal);
    }
    expect(child.signals).toEqual([]);
  });

  test("forwards SIGTERM and SIGHUP to the child", () => {
    const host = recordingHost();
    const child = recordingChild();
    forwardSignals(child, host);

    for (const signal of FORWARDED_SIGNALS) {
      host.emit(signal);
    }
    expect(child.signals).toEqual([...FORWARDED_SIGNALS]);
  });

  test("removes every handler on dispose", () => {
    const host = recordingHost();
    const child = recordingChild();
    const dispose = forwardSignals(child, host);
    dispose();

    for (const signal of [...IGNORED_SIGNALS, ...FORWARDED_SIGNALS]) {
      host.emit(signal);
    }
    expect(child.signals).toEqual([]);
  });

  test("survives a child that already exited", () => {
    const host = recordingHost();
    const child: SpawnedChild = {
      pid: undefined,
      exit: Promise.resolve(0),
      kill: () => {
        throw new Error("ESRCH");
      },
    };
    forwardSignals(child, host);
    for (const signal of FORWARDED_SIGNALS) {
      expect(() => host.emit(signal)).not.toThrow();
    }
  });
});
