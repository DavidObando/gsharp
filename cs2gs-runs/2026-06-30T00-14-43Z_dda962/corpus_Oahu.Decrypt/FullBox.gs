package Oahu.Decrypt.Mpeg4.Boxes

import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class FullBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        VersionFlags = file.ReadBlock(4)
    }

    init(versionFlags []uint8, header BoxHeader, parent IBox?) : base(header, parent) {
        VersionFlags = versionFlags
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(4)

    prop Version uint8 {
        get -> VersionFlags[0]
        set -> VersionFlags[0] = value
    }

    prop Flags int32 -> VersionFlags[1] << 16 | VersionFlags[2] << 8 | int32(VersionFlags[3])

    protected prop VersionFlags []uint8 {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        file.Write(VersionFlags)
    }
}
