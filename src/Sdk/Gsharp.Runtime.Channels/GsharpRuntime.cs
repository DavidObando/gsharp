// <copyright file="GsharpRuntime.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Globalization;

namespace Gsharp.Concurrency;

/// <summary>
/// The host-observable surface of G#'s concurrency runtime (ADR-0174 D6/D7):
/// the budgets a host may retune, the diagnostics it may subscribe to, and the
/// counters it may sample. Nothing here changes program semantics — a host that
/// ignores this class gets the documented defaults.
/// </summary>
/// <remarks>
/// Two situations are reportable rather than fatal. A <c>defer</c> body runs
/// under a shielded context with a bounded grace budget (D7); if the budget
/// expires the cleanup is abandoned so cancellation cannot be held hostage by
/// a cleanup that blocks forever, and <see cref="DeferGraceExpired"/> says so.
/// A <c>scope</c> whose join outlives <see cref="ScopeStallTimeout"/> raises
/// <see cref="ScopeStalled"/> — the documented partial mitigation for a
/// goroutine that never completes, which no amount of structure can prevent.
/// </remarks>
public static class GsharpRuntime
{
    private static long deferGraceExpirations;
    private static long scopeStalls;

    static GsharpRuntime()
    {
        DeferGraceBudget = ReadDuration("GSHARP_DEFER_GRACE_MS", TimeSpan.FromSeconds(5));
        ScopeStallTimeout = ReadDuration("GSHARP_SCOPE_STALL_MS", Timeout.InfiniteTimeSpan);
    }

    /// <summary>Raised when a <c>defer</c> body's shielded grace budget expired and the cleanup was abandoned.</summary>
    public static event EventHandler<DeferGraceExpiredEventArgs>? DeferGraceExpired;

    /// <summary>Raised when a <c>scope</c>'s join has been waiting longer than <see cref="ScopeStallTimeout"/>.</summary>
    public static event EventHandler<ScopeStalledEventArgs>? ScopeStalled;

    /// <summary>
    /// Gets or sets how long a <c>defer</c> body may run after its scope was
    /// cancelled before the shield gives up. Defaults to five seconds, or to
    /// <c>GSHARP_DEFER_GRACE_MS</c> when that environment variable is set;
    /// <see cref="Timeout.InfiniteTimeSpan"/> disables the budget.
    /// </summary>
    public static TimeSpan DeferGraceBudget { get; set; }

    /// <summary>
    /// Gets or sets how long a scope's join may take before
    /// <see cref="ScopeStalled"/> is raised. Defaults to
    /// <see cref="Timeout.InfiniteTimeSpan"/> (no reporting), or to
    /// <c>GSHARP_SCOPE_STALL_MS</c> when that environment variable is set.
    /// Reporting never cancels or abandons the join.
    /// </summary>
    public static TimeSpan ScopeStallTimeout { get; set; }

    /// <summary>Gets the number of <c>defer</c> bodies abandoned because their grace budget expired.</summary>
    public static long DeferGraceExpirations => Volatile.Read(ref deferGraceExpirations);

    /// <summary>Gets the number of scope joins that outlived <see cref="ScopeStallTimeout"/>.</summary>
    public static long ScopeStalls => Volatile.Read(ref scopeStalls);

    /// <summary>Gets the number of goroutines started and not yet completed.</summary>
    public static long LiveGoroutines => GoroutineRuntime.LiveGoroutines;

    internal static void RaiseDeferGraceExpired(TimeSpan budget)
    {
        Interlocked.Increment(ref deferGraceExpirations);
        DeferGraceExpired?.Invoke(null, new DeferGraceExpiredEventArgs(budget));
    }

    internal static void RaiseScopeStalled(TimeSpan waited, int pending)
    {
        Interlocked.Increment(ref scopeStalls);
        ScopeStalled?.Invoke(null, new ScopeStalledEventArgs(waited, pending));
    }

    private static TimeSpan ReadDuration(string variable, TimeSpan fallback)
    {
        var raw = Environment.GetEnvironmentVariable(variable);
        if (string.IsNullOrWhiteSpace(raw)
            || !double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var milliseconds)
            || milliseconds < 0)
        {
            return fallback;
        }

        return TimeSpan.FromMilliseconds(milliseconds);
    }
}
