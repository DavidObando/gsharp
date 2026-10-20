package GSharp.Core.CodeAnalysis.Compilation

import System
import System.Runtime.ExceptionServices
import System.Threading
import System.Threading.Tasks

/// Bounds independent work within one compilation. Phases share this budget and must join before advancing.
class CompilationWorkBudget {
    private var running int32
    private var active int32
    private var peak int32 = 1
    private var lastPeak int32 = 1

    /// Creates an opt-in worker budget. Memory bounds concurrent workspaces, not the retained syntax or symbol graph.
    init(
        maxWorkers int32 = 1,
        memoryBudgetMiB int32 = 1024,
        cancellationToken CancellationToken = default(CancellationToken)
    ) {
        if maxWorkers < 1 || maxWorkers > 32 {
            throw ArgumentOutOfRangeException("maxWorkers", "Worker count must be between 1 and 32.")
        }
        if memoryBudgetMiB < 256 {
            throw ArgumentOutOfRangeException("memoryBudgetMiB", "Workspace memory budget must be at least 256 MiB.")
        }
        MaxWorkers = Math.Min(
            maxWorkers,
            Math.Min(Environment.ProcessorCount, Math.Max(1, (memoryBudgetMiB - 256) / 96))
        )
        MemoryBudgetMiB = memoryBudgetMiB
        CancellationToken = cancellationToken
    }

    /// Gets the maximum number of concurrent operations, including the calling thread.
    prop MaxWorkers int32 {
        get;
    }

    /// Gets the budget for concurrent workspaces in MiB.
    prop MemoryBudgetMiB int32 {
        get;
    }

    /// Gets cancellation for this request.
    prop CancellationToken CancellationToken {
        get;
    }

    /// Gets the largest observed number of simultaneous operations.
    prop MaxObservedWorkers int32 -> Volatile.Read(&peak)

    /// Gets the observed concurrency of the most recently joined batch.
    prop LastObservedWorkers int32 -> Volatile.Read(&lastPeak)

    /// Executes indexed work and joins all workers. Failures are rethrown in input order.
    /// The action owns its output slot and must not publish mutable state to other actions.
    internal func Run(count int32, action(int32) -> void, workspaceBytes int64 = 100663296) {
        CancellationToken.ThrowIfCancellationRequested()
        if Interlocked.CompareExchange(&running, 1, 0) != 0 {
            throw InvalidOperationException("Compilation phases cannot nest or overlap worker budgets.")
        }
        try {
            Volatile.Write(&lastPeak, 1)
            let available = cast[int64](MemoryBudgetMiB - 256) * 1048576
            let workers = Math.Min(
                count,
                Math.Min(MaxWorkers, cast[int32](Math.Min(32, Math.Max(1, available / Math.Max(1, workspaceBytes)))))
            )
            if workers <= 1 {
                for var i = 0; i < count; i++ {
                    CancellationToken.ThrowIfCancellationRequested()
                    action(i)
                }
                return
            }
            let failures = [count]ExceptionDispatchInfo?
            var next int32 = -1
            CompilationMeasurements.Count("workers.parallel-batches")
            CompilationMeasurements.Count("workers.parallel-items", count)
            Parallel.For(
                0,
                workers,
                ParallelOptions(){MaxDegreeOfParallelism = workers},
                (_ int32) -> {
                    while !CancellationToken.IsCancellationRequested {
                        let index = Interlocked.Increment(&next)
                        if index >= count {
                            break
                        }
                        try {
                            let current = Interlocked.Increment(&active)
                            try {
                                var batchPeak = Volatile.Read(&lastPeak)
                                while current > batchPeak {
                                    let previous = Interlocked.CompareExchange(&lastPeak, current, batchPeak)
                                    if previous == batchPeak {
                                        break
                                    }
                                    batchPeak = previous
                                }
                                var observed = Volatile.Read(&peak)
                                while current > observed {
                                    let previous = Interlocked.CompareExchange(&peak, current, observed)
                                    if previous == observed {
                                        CompilationMeasurements.Count("workers.active", current - observed)
                                        break
                                    }
                                    observed = previous
                                }
                                action(index)
                            } finally {
                                Interlocked.Decrement(&active)
                            }
                        } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
                            failures[index] = ExceptionDispatchInfo.Capture(ex)
                        }
                    }
                }
            )
            CancellationToken.ThrowIfCancellationRequested()
            for failure in failures {
                failure?.Throw()
            }
        } finally {
            Volatile.Write(&running, 0)
        }
    }
}
