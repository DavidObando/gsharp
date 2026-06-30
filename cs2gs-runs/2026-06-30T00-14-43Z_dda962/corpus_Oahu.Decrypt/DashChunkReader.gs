package Oahu.Decrypt.Chunks

import System
import System.Collections.Generic
import System.IO
import System.Linq
import Oahu.Decrypt.FrameFilters
import Oahu.Decrypt.Mpeg4.Boxes
import Oahu.Decrypt.Mpeg4.Chunks

internal open class DashChunkReader : ChunkReader {
    init(dash DashFile, inputStream Stream, startTime TimeSpan, endTime TimeSpan) : base(inputStream, startTime, endTime) {
        ArgumentNullException.ThrowIfNull(dash, nameof(dash))
        ArgumentNullException.ThrowIfNull(inputStream, nameof(inputStream))
        Dash = dash
    }

    private prop Dash DashFile {
        get;
        init;
    }

    open override func AddTrack(track TrakBox, filter FrameFilterBase[FrameEntry]) {
        if TrackEntries.Count > 0 {
            throw InvalidOperationException("The ${nameof(DashChunkReader)} currently only supports a single track.")
        }
        base.AddTrack(track, filter)
    }

    protected open override func CreateFrameEntry(chunk ChunkEntry, frameInChunk int32, frameDelta uint32, frameData Memory[uint8]) FrameEntry {
        let entry = base.CreateFrameEntry(chunk, frameInChunk, frameDelta, frameData)
        let ivs []?[]uint8 = chunk.ExtraData as [][]uint8
        if ivs != nil {
            entry!!.ExtraData = if ivs.Length > frameInChunk { ivs[frameInChunk] } else { throw InvalidDataException("There are only ${ivs.Length} in the chunk, but caller requesting frame at index $frameInChunk.")
                default([]uint8) }
        }
        return entry!!
    }

    protected open override func EnumerateChunks() IEnumerable[ChunkEntry] {
        let singleTrack = TrackEntries.Values.Single()
        let minimumSample = int64((StartTime.TotalSeconds * float64(singleTrack!!.Timescale)))
        let maximumSample = int64((EndTime.TotalSeconds * float64(singleTrack!!.Timescale)))
        return DashChunkEntryies(InputStream, singleTrack!!.TrackId, Dash.Sidx, Dash.FirstMoof, Dash.FirstMdat, minimumSample, maximumSample)
    }
}
