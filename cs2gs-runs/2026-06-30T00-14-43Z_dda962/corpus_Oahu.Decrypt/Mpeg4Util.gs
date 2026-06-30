package Oahu.Decrypt.Mpeg4.Util

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks
import Oahu.Decrypt.Mpeg4.Boxes

class Mpeg4Util {
    shared {
        func LoadTopLevelBoxes(file Stream) List[IBox] {
            let boxes = List[IBox]()
            while file.Position < file.Length && (!boxes.OfType[FtypBox]().Any() || !boxes.OfType[MoovBox]().Any() || !boxes.OfType[MdatBox]().Any()) {
                let box = BoxFactory.CreateBox(file, nil)
                boxes.Add(box!!)
                if box is MdatBox && !boxes.OfType[MoovBox]().Any() {
                    file.Position = box!!.Header.FilePosition + box!!.Header.TotalBoxSize
                }
            }
            return boxes
        }

        async func ShiftDataBlock(file Stream, start int64, length int64, shiftVector int64, progressTracker ProgressTracker? = nil, cancellationToken CancellationToken = default(CancellationToken)) {
            var length = length
            const MoveBufferSize = 8 * 1024 * 1024
            if start + shiftVector < int64(0) {
                throw ArgumentOutOfRangeException(nameof(shiftVector), "Data cannot be shifted to a negative file position.")
            }
            if !file.CanRead || !file.CanWrite || !file.CanSeek {
                throw ArgumentException("Stream must support reading, writing, and seeking.", nameof(file))
            }
            if start > file.Length {
                throw ArgumentOutOfRangeException(nameof(start), "Start index exceeds the file length.")
            }
            if start + length > file.Length {
                throw ArgumentOutOfRangeException(nameof(length), "End of data block is beyond the end of the file.")
            }
            let backToFront = shiftVector > int64(0)
            file.Position = if backToFront { start + length } else { start }
            if progressTracker != nil {
                progressTracker!!.TotalSize = length
                progressTracker!!.MovedBytes = 0
            }
            let buffer Memory[uint8] = [MoveBufferSize]uint8
            var read int32
            do {
                let toRead = int32(Math.Min(MoveBufferSize, length))
                if backToFront {
                    file.Position -= int64(toRead)
                }
                read = await file.ReadAsync(buffer.Slice(0, toRead), cancellationToken)
                file.Position += shiftVector - int64(read)
                await file.WriteAsync(buffer.Slice(0, read), cancellationToken)
                file.Position -= if backToFront { shiftVector + int64(read) } else { shiftVector }
                if progressTracker != nil {
                    progressTracker!!.MovedBytes += int64(read)
                }
                cancellationToken.ThrowIfCancellationRequested()
                length -= int64(read)
            } while length > int64(0)
            progressTracker?.ReportProgress(true)
        }
    }
}

class ProgressTracker {
    private let startTime DateTime = DateTime.UtcNow
    private var nextUpdate DateTime = default
    private var movedBytes int64
    event ProgressUpdated (object?, EventArgs) -> void

    prop MovedBytes int64 {
        get -> movedBytes
        set {
            movedBytes = value
            ReportProgress()
        }
    }

    prop TotalDuration TimeSpan
    prop TotalSize int64
    prop Speed float64
    prop Position TimeSpan

    func ReportProgress(forceReport bool = false) {
        if DateTime.UtcNow > nextUpdate || forceReport {
            Position = TimeSpan.FromSeconds(TotalDuration.TotalSeconds / float64(TotalSize) * float64(MovedBytes))
            Speed = Position / (DateTime.UtcNow - startTime)
            ProgressUpdated?(this, EventArgs.Empty)
            nextUpdate = DateTime.UtcNow.AddMilliseconds(200.0)
        }
    }
}
