package Oahu.Decrypt.FrameFilters.Video

import System.Threading.Tasks

internal open class VideoPassthrough : FrameFinalBase[FrameEntry] {
    protected open override prop InputBufferSize int32 -> 1

    open override func AddInputAsync(input FrameEntry) Task {
        return Task.CompletedTask
    }

    protected open override func FlushAsync() Task -> Task.CompletedTask
    protected open override func PerformFilteringAsync(input FrameEntry) Task -> Task.CompletedTask
}
