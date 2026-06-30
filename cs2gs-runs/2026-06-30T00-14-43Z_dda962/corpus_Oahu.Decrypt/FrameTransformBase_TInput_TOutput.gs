package Oahu.Decrypt.FrameFilters

import System.Threading
import System.Threading.Tasks

open class FrameTransformBase[TInput, TOutput] : FrameFilterBase[TInput] {
    private var linked FrameFilterBase[TOutput]?

    open override func SetCancellationToken(cancellationToken CancellationToken) {
        base.SetCancellationToken(cancellationToken)
        linked?.SetCancellationToken(cancellationToken)
    }

    func LinkTo(nextFilter FrameFilterBase[TOutput]) -> linked = nextFilter
    open func PerformFiltering(input TInput) TOutput;
    protected open func PerformFinalFiltering() TOutput? -> default

    protected override async func FlushAsync() {
        if PerformFinalFiltering() is TOutput && linked != nil {
            await linked!!.AddInputAsync((PerformFinalFiltering() as TOutput)!!)
        }
    }

    protected override async func HandleInputDataAsync(input TInput) {
        let filteredData = PerformFiltering(input)
        if linked == nil {
            return
        }
        await linked!!.AddInputAsync(filteredData)
    }

    protected override async func CompleteInternalAsync() {
        await base.CompleteInternalAsync()
        await (linked?.CompleteAsync() ?? Task.CompletedTask)
    }

    protected open override func Dispose(disposing bool) {
        if disposing && !Disposed {
            linked?.Dispose()
        }
        base.Dispose(disposing)
    }
}
