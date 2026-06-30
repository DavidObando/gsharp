package Oahu.Decrypt.FrameFilters.Audio

import System
import System.Collections.Generic
import System.Threading.Tasks
import Oahu.Decrypt.Mpeg4

open class MultipartFilterBase[TInput FrameEntry, TCallback INewSplitCallback[TCallback]] : FrameFinalBase[TInput] {
    protected let InputStereo bool
    protected let InputSampleRate SampleRate
    private let splitChapters IEnumerator[Chapter]
    private var startSample int64
    private var endSample int64 = -1
    private var lastChunkIndex int64 = -1
    private var currentSample int64

    init(splitChapters ChapterInfo?, inputSampleRate SampleRate, inputStereo bool) {
        if splitChapters == nil || splitChapters!!.Count == 0 {
            throw ArgumentException("${nameof(splitChapters)} must contain at least one chapter.")
        }
        InputSampleRate = inputSampleRate
        InputStereo = inputStereo
        currentSample = TimeToSample(splitChapters!!.StartOffset)
        startSample = currentSample
        this.splitChapters = splitChapters!!.GetEnumerator()
    }

    protected open func CloseCurrentWriter();
    protected open func WriteFrameToFile(audioFrame TInput, newChunk bool);
    protected open func CreateNewWriter(callback TCallback);

    protected override func FlushAsync() Task {
        CloseCurrentWriter()
        return Task.CompletedTask
    }

    protected open override func PerformFilteringAsync(input TInput) Task {
        if input.Chunk == nil {
            WriteFrameToFile(input, false)
        } else if currentSample > endSample {
            CloseCurrentWriter()
            if GetNextChapter() {
                CreateNewWriter(TCallback.Create(splitChapters.Current))
                WriteFrameToFile(input, true)
                lastChunkIndex = input.Chunk!!.ChunkIndex
            }
        } else if currentSample >= startSample {
            let newChunk = int64(input.Chunk!!.ChunkIndex) > lastChunkIndex
            if newChunk {
                lastChunkIndex = input.Chunk!!.ChunkIndex
            }
            WriteFrameToFile(input, newChunk)
        }
        currentSample += int64(input.SamplesInFrame)
        return Task.CompletedTask
    }

    protected open override func Dispose(disposing bool) {
        if disposing && !Disposed {
            splitChapters?.Dispose()
        }
        base.Dispose(disposing)
    }

    private func GetNextChapter() bool {
        if !splitChapters.MoveNext() {
            return false
        }
        startSample = TimeToSample(splitChapters.Current.StartOffset)
        endSample = TimeToSample(splitChapters.Current.EndOffset)
        return true
    }

    private func TimeToSample(time TimeSpan) int64 -> int64(Math.Round(time.TotalSeconds * float64(int32(InputSampleRate))))
}
