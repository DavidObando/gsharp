package Oahu.Decrypt.FrameFilters.Text

import System
import System.Threading.Tasks

open class ChapterFilter : FrameFinalBase[FrameEntry] {
    event ChapterRead (object?, FrameEntry) -> void
    protected open override prop InputBufferSize int32 -> 1

    open override func AddInputAsync(input FrameEntry) Task {
        ChapterRead?(this, input)
        return Task.CompletedTask
    }

    protected open override func FlushAsync() Task -> Task.CompletedTask
    protected open override func PerformFilteringAsync(input FrameEntry) Task -> Task.CompletedTask
}
