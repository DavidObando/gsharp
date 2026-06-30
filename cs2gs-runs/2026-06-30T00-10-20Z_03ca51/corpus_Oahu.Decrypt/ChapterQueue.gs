package Oahu.Decrypt

import System
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Text
import Oahu.Decrypt.FrameFilters
import Oahu.Decrypt.Mpeg4

class ChapterEntry {
    init(title string) {
        ArgumentNullException.ThrowIfNull(title, nameof(title))
        Title = title
    }

    prop FrameData Memory[uint8] {
        get;
        init;
    }

    prop SamplesInFrame uint32 {
        get;
        init;
    }

    prop Title string {
        get;
        init;
    }
}

class ChapterQueue {
    private let sampleScaleFactor float64
    private let outputSampleRate SampleRate
    private let lockObj object = System.Object()
    private let chapterEntries Queue[ChapterEntry] = Queue[ChapterEntry]()
    private var subtractNext int32 = 0

    init(inputRate SampleRate, outputRate SampleRate) {
        outputSampleRate = outputRate
        sampleScaleFactor = float64(outputRate) / float64(inputRate)
    }

    func TryGetNextChapter(out chapterEntry ChapterEntry?) bool {
        {
            Monitor.Enter(lockObj)
            try {
                if chapterEntries.Count > 0 {
                    chapterEntry = chapterEntries.Dequeue()
                    return true
                }
            } finally {
                Monitor.Exit(lockObj)
            }
        }
        chapterEntry = nil
        return false
    }

    func AddRange(chapters IEnumerable[Chapter]) {
        for ch in chapters {
            Add(ch!!)
        }
    }

    func Add(chapter Chapter) {
        let frameData = [chapter.RenderSize]uint8
        using let ms = MemoryStream(frameData)
        chapter.WriteChapter(ms!!)
        let sampleDelta = uint32((chapter.Duration.TotalSeconds * float64(int32(outputSampleRate))))
        {
            Monitor.Enter(lockObj)
            try {
                chapterEntries.Enqueue(ChapterEntry(chapter.Title))
            } finally {
                Monitor.Exit(lockObj)
            }
        }
    }

    func Add(entry FrameEntry) {
        let frameData ReadOnlySpan[uint8] = entry.FrameData.Span
        var title = String.Empty
        if frameData.Length >= 2 {
            var size = (frameData[0] << 8) | int32(frameData[1])
            if size > frameData.Length - 2 {
                size = frameData.Length - 2
            }
            if size > 0 {
                title = Encoding.UTF8.GetString(frameData.Slice(2, size))
            }
        }
        let sif = int32(entry.SamplesInFrame)
        {
            Monitor.Enter(lockObj)
            try {
                chapterEntries.Enqueue(ChapterEntry(title))
            } finally {
                Monitor.Exit(lockObj)
            }
        }
        subtractNext = if sif < 0 { sif } else { 0 }
    }
}
