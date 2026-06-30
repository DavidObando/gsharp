package Oahu.Decrypt

import System
import System.Linq
import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Tasks

open class Mp4Operation {
    private let cancellationSource CancellationTokenSource = CancellationTokenSource()
    private let startAction async (CancellationTokenSource) -> void
    private let continuationAction ((Task) -> void)?
    private var lastArgs ConversionProgressEventArgs?
    private var continuation Task?
    private var readerTask Task?

    internal convenience init(startAction async (CancellationTokenSource) -> void, mp4File Mp4File?, continuationTask (Task) -> void) {
        init(startAction, mp4File)
        continuationAction = continuationTask
    }

    protected init(startAction async (CancellationTokenSource) -> void, mp4File Mp4File?) {
        this.startAction = startAction
        Mp4File = mp4File
    }

    event ConversionProgressUpdate (object?, ConversionProgressEventArgs) -> void
    prop IsCompleted bool -> Continuation?.IsCompleted == true
    prop IsFaulted bool -> readerTask?.IsFaulted == true
    prop IsCanceled bool -> readerTask?.IsCanceled == true
    prop IsCompletedSuccessfully bool -> readerTask?.IsCompletedSuccessfully == true && Continuation?.IsCompletedSuccessfully == true
    prop CurrentProcessPosition TimeSpan -> lastArgs?.ProcessPosition ?? TimeSpan.Zero
    prop ProcessSpeed float64 -> lastArgs?.ProcessSpeed ?? float64(0.0)
    prop TaskStatus TaskStatus -> readerTask?.Status ?? TaskStatus.Created
    prop OperationTask Task -> Continuation

    prop Mp4File Mp4File? {
        get;
        init;
    }

    protected open prop Continuation Task? -> continuation ?? Task.CompletedTask

    func CancelAsync() Task {
        cancellationSource.Cancel()
        return if Continuation == nil { Task.FromCanceled(cancellationSource.Token) } else { Continuation!! }
    }

    func Start() {
        if readerTask == nil {
            readerTask = Task.Run(() -> startAction(cancellationSource))
            SetContinuation(readerTask!!)
        }
    }

    func GetAwaiter() ConfiguredTaskAwaitable.ConfiguredTaskAwaiter {
        Start()
        return Continuation!!.ConfigureAwait(false).GetAwaiter()
    }

    internal func OnProgressUpdate(args ConversionProgressEventArgs) {
        lastArgs = args
        ConversionProgressUpdate?(this, args)
    }

    protected open func SetContinuation(readerTask Task) {
        continuation = readerTask.ContinueWith((t Task) -> {
            try {
                continuationAction?(t)
            } catch (ex Exception) {
                if t.Exception == nil && !t.IsCanceled {
                    throw ex
                }
                if t.Exception != nil {
                    throw AggregateException("Two or more errors occurred.", t.Exception!!.InnerExceptions.Append(ex))
                }
                throw ex
            }
            if t.IsFaulted && t.Exception != nil {
                throw t.Exception
            }
            if t.IsCanceled {
                throw TaskCanceledException("The decryption operation was cancelled.", nil, cancellationSource.Token)
            }
        }, TaskContinuationOptions.ExecuteSynchronously)
    }

    shared {
        func FromCompleted(mp4File Mp4File?) Mp4Operation -> Mp4Operation((c CancellationTokenSource) -> Task.CompletedTask, mp4File, (_ Task) -> {
        })
    }
}
