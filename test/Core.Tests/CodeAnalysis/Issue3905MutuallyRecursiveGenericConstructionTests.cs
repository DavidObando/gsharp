// <copyright file="Issue3905MutuallyRecursiveGenericConstructionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3905: constructing a generic type whose members name a second
/// generic type that names the first back — the shape
/// <c>Gsharp.Runtime.Channels</c> is built on, where
/// <c>ISelectableCore[T].RegisterReceiveLocked</c> takes a
/// <c>SelectNode[T]</c> and <c>SelectNode[T]</c> holds an
/// <c>ISelectableCore[T]</c>.
/// <para><b>Read this before you debug a failure here.</b> The regression these
/// tests guard is a STACK OVERFLOW inside the compiler, not a diagnostic. A
/// stack overflow cannot be caught, so a regression does not present as a
/// failing assertion: the whole test host dies mid-run and xunit reports a
/// crashed/aborted process, usually blaming whichever test happened to be
/// executing. If this suite ever shows up as a test-host crash, the cause is
/// almost certainly generic construction recursing again — start from
/// <c>InterfaceSymbol.Construct</c> and <c>StructSymbol.CreateConstructed</c>.
/// The same failure in a build shows as <c>gsc</c> exiting non-zero with
/// "Stack overflow." and a managed stack trace and NO diagnostics at all.</para>
/// <para>The cause was memoisation that could be entered re-entrantly:
/// both constructed-instance caches populated their entry from inside
/// <c>ConcurrentDictionary.GetOrAdd</c>'s factory, and the factory substituted
/// members. <c>GetOrAdd</c> offers no re-entrancy protection and does not
/// promise the factory runs once, so the recursive request for the same
/// (definition, type-arguments) key arrived before the entry was published and
/// ran the factory again, forever. The interface cache now publishes the
/// instance before resolving its members, and the struct/class cache no longer
/// substitutes anything during construction at all (its <c>Fields</c> and
/// <c>PrimaryConstructorParameters</c> getters already substituted lazily —
/// the eager copy was dead work).</para>
/// <para>All three shapes below are legal G#, so each is compiled AND executed:
/// "it did not crash" is not enough, the constructed member types have to come
/// out closed and the emitted IL has to run.</para>
/// </summary>
public class Issue3905MutuallyRecursiveGenericConstructionTests
{
    [Fact]
    public void GenericInterfaceAndClassThatNameEachOther_CompileAndRun()
    {
        // The Gsharp.Runtime.Channels shape, reduced: ICore[T] mentions
        // Node[T] in a method signature, Node[T] holds an ICore[T] field.
        var source = @"
import System

interface ICore[T] {
    func Register(node Node[T]) int32;
}

class Node[T] {
    var Core ICore[T]
    var Value T
}

class Source[T] : ICore[T] {
    func Register(node Node[T]) int32 {
        node.Core = this
        return 1
    }
}

func run() int32 {
    let source = Source[int32]()
    let node = Node[int32]{Value: 7}
    if source.Register(node) != 1 {
        return -1
    }

    // The field must have come out closed over int32, and hold the receiver.
    if node.Core != source {
        return -2
    }

    return node.Value
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void TwoGenericInterfacesThatNameEachOther_CompileAndRun()
    {
        var source = @"
import System

interface IA[T] {
    func ToB() IB[T];
}

interface IB[T] {
    func ToA() IA[T];
}

class Pair[T] : IA[T], IB[T] {
    var Tag T

    func ToB() IB[T] {
        return this
    }

    func ToA() IA[T] {
        return this
    }
}

func run() int32 {
    let pair = Pair[int32]{Tag: 11}
    let a IA[int32] = pair
    // Round-tripping through both constructed interfaces must land back on
    // the same instance with both signatures closed over int32.
    if a.ToB().ToA() != pair {
        return -1
    }

    return pair.Tag
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void TwoGenericClassesThatNameEachOther_CompileAndRun()
    {
        var source = @"
import System

class Left[T] {
    var Right Right[T]
    var Tag T
}

class Right[T] {
    var Left Left[T]
    var Tag T
}

func run() int32 {
    let left = Left[int32]{Tag: 1}
    let right = Right[int32]{Tag: 2}
    left.Right = right
    right.Left = left
    return left.Right.Tag * 10 + right.Left.Tag
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(21, result.Value);
    }

    [Fact]
    public void GenericInterfaceAndStructThatNameEachOther_CompileAndRun()
    {
        // The value-type half of the cycle: a struct cannot contain itself, but
        // it can hold an interface whose members name the struct back.
        var source = @"
import System

interface IBox[T] {
    func Wrap(value T) Cell[T];
}

struct Cell[T] {
    var Box IBox[T]
    var Value T
}

class Boxer[T] : IBox[T] {
    func Wrap(value T) Cell[T] {
        return Cell[T]{Value: value}
    }
}

func run() int32 {
    let boxer IBox[int32] = Boxer[int32]()
    let cell = boxer.Wrap(42)
    return cell.Value
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }
}
