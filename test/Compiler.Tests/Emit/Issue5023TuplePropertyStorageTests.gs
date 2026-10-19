package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import Xunit

open class Issue5023TuplePropertyStorageTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func AddressPairPropertyWrites_PreserveStoredReceiver(native bool) {
        let source = `package Test
import System
import System.Collections
struct Cell {
    var Stored object?
    prop Value object? {
        get -> Stored
        set { Stored = value }
    }
}
let items = [](CELLTYPE, int32){(CELL, 0)}
var index = 0
var calls = 0
func Index() int32 {
    calls++
    return index
}
(*&items[Index()]).Item1.Value = {
    index = 1
    "v"
}
Console.WriteLine("${items[0].Item1.Value ?? "nil"} ${calls}")
var tuple = (CELL, 0)
(*&tuple).Item1.Value = {
    if index == 1 { calls++ }
    "w"
}
Console.WriteLine("${tuple.Item1.Value ?? "nil"} ${calls}")`.Replace(
            "CELLTYPE",
            if native {
                "Cell"
            } else {
                "DictionaryEntry"
            }
        )
            .Replace(
            "CELL",
            if native {
                "Cell{}"
            } else {
                `DictionaryEntry("key", nil)`
            }
        )
        Assert.Equal("v 1\nw 2\n", CompileAndRun(source))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func AddressPairBorrow_ReconstructsSelectedStorageAcrossSuspension(array bool) {
        let source = `package Test
import System
import System.Threading.Tasks
struct Cell { var Stored int32 }
var tuple = (Cell{Stored: 1}, 0)
var items = [](Cell, int32){(Cell{Stored: 1}, 0)}
let original = items
var index = 0
var calls = 0
func Index() int32 {
    calls++
    return index
}
let gate = TaskCompletionSource[int32]()
func Read(in value int32, ignored int32) int32 -> value
async func Change() int32 {
    await gate.Task
    tuple.Item1.Stored = 2
    original[0].Item1.Stored = 3
    items = [](Cell, int32){(Cell{Stored: 9}, 0)}
    index = 1
    return 0
}
async func Run() {
    Console.WriteLine(Read(RECEIVER.Item1.Stored, await Change()))
}
let pending = Run()
Console.WriteLine(pending.IsCompleted)
gate.SetResult(0)
pending.GetAwaiter().GetResult()
Console.WriteLine(calls)`.Replace(
            "RECEIVER",
            if array {
                "(*&items[Index()])"
            } else {
                "(*&tuple)"
            }
        )
        Assert.Equal(
            if array {
                "False\n3\n1\n"
            } else {
                "False\n2\n0\n"
            },
            CompileAndRun(source)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefReturningArrayOwner_CapturesArrayValueBeforeSuspension(imported bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace RefArray5023;
public static class Api {
    public static int[] Slot = new[] { 1 };
    public static int Calls;
    public static ref int[] Items() { Calls++; return ref Slot; }
}`, "RefArray5023")
        let source = `package Test
import System
import System.Threading.Tasks
DECLARATIONS
let original = OWNER
let gate = TaskCompletionSource[int32]()
var index = 0
func Read(in value int32, ignored int32) int32 -> value
async func Change() int32 {
    await gate.Task
    original[0] = 2
    OWNER = []int32{9}
    index = 1
    return 0
}
async func Run() {
    Console.WriteLine(Read(PRODUCER[index], await Change()))
}
let pending = Run()
Console.WriteLine(pending.IsCompleted)
gate.SetResult(0)
pending.GetAwaiter().GetResult()
Console.WriteLine(CALLS)`.Replace(
            "DECLARATIONS",
            if imported {
                "import RefArray5023"
            } else {
                `
var items = []int32{1}
var calls = 0
func Items() ref []int32 {
    calls++
    return ref items
}`
            }
        ).Replace(
            "OWNER",
            if imported {
                "Api.Slot"
            } else {
                "items"
            }
        ).Replace(
            "PRODUCER",
            if imported {
                "Api.Items()"
            } else {
                "Items()"
            }
        ).Replace(
            "CALLS",
            if imported {
                "Api.Calls"
            } else {
                "calls"
            }
        )
        let executable = fixture.Compile(source, "RefArrayBorrow5023", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal("False\n2\n1\n", fixture.Run(executable))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func TuplePropertyWrites_PreserveStorageBeforeControlFlowRhs(native bool, suspending bool) {
        let source = `package Test
import System
import System.Collections
import System.Threading.Tasks
struct Cell {
    var Stored object?
    prop Value object? {
        get -> Stored
        set { Stored = value }
    }
}
var items = [](CELLTYPE, int32){(CELL, 0)}
let original = items
var index = 0
var log = ""
func Items() [](CELLTYPE, int32) {
    log += "a"
    return items
}
func Index() int32 {
    log += "i"
    return index
}
async func Run(flag bool) {
    var tuple = (CELL, 0)
    tuple.Item1.Value = {
        if flag { log += "l" }
        SUSPEND
        "local"
    }
    Console.WriteLine(tuple.Item1.Value ?? "nil")
    let result = (Items()[Index()].Item1.Value = {
        if flag { log += "b" }
        SUSPEND
        items = [](CELLTYPE, int32){(CELL, 0)}
        index = 1
        "v"
    })
    Console.WriteLine("${result} ${original[0].Item1.Value ?? "nil"} ${items[0].Item1.Value ?? "nil"} ${log}")
    var calls = 0
    try {
        items[2].Item1.Value = {
            if flag { calls++ }
            SUSPEND
            "bad"
        }
    } catch (ex IndexOutOfRangeException) {
        Console.WriteLine(calls)
    }
}
Run(true).GetAwaiter().GetResult()`.Replace(
            "CELLTYPE",
            if native {
                "Cell"
            } else {
                "DictionaryEntry"
            }
        ).Replace(
            "CELL",
            if native {
                "Cell{}"
            } else {
                `DictionaryEntry("key", nil)`
            }
        ).Replace(
            "SUSPEND",
            if suspending {
                "await Task.Yield()"
            } else {
                ""
            }
        )
        Assert.Equal("local\nv v nil laib\n0\n", CompileAndRun(source))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConditionalTupleBorrow_CapturesOnlySelectedComponentsAcrossSuspension(chooseFirst bool) {
        let source = `package Test
import System
import System.Threading.Tasks
struct Cell { var Stored int32 }
var first = [](Cell, int32){(Cell{Stored: 1}, 0)}
var second = [](Cell, int32){(Cell{Stored: 4}, 0)}
let originalFirst = first
let originalSecond = second
var choose = CHOICE
var index = 0
var log = ""
let gate = TaskCompletionSource[int32]()
func Choose() bool {
    log += "c"
    return choose
}
func First() [](Cell, int32) {
    log += "a"
    return first
}
func Second() [](Cell, int32) {
    log += "b"
    return second
}
func Index() int32 {
    log += "i"
    return index
}
func Read(in value Cell, ignored int32) int32 -> value.Stored
async func Change() int32 {
    log += "r"
    await gate.Task
    originalFirst[0] = (Cell{Stored: 2}, 0)
    originalSecond[0] = (Cell{Stored: 5}, 0)
    first = [](Cell, int32){(Cell{Stored: 9}, 0)}
    second = [](Cell, int32){(Cell{Stored: 8}, 0)}
    choose = !choose
    index = 1
    return 0
}
async func Run() {
    Console.WriteLine(Read((*&(Choose() ? First()[Index()] : Second()[Index()])).Item1, await Change()))
}
let pending = Run()
Console.WriteLine(pending.IsCompleted)
gate.SetResult(0)
pending.GetAwaiter().GetResult()
Console.WriteLine(log)`.Replace(
            "CHOICE",
            if chooseFirst {
                "true"
            } else {
                "false"
            }
        )
        Assert.Equal(
            if chooseFirst {
                "False\n2\ncair\n"
            } else {
                "False\n5\ncbir\n"
            },
            CompileAndRun(source)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func FieldChainBorrow_CapturesReferenceOwnerAcrossSuspension(native bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace FieldOwner5023;
public struct Cell { public int N; }
public sealed class Owner {
    public Cell Cell;
    public Owner(int n) { Cell.N = n; }
}`, "FieldOwner5023")
        let source = `package Test
import System
import System.Threading.Tasks
DECLARATIONS
var owner = Owner(1)
let original = owner
let gate = TaskCompletionSource[int32]()
func Read(in value int32, ignored int32) int32 -> value
async func Change() int32 {
    await gate.Task
    original.Cell.N = 2
    owner = Owner(9)
    return 0
}
async func Run() {
    Console.WriteLine(Read(owner.Cell.N, await Change()))
}
let pending = Run()
Console.WriteLine(pending.IsCompleted)
gate.SetResult(0)
pending.GetAwaiter().GetResult()`.Replace(
            "DECLARATIONS",
            if native {
                `
struct Cell { var N int32 }
class Owner {
    var Cell Cell
    init(n int32) { this.Cell = Cell{N: n} }
}`
            } else {
                "import FieldOwner5023"
            }
        )
        let executable = fixture.Compile(source, "FieldOwnerBorrow5023", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal("False\n2\n", fixture.Run(executable))
    }

    @Theory
    @InlineData("Pick()", false)
    @InlineData("owner.Pick()", false)
    @InlineData("owner.Slot", false)
    @InlineData("TupleOpaque5023.External.Pick()", true)
    @InlineData("owner.Pick()", true)
    @InlineData("owner.Slot", true)
    @InlineData("owner[0]", true)
    func OpaqueTupleBorrow_RejectsSuspensionButPreservesSingleSelection(receiver string, imported bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace TupleOpaque5023 {
    public sealed class Borrower<T> {
        public T Value { get; }
        public Borrower(in T value, int ignored) { Value = value; }
    }
    public struct Cell {
        public int Stored;
        public int Value { get => Stored; set => Stored = value; }
        public int? MaybeValue { get => null; set => Stored = value ?? 0; }
    }
    public sealed class Owner {
        public int Selected;
        public int Calls;
        public (Cell, int)[] Items = {
            (new Cell { Stored = 1 }, 0), (new Cell { Stored = 2 }, 0)
        };
        public ref (Cell, int) Pick() { Calls++; return ref Items[Selected]; }
        public ref (Cell, int) Slot => ref Pick();
        public ref (Cell, int) this[int ignored] => ref Pick();
    }
    public static class External {
        public static Owner Current = new Owner();
        public static ref (Cell, int) Pick() => ref Current.Pick();
    }
}`, "TupleOpaque5023")
        for action in[]string{
            "Console.WriteLine(Read($receiver.Item1, await Change()))",
            "$receiver.Item1.Value = await Change()",
            "let copy = TupleOpaque5023.Borrower[Cell]($receiver.Item1, await Change())"
        } {
            let source = OpaqueBorrowSource(action, imported)
            let (exit, output) = fixture.TryCompile(source, "OpaqueTuple5023", executable: true, "/r:" + contract)
            Assert.Equal(1, exit)
            let marker = source.IndexOf("await Change()")
            let line = source.Substring(0, marker).Split('\n').Length
            let column = marker - source.LastIndexOf('\n', marker)
            Assert.Contains(
                "OpaqueTuple5023.gs($line,$column,$line,${column + "await Change()".Length}): error GS0604:",
                output
            )
            Assert.DoesNotContain("GS9998", output)
        }
        let ordered = OpaqueBorrowSource(`Console.WriteLine(Read(RECEIVER.Item1, 0))
Console.WriteLine(owner.Calls)
let ignored = await Change()
Console.WriteLine(Read(RECEIVER.Item1, ignored))
Console.WriteLine(owner.Calls)
let copy = TupleOpaque5023.Borrower[Cell](RECEIVER.Item1, 0)
Console.WriteLine("${copy.Value.Stored} ${owner.Calls}")
owner.Selected = 0
RECEIVER.Item1.Value = {
    owner.Selected = 1
    9
}
Console.WriteLine("${owner.Items[0].Item1.Stored} ${owner.Items[1].Item1.Stored} ${owner.Calls}")
owner.Selected = 0
RECEIVER.Item1.MaybeValue ??= {
    owner.Selected = 1
    11
}
Console.WriteLine("${owner.Items[0].Item1.Stored} ${owner.Items[1].Item1.Stored} ${owner.Calls}")
owner.Selected = 0
Console.WriteLine(Read(RECEIVER.Item1, {
    if owner.Selected == 0 { owner.Selected = 1 }
    0
}))
Console.WriteLine(owner.Calls)
await Task.Yield()
owner.Selected = 0
let controlCopy = TupleOpaque5023.Borrower[Cell](RECEIVER.Item1, {
    if owner.Selected == 0 { owner.Selected = 1 }
    0
})
Console.WriteLine("${controlCopy.Value.Stored} ${owner.Calls}")
await Task.Yield()`.Replace("RECEIVER", receiver), imported)
        let executable = fixture.Compile(ordered, "OpaqueTupleOrdered5023", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal("1\n1\n2\n2\n2 3\n9 2 4\n11 2 5\n11\n6\n11 7\n", fixture.Run(executable))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ReadOnlyTupleBorrow_ObservesLaterArgumentMutation(symbolic bool) {
        let source = `package Test
import System
struct Cell { var Stored int32 }
func Read(in value TYPE, ignored int32) int32 -> RESULT
func Run() {
    var tuple = (FIRST, 0)
    let ref readonly alias = tuple
    Console.WriteLine(Read(alias.Item1, {
        tuple = (SECOND, 0)
        0
    }))
}
Run()`.Replace(
            "TYPE",
            if symbolic {
                "Cell"
            } else {
                "int32"
            }
        ).Replace(
            "RESULT",
            if symbolic {
                "value.Stored"
            } else {
                "value"
            }
        ).Replace(
            "FIRST",
            if symbolic {
                "Cell{Stored: 1}"
            } else {
                "1"
            }
        ).Replace(
            "SECOND",
            if symbolic {
                "Cell{Stored: 2}"
            } else {
                "2"
            }
        )
        Assert.Equal("2\n", CompileAndRun(source))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func PlainPropertyWrite_SelectsRuntimeReferenceBeforeRhs(suspending bool) {
        let source = `package Test
import System
import System.Runtime.CompilerServices
import System.Text
import System.Threading.Tasks
class Box : IStrongBox {
    var Stored object?
    prop Value object? {
        get -> Stored
        set { Stored = value }
    }
}
struct Cell : IStrongBox {
    var Stored object?
    prop Value object? {
        get -> Stored
        set { Stored = value }
    }
}
async func Fill[T IStrongBox](items [](T, int32), replacement T) {
    ASSIGN
}
async func FillBox(original Box, replacement Box) {
    var tuple = (original, 0)
    tuple.Item1.Value = {
        SUSPEND
        if tuple.Item2 == 0 { tuple = (replacement, 0) }
        "v"
    }
}
async func FillStaticClr(original StringBuilder, replacement StringBuilder) {
    var tuple = (original, 0)
    tuple.Item1.Length = {
        SUSPEND
        if tuple.Item2 == 0 { tuple = (replacement, 0) }
        1
    }
}
let oldBox = Box{}
let newBox = Box{}
let boxes = [](Box, int32){(oldBox, 0)}
Fill(boxes, newBox).GetAwaiter().GetResult()
Console.WriteLine("${oldBox.Stored ?? "nil"} ${newBox.Stored ?? "nil"}")
let cells = [](Cell, int32){(Cell{}, 0)}
Fill(cells, Cell{}).GetAwaiter().GetResult()
Console.WriteLine(cells[0].Item1.Stored ?? "nil")
let oldClr = StrongBox[object?]()
let newClr = StrongBox[object?]()
let clr = [](StrongBox[object?], int32){(oldClr, 0)}
Fill(clr, newClr).GetAwaiter().GetResult()
Console.WriteLine("${oldClr.Value ?? "nil"} ${newClr.Value ?? "nil"}")
let oldStatic = Box{}
let newStatic = Box{}
FillBox(oldStatic, newStatic).GetAwaiter().GetResult()
Console.WriteLine("${oldStatic.Stored ?? "nil"} ${newStatic.Stored ?? "nil"}")
let oldBuilder = StringBuilder()
let newBuilder = StringBuilder()
FillStaticClr(oldBuilder, newBuilder).GetAwaiter().GetResult()
Console.WriteLine("${oldBuilder.Length} ${newBuilder.Length}")`.Replace("ASSIGN", `items[0].Item1.Value = {
        SUSPEND
        if items.Length > 0 { items[0] = (replacement, 0) }
        "v"
    }`).Replace(
            "SUSPEND",
            if suspending {
                "await Task.Yield()"
            } else {
                ""
            }
        )
        Assert.Equal("v nil\nv\nv nil\nv nil\n1 0\n", CompileAndRun(source))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TuplePropertyWrites_UpdateStoredElements(native bool) {
        let source = `package Test
import System
import System.Collections
struct Cell {
    var Stored object?
    prop Value object? {
        get -> Stored
        set { Stored = value }
    }
}
var tuple = (CELL, 0)
tuple.Item1.Value = "global"
Console.WriteLine(tuple.Item1.Value ?? "nil")
func Run() {
    var local = (CELL, 0)
    local.Item1.Value = "local"
    var nested = (0, (CELL, 0))
    nested.Item2.Item1.Value = "nested"
    var wide = (0, 0, 0, 0, 0, 0, 0, CELL, 0)
    wide.Item8.Value = "rest"
    Console.WriteLine("${local.Item1.Value ?? "nil"} ${nested.Item2.Item1.Value ?? "nil"} ${wide.Item8.Value ?? "nil"}")
    var empty = (CELL, 0)
    let result = (empty.Item1.Value ??= "expression")
    Console.WriteLine("${result} ${empty.Item1.Value ?? "nil"}")
    var other = (CELL, 0)
    var choose = true
    (*&(choose ? local : other)).Item1.Value = {
        choose = false
        "selected"
    }
    Console.WriteLine("${local.Item1.Value ?? "nil"} ${other.Item1.Value ?? "nil"}")
}
Run()`.Replace(
            "CELL",
            if native {
                "Cell{}"
            } else {
                `DictionaryEntry("key", nil)`
            }
        )
        Assert.Equal("global\nlocal nested rest\nexpression expression\nselected nil\n", CompileAndRun(source))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func TuplePropertyWrites_CaptureComponentsBeforeRhs(suspending bool, coalescing bool) {
        let source = `package Test
import System
import System.Collections
import System.Threading.Tasks
var items = []System.ValueTuple[DictionaryEntry, int32]{(DictionaryEntry("key", nil), 0)}
let original = items
var log = ""
func Items() []System.ValueTuple[DictionaryEntry, int32] {
    log += "a"
    return items
}
func Index() int32 {
    log += "i"
    return 0
}
async func Run() {
    Items()[Index()].Item1.Value OP {
        SUSPEND
        log += "r"
        items = []System.ValueTuple[DictionaryEntry, int32]{(DictionaryEntry("new", nil), 0)}
        "v"
    }
    Console.WriteLine("${original[0].Item1.Value ?? "nil"} ${items[0].Item1.Value ?? "nil"} ${log}")
    var index = 0
    items[index].Item1.Value OP {
        SUSPEND
        index = 1
        "w"
    }
    Console.WriteLine(items[0].Item1.Value ?? "nil")
    var calls = 0
    try {
        items[2].Item1.Value = {
            SUSPEND
            calls++
            "bad"
        }
    } catch (ex IndexOutOfRangeException) {
        Console.WriteLine(calls)
    }
}
Run().GetAwaiter().GetResult()`.Replace(
            "OP",
            if coalescing {
                "??="
            } else {
                "="
            }
        )
            .Replace(
            "SUSPEND",
            if suspending {
                "await Task.Yield()"
            } else {
                ""
            }
        )
        Assert.Equal("v nil air\nw\n0\n", CompileAndRun(source))
    }

    @Fact
    func TuplePropertyCompoundWrite_UsesStoredReadAndWrite() {
        Assert.Equal("rhs\n3 1\n", CompileAndRun(`package Test
import System
struct Cell {
    var Stored int32
    prop Value int32 {
        get -> Stored
        set { Stored = value }
    }
}
struct Wrapper { var Inner Cell }
let items = [](Wrapper, int32){(Wrapper{Inner: Cell{Stored: 1}}, 0)}
var calls = 0
func Index() int32 {
    calls++
    return 0
}
items[Index()].Item1.Inner.Value += {
    if calls == 1 { Console.WriteLine("rhs") }
    2
}
Console.WriteLine("${items[0].Item1.Inner.Stored} ${calls}")`))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func GenericTuplePropertyWrite_PreservesRuntimeStorage(suspending bool) {
        let source = `package Test
import System
import System.Runtime.CompilerServices
import System.Threading.Tasks
struct Cell : IStrongBox {
    var Stored object?
    prop Value object? {
        get -> Stored
        set { Stored = value }
    }
}
async func Fill[T IStrongBox](items [](T, int32)) {
    items[0].Item1.Value ??= {
        SUSPEND
        "v"
    }
}
let values = [](Cell, int32){(Cell{}, 0)}
Fill(values).GetAwaiter().GetResult()
Console.WriteLine(values[0].Item1.Stored ?? "nil")
let box = StrongBox[object?]()
let references = [](StrongBox[object?], int32){(box, 0)}
Fill(references).GetAwaiter().GetResult()
Console.WriteLine(box.Value ?? "nil")`.Replace(
            "SUSPEND",
            if suspending {
                "await Task.Yield()"
            } else {
                ""
            }
        )
        Assert.Equal("v\nv\n", CompileAndRun(source))
    }

    @Theory
    @InlineData(`let tuple = (DictionaryEntry("key", nil), 0)`)
    @InlineData(`var stored = (DictionaryEntry("key", nil), 0)
let ref readonly tuple = stored`)
    func ReadOnlyTuplePropertyWrite_IsRejected(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package Test
import System.Collections
func Reject() {
DECLARATION
tuple.Item1.Value = "v"
}`.Replace("DECLARATION", declaration), "ReadOnlyTuple5023", false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0127", output)
        let line = if declaration.Contains("\n") {
            6
        } else {
            5
        }
        Assert.Contains("ReadOnlyTuple5023.gs(${line},19,${line},20): error GS0127", output)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func TupleImplicitInArgument_KeepsSelectedStorage(native bool, suspending bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace TupleContract5023;
public struct Cell {
    public int Stored;
    public Cell(int value) { Stored = value; }
}`, "TupleContract5023")
        let source = `package Test
import System
import System.Threading.Tasks
CELLDECLARATION
func NewCell(n int32) Cell -> CELLINIT
var items = [](Cell, int32){(NewCell(1), 0)}
let original = items
var log = ""
func Items() [](Cell, int32) {
    log += "a"
    return items
}
func Index() int32 {
    log += "i"
    return 0
}
func Read(in value int32, ignored int32) int32 -> value
ASYNCfunc Change() int32 {
    SUSPEND
    log += "r"
    original[0] = (NewCell(2), 0)
    items = [](Cell, int32){(NewCell(9), 0)}
    return 0
}
async func Run() {
    Console.WriteLine(Read(Items()[Index()].Item1.Stored, AWAITChange()))
    items = original
    var index = 0
    Console.WriteLine(Read(items[index].Item1.Stored, AWAITChange()))
    Console.WriteLine(log)
}
Run().GetAwaiter().GetResult()`.Replace(
            "ASYNC",
            if suspending {
                "async "
            } else {
                ""
            }
        ).Replace(
            "SUSPEND",
            if suspending {
                "await Task.Yield()"
            } else {
                ""
            }
        ).Replace(
            "AWAIT",
            if suspending {
                "await "
            } else {
                ""
            }
        ).Replace(
            "CELLDECLARATION",
            if native {
                "struct Cell { var Stored int32 }"
            } else {
                "import TupleContract5023"
            }
        ).Replace(
            "CELLINIT",
            if native {
                "Cell{Stored: n}"
            } else {
                "Cell(n)"
            }
        )
        let executable = fixture.Compile(source, "TupleBorrow5023", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal("2\n2\nairr\n", fixture.Run(executable))
    }

    shared {
        private func OpaqueBorrowSource(actions string, imported bool) string -> `package Test
import System
import System.Threading.Tasks
DECLARATIONS
INITIALIZATION
func Read(in value Cell, ignored int32) int32 -> value.Stored
async func Change() int32 {
    await Task.Yield()
    owner.Selected = 1
    return 0
}
async func Run() {
ACTIONS
}
Run().GetAwaiter().GetResult()`.Replace(
            "DECLARATIONS",
            if imported {
                "import TupleOpaque5023"
            } else {
                `
struct Cell {
    var Stored int32
    prop Value int32 {
        get -> Stored
        set { Stored = value }
    }
    prop MaybeValue int32? {
        get -> nil
        set { Stored = value ?? 0 }
    }
}
class Owner {
    var Selected int32
    var Calls int32
    var Items [](Cell, int32) = [](Cell, int32){(Cell{Stored: 1}, 0), (Cell{Stored: 2}, 0)}
    func Pick() ref (Cell, int32) {
        Calls += 1
        return ref Items[Selected]
    }
    prop Slot ref (Cell, int32) {
        get {
            Calls += 1
            return ref Items[Selected]
        }
    }
}`
            }
        ).Replace(
            "INITIALIZATION",
            if imported {
                "let owner = Owner()\nExternal.Current = owner"
            } else {
                "let owner = Owner{}\nfunc Pick() ref (Cell, int32) { return ref owner.Pick() }"
            }
        ).Replace("ACTIONS", actions)

        private func CompileAndRun(source string) string {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let executable = fixture.Compile(source, "TupleStorage5023", true)
            IlVerifier.Verify(executable)
            return fixture.Run(executable)
        }
    }
}
