import { type ContainmentController, type ContainmentReason } from '../../../packages/sentinel-runtime/src/index.js';

/**
 * Execution-broker containment adapter contract (sections 46, 100). Documented limitation, not a
 * partial implementation pretending otherwise:
 *
 * `ExecutionBroker.redeem()` (packages/execution-broker) runs a tool invocation to completion inside
 * one call and exposes no external cancellation handle; `IsolationRunner.run()` (packages/
 * isolation-runner) is likewise a single run-to-completion `Promise` with no kill/abort surface.
 * Neither can be safely reached into from outside without modifying accepted, already-verified code
 * — which this milestone does not do (see the closure instructions and TNA-25 preserved elsewhere).
 *
 * Rather than fabricate a `hold`/`terminate` that silently does nothing while claiming success (a
 * direct violation of TNA-30), this adapter honestly reports containment as unconfirmed: it always
 * throws, so `SentinelRuntime` correctly resolves the session to INDETERMINATE (never TERMINATED)
 * whenever it is the wired containment controller. Real broker/runner termination is future work —
 * it requires an accepted-code change (an abort signal threaded through `redeem`/`run`) that is out
 * of scope here. Tests and the demo use `FakeContainmentController` for confirmed containment paths.
 */
export class ExecutionBrokerContainmentAdapter implements ContainmentController {
  public hold(sessionId: string, reason: ContainmentReason): never {
    void sessionId; void reason;
    throw new Error('ExecutionBrokerContainmentAdapter cannot confirm hold: the accepted broker/isolation-runner expose no external pause mechanism');
  }
  public terminate(sessionId: string, reason: ContainmentReason): never {
    void sessionId; void reason;
    throw new Error('ExecutionBrokerContainmentAdapter cannot confirm termination: the accepted broker/isolation-runner expose no external cancellation mechanism');
  }
}
