package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import Xunit

open class Issue5023TuplePropertyStorageTests {
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
        Assert.Equal("3 1\n", CompileAndRun(`package Test
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
items[Index()].Item1.Inner.Value += 2
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
        private func CompileAndRun(source string) string {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let executable = fixture.Compile(source, "TupleStorage5023", true)
            IlVerifier.Verify(executable)
            return fixture.Run(executable)
        }
    }
}
