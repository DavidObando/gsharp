package Oahu.Decrypt.Mpeg4

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks
import Oahu.Decrypt.Mpeg4.Boxes
import Oahu.Decrypt.Mpeg4.Chunks
import Oahu.Decrypt.Mpeg4.Util

open class Mpeg4File : IDisposable {
    private let lazyMetadataItems Lazy[MetadataItems]
    private var disposed int32
    private var timescale int32? = nil
    private var audioChannels int32? = nil
    private var averageBitrate int32? = nil

    convenience init(file Stream) {
        init(file, file.Length)
    }

    convenience init(fileName string, access FileAccess = 1, share FileShare = 1) {
        init(File.Open(fileName, FileMode.Open, access, share))
    }

    init(file Stream, fileSize int64) {
        InputStream = if file.CanSeek { file } else { TrackedReadStream(file, fileSize) }
        TopLevelBoxes = Mpeg4Util.LoadTopLevelBoxes(InputStream)
        Ftyp = TopLevelBoxes.OfType[FtypBox]().Single()
        Moov = TopLevelBoxes.OfType[MoovBox]().Single()
        Mdat = TopLevelBoxes.OfType[MdatBox]().Single()
        lazyMetadataItems = Lazy[MetadataItems](() -> MetadataItems(Moov.ILst ?? Moov.CreateEmptyMetadata()))
        AudioSampleEntry = Moov.AudioTrack.Mdia.Minf.Stbl.Stsd.AudioSampleEntry ?? throw InvalidOperationException("The audio track's AudioSampleEntry is null")
    }

    deinit {
        Dispose(false)
    }

    prop Chapters ChapterInfo?

    prop InputStream Stream {
        get;
        init;
    }

    prop Ftyp FtypBox

    prop Moov MoovBox {
        get;
        init;
    }

    prop Mdat MdatBox {
        get;
        init;
    }

    prop MetadataItems MetadataItems -> lazyMetadataItems.Value
    open prop Duration TimeSpan -> TimeSpan.FromSeconds(float64(Moov.AudioTrack.Mdia.Mdhd.Duration) / float64(TimeScale))
    prop MaxBitrate int32 -> int32((AudioSampleEntry.Esds?.ES_Descriptor.DecoderConfig.MaxBitrate ?? uint32(0)))

    prop AudioSampleEntry AudioSampleEntry {
        get;
        init;
    }

    prop TopLevelBoxes List[IBox] {
        get;
        init;
    }

    prop TimeScale int32 -> AudioSampleEntry.Esds?.ES_Descriptor.DecoderConfig.AudioSpecificConfig.SamplingFrequency ?? AudioSampleEntry.Dec3?.SampleRate ?? AudioSampleEntry.Dac4?.SampleRate ?? int32(Moov.AudioTrack.Mdia.Mdhd.Timescale)
    prop AudioChannels int32 -> AudioSampleEntry.Esds?.ES_Descriptor.DecoderConfig.AudioSpecificConfig.ChannelConfiguration ?? AudioSampleEntry.Dec3?.NumberOfChannels ?? AudioSampleEntry.Dac4?.NumberOfChannels ?? int32(AudioSampleEntry.ChannelCount)
    prop AverageBitrate int32 -> int32((AudioSampleEntry.Esds?.ES_Descriptor.DecoderConfig.AverageBitrate ?? AudioSampleEntry.Dec3?.AverageBitrate ?? AudioSampleEntry?.Dac4?.AverageBitrate ?? CalculateBitrate()))
    protected prop Disposed bool -> disposed != 0

    async func SaveAsync(keepMoovInFront bool = true, progressTracker ProgressTracker? = nil, cancellationToken CancellationToken = default(CancellationToken)) {
        if !InputStream.CanRead || !InputStream.CanWrite || !InputStream.CanSeek {
            throw InvalidOperationException("${nameof(InputStream)} must be readable, writable and seekable to save")
        }
        for box in Moov.GetFreeBoxes() {
            box!!.Parent?.Children.Remove(box!!)
        }
        this.InputStream.Position = 0
        let moovInFront = Moov.Header.FilePosition < Mdat.Header.FilePosition
        if moovInFront {
            var totalSizeChange = Ftyp.RenderSize + Moov.RenderSize - Mdat.Header.FilePosition
            if totalSizeChange == int64(0) {
                Ftyp.Save(InputStream)
                Moov.Save(InputStream)
            } else if int64(FreeBox.MinSize) + totalSizeChange <= int64(0) {
                Ftyp.Save(InputStream)
                Moov.Save(InputStream)
                FreeBox.Create(-totalSizeChange, nil).Save(InputStream)
            } else {
                if keepMoovInFront {
                    totalSizeChange = Moov.ShiftChunkOffsetsWithMoovInFront(totalSizeChange)
                    await Mdat.ShiftMdatAsync(InputStream, totalSizeChange, progressTracker, cancellationToken)
                    this.InputStream.Position = 0
                    Ftyp.Save(InputStream)
                    Moov.Save(InputStream)
                    InputStream.SetLength(Mdat.Header.FilePosition + Mdat.Header.TotalBoxSize)
                } else {
                    let freeBoxSize = Mdat.Header.FilePosition - Ftyp.RenderSize
                    if freeBoxSize < int64(8) {
                        throw InvalidOperationException("Not enough space to write ftyp box before mdat box")
                    }
                    Ftyp.Save(InputStream)
                    FreeBox.Create(freeBoxSize, nil).Save(InputStream)
                    this.InputStream.Position = Mdat.Header.FilePosition + Mdat.Header.TotalBoxSize
                    Moov.Save(InputStream)
                }
            }
        } else {
            var rewriteMoovAtEnd = true
            let ftypSizeChange = Ftyp.RenderSize - Ftyp.Header.TotalBoxSize
            if ftypSizeChange == int64(0) {
                Ftyp.Save(InputStream)
            } else if int64(FreeBox.MinSize) + ftypSizeChange <= int64(0) {
                Ftyp.Save(InputStream)
                FreeBox.Create(-ftypSizeChange, nil).Save(InputStream)
            } else {
                if keepMoovInFront {
                    var shiftVector = ftypSizeChange + Moov.RenderSize
                    shiftVector = Moov.ShiftChunkOffsetsWithMoovInFront(shiftVector)
                    await Mdat.ShiftMdatAsync(InputStream, shiftVector, progressTracker, cancellationToken)
                    this.InputStream.Position = 0
                    Ftyp.Save(InputStream)
                    Moov.Save(InputStream)
                    InputStream.SetLength(Mdat.Header.FilePosition + Mdat.Header.TotalBoxSize)
                    rewriteMoovAtEnd = false
                } else {
                    Moov.ShiftChunkOffsets(ftypSizeChange)
                    await Mdat.ShiftMdatAsync(InputStream, ftypSizeChange, progressTracker, cancellationToken)
                    this.InputStream.Position = 0
                    Ftyp.Save(InputStream)
                }
            }
            if rewriteMoovAtEnd {
                this.InputStream.Position = Mdat.Header.FilePosition + Mdat.Header.TotalBoxSize
                Moov.Save(InputStream)
                InputStream.SetLength(InputStream.Position)
            }
        }
        await InputStream.FlushAsync(cancellationToken)
    }

