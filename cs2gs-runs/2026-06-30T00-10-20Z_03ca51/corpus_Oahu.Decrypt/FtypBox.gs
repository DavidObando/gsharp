package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.Collections.Generic
import System.IO
import Oahu.Decrypt.Mpeg4.Util

open class FtypBox : Box {
    init(file Stream, header BoxHeader) : base(header, nil) {
        CompatibleBrands = List[string]()
        let endPos = header.FilePosition + header.TotalBoxSize
        MajorBrand = file.ReadType()
        MajorVersion = file.ReadInt32BE()
        while file.Position < endPos {
            CompatibleBrands.Add(file.ReadType())
        }
    }

    private init(header BoxHeader, majorBrand string, majorVersion int32) : base(header, nil) {
        CompatibleBrands = List[string]()
        MajorBrand = majorBrand
        MajorVersion = majorVersion
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(8) + int64(CompatibleBrands.Count * 4)
    prop MajorBrand string
    prop MajorVersion int32

    prop CompatibleBrands List[string] {
        get;
        init;
    }

    protected open override func Render(file Stream) {
        file.WriteType(MajorBrand)
        file.WriteInt32BE(MajorVersion)
        for brand in CompatibleBrands {
            file.WriteType(brand)
        }
    }

    protected open override func Dispose(disposing bool) {
        if disposing && !Disposed {
            CompatibleBrands.Clear()
        }
        base.Dispose(disposing)
    }

    shared {
        func Create(majorBrand string, majorVersion int32) FtypBox {
            ArgumentException.ThrowIfNullOrWhiteSpace(majorBrand, nameof(majorBrand))
            return if majorBrand.Length == 4 { FtypBox(BoxHeader(16, "ftyp"), majorBrand, majorVersion) } else { throw ArgumentException("Major brand must be 4 chars long.", nameof(majorBrand))
                default(FtypBox) }
        }
    }
}
