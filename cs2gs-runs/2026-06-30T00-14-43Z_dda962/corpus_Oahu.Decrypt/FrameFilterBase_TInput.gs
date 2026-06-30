package Oahu.Decrypt.FrameFilters

import System
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

open class FrameFilterBase[TInput]() : IDisposable {
    private let filterChannel Channel[BufferEntry] = Channel.CreateBounded[BufferEntry](BoundedChannelOptions(2))
    private var cancellationToken CancellationToken
    private var filterLoop Task?
    private var buffer []TInput
    private var bufferPosition int32 = 0

    init() {
        buffer = [InputBufferSize]TInput
    }

    deinit {
        Dispose(false)
    }

    protected prop Disposed bool

    protected open prop InputBufferSize int32 {
        get;
    }

    open async func AddInputAsync(input TInput) {
        filterLoop ??= Task.Run(Encoder, cancellationToken)
        if cancellationToken.IsCancellationRequested {
            return
        }
        buffer[bufferPosition] = input
        bufferPosition++
        if bufferPosition == InputBufferSize {
            if await filterChannel.Writer.WaitToWriteAsync(cancellationToken) {
                await filterChannel.Writer.WriteAsync(BufferEntry(bufferPosition, buffer), cancellationToken)
                bufferPosition = 0
                buffer = [InputBufferSize]TInput
            }
        }
    }

    func CompleteAsync() Task -> CompleteInternalAsync()

    func Dispose() {
        Dispose(true)
        GC.SuppressFinalize(this)
    }

    open func SetCancellationToken(cancellationToken CancellationToken) -> this.cancellationToken = cancellationToken
    protected open func FlushAsync() Task;
    protected open func HandleInputDataAsync(input TInput) Task;

    protected open async func CompleteInternalAsync() {
        try {
            await filterChannel.Writer.WriteAsync(BufferEntry(bufferPosition, buffer), cancellationToken)
            filterChannel.Writer.Complete()
        } catch (ex OperationCanceledException) {
        }
        if filterLoop != nil {
            await filterLoop
        }
    }

    protected open func Dispose(disposing bool) {
        if disposing && !Disposed {
            if filterLoop?.IsCompleted == false {
                filterChannel.Writer.TryComplete()
            }
        }
        Disposed = true
    }

    private async func Encoder() {
        try {
            while await filterChannel.Reader.WaitToReadAsync(cancellationToken) {
                await for messages in filterChannel.Reader.ReadAllAsync(cancellationToken) {
                    for var i = 0; i < messages!!.NumEntries; i++ {
                        await HandleInputDataAsync(messages!!.Entries[i])
                    }
                }
            }
            await FlushAsync()
        } catch (ex Exception) {
            filterChannel.Writer.Complete(ex)
            throw ex
        }
    }

    private open data class BufferEntry(NumEntries int32, Entries []TInput) {
    }
}
