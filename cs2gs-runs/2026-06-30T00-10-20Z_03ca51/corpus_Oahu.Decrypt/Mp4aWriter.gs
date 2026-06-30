package Oahu.Decrypt.FrameFilters.Audio

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Oahu.Decrypt.Mpeg4.Boxes
import Oahu.Decrypt.Mpeg4.Util

open class Mp4aWriter : IDisposable {
    let Moov MoovBox
    private let mdatStart int64
    private let stts SttsBox
    private let stsc StscBox
    private let audioSampleEntry AudioSampleEntry
    private let audioChunks ChunkOffsetList = ChunkOffsetList()
    private let textChunks ChunkOffsetList = ChunkOffsetList()
    private let audioSampleSizes List[uint16] = List[uint16]()
    private let textSampleSizes List[int32] = List[int32]()
    private let lockObj object = System.Object()
    private let chapterTitles List[string] = List[string]()
    private var lastSamplesPerChunk int64 = -1
    private var samplesPerChunk uint32 = uint32(0)
    private var currentChunk uint32 = uint32(0)
    private var closed bool
    private var closing bool
    private var currentFrameDuration uint32
    private var frameDurationCount uint32
    private var disposed bool = false

    init(outputFile Stream, ftyp FtypBox, moov MoovBox) {
        ArgumentNullException.ThrowIfNull(outputFile, nameof(outputFile))
        ArgumentNullException.ThrowIfNull(ftyp, nameof(ftyp))
        ArgumentNullException.ThrowIfNull(moov, nameof(moov))
        if !outputFile.CanWrite {
            throw ArgumentException("The stream is not writable", nameof(outputFile))
        }
        OutputFile = outputFile
        Moov = Mp4aWriter.MakeBlankMoov(moov)
        stts = Moov.AudioTrack.Mdia.Minf.Stbl.Stts
        stsc = Moov.AudioTrack.Mdia.Minf.Stbl.Stsc
        audioSampleEntry = Moov.AudioTrack.Mdia.Minf.Stbl.Stsd.AudioSampleEntry ?? throw InvalidDataException("Audio track's stsd box does not contain an ${nameof(AudioSampleEntry)}")
        ftyp.Save(OutputFile)
        mdatStart = OutputFile.Position
        OutputFile.WriteUInt32BE(0)
        OutputFile.WriteType("mdat")
        OutputFile.WriteInt64BE(0)
    }

    convenience init(outputFile Stream, ftyp FtypBox, moov MoovBox, ascBytes []uint8) {
        init(outputFile, ftyp, moov)
        ArgumentNullException.ThrowIfNull(ascBytes, nameof(ascBytes))
        audioSampleEntry.Header.ChangeAtomName("mp4a")
        var esds EsdsBox? = audioSampleEntry.Esds as EsdsBox
        if esds != nil {
            audioSampleEntry.Children.Remove(esds)
        }
        let dec3 Dec3Box? = audioSampleEntry.Dec3 as Dec3Box
        if dec3 != nil {
            audioSampleEntry.Children.Remove(dec3)
        }
        esds = EsdsBox.CreateEmpty(audioSampleEntry)
        let asc = esds.ES_Descriptor.DecoderConfig.AudioSpecificConfig
        asc!!.AscBlob = ascBytes
        if asc!!.ChannelConfiguration > 2 {
            throw NotSupportedException("Only supports maximum of 2-channel audio. (Channels=${asc!!.ChannelConfiguration})")
        }
        this.audioSampleEntry.ChannelCount = uint16(asc!!.ChannelConfiguration)
        SetTimeScale(uint32(asc!!.SamplingFrequency))
    }

    deinit {
        Dispose(false)
    }

    prop OutputFile Stream {
        get;
        init;
    }

