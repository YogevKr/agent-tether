import test from "node:test";
import assert from "node:assert/strict";
import { runWorkerLane } from "../src/worker.js";

test("When multiple worker lanes run, then jobs for different sessions can execute in parallel", async () => {
  const blockers = new Map([
    ["job-1", createDeferred()],
    ["job-2", createDeferred()],
  ]);
  const startedSessions = [];
  let activeJobs = 0;
  let maxActiveJobs = 0;
  let stop = false;
  const pulls = [
    {
      job: { id: "job-1", kind: "run-turn" },
      session: { id: "session-1" },
    },
    {
      job: { id: "job-2", kind: "run-turn" },
      session: { id: "session-2" },
    },
  ];
  const bothStarted = createDeferred();

  const pullNextJob = async () => pulls.shift() || null;
  const executeJob = async (job, session) => {
    startedSessions.push(session.id);
    activeJobs += 1;
    maxActiveJobs = Math.max(maxActiveJobs, activeJobs);

    if (startedSessions.length === 2) {
      bothStarted.resolve();
    }

    await blockers.get(job.id).promise;
    activeJobs -= 1;
  };
  const sleep = async () => {
    stop = true;
  };
  const shouldContinue = () => !stop;

  const laneOne = runWorkerLane({
    pullNextJob,
    executeJob,
    sleep,
    shouldContinue,
  });
  const laneTwo = runWorkerLane({
    pullNextJob,
    executeJob,
    sleep,
    shouldContinue,
  });

  await bothStarted.promise;
  stop = true;
  blockers.get("job-1").resolve();
  blockers.get("job-2").resolve();
  await Promise.all([laneOne, laneTwo]);

  assert.deepEqual(startedSessions.sort(), ["session-1", "session-2"]);
  assert.equal(maxActiveJobs, 2);
});

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve,
  };
}
