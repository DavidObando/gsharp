package Oahu.Decrypt.Mpeg4.Chunks

import System
import System.Collections
import System.Collections.Generic
import System.IO
import System.Linq
import Oahu.Decrypt.Mpeg4.Boxes
import Oahu.Decrypt.Mpeg4.Util

class DashChunkEntryies(InputStream Stream, TrackId uint32, Sidx SidxBox, FirstMoof MoofBox, FirstMdat MdatBox, MinimumSample int64, MaximumSample int64) : IEnumerable[ChunkEntry] {
    func GetEnumerator() IEnumerator[ChunkEntry] -> EnumerateChunks().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()

    private func EnumerateChunks() sequence[ChunkEntry] {
        SkipToFirstMoof(out var moofBox, out var mdatBox, out var startSample)
        let totalDataSize = Sidx.Segments.Sum((s Segment) -> int64(s.ReferenceSize))
        let endOfFile = FirstMoof.Header.FilePosition + totalDataSize
        while InputStream.Position < endOfFile {
            if startSample > MaximumSample {
                break
            }
            let trackChunk = ValidateMdatSize(moofBox!!, mdatBox!!, startSample)
            startSample += trackChunk!!.FrameDurations.Sum((d uint32) -> d)
            if startSample > MinimumSample {
                yield trackChunk
            } else {
                let endOfMdat = InputStream.Position + mdatBox!!.Header.TotalBoxSize - int64(mdatBox!!.Header.HeaderSize)
                InputStream.SeekToOffset(endOfMdat)
            }
            if InputStream.Position < endOfFile {
                moofBox = BoxFactory.CreateBox[MoofBox](InputStream, nil)
                mdatBox = BoxFactory.CreateBox[MdatBox](InputStream, nil)
            }
        }
    }

    private func ValidateMdatSize(moofBox MoofBox, mdatBox MdatBox, startSample int64) ChunkEntry {
        let trun TrunBox? = moofBox.Traf.Trun as TrunBox
        if trun == nil {
            throw InvalidDataException("The ${nameof(TrafBox)} doesn't contain a ${nameof(TrunBox)}")
        }
        let frameSizes = if trun.SampleSizePresent { trun.Samples.Select((s SampleInfo) -> s.SampleSize).OfType[int32]().ToArray() } else { if moofBox.Traf.Tfhd.DefaultSampleSize is uint32 { Enumerable.Repeat(int32(moofBox.Traf.Tfhd.DefaultSampleSize!!), trun.Samples.Length).ToArray() } else { throw InvalidOperationException("Trun sample infos don't contain sample sizes and no default sample size is set.")
            default([]int32) } }
        let mdatSize = mdatBox.Header.TotalBoxSize - int64(mdatBox.Header.HeaderSize)
        if int64(frameSizes!!.Sum()) != mdatSize {
            throw InvalidDataException("Mdat box size doesn't match sample sizes in track fragment")
        }
        if mdatSize > int64(Int32.MaxValue) {
            throw InvalidDataException("Mdat is larger than Int32.MaxValue")
        }
        let frameDurations = if trun.SampleDurationPresent { trun.Samples.Select((s SampleInfo) -> s.SampleDuration).OfType[uint32]().ToArray() } else { if moofBox.Traf.Tfhd.DefaultSampleDuration is uint32 { Enumerable.Repeat(moofBox.Traf.Tfhd.DefaultSampleDuration!!, trun.Samples.Length).ToArray() } else { throw InvalidOperationException("Trun sample infos don't contain sample durations and no default sample duration is set.")
            default([]uint32) } }
        if frameDurations!!.Length != frameSizes!!.Length {
            throw InvalidDataException("The number of frame sizes (${frameSizes!!.Length}) does not match the number of durations (${frameDurations!!.Length}) in fragment ${moofBox.Mfhd.SequenceNumber}")
        }
        var extraData object? = nil
        if moofBox.Traf.Senc != nil {
            extraData = if frameSizes!!.Length == moofBox.Traf.Senc!!!!.IVs.Length { moofBox.Traf.Senc!!!!.IVs } else { throw InvalidDataException("The number of IVs (${moofBox.Traf.Senc!!!!.IVs.Length}) does not match the number of samples (${frameSizes!!.Length}) in fragment ${moofBox.Mfhd.SequenceNumber}")
                default([][]uint8) }
        }
        return ChunkEntry{TrackId: TrackId, ChunkIndex: uint32(moofBox.Mfhd.SequenceNumber), ChunkOffset: InputStream.Position, ChunkSize: int32(mdatSize), FirstSample: startSample, FrameSizes: frameSizes, FrameDurations: frameDurations, ExtraData: extraData}
    }

    private func SkipToFirstMoof(out firstMoof MoofBox, out firstMdat MdatBox, out firstSample int64) {
        let startPosition = FirstMoof.Header.FilePosition
        var dataOffset int64 = 0
        firstSample = 0
        if Sidx.Segments.Any((s Segment) -> s.ReferenceType || !s.StartsWithSAP || s.SapType != 1 || s.SapDeltaTime != 0) {
            throw InvalidOperationException("AAXClean doesn't know how to inrepret segment index boxes other than " + "${nameof(SidxBox.Segment.SapType)} = 1, " + "${nameof(SidxBox.Segment.SapDeltaTime)} = 0, " + "${nameof(SidxBox.Segment.StartsWithSAP)} = 1, " + "${nameof(SidxBox.Segment.ReferenceType)} = 0")
        }
        for segment in Sidx.Segments {
            if MinimumSample < firstSample + int64(segment!!.SubsegmentDuration) {
                break
            }
            dataOffset += int64(segment!!.ReferenceSize)
            firstSample += int64(segment!!.SubsegmentDuration)
        }
        if dataOffset == int64(0) {
            var __decon0 = FirstMoof
            var __decon1 = FirstMdat
            firstMoof = __decon0
            firstMdat = __decon1
        } else {
            InputStream.SeekToOffset(startPosition + dataOffset)
            firstMoof = BoxFactory.CreateBox[MoofBox](InputStream, nil)
            firstMdat = BoxFactory.CreateBox[MdatBox](InputStream, nil)
        }
    }
}
