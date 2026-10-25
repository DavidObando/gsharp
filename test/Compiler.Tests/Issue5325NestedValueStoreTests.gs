// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import System
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue5325NestedValueStoreTests {
    @Theory
    @InlineData("source", false)
    @InlineData("source", true)
    @InlineData("implementation", false)
    @InlineData("implementation", true)
    @InlineData("reference", false)
    @InlineData("reference", true)
    func NestedStoresKeepSelectedStorageAndValueSnapshots(mode string, generic bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        var declarations = Declarations(generic)
        var imports = string.Empty
        var references = []string{}
        if mode != "source" {
            let referenceDirectory = Path.Combine(fixture.Directory, "ref")
            Directory.CreateDirectory(referenceDirectory)
            let reference = Path.Combine(referenceDirectory, "StoreForeign.dll")
            let implementation = fixture.Compile(
                "package StoreForeign\n" + declarations,
                "StoreForeign",
                false,
                "/refout:" + reference
            )
            IlVerifier.Verify(implementation)
            IlVerifier.Verify(reference)
            references = []string{
                if mode == "reference" {
                    reference
                } else {
                    implementation
                }
            }
            declarations = string.Empty
            imports = "import StoreForeign"
        }
        let source = (`package NestedStores
import System
IMPORTS
DECLARATIONS
class Holder { var Value PAIR }
func Main() {
    var initial PAIR = default
    initial.Left.Item = 3
    initial.Right.Item = 4
    let storage = []PAIR{initial, initial}
    var frames = slice[PAIR].FromArray(storage)
    let snapshot = frames[1]
    let held = managed(frames[1].Left.Item)
    frames[1].Left.Item = 50
    frames[1].Right.Item += 6
    let previous = frames[1].Left.Item++
    Console.WriteLine(snapshot.Left.Item)
    Console.WriteLine(snapshot.Right.Item)
    Console.WriteLine(previous)
    Console.WriteLine(storage[0].Left.Item)
    Console.WriteLine(storage[1].Left.Item)
    Console.WriteLine(storage[1].Right.Item)
    frames = frames.Append(initial)
    frames[1].Left.Item = 99
    GC.Collect()
    GC.WaitForPendingFinalizers()
    GC.Collect()
    Console.WriteLine(*held)
    Console.WriteLine(storage[1].Left.Item)
    Console.WriteLine(frames[1].Left.Item)
    let arraySnapshot = storage[0]
    storage[0].Left.Item = 20
    storage[0].Right.Item += 2
    let arrayPrevious = storage[0].Left.Item++
    Console.WriteLine(arraySnapshot.Left.Item)
    Console.WriteLine(arrayPrevious)
    Console.WriteLine(storage[0].Left.Item)
    Console.WriteLine(storage[0].Right.Item)
    let owner = Holder{Value: initial}
    let objectSnapshot = owner.Value
    let objectHeld = managed(owner.Value.Left.Item)
    owner.Value.Left.Item = 30
    owner.Value.Right.Item += 3
    let objectPrevious = owner.Value.Left.Item++
    Console.WriteLine(objectSnapshot.Left.Item)
    Console.WriteLine(objectPrevious)
    Console.WriteLine(owner.Value.Left.Item)
    Console.WriteLine(owner.Value.Right.Item)
    Console.WriteLine(*objectHeld)
}`).Replace(
            "IMPORTS",
            imports,
            StringComparison.Ordinal
        ).Replace(
            "DECLARATIONS",
            declarations,
            StringComparison.Ordinal
        ).Replace(
            "PAIR",
            if generic {
                "Pair[int32]"
            } else {
                "Pair"
            },
            StringComparison.Ordinal
        )
        let dll = fixture.Compile(
            source,
            "nested",
            true,
            references.Select((path string) -> "/reference:" + path).ToArray()
        )
        IlVerifier.Verify(dll, references)
        Assert.Equal(
            Encoding.UTF8.GetBytes("3\n4\n50\n3\n51\n10\n51\n51\n99\n3\n20\n21\n6\n3\n30\n31\n7\n31\n"),
            Encoding.UTF8.GetBytes(fixture.Run(dll))
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NestedMemberWritesCaptureTheLocationBeforeTheRhs(imported bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let declarations = `struct Cell {
    var Item int32
    prop Value int32 {
        get -> Item
        set { Item = value }
    }
    func Bump() { Item++ }
}
struct Pair { var Left Cell }`
        var header = declarations
        var references = []string{}
        if imported {
            let library = fixture.Compile("package StoreEffects\n" + declarations, "StoreEffects", false)
            IlVerifier.Verify(library)
            references = []string{library}
            header = "import StoreEffects"
        }
        let dll = fixture.Compile((`package SelectedLocation
import System
HEADER
let storage = []Pair{Pair{Left: Cell{Item: 3}}}
var frames = slice[Pair].FromArray(storage)
var owners = 0
var indices = 0
var changes = 0
var index = 0
func Owner() slice[Pair] {
    owners++
    return frames
}
func Index() int32 {
    indices++
    return index
}
func Change() int32 {
    changes++
    frames = slice[Pair]{Pair{}}
    storage[0] = Pair{Left: Cell{Item: 40}}
    return 7
}
func Fault() int32 { throw InvalidOperationException() }
Owner()[Index()].Left.Value += Change()
Console.WriteLine(owners)
Console.WriteLine(indices)
Console.WriteLine(changes)
Console.WriteLine(storage[0].Left.Item)
Console.WriteLine(frames[0].Left.Item)
Owner()[Index()].Left.Bump()
Console.WriteLine(frames[0].Left.Item)
try { Owner()[Index()].Left.Value = Fault() }
catch (error InvalidOperationException) { Console.WriteLine("rhs") }
index = 5
try { Owner()[Index()].Left.Value = Change() }
catch (error IndexOutOfRangeException) { Console.WriteLine("bounds") }
Console.WriteLine(owners)
Console.WriteLine(indices)
Console.WriteLine(changes)
Console.WriteLine(frames[0].Left.Item)`).Replace(
                "HEADER",
                header,
                StringComparison.Ordinal
            ), "effects", true, references.Select((path string) -> "/reference:" + path).ToArray())
        IlVerifier.Verify(dll, references)
        Assert.Equal(
            Encoding.UTF8.GetBytes("1\n1\n1\n10\n0\n1\nrhs\nbounds\n4\n4\n1\n1\n"),
            Encoding.UTF8.GetBytes(fixture.Run(dll))
        )
    }

    @Theory
    @InlineData(
        "let frames = readonly slice[Pair[int32]]{Pair[int32]{}}\nframes[0].Left.Item = 1",
        "GS0499",
        "(8,21,8,22)"
    )
    @InlineData("func Make() Pair[int32] -> default\nMake().Left.Item = 1", "GS0499", "(8,18,8,19)")
    @InlineData("let items = List[Pair[int32]]{Pair[int32]{}}\nitems[0].Left.Item = 1", "GS0499", "(8,20,8,21)")
    @InlineData(
        "let frames = slice[Pair[int32]]{Pair[int32]{}}\nasync func Run() { frames[0].Left.Item = await Task.FromResult(1) }",
        "GS0602",
        "(8,42,8,66)"
    )
    @InlineData(
        "struct Receiver { var Value int32\nfunc Update(value int32) { Value = value } }\nlet frames = slice[Receiver]{Receiver{}}\nasync func Run() { frames[0].Update(await Task.FromResult(1)) }",
        "GS0604",
        "(10,37,10,61)"
    )
    func NonwritableAndSuspendingNeighborsRemainRejected(statement string, diagnostic string, location string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package StoreRejected
import System.Collections.Generic
import System.Threading.Tasks
` + Declarations(true) + "\n" + statement
        let (code, output) = fixture.TryCompile(source, "rejected", true)
        Assert.NotEqual(0, code)
        Assert.Contains(".gs" + location + ": error " + diagnostic + ":", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0285", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
    }

    shared {
        private func Declarations(generic bool) string -> if generic {
            `struct Cell[T] { var Item T }
struct Pair[T] { var Left Cell[T]
var Right Cell[T] }`
        } else {
            `struct Cell { var Item int32 }
struct Pair { var Left Cell
var Right Cell }`
        }
    }
}
