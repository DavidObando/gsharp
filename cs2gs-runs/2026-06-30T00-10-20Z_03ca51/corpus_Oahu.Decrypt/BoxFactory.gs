package Oahu.Decrypt.Mpeg4.Boxes

import System.Diagnostics
import System.IO

class BoxFactory {
    shared {
        func CreateBox[T Box](file Stream, parent IBox?) T {
            let box = BoxFactory.CreateBox(file, parent)
            return box as T ?? throw InvalidDataException("The ${box!!.Header.Type} box is not of type ${typeof(T)}")
        }

        func CreateBox(file Stream, parent IBox?) IBox -> BoxFactory.CreateBox(BoxHeader(file), file, parent)

        func CreateBox(header BoxHeader, file Stream, parent IBox?) IBox {
            let box IBox = switch header.Type {
                case "free" or "skip": FreeBox(file, header, parent)
                case "ftyp": FtypBox(file, header)
                case "mdat": MdatBox(header)
                case "moov": MoovBox(file, header)
                case "moof": MoofBox(file, header)
                case "mvhd": MvhdBox(file, header, parent)
                case "trak": TrakBox(file, header, parent)
                case "tkhd": TkhdBox(file, header, parent)
                case "mdia": MdiaBox(file, header, parent)
                case "minf": MinfBox(file, header, parent)
                case "mdhd": MdhdBox(file, header, parent)
                case "hdlr": HdlrBox(file, header, parent)
                case "stbl": StblBox(file, header, parent)
                case "stsd": StsdBox(file, header, parent)
                case "esds": EsdsBox(file, header, parent)
                case "btrt": BtrtBox(file, header, parent)
                case "adrm": AdrmBox(file, header, parent)
                case "stts": SttsBox(file, header, parent)
                case "stsc": StscBox(file, header, parent)
                case "stsz": StszBox(file, header, parent)
                case "stz2": Stz2Box(file, header, parent)
                case "stco": StcoBox(file, header, parent)
                case "co64": Co64Box(file, header, parent)
                case "udta": UdtaBox(file, header, parent)
                case "meta": MetaBox(file, header, parent)
                case "ilst": AppleListBox(file, header, parent)
                case "data": AppleDataBox(file, header, parent)
                case "mean": MeanBox(file, header, parent)
                case "name": NameBox(file, header, parent)
                case "pssh": PsshBox(file, header, parent)
                case "sidx": SidxBox(file, header, parent)
                case "mfhd": MfhdBox(file, header, parent)
                case "tfhd": TfhdBox(file, header, parent)
                case "traf": TrafBox(file, header, parent)
                case "tfdt": TfdtBox(file, header, parent)
                case "trun": TrunBox(file, header, parent)
                case "saiz": SaizBox(file, header, parent)
                case "saio": SaioBox(file, header, parent)
                case "schm": SchmBox(file, header, parent)
                case "frma": FrmaBox(file, header, parent)
                case "tenc": TencBox(file, header, parent)
                case "schi": SchiBox(file, header, parent)
                case "sinf": SinfBox(file, header, parent)
                case "senc": SencBox(file, header, parent)
                case "mvex": MvexBox(file, header, parent)
                case "mehd": MehdBox(file, header, parent)
                case "dec3": Dec3Box(file, header, parent)
                case "tref": TrefBox(file, header, parent)
                case "dac4": Dac4Box(file, header, parent)
                default: UnknownBox(file, header, parent)
            }
            Debug.Assert(box.RenderSize == header.TotalBoxSize || box is MdatBox)
            return box
        }
    }
}