    func GetChaptersFromMetadata() ChapterInfo? {
        let textTrak TrakBox? = Moov.TextTrack
        let chapterNames List[string]? = textTrak?.GetChild[UdtaBox]()?.GetChild[MetaBox]()?.GetChild[AppleListBox]()?.Children?.OfType[AppleTagBox]()?.Where((b AppleTagBox) -> b.Header.Type == "©nam")?.Select((b AppleTagBox) -> b.Data.ReadAsString())?.ToList()
        if chapterNames == nil {
            return nil
        }
        let sampleTimes = textTrak!!.Mdia.Minf.Stbl.Stts.Samples
        if sampleTimes.Count != chapterNames!!.Count {
            return nil
        }
        let cEntryList = ChunkEntryList(textTrak!!).OrderBy((s ChunkEntry) -> s.ChunkOffset).ToList()
        if cEntryList!!.Count != chapterNames!!.Count {
            return nil
        }
        let chapterInfo = ChapterInfo()
        var subtractNext = 0
        for var i = 0; i < chapterNames!!.Count; i++ {
            let sif = int32(sampleTimes[i].FrameDelta)
            let duration = TimeSpan.FromSeconds(Math.Max(0d, sif + subtractNext) / float64(TimeScale))
            chapterInfo.AddChapter(chapterNames!![int32(cEntryList!![i].ChunkIndex)], duration)
            subtractNext = if sif < 0 { sif } else { 0 }
        }
        Chapters ??= chapterInfo
        return chapterInfo
    }

    func Dispose() {
        Dispose(true)
        GC.SuppressFinalize(this)
    }

    protected open func CalculateBitrate() uint32 {
        let totalSize = Moov.AudioTrack.Mdia.Minf.Stbl.Stsz?.TotalSize
        return if !totalSize.HasValue || totalSize.Value == int64(0) { uint32(0) } else { uint32(Math.Round(float64(totalSize.Value * int64(8)) / Duration.TotalSeconds, 0)) }
    }

    protected open func Dispose(disposing bool) {
        if disposing && Interlocked.CompareExchange(&disposed, 1, 0) == 0 {
            InputStream.Dispose()
            for box in TopLevelBoxes {
                box!!.Dispose()
            }
        }
    }

    shared {
        async func RelocateMoovToBeginningAsync(mp4FilePath string, progressTracker ProgressTracker? = nil, cancellationToken CancellationToken = default(CancellationToken)) {
            var boxes List[IBox]
            {
                using let fileStream = File.OpenRead(mp4FilePath)
                boxes = Mpeg4Util.LoadTopLevelBoxes(fileStream)
            }
            try {
                let ftypeSize = boxes.OfType[FtypBox]().Single().RenderSize
                let moov = boxes.OfType[MoovBox]().Single()
                if progressTracker != nil {
                    progressTracker!!.TotalDuration = TimeSpan.FromSeconds(float64(moov.Mvhd.Duration) / float64(moov.Mvhd.Timescale))
                    if moov.Header.FilePosition == ftypeSize {
                        progressTracker!!.TotalSize = 1
                        progressTracker!!.MovedBytes = progressTracker!!.TotalSize
                        return
                    }
                }
                let mdat = boxes.OfType[MdatBox]().Single()
                let toShift = ftypeSize + moov.RenderSize - mdat!!.Header.FilePosition
                let shifted = moov.ShiftChunkOffsetsWithMoovInFront(toShift)
                using let mpegFile = FileStream(mp4FilePath, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite)
                await mdat!!.ShiftMdatAsync(mpegFile, shifted, progressTracker, cancellationToken)
                mpegFile.Position = ftypeSize
                moov.Save(mpegFile)
                mpegFile.SetLength(mpegFile.Position + mdat!!.Header.TotalBoxSize)
            } finally {
                for box in boxes {
                    box.Dispose()
                }
            }
        }
    }
}
