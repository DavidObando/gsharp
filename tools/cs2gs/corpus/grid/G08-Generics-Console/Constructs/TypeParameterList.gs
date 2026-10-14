// inventory: TypeParameterList — generic class, interface, and method declarations
// gsc issue #1932 (fixed): calling a generic method with an INFERRED type
// argument over a user generic type (`Swapper.Swap(pair)`) used to fail with
// GS0151 "Cannot infer type argument 'T'" even though the explicit form
// `Swapper.Swap<string>(pair)` worked; both forms are exercised below now.
// issue #1915 (fixed): a generic STRUCT (`struct Slot<T>` with
// `_content = content` in its ctor) used to fail translate with CS2GS-GAP
// "struct constructor assigns a member from something other than a plain,
// once-only parameter reference" — the identical pattern on a non-generic
// struct (G06 StructDeclaration) always zipped fine.

package Corpus.Grid08

import System

interface IPairView[T] {
    func First() T;
}

open class Pair[T] : IPairView[T] {
    private let _first T
    private let _second T
    private let _size int32

    init(first T, second T, seed int32) {
        _first = first
        _second = second
        _size = seed + 2
    }

    func Size() int32 {
        return _size
    }

    func First() T {
        return _first
    }

    func Second() T {
        return _second
    }
}

shared class Swapper {
    func Swap[T](pair Pair[T]) Pair[T] {
        return Pair[T](pair.Second(), pair.First(), 0)
    }
}

struct Slot[T] {
    private let _content T

    init(content T) {
        _content = content
    }

    prop Content T -> _content
}

shared class TypeParameterListFixture {
    func Run() {
        let pair = Pair[string]("left", "right", 0)
        Console.WriteLine("TypeParameterList: first=" + pair.First())
        let swapped = Swapper.Swap[string](pair)
        Console.WriteLine("TypeParameterList: swapped-first=" + swapped.First())
        let inferredSwapped = Swapper.Swap(pair)
        Console.WriteLine("TypeParameterList: inferred-swapped-first=" + inferredSwapped.First())
        let view IPairView[string] = pair
        Console.WriteLine("TypeParameterList: interface-first=" + view.First())
        Console.WriteLine("TypeParameterList: size=" + pair.Size().ToString())
        var slot = Slot[int32](7)
        Console.WriteLine("TypeParameterList: slot-content=" + slot.Content.ToString())
    }
}
