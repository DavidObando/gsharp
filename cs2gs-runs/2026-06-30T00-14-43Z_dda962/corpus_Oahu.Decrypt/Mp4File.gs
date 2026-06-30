package Oahu.Decrypt

import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Oahu.Decrypt.Chunks
import Oahu.Decrypt.FrameFilters
import Oahu.Decrypt.FrameFilters.Audio
import Oahu.Decrypt.FrameFilters.Text
import Oahu.Decrypt.Mpeg4
import Oahu.Decrypt.Mpeg4.Boxes
import Oahu.Decrypt.Mpeg4.Util

enum FileType { Aax, Aaxc, Mpeg4, Dash }
enum SampleRate { Hz_96000, Hz_88200, Hz_64000, Hz_48000, Hz_44100, Hz_32000, Hz_24000, Hz_22050, Hz_16000, Hz_12000, Hz_11025, Hz_8000, Hz_7350 }

open class Mp4File : Mpeg4File {
    init(file Stream, fileSize int64) : base(file, fileSize) {
        FileType = if Ftyp.CompatibleBrands.Any((b string) -> b == "dash") { FileType.Dash } else { (switch Ftyp.MajorBrand {
            case "aax ": FileType.Aax
            case "aaxc": FileType.Aaxc
            default: FileType.Mpeg4
        }) }
    }

    convenience init(file Stream) {
        init(file, file.Length)
    }

    convenience init(fileName string, access FileAccess = 1, share FileShare = 1) {
        init(File.Open(fileName, FileMode.Open, access, share))
    }

    prop FileType FileType {
        get;
        init;
    }

    prop SampleRate SampleRate -> SampleRate(TimeScale)
    open func GetAudioFrameFilter() FrameTransformBase[FrameEntry, FrameEntry] -> AacValidateFilter()

    func SaveAsync(keepMoovInFront bool = true) Mp4Operation {
        let tracker = ProgressTracker{TotalDuration: Duration}
        let operation = Mp4Operation((t CancellationTokenSource) -> SaveAsync(keepMoovInFront, tracker, t.Token), this, (t Task) -> {
        })
        tracker.ProgressUpdated += (_ object?, _ EventArgs) -> operation.OnProgressUpdate(ConversionProgressEventArgs(TimeSpan.Zero, tracker.TotalDuration, tracker.Position, tracker.Speed))
        return operation
    }

    func ConvertToMp4aAsync(outputStream Stream, userChapters ChapterInfo? = nil) Mp4Operation {
        let start = userChapters?.StartOffset ?? TimeSpan.Zero
        let end = userChapters?.EndOffset ?? TimeSpan.MaxValue
        let chapterQueue = ChapterQueue(SampleRate, SampleRate)
        if userChapters != nil {
            if Moov.TextTrack == nil {
                Moov.CreateEmptyTextTrack()
            }
            chapterQueue.AddRange(userChapters!!)
        }
        let filter1 = GetAudioFrameFilter()
        let filter2 = LosslessFilter(outputStream, this, chapterQueue)
        filter1.LinkTo(filter2)
        if Moov.TextTrack != nil && userChapters == nil {
            let c1 = ChapterFilter()
            c1.ChapterRead += (_ object?, e FrameEntry) -> chapterQueue.Add(e)
            let Continuation = func (t Task) {
                filter1.Dispose()
                c1.Dispose()
                outputStream.Close()
            }
            return ProcessAudio(start, end, Continuation, (Moov.AudioTrack, filter1), (Moov.TextTrack!!, c1))
        } else {
            let Continuation = func (t Task) {
                filter1.Dispose()
                outputStream.Close()
            }
            return ProcessAudio(start, end, Continuation, (Moov.AudioTrack, filter1))
        }
    }

    func ConvertToMultiMp4aAsync(userChapters ChapterInfo, newFileCallback (NewSplitCallback) -> void) Mp4Operation {
        let f1 = GetAudioFrameFilter()
        let f2 = LosslessMultipartFilter(userChapters, Ftyp, Moov, newFileCallback)
        f1.LinkTo(f2)
        let Continuation = func (t Task) {
            f1.Dispose()
        }
        return ProcessAudio(userChapters.StartOffset, userChapters.EndOffset, Continuation, (Moov.AudioTrack, f1))
    }

    func GetChapterInfoAsync() Mp4Operation[ChapterInfo?] {
        let textTrack TrakBox? = Moov.TextTrack as TrakBox
        if textTrack == nil {
            return Mp4Operation[ChapterInfo?].FromCompleted(this, nil)
        }
        let chapterFilter = ChapterFilter()
        let chapterQueue = ChapterQueue(SampleRate, SampleRate)
        chapterFilter.ChapterRead += (s object?, e FrameEntry) -> chapterQueue.Add(e)
        let Continuation = func (t Task) ChapterInfo? {
            let chapters = ChapterInfo()
            while chapterQueue.TryGetNextChapter(out var ch) {
                chapters.AddChapter(ch!!.Title, TimeSpan.FromSeconds(float64(ch!!.SamplesInFrame) / float64(SampleRate)))
            }
            chapterFilter.Dispose()
            Chapters ??= chapters
            return chapters
        }
        return ProcessAudio(TimeSpan.Zero, TimeSpan.MaxValue, Continuation!!, (Moov.TextTrack!!, chapterFilter))
    }

    open func ProcessAudio(startTime TimeSpan, endTime TimeSpan, continuation (Task) -> void, filters ...(TrakBox, FrameFilterBase[FrameEntry])) Mp4Operation {
        let reader = CreateChunkReader(InputStream, startTime, Mp4File.Min(Duration, endTime))
        for __decon0 in filters {
            let (track, filter) = __decon0
            reader.AddTrack(track, filter)
        }
        let operation = Mp4Operation(reader.RunAsync, this, continuation)
        reader.OnProgressUpdateDelegate = operation!!.OnProgressUpdate
        return operation!!
    }

    func ProcessAudio[TResult](startTime TimeSpan, endTime TimeSpan, continuation (Task) -> TResult, filters ...(TrakBox, FrameFilterBase[FrameEntry])) Mp4Operation[TResult] {
        let reader = CreateChunkReader(InputStream, startTime, Mp4File.Min(Duration, endTime))
        for __decon1 in filters {
            let (track, filter) = __decon1
            reader.AddTrack(track, filter)
        }
        let operation = Mp4Operation[TResult](reader.RunAsync, this, continuation)
        reader.OnProgressUpdateDelegate = operation!!.OnProgressUpdate
        return operation!!
    }

    protected open func CreateChunkReader(inputStream Stream, startTime TimeSpan, endTime TimeSpan) IChunkReader -> ChunkReader(inputStream, startTime, endTime)

    shared {
        func RelocateMoovAsync(mp4FilePath string) Mp4Operation {
            let tracker = ProgressTracker()
            let moovMover Mp4Operation? = Mp4Operation((t CancellationTokenSource) -> Mpeg4File.RelocateMoovToBeginningAsync(mp4FilePath, tracker, t.Token), nil, (t Task) -> {
            })
            tracker.ProgressUpdated += (_ object?, _ EventArgs) -> moovMover!!.OnProgressUpdate(ConversionProgressEventArgs(TimeSpan.Zero, tracker.TotalDuration, tracker.Position, tracker.Speed))
            return moovMover!!
        }

        private func Min(t1 TimeSpan, t2 TimeSpan) TimeSpan -> if t1 > t2 { t2 } else { t1 }
    }
}
