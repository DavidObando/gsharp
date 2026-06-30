package Oahu.Decrypt.Mpeg4.Boxes

import System.Collections.Generic
import System.IO
import System.Linq
import System.Text

open class AppleListBox : Box {
    init(file Stream, header BoxHeader, parent IBox?) : base(header, parent) {
        let endPos = Header.FilePosition + Header.TotalBoxSize
        while file.Position < endPos {
            let tagBoxHeader = BoxHeader(file)
            let appleTag = if tagBoxHeader.Type == "----" { FreeformTagBox(file, tagBoxHeader, this) } else { AppleTagBox(file, tagBoxHeader, this) }
            if appleTag.Header.TotalBoxSize == int64(0) {
                break
            }
            Children.Add(appleTag)
        }
    }

    private init(parent IBox) : base(BoxHeader(8, "ilst"), parent) {
    }

    prop TagNames IEnumerable[string] -> Tags.Select((t AppleTagBox) -> t.Header.Type)
    prop FreeformTagNames IEnumerable[string] -> FreeformTags.Select((t FreeformTagBox) -> t.TagName)
    prop Tags IEnumerable[AppleTagBox] -> GetChildren[AppleTagBox]()
    prop FreeformTags IEnumerable[FreeformTagBox] -> GetChildren[FreeformTagBox]()

    func AddTag(name string, data string) {
        AppleTagBox.Create(this, name, Encoding.UTF8.GetBytes(data), AppleDataType.Utf_8)
    }

    func AddTag(name string, data []uint8, type_ AppleDataType) {
        AppleTagBox.Create(this, name, data, type_)
    }

    func RemoveTag(name string) bool -> GetTagBox(name) != nil && RemoveTag(GetTagBox(name)!!!!)
    func RemoveFreeformTag(domain string, name string) bool -> GetFreeformTagBox(domain, name) != nil && RemoveTag(GetFreeformTagBox(domain, name)!!!!)

    func RemoveTag(tag AppleTagBox) bool {
        if Children.Remove(tag) {
            tag.Dispose()
            return true
        } else if tag is FreeformTagBox {
            if tag.Mean?.ReverseDnsDomain != nil && tag.Name?.Name != nil && GetFreeformTagBox(tag.Mean?.ReverseDnsDomain!!!!, tag.Name?.Name!!!!) != nil && Children.Remove(GetFreeformTagBox(tag.Mean?.ReverseDnsDomain!!!!, tag.Name?.Name!!!!)!!!!) {
                GetFreeformTagBox(tag.Mean?.ReverseDnsDomain!!!!, tag.Name?.Name!!!!)!!!!.Dispose()
                return true
            }
        } else if GetTagBox(tag.Header.Type) != nil && Children.Remove(GetTagBox(tag.Header.Type)!!!!) {
            GetTagBox(tag.Header.Type)!!!!.Dispose()
            return true
        }
        return false
    }

    func EditOrAddTag(name string, data string?) {
        EditOrAddTag(name, if data == nil { default([]?uint8) } else { Encoding.UTF8.GetBytes(data!!) }, AppleDataType.Utf_8)
    }

    func EditOrAddTag(name string, data []?uint8) {
        EditOrAddTag(name, data, AppleDataType.ContainsData)
    }

    func EditOrAddTag[TData IAppleData[TData]](name string, data TData?) {
        var bytes []?uint8
        if data != nil {
            bytes = [TData.SizeInBytes]uint8
            data.Write(bytes!!)
        } else {
            bytes = nil
        }
        EditOrAddTag(name, bytes, AppleDataType.ContainsData)
    }

    func EditOrAddTag(name string, data []?uint8, type_ AppleDataType) {
        if GetTagBox(name) != nil {
            EditExistingTag(GetTagBox(name)!!!!, data, type_)
        } else if data != nil {
            AddTag(name, data!!, type_)
        }
    }

    func AddFreeformTag(domain string, name string, data string) {
        FreeformTagBox.Create(this, domain, name, Encoding.UTF8.GetBytes(data), AppleDataType.Utf_8)
    }

    func AddFreeformTag(domain string, name string, data []uint8, type_ AppleDataType) {
        FreeformTagBox.Create(this, domain, name, data, type_)
    }

    func EditOrAddFreeformTag(domain string, name string, data string?) {
        EditOrAddFreeformTag(domain, name, if data == nil { default([]?uint8) } else { Encoding.UTF8.GetBytes(data!!) }, AppleDataType.Utf_8)
    }

    func EditOrAddFreeformTag(domain string, name string, data []?uint8) {
        EditOrAddFreeformTag(domain, name, data, AppleDataType.ContainsData)
    }

    func EditOrAddFreeformTag(domain string, name string, data []?uint8, type_ AppleDataType) {
        if GetFreeformTagBox(domain, name) != nil {
            EditExistingTag(GetFreeformTagBox(domain, name)!!!!, data, type_)
        } else if data != nil {
            AddFreeformTag(domain, name, data!!, type_)
        }
    }

    func GetTagString(name string) string? -> AppleListBox.GetTagString(GetTagBox(name))
    func GetFreeformTagString(domain string, name string) string? -> AppleListBox.GetTagString(GetFreeformTagBox(domain, name))

    func GetTagData[TData IAppleData[TData]](name string) TData? -> if GetTagBox(name)?.Data == nil { default } else { if GetTagBox(name)?.Data!!.DataType != AppleDataType.ContainsData { throw InvalidDataException("Apple data type ${GetTagBox(name)?.Data!!.DataType} is not compatible with ${nameof(IAppleData[TData])}")
        default(TData) } else { if GetTagBox(name)?.Data!!.Data.Length != TData.SizeInBytes { throw InvalidDataException("Tag data size (${GetTagBox(name)?.Data!!.Data.Length}) differs from ${nameof(IAppleData[TData])} size (${TData.SizeInBytes})")
        default(TData) } else { TData.Create(GetTagBox(name)?.Data!!.Data) } } }

    func GetTagBox(name string) AppleTagBox? -> Tags.FirstOrDefault((t AppleTagBox) -> t.Header.Type == name)
    func GetFreeformTagBox(domain string, name string) AppleTagBox? -> Tags.OfType[FreeformTagBox]().FirstOrDefault((t FreeformTagBox) -> t.Mean?.ReverseDnsDomain == domain && t.Name?.Name == name)

    protected open override func Render(file Stream) {
    }

    private func EditExistingTag(tagBox AppleTagBox, data []?uint8, type_ AppleDataType) {
        if data == nil {
            RemoveTag(tagBox)
        } else {
            let dataBox = tagBox.GetChildOrThrow[AppleDataBox]()
            dataBox.Data = if dataBox.DataType == type_ { data!! } else { throw InvalidDataException("Existing tag data type ${dataBox.DataType} differs from new edited type $type_")
                default([]uint8) }
        }
    }

    shared {
        func CreateEmpty(parent IBox) AppleListBox {
            let ilist = AppleListBox(parent)
            parent.Children.Add(ilist!!)
            return ilist!!
        }

        private func GetTagString(tagBox AppleTagBox?) string? -> if tagBox?.Data == nil { default(string?) } else { (switch tagBox?.Data!!.DataType {
            case AppleDataType.Utf_8: Encoding.UTF8.GetString(tagBox?.Data!!.Data)
            case AppleDataType.Utf_16: Encoding.Unicode.GetString(tagBox?.Data!!.Data)
            default: throw InvalidDataException("Apple data type ${tagBox?.Data!!.DataType} is not a string type")
        }) }
    }
}
