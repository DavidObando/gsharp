package Oahu.Decrypt.FrameFilters.Audio

import System.IO
import System.Threading.Tasks

internal open class LosslessFilter : FrameFinalBase[FrameEntry] {
    let Mp4aWriter Mp4aWriter
    private let chapterQueue ChapterQueue
    private var lastChunkIndex int64 = -1

    init(outputStream Stream, mp4Audio Mp4File, chapterQueue ChapterQueue) {
        Mp4aWriter = Mp4aWriter(outputStream, mp4Audio.Ftyp, mp4Audio.Moov)
        this.chapterQueue = chapterQueue
    }

    prop Closed bool
    protected open override prop InputBufferSize int32 -> 1000

    protected open override func FlushAsync() Task {
        while chapterQueue.TryGetNextChapter(out var chapterEntry) {
            Mp4aWriter.WriteChapter(chapterEntry!!)
        }
        CloseWriter()
        return Task.CompletedTask
    }

    protected open override func PerformFilteringAsync(input FrameEntry) Task {
        let chunkIndex = input.Chunk?.ChunkIndex ?? uint32(lastChunkIndex)
        var newChunk = chunkIndex > lastChunkIndex
        while chapterQueue.TryGetNextChapter(out var chapterEntry) {
            Mp4aWriter.WriteChapter(chapterEntry!!)
            newChunk = true
        }
        Mp4aWriter.AddFrame(input.FrameData.Span, newChunk, input.SamplesInFrame)
        lastChunkIndex = chunkIndex
        return Task.CompletedTask
    }

    protected open override func Dispose(disposing bool) {
        if disposing && !Disposed {
            CloseWriter()
            Mp4aWriter?.Dispose()
        }
        base.Dispose(disposing)
    }

    private func CloseWriter() {
        if Closed {
            return
        }
        Mp4aWriter.Close()
        Closed = true
    }
}
