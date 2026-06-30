package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.IO
import System.Threading
import System.Threading.Tasks
import Oahu.Decrypt.Mpeg4.Util

open class MdatBox : Box {
    init(header BoxHeader) : base(header, nil) {
    }

    async func ShiftMdatAsync(file Stream, shiftVector int64, progressTracker ProgressTracker? = nil, cancellationToken CancellationToken = default(CancellationToken)) {
        await Mpeg4Util.ShiftDataBlock(file, Header.FilePosition, Header.TotalBoxSize, shiftVector, progressTracker, cancellationToken).ConfigureAwait(false)
        this.Header.FilePosition += shiftVector
    }

    protected open override func Render(file Stream) {
        throw NotSupportedException()
    }
}
