package Oahu.Decrypt

import System
import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Tasks

open class Mp4Operation[TOutput] : Mp4Operation {
    private let continuationFunc (Task) -> TOutput?
    private var continuation Task[TOutput?]?

    internal init(startAction async (CancellationTokenSource) -> void, mp4File Mp4File, continuationFunc (Task) -> TOutput) : base(startAction, mp4File) {
        this.continuationFunc = continuationFunc
    }

    prop OperationTask Task[TOutput?] -> continuation ?? Task.FromResult[TOutput](default)
    protected open override prop Continuation Task -> continuation ?? Task.CompletedTask

    func GetAwaiter() TaskAwaiter[TOutput?] {
        Start()
        return (continuation ?? Task.FromResult[TOutput](default)).GetAwaiter()
    }

    protected open override func SetContinuation(readerTask Task) {
        continuation = readerTask.ContinueWith((t Task) -> {
            if t.IsFaulted {
                continuationFunc(t)
                throw t.Exception
            }
            return continuationFunc(t)
        }, TaskContinuationOptions.ExecuteSynchronously)
    }

    shared {
        func FromCompleted(mp4File Mp4File, result TOutput) Mp4Operation[TOutput] -> Mp4Operation[TOutput]((c CancellationTokenSource) -> Task.CompletedTask, mp4File, (_ Task) -> result)
    }
}
