package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import Oahu.Decrypt.Mpeg4.Util

open class Box : IBox {
    private var disposed int32 = 0

    init(header BoxHeader, parent IBox?) {
        Children = List[IBox]()
        Header = header
        Parent = parent
    }

    deinit {
        Dispose(false)
    }

    prop Parent IBox? {
        get;
        init;
    }

    prop Header BoxHeader {
        get;
        init;
    }

    prop Children List[IBox] {
        get;
        init;
    }

    open prop RenderSize int64 -> int64(8) + Children.Sum((b IBox) -> b.RenderSize)
    protected prop Disposed bool -> disposed != 0

    func GetChild[T IBox]() T? {
        let children = GetChildren[T]()
        return switch children.Count() {
            case 0: default
            case 1: children.First()
            default: throw InvalidOperationException("${GetType().Name} has ${children.Count()} children of type ${typeof(T)}. Call ${nameof(GetChildren)} instead.")
        }
    }

    func GetChildOrThrow[T IBox]() T -> GetChild[T]() ?? throw InvalidDataException("${Header.Type} does not contain a child of type ${typeof(T)}")

    func GetChildren[T IBox]() IEnumerable[T] {
        return Children.OfType[T]()
    }

    func GetFreeBoxes() List[FreeBox] {
        let freeBoxes = GetChildren[FreeBox]().ToList()
        for child in Children {
            freeBoxes.AddRange(child!!.GetFreeBoxes())
        }
        return freeBoxes
    }

    func Save(file Stream) {
        ObjectDisposedException.ThrowIf(Disposed, this)
        this.Header.FilePosition = file.Position
        file.WriteHeader(Header, RenderSize)
        Render(file)
        for child in Children {
            child!!.Save(file)
        }
    }

    func Dispose() {
        Dispose(true)
        GC.SuppressFinalize(this)
    }

    protected func RemainingBoxLength(file Stream) int64 -> Header.FilePosition + Header.TotalBoxSize - file.Position
    protected open func Render(file Stream);

    protected func LoadChildren(file Stream) {
        let endPos = Header.FilePosition + Header.TotalBoxSize
        while file.Position < endPos {
            let child = BoxFactory.CreateBox(file, this)
            if child.Header.TotalBoxSize == int64(0) {
                break
            }
            Children.Add(child)
            if child.Header.FilePosition + child.Header.TotalBoxSize != file.Position {
                break
            }
        }
    }

    protected open func Dispose(disposing bool) {
        if disposing && Interlocked.CompareExchange(&disposed, 1, 0) == 0 {
            for child in Children {
                child?.Dispose()
            }
            Children.Clear()
        }
    }
}
