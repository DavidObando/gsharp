package Oahu.Decrypt.Mpeg4.Descriptors

import System
import System.Collections.Generic
import System.IO
import System.Linq

open class BaseDescriptor {
    init(file Stream, header DescriptorHeader) {
        Children = List[BaseDescriptor]()
        Header = header
    }

    protected init(tagId uint8) {
        Children = List[BaseDescriptor]()
        Header = DescriptorHeader(tagId)
    }

    prop Header DescriptorHeader {
        get;
        init;
    }

    prop Children List[BaseDescriptor] {
        get;
        init;
    }

    prop RenderSize uint32 -> uint32(1) + uint32(Header.GetEncodedSizeLength(InternalSize)) + uint32(InternalSize)
    open prop InternalSize int32 -> int32(Children.Sum((c BaseDescriptor) -> c.RenderSize))
    open func Render(file Stream);

    func GetChild[T BaseDescriptor]() T? {
        let children = GetChildren[T]()
        return switch children.Count() {
            case 0: nil
            case 1: children.First()
            default: throw InvalidOperationException("${GetType().Name} has ${children.Count()} children of type ${typeof(T)}. Call ${nameof(GetChildren)} instead.")
        }
    }

    func GetChildOrThrow[T BaseDescriptor]() T -> GetChild[T]() ?? throw InvalidDataException("Descriptor does not contain a child of type ${typeof(T)}")

    func GetChildren[T BaseDescriptor]() IEnumerable[T] {
        return Children.OfType[T]()
    }

    func Save(file Stream) {
        file.WriteByte(Header.TagID)
        ExpandableClass.EncodeSize(file, InternalSize, Header.GetEncodedSizeLength(InternalSize))
        Render(file)
        for child in Children {
            child.Save(file)
        }
    }

    protected func LoadChildren(file Stream) {
        while file.Position < Header.FilePosition + int64(Header.TotalBoxSize) {
            let child = DescriptorFactory.CreateDescriptor(file)
            if child.InternalSize == 0 {
                break
            }
            Children.Add(child)
        }
    }
}