    func Close() {
        {
            Monitor.Enter(lockObj)
            try {
                if closing {
                    return
                }
                closing = true
            } finally {
                Monitor.Exit(lockObj)
            }
        }
        if closed || !OutputFile.CanWrite {
            return
        }
        let mdatEnd = OutputFile.Position
        let mdatSize = mdatEnd - mdatStart
        this.OutputFile.Position = mdatStart
        if mdatSize <= int64(UInt32.MaxValue) {
            OutputFile.WriteUInt32BE(uint32(mdatSize))
        } else {
            OutputFile.WriteUInt32BE(1)
        }
        OutputFile.WriteType("mdat")
        if mdatSize > int64(UInt32.MaxValue) {
            OutputFile.WriteInt64BE(mdatSize)
        }
        this.OutputFile.Position = mdatEnd
        WriteChapterMetadata(chapterTitles)
        stsc.Samples.Add(StscChunkEntry{FirstChunk: currentChunk, SamplesPerChunk: samplesPerChunk, SampleDescriptionIndex: 1})
        stts.Samples.Add(SttsBox.SampleEntry{FrameCount: frameDurationCount, FrameDelta: currentFrameDuration})
        frameDurationCount = uint32(0)
        Debug.Assert(int64(audioSampleSizes.Count) == stts.Samples.Sum((s SttsBox.SampleEntry) -> s.FrameCount))
        let stsz IStszBox = StszBox.CreateBlank(Moov.AudioTrack.Mdia.Minf.Stbl, audioSampleSizes)
        IChunkOffsets.Create(Moov.AudioTrack.Mdia.Minf.Stbl, audioChunks)
        if Moov.TextTrack != nil {
            IChunkOffsets.Create(Moov.TextTrack!!.Mdia.Minf.Stbl, textChunks)
        }
        SetDuration(uint64(stts.Samples.Sum((s SttsBox.SampleEntry) -> decimal(s.FrameCount) * decimal(s.FrameDelta))))
        let (maxBitRate, avgBitrate) = Mp4aWriter.CalculateBitrate(Moov.AudioTrack.Mdia.Mdhd.Timescale, Moov.AudioTrack.Mdia.Mdhd.Duration, stsz, stts)
        let esds EsdsBox? = audioSampleEntry.Esds as EsdsBox
        if esds != nil {
            esds.ES_Descriptor.DecoderConfig.MaxBitrate = maxBitRate
            esds.ES_Descriptor.DecoderConfig.AverageBitrate = avgBitrate
        }
        if audioSampleEntry.GetChild[BtrtBox]() == nil {
            BtrtBox.Create(0, maxBitRate, avgBitrate, audioSampleEntry)
        }
        SaveMoov()
        closed = true
    }

    func Dispose() {
        Dispose(true)
        GC.SuppressFinalize(this)
    }

    func WriteChapter(entry ChapterEntry) {
        if Moov.TextTrack == nil {
            return
        }
        if Moov.TextTrack!!.Mdia.Minf.Stbl.Stsz == nil {
            StszBox.CreateBlank(Moov.TextTrack!!.Mdia.Minf.Stbl, textSampleSizes)
        }
        if !Moov.TextTrack!!.Mdia.Minf.Stbl.Stsc.Samples.Any() {
            Moov.TextTrack!!.Mdia.Minf.Stbl.Stsc.Samples.Add(StscChunkEntry{FirstChunk: 1, SamplesPerChunk: 1, SampleDescriptionIndex: 1})
        }
        chapterTitles.Add(entry.Title)
        Moov.TextTrack!!.Mdia.Minf.Stbl.Stts.Samples.Add(SttsBox.SampleEntry{FrameCount: 1, FrameDelta: entry.SamplesInFrame})
        textSampleSizes.Add(entry.FrameData.Length)
        textChunks.Add(OutputFile.Position)
        OutputFile.Write(entry.FrameData.Span)
    }

    func RemoveTextTrack() {
        if Moov.TextTrack == nil || !Moov.Children.Remove(Moov.TextTrack!!) {
            return
        }
        var trackNum uint32 = uint32(1)
        let trackRemap Dictionary[uint32, uint32] = Dictionary[uint32, uint32]()
        for t in Moov.GetChildren[TrakBox]().OrderBy((t TrakBox) -> t.Tkhd.TrackID) {
            trackRemap[t!!.Tkhd.TrackID] = trackNum
            t!!.Tkhd.TrackID = trackNum
            trackNum++
        }
        Moov.Mvhd.NextTrackID = trackNum
        for track in Moov.GetChildren[TrakBox]().Select((c TrakBox) -> c.GetChild[TrefBox]()).OfType[TrefBox]() {
            for tref in track!!.References.ToArray() {
                if tref!!.Header.Type == "chap" {
                    track!!.References.Remove(tref!!)
                    continue
                }
                for tid in tref!!.TrackIds.Order().ToArray() {
                    if !trackRemap.TryGetValue(tid, out var remap) {
                        tref!!.TrackIds.Remove(tid)
                    } else if remap != tid {
                        tref!!.TrackIds.Remove(tid)
                        tref!!.TrackIds.Add(remap)
                    }
                }
                if tref!!.TrackIds.Count == 0 {
                    track!!.References.Remove(tref!!)
                }
            }
            if track!!.References.Count == 0 {
                track!!.Parent!!.Children.Remove(track!!)
            }
        }
    }

