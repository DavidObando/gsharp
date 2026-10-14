// <copyright file="GsharpRuntime.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Globalization
import System.Threading

/// The host-observable surface of G#'s concurrency runtime (ADR-0174 D6/D7):
/// the budgets a host may retune, the diagnostics it may subscribe to, and the
/// counters it may sample. Nothing here changes program semantics — a host that
/// ignores this class gets the documented defaults.
/// @remarks Two situations are reportable rather than fatal. A `defer` body runs
/// under a shielded context with a bounded grace budget (D7); if the budget
/// expires the cleanup is abandoned so cancellation cannot be held hostage by
/// a cleanup that blocks forever, and (cref:DeferGraceExpired) says so.
/// A `scope` whose join outlives (cref:ScopeStallTimeout) raises
/// (cref:ScopeStalled) — the documented partial mitigation for a
/// goroutine that never completes, which no amount of structure can prevent.
shared class GsharpRuntime {
    private var deferGraceExpirations int64
    private var scopeStalls int64

    init {
        DeferGraceBudget = ReadDuration("GSHARP_DEFER_GRACE_MS", TimeSpan.FromSeconds(5))
        ScopeStallTimeout = ReadDuration("GSHARP_SCOPE_STALL_MS", Timeout.InfiniteTimeSpan)
    }

    /// Raised when a `defer` body's shielded grace budget expired and the cleanup was abandoned.
    event DeferGraceExpired EventHandler[DeferGraceExpiredEventArgs]

    /// Raised when a `scope`'s join has been waiting longer than (cref:ScopeStallTimeout).
    event ScopeStalled EventHandler[ScopeStalledEventArgs]

    /// Gets or sets how long a `defer` body may run after its scope was
    /// cancelled before the shield gives up. Defaults to five seconds, or to
    /// `GSHARP_DEFER_GRACE_MS` when that environment variable is set;
    /// (cref:Timeout.InfiniteTimeSpan) disables the budget.
    prop DeferGraceBudget TimeSpan

    /// Gets or sets how long a scope's join may take before
    /// (cref:ScopeStalled) is raised. Defaults to
    /// (cref:Timeout.InfiniteTimeSpan) (no reporting), or to
    /// `GSHARP_SCOPE_STALL_MS` when that environment variable is set.
    /// Reporting never cancels or abandons the join.
    prop ScopeStallTimeout TimeSpan

    /// Gets the number of `defer` bodies abandoned because their grace budget expired.
    prop DeferGraceExpirations int64 -> Volatile.Read(&deferGraceExpirations)

    /// Gets the number of scope joins that outlived (cref:ScopeStallTimeout).
    prop ScopeStalls int64 -> Volatile.Read(&scopeStalls)

    /// Gets the number of goroutines started and not yet completed.
    prop LiveGoroutines int64 -> GoroutineRuntime.LiveGoroutines

    internal func RaiseDeferGraceExpired(budget TimeSpan) {
        Interlocked.Increment(&deferGraceExpirations)
        DeferGraceExpired?(nil, DeferGraceExpiredEventArgs(budget))
    }

    internal func RaiseScopeStalled(waited TimeSpan, pending int32) {
        Interlocked.Increment(&scopeStalls)
        ScopeStalled?(nil, ScopeStalledEventArgs(waited, pending))
    }

    private func ReadDuration(variable string, fallback TimeSpan) TimeSpan {
        let raw = Environment.GetEnvironmentVariable(variable)
        if string.IsNullOrWhiteSpace(raw) || !float64.TryParse(
            raw,
            NumberStyles.Float,
            CultureInfo.InvariantCulture,
            out var milliseconds
        ) ||
            milliseconds < float64(0.0) {
            return fallback
        }
        return TimeSpan.FromMilliseconds(milliseconds)
    }
}
