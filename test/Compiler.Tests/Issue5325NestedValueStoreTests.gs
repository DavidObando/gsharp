// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import System
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue5325NestedValueStoreTests {
    @Theory
    @InlineData("source")
    @InlineData("implementation")
    @InlineData("reference")
    @InlineData("canonical")
    func NestedSliceStoresKeepTheSelectedElementAndValueSnapshots(mode string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        var declarations = Declarations()
        var imports = string.Empty
        var references = []string{}
        if mode == "canonical" {
            declarations = string.Empty
            imports = "import Gsharp.Values.FixedArrays.V1"
        } else if mode != "source" {
            let referenceDirectory = Path.Combine(fixture.Directory, "ref")
            Directory.CreateDirectory(referenceDirectory)
            let reference = Path.Combine(referenceDirectory, "StoreForeign.dll")
            let implementation = fixture.Compile(
                "package StoreForeign\n" + declarations,
                "StoreForeign",
                false,
                "/refout:" + reference
            )
            VerifyStrict(implementation)
            VerifyStrict(reference)
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
        let source = (`package NestedSliceStores
import System
IMPORTS
DECLARATIONS
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
            if mode == "canonical" {
                "Branch[int32, Leaf[int32], Leaf[int32]]"
            } else {
                "Pair[int32]"
            },
            StringComparison.Ordinal
        )
        let dll = fixture.Compile(
            source,
            "nested",
            true,
            references.Select((path string) -> "/reference:" + path).ToArray()
        )
        VerifyStrict(dll, references)
        Assert.Equal(
            Encoding.UTF8.GetBytes("3\n4\n50\n3\n51\n10\n51\n51\n99\n"),
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
            VerifyStrict(library)
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
        VerifyStrict(dll, references)
        Assert.Equal(
            Encoding.UTF8.GetBytes("1\n1\n1\n10\n0\n1\nrhs\nbounds\n4\n4\n1\n1\n"),
            Encoding.UTF8.GetBytes(fixture.Run(dll))
        )
    }

    @Theory
    @InlineData("let frames = readonly slice[Pair[int32]]{Pair[int32]{}}\nframes[0].Left.Item = 1", "GS0499", int32(8))
    @InlineData("func Make() Pair[int32] -> default\nMake().Left.Item = 1", "GS0499", int32(8))
    @InlineData("let items = List[Pair[int32]]{Pair[int32]{}}\nitems[0].Left.Item = 1", "GS0499", int32(8))
    @InlineData(
        "let frames = slice[Pair[int32]]{Pair[int32]{}}\nasync func Run() { frames[0].Left.Item = await Task.FromResult(1) }",
        "GS0602",
        int32(8)
    )
    func NonwritableAndSuspendingNeighborsRemainRejected(statement string, diagnostic string, line int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package StoreRejected
import System.Collections.Generic
import System.Threading.Tasks
` + Declarations() + "\n" + statement
        let (code, output) = fixture.TryCompile(source, "rejected", false)
        Assert.NotEqual(0, code)
        Assert.Contains("error " + diagnostic + ":", output, StringComparison.Ordinal)
        Assert.Contains(".gs(" + line.ToString() + ",", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
    }

    shared {
        private func VerifyStrict(path string, references ...string) {
            var report = string.Empty
            IlVerifier.Verify(
                path,
                references,
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
        }

        private func Declarations() string -> `struct Cell[T] { var Item T }
struct Pair[T] { var Left Cell[T]
var Right Cell[T] }`
    }
}