    func AddFrame(frame Span[uint8], newChunk bool, frameDelta uint32) {
        {
            Monitor.Enter(lockObj)
            try {
                if closing {
                    return
                }
                if newChunk {
                    audioChunks.Add(OutputFile.Position)
                    if samplesPerChunk > uint32(0) && int64(samplesPerChunk) != lastSamplesPerChunk {
                        stsc.Samples.Add(StscChunkEntry{FirstChunk: currentChunk, SamplesPerChunk: samplesPerChunk, SampleDescriptionIndex: 1})
                        lastSamplesPerChunk = samplesPerChunk
                    }
                    samplesPerChunk = uint32(0)
                    currentChunk++
                }
                audioSampleSizes.Add(uint16(frame.Length))
                if currentFrameDuration == uint32(0) {
                    currentFrameDuration = frameDelta
                } else if currentFrameDuration != frameDelta {
                    stts.Samples.Add(SttsBox.SampleEntry{FrameCount: frameDurationCount, FrameDelta: currentFrameDuration})
                    frameDurationCount = uint32(0)
                    currentFrameDuration = frameDelta
                }
                frameDurationCount++
                samplesPerChunk++
            } finally {
                Monitor.Exit(lockObj)
            }
        }
        OutputFile.Write(frame)
    }

    protected open func SaveMoov() {
        Moov.Save(OutputFile)
    }

    private func SetTimeScale(timeScale uint32) {
        Debug.Assert(timeScale <= uint32(UInt16.MaxValue))
        this.audioSampleEntry.SampleRate = uint16(timeScale)
        Moov.AudioTrack.Mdia.Mdhd.Timescale = timeScale
        if Moov.TextTrack != nil {
            Moov.TextTrack!!.Mdia.Mdhd.Timescale = Moov.AudioTrack.Mdia.Mdhd.Timescale
        }
    }

    private func SetDuration(duration uint64) {
        Moov.Mvhd.Duration = duration * uint64(Moov.Mvhd.Timescale) / uint64(Moov.AudioTrack.Mdia.Mdhd.Timescale)
        Moov.AudioTrack.Mdia.Mdhd.Duration = duration
        Moov.AudioTrack.Tkhd.Duration = Moov.Mvhd.Duration
        if Moov.TextTrack != nil {
            Moov.TextTrack!!.Mdia.Mdhd.Duration = Moov.AudioTrack.Mdia.Mdhd.Duration
            Moov.TextTrack!!.Tkhd.Duration = Moov.Mvhd.Duration
        }
    }

    private func WriteChapterMetadata(chapterTitles IEnumerable[string]) {
        if Moov.TextTrack == nil {
            return
        }
        let chapterNames AppleListBox? = Moov.TextTrack?.GetChild[UdtaBox]()?.GetChild[MetaBox]()?.GetChild[AppleListBox]()
        if chapterNames == nil {
            return
        }
        chapterNames!!.Children.Clear()
        for title in chapterTitles {
            chapterNames!!.AddTag("©nam", title!!)
            chapterNames!!.AddTag("©cmt", title!!)
        }
    }

    private func Dispose(disposing bool) {
        if disposing && !disposed {
            Close()
            stsc?.Samples.Clear()
            audioSampleSizes.Clear()
            audioChunks.Clear()
            textChunks.Clear()
            disposed = true
        }
    }

