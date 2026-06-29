package Oahu.Decrypt.Mpeg4.Boxes

import System.Diagnostics
import System.IO
import System.Text
import Oahu.Decrypt.Mpeg4.Util

@DebuggerDisplay("{DebuggerDisplay,nq}")
open class AppleDataBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        DataType = AppleDataType(file.ReadUInt32BE())
        Flags = file.ReadUInt32BE()
        let length = RemainingBoxLength(file)
        Data = file.ReadBlock(int32(length))
    }

    private init(header BoxHeader, parent IBox, data []uint8, type_ AppleDataType) : base(header, parent) {
        DataType = type_
        Flags = uint32(0)
        Data = data
    }

    open override prop RenderSize int64 -> base.RenderSize + int64(8) + int64(Data.Length)

    prop DataType AppleDataType {
        get;
        init;
    }

    prop Flags uint32 {
        get;
        init;
    }

    prop Data []uint8

    @DebuggerHidden
    private prop DebuggerDisplay string -> if DataType is AppleDataType { "[UTF-8]: '${Encoding.UTF8.GetString(Data)}'" } else { if DataType is AppleDataType { "[UTF-16]: '${Encoding.Unicode.GetString(Data)}'" } else { "[$DataType]: ${Data.Length} bytes" } }

    func ReadAsString() string {
        return switch DataType {
            case AppleDataType.Utf_8: Encoding.UTF8.GetString(Data)
            case AppleDataType.Utf_16: Encoding.Unicode.GetString(Data)
            default: throw InvalidDataException("Cannot read AppleDataBox of type $DataType as string.")
        }
    }

    protected open override func Render(file Stream) {
        file.WriteUInt32BE(uint32(DataType))
        file.WriteUInt32BE(Flags)
        file.Write(Data)
    }

    shared {
        func Create(parent IBox, data []uint8, type_ AppleDataType) AppleDataBox {
            let size = data.Length + 8
            let header = BoxHeader(uint32(size), "data")
            let dataBox = AppleDataBox(header, parent, data, type_)
            parent.Children.Add(dataBox)
            return dataBox
        }
    }
}
