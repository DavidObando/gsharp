package Oahu.Decrypt.FrameFilters.Audio

import System
import System.IO
import Oahu.Decrypt.Mpeg4
import Oahu.Decrypt.Mpeg4.Boxes

internal open class LosslessMultipartFilter : MultipartFilterBase[FrameEntry, NewSplitCallback] {
    private let ftyp FtypBox
    private let moov MoovBox
    private let newFileCallback (NewSplitCallback) -> void
    private var mp4writer Mp4aWriter?

    init(splitChapters ChapterInfo, ftyp FtypBox, moov MoovBox, newFileCallback (NewSplitCallback) -> void) : base(splitChapters, SampleRate(moov.AudioTrack.Mdia.Mdhd.Timescale), moov.AudioTrack.Mdia.Minf.Stbl.Stsd.AudioSampleEntry?.ChannelCount == (2 as uint16?)) {
        this.ftyp = ftyp
        this.moov = moov
        this.newFileCallback = newFileCallback
    }

    prop CurrentWriterOpen bool
    protected open override prop InputBufferSize int32 -> 1000

    protected open override func CloseCurrentWriter() {
        if !CurrentWriterOpen {
            return
        }
        mp4writer?.Close()
        mp4writer?.OutputFile.Close()
        CurrentWriterOpen = false
    }

    protected open override func WriteFrameToFile(audioFrame FrameEntry, newChunk bool) {
        mp4writer?.AddFrame(audioFrame.FrameData.Span, newChunk, audioFrame.SamplesInFrame)
    }

    protected open override func CreateNewWriter(callback NewSplitCallback) {
        newFileCallback(callback)
        let outfile Stream? = callback.OutputFile as Stream
        if outfile == nil {
            throw InvalidOperationException("Output file stream null")
        }
        CurrentWriterOpen = true
        mp4writer = Mp4aWriter(outfile, ftyp, moov)
        mp4writer!!.RemoveTextTrack()
        if mp4writer!!.Moov.ILst != nil {
            let tags = MetadataItems(mp4writer!!.Moov.ILst!!)
            if callback.TrackNumber.HasValue && callback.TrackCount.HasValue {
                tags!!.TrackNumber = (callback.TrackNumber.Value, callback.TrackCount.Value)
            }
            tags!!.Title = callback.TrackTitle ?? tags!!.Title
        }
    }

    protected open override func Dispose(disposing bool) {
        if disposing && !Disposed {
            CloseCurrentWriter()
        }
        base.Dispose(disposing)
    }
}
