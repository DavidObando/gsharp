// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import System
import System.IO
import System.Text
import Xunit

class Issue5998SwitchGuardCaptureTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImmediateGuard_SeesMatchedString_InBothSwitchForms(expression bool) {
        let arm = if expression {
            `return switch input {
        case p is string when Immediate(() -> p): p
        default: "miss"
    }`
        } else {
            `switch input {
        case p is string when Immediate(() -> p) { return p }
    }
    return "miss"`
        }
        Check(`import System
func Immediate(value () -> string) bool -> value() == "old"
func Read(input string) string {
    ` + arm + `
}
func Local(input string) string {
    let p = input
    if Immediate(() -> p) { return p }
    return "miss"
}
func Body(input string) string {
    switch input {
        case p is string {
            let read = () -> p
            return read()
        }
    }
    return "miss"
}
Console.Write(Read("old") + "|" + Read("new") + "|" + Local("old") + "|" + Body("old"))
`, "old|miss|old|old")
    }

    @Fact
    func VarAndNestedPatternGuards_SeeNondefaultValues_AndEvaluateTheReceiverOnce() {
        Check(`import System
class Box {
    prop Value int32 {
        get {
            Console.Write("P")
            return 43
        }
    }
}
func Input() Box {
    Console.Write("D")
    return Box()
}
func Has(read () -> int32, expected int32) bool {
    Console.Write("G")
    return read() == expected
}
func Read(input int32) int32 {
    switch input {
        case var number when Has(() -> number, 42) { return number }
    }
    return -1
}
Console.Write(Read(42))
Console.Write("|")
Console.Write(switch Input() {
    case { Value: var number } when Has(() -> number, 43): number
    default: -1
})
`, "G42|DPG43")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func EscapingGuards_KeepCellsAcrossFalseGuardsLaterArmsAndRepeatedCalls(expression bool) {
        let arms = if expression {
            `let result = switch input {
        case { First: var p } when Save(() -> p, take): Save(() -> p, true)
        case { Second: var p } when Save(() -> p, true): Save(() -> p, true)
        default: false
    }
    Console.Write(result)`
        } else {
            `switch input {
        case { First: var p } when Save(() -> p, take) { Save(() -> p, true) }
        case { Second: var p } when Save(() -> p, true) { Save(() -> p, true) }
    }`
        }
        Check(`import System
import System.Collections.Generic
class Pair {
    var First int32
    var Second int32
}
class State {
    shared {
        let Readers List[() -> int32] = List[() -> int32]()
    }
}
func Save(read () -> int32, take bool) bool {
    State.Readers.Add(read)
    return take
}
func Cell(read Func[int32]) object? {
    let target = read.Target!!
    let fields = target.GetType().GetFields()
    if fields.Length != 1 { throw InvalidOperationException("Expected one captured cell") }
    return fields[0].GetValue(target)
}
let visit = (input Pair, take bool) -> {
    ` + arms + `
}
visit(Pair{First:42, Second:43}, false)
visit(Pair{First:99, Second:100}, true)
for read in State.Readers {
    Console.Write("|")
    Console.Write(read())
}
if State.Readers.Count != 5 { throw InvalidOperationException("Expected five retained closures") }
Console.Write("|")
Console.Write(Object.ReferenceEquals(Cell(State.Readers[0]), Cell(State.Readers[1])))
Console.Write("|")
Console.Write(Object.ReferenceEquals(Cell(State.Readers[1]), Cell(State.Readers[2])))
Console.Write("|")
Console.Write(Object.ReferenceEquals(Cell(State.Readers[3]), Cell(State.Readers[4])))
`, (
                if expression {
                    "TrueTrue"
                } else {
                    ""
                }
            ) +
                "|42|43|43|99|99|False|True|True")
    }

    @Fact
    func GuardCells_AreAvailableInInitializerAndAwaitedGuardRoots() {
        Check(`import System
import System.Threading.Tasks
func Has(read () -> int32, expected int32) bool -> read() == expected
class Initialized {
    shared {
        let Value int32 = (() -> {
            switch 43 {
                case var number when Has(() -> number, 43) { return number }
            }
            return -1
        })()
    }
}
async func HasAsync(read () -> int32) Task[bool] {
    await Task.Yield()
    return Has(read, 42)
}
async func Read(input object) Task[int32] {
    return switch input {
        case number is int32 when await HasAsync(() -> number): (() -> number)()
        default: -1
    }
}
Console.Write(Read(42).Result)
Console.Write("|")
Console.Write(Initialized.Value)
`, "42|43")
    }

    @Fact
    func GuardCapture_DoesNotMakeThePatternBindingWritable() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, diagnostics) = fixture.TryCompile(`func Read(input string) string {
    switch input {
        case p is string when (() -> {
            p = "new"
            return true
        })() { return p }
    }
    return "miss"
}
System.Console.Write(Read("old"))
`, "readonly", true)
        Assert.Equal(1, code)
        Assert.Contains("readonly.gs(4,15,4,16): error GS0127", diagnostics, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0005", diagnostics, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "readonly.dll")))
    }

    shared {
        private func Check(source string, expected string) {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let (code, diagnostics) = fixture.TryCompile(source, "guard", true, "/deterministic+")
            Assert.True(code == 0, diagnostics)
            let path = Path.Combine(fixture.Directory, "guard.dll")
            Assert.Equal("Wrote $path${Environment.NewLine}", diagnostics)
            Assert.NotEmpty(File.ReadAllBytes(path))
            var report = string.Empty
            IlVerifier.Verify(
                path,
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(path))
            let bytes = File.ReadAllBytes(path)
            let (repeated, repeatedDiagnostics) = fixture.TryCompile(source, "guard", true, "/deterministic+")
            Assert.Equal(0, repeated)
            Assert.Equal(diagnostics, repeatedDiagnostics)
            Assert.Equal(bytes, File.ReadAllBytes(path))
        }
    }
}
