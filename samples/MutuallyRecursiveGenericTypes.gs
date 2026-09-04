// file: MutuallyRecursiveGenericTypes.gs
//
// Issue #3905: two generic types that name each other in their members are
// ordinary, legal G# — the shape `Gsharp.Runtime.Channels` is built on, where
// `ISelectableCore[T]` takes a `SelectNode[T]` and `SelectNode[T]` holds an
// `ISelectableCore[T]`. Constructing either at a closed type argument used to
// make the constructed-instance caches recurse through one another forever,
// and gsc died with a stack overflow before it could emit or diagnose
// anything.
//
// All three cycle families are exercised here: interface <-> class,
// interface <-> interface, and class <-> class.

package GSharp.Samples.MutuallyRecursiveGenericTypes

import System

// 1. interface <-> class: the channels shape.
interface ICore[T] {
    func Register(node Node[T]) int32;
}

class Node[T] {
    var Core ICore[T]
    var Value T
}

class Source[T] : ICore[T] {
    var Registered int32

    func Register(node Node[T]) int32 {
        node.Core = this
        Registered = Registered + 1
        return Registered
    }
}

// Reaching the same construction through a second route must resolve the same
// closed member signatures.
func probe(core ICore[int32], n Node[int32]) int32 {
    return core.Register(n)
}

// 2. interface <-> interface.
interface IA[T] {
    func ToB() IB[T];
}

interface IB[T] {
    func ToA() IA[T];
}

class Pair[T] : IA[T], IB[T] {
    func ToB() IB[T] {
        return this
    }

    func ToA() IA[T] {
        return this
    }
}

// 3. class <-> class.
class Left[T] {
    var Right Right[T]
    var Tag T
}

class Right[T] {
    var Left Left[T]
    var Tag T
}

var source = Source[int32]()
var node = Node[int32]{Value: 7}
Console.WriteLine(source.Register(node))
Console.WriteLine(source.Register(node))
Console.WriteLine(node.Value)
Console.WriteLine(node.Core == source)
Console.WriteLine(probe(source, node))

var pair = Pair[string]()
var a IA[string] = pair
Console.WriteLine(a.ToB().ToA() == pair)

var left = Left[int32]{Tag: 1}
var right = Right[int32]{Tag: 2}
left.Right = right
right.Left = left
Console.WriteLine(left.Right.Tag)
Console.WriteLine(right.Left.Tag)
