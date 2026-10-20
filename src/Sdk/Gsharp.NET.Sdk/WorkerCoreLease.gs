package Gsharp.NET.Sdk.Tools

import Microsoft.Build.Framework
import System
import System.Threading

/// Owns one task's resource grant. Compiler and generator requests must not acquire nested grants.
internal class WorkerCoreLease : IDisposable {
    private let engine IBuildEngine9?
    private var released int32

    private init(engine IBuildEngine9?, grant int32, memoryBudgetMiB int32) {
        this.engine = engine
        Grant = grant
        MemoryBudgetMiB = memoryBudgetMiB
    }

    /// Gets the total grant, including the task's implicit core.
    internal prop Grant int32 {
        get;
    }

    /// Gets the limit for concurrent compiler workspaces, not the compilation's total heap.
    internal prop MemoryBudgetMiB int32 {
        get;
    }

    func Dispose() {
        if Interlocked.Exchange(&released, 1) == 0 {
            engine?.ReleaseCores(Grant)
        }
    }

    shared {
        /// Acquires once. MSBuild guarantees that a task's first request does not block.
        internal func Acquire(
            buildEngine IBuildEngine?,
            requestedWorkers int32,
            memoryBudgetMiB int32,
            cancellationToken CancellationToken
        ) WorkerCoreLease {
            if requestedWorkers < 1 || requestedWorkers > 32 {
                throw ArgumentOutOfRangeException("requestedWorkers", "Worker count must be between 1 and 32.")
            }
            if memoryBudgetMiB < 256 {
                throw ArgumentOutOfRangeException(
                    "memoryBudgetMiB",
                    "Workspace memory budget must be at least 256 MiB."
                )
            }
            cancellationToken.ThrowIfCancellationRequested()
            let requested = Math.Min(
                requestedWorkers,
                Math.Min(Environment.ProcessorCount, Math.Max(1, (memoryBudgetMiB - 256) / 96))
            )
            if buildEngine is not IBuildEngine9 engine {
                return WorkerCoreLease(nil, 1, memoryBudgetMiB)
            }
            let granted = engine.RequestCores(requested)
            let lease = WorkerCoreLease(engine, granted, memoryBudgetMiB)
            try {
                if granted < 1 || granted > requested {
                    throw InvalidOperationException("MSBuild returned an invalid core grant: $granted for $requested.")
                }
                cancellationToken.ThrowIfCancellationRequested()
                return lease
            } catch {
                lease.Dispose()
                rethrow
            }
        }
    }
}