    shared {
        private func CalculateBitrate(timeScale float64, duration uint64, stsz IStszBox, stts SttsBox) (uint32, uint32) {
            let audioBits = stsz.TotalSize * int64(8)
            let avgBitrate = uint32((float64(audioBits) * timeScale / float64(duration)))
            let frameDeltas = stts.EnumerateFrameDeltas().Select((d uint32) -> uint16(d)).ToArray()
            if int64(stts.SampleTimeCount) != int64(stsz.SampleCount) || int64(stts.SampleTimeCount) != int64(frameDeltas!!.Length) {
                throw InvalidOperationException("The number of sample deltas (${stts.SampleTimeCount}) doesn't match the number of sample sizes (${stsz.SampleCount}).")
            }
            var currentWindowSampleSpan int64 = 0
            var windowSizeInBytes int64 = 0
            var maxOneSecondBitrate float64 = 0.0
            {
                var i = 0
                var beginIndex = 0
                while i < stsz.SampleCount {
                    while float64(currentWindowSampleSpan) > timeScale {
                        let bitrate = float64(windowSizeInBytes * int64(8)) * timeScale / float64(currentWindowSampleSpan)
                        if bitrate > maxOneSecondBitrate {
                            maxOneSecondBitrate = bitrate
                        }
                        windowSizeInBytes -= int64(stsz.GetSizeAtIndex(beginIndex))
                        currentWindowSampleSpan -= int64(frameDeltas!![beginIndex])
                        beginIndex++
                    }
                    windowSizeInBytes += int64(stsz.GetSizeAtIndex(i))
                    currentWindowSampleSpan += int64(frameDeltas!![i])
                    i++
                }
            }
            return (uint32(Math.Round(maxOneSecondBitrate)), avgBitrate)
        }

        private func MakeBlankMoov(moov MoovBox) MoovBox {
            var t1 SttsBox? = nil
            var t2 StscBox? = nil
            var t3 IStszBox? = nil
            var t4 IChunkOffsets? = nil
            if moov.TextTrack != nil {
                t1 = moov.TextTrack!!.Mdia.Minf.Stbl.Stts
                t2 = moov.TextTrack!!.Mdia.Minf.Stbl.Stsc
                t3 = moov.TextTrack!!.Mdia.Minf.Stbl.Stsz
                t4 = moov.TextTrack!!.Mdia.Minf.Stbl.COBox
                moov.TextTrack!!.Mdia.Minf.Stbl.Children.Remove(t1!!)
                moov.TextTrack!!.Mdia.Minf.Stbl.Children.Remove(t2!!)
                if t3 != nil {
                    moov.TextTrack!!.Mdia.Minf.Stbl.Children.Remove(t3!!)
                }
                moov.TextTrack!!.Mdia.Minf.Stbl.Children.Remove(t4!!)
            }
            let a1 = moov.AudioTrack.Mdia.Minf.Stbl.Stts
            let a2 = moov.AudioTrack.Mdia.Minf.Stbl.Stsc
            let a3 IStszBox? = moov.AudioTrack.Mdia.Minf.Stbl.Stsz
            let a4 = moov.AudioTrack.Mdia.Minf.Stbl.COBox
            moov.AudioTrack.Mdia.Minf.Stbl.Children.Remove(a1)
            moov.AudioTrack.Mdia.Minf.Stbl.Children.Remove(a2)
            if a3 != nil {
                moov.AudioTrack.Mdia.Minf.Stbl.Children.Remove(a3!!)
            }
            moov.AudioTrack.Mdia.Minf.Stbl.Children.Remove(a4)
            let mvex MvexBox? = moov.GetChild[MvexBox]()
            if mvex != nil {
                moov.Children.Remove(mvex!!)
            }
            let ms = MemoryStream()
            moov.Save(ms)
            if mvex != nil {
                moov.Children.Add(mvex!!)
            }
            moov.AudioTrack.Mdia.Minf.Stbl.Children.Add(a1)
            moov.AudioTrack.Mdia.Minf.Stbl.Children.Add(a2)
            if a3 != nil {
                moov.AudioTrack.Mdia.Minf.Stbl.Children.Add(a3!!)
            }
            moov.AudioTrack.Mdia.Minf.Stbl.Children.Add(a4)
            if moov.TextTrack != nil {
                if t1 != nil {
                    moov.TextTrack!!.Mdia.Minf.Stbl.Children.Add(t1!!)
                }
                if t2 != nil {
                    moov.TextTrack!!.Mdia.Minf.Stbl.Children.Add(t2!!)
                }
                if t3 != nil {
                    moov.TextTrack!!.Mdia.Minf.Stbl.Children.Add(t3!!)
                }
                if t4 != nil {
                    moov.TextTrack!!.Mdia.Minf.Stbl.Children.Add(t4!!)
                }
            }
            ms.Position = 0
            let newMoov = BoxFactory.CreateBox[MoovBox](ms, nil)
            SttsBox.CreateBlank(newMoov.AudioTrack.Mdia.Minf.Stbl)
            StscBox.CreateBlank(newMoov.AudioTrack.Mdia.Minf.Stbl)
            newMoov.AudioTrack.Mdia.Mdhd.ModificationTime = DateTimeOffset.UtcNow
            newMoov.AudioTrack.Mdia.Mdhd.CreationTime = newMoov.AudioTrack.Mdia.Mdhd.ModificationTime
            if newMoov.TextTrack != nil {
                SttsBox.CreateBlank(newMoov.TextTrack!!.Mdia.Minf.Stbl)
                StscBox.CreateBlank(newMoov.TextTrack!!.Mdia.Minf.Stbl)
                newMoov.TextTrack!!.Mdia.Mdhd.ModificationTime = newMoov.AudioTrack.Mdia.Mdhd.CreationTime
                newMoov.TextTrack!!.Mdia.Mdhd.CreationTime = newMoov.TextTrack!!.Mdia.Mdhd.ModificationTime
            }
            return newMoov
        }
    }
}
