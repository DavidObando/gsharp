package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System.IO
import Xunit

class Issue5807ListPatternElementEvaluationTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func CompoundElements_ReadOnceAndSkipNonConsumingBranches(suspending bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ElementEvaluation.ref.dll")
        let implementation = fixture.CompileCSharpWithReference(`namespace ElementEvaluation {
public sealed class Items<T> {
    public static string Events = "";
    public T Value;
    public int Count => 1;
    public Items(T value) { Value = value; }
    public T this[int index] { get { Events += "i"; return Value; } }
}
}`, "ElementEvaluation", reference)
        let modifier = if suspending {
            "async "
        } else {
            ""
        }
        let result = if suspending {
            "Task[bool]"
        } else {
            "bool"
        }
        let one = if suspending {
            "await Value(1)"
        } else {
            "1"
        }
        let two = if suspending {
            "await Value(2)"
        } else {
            "2"
        }
        let call = if suspending {
            ".Result"
        } else {
            ""
        }
        let patterns = []string{
            "== " + one + " or == " + two,
            "> 0 and < " + two,
            "_ or == " + one,
            "not _ and == " + one,
            "(not _ and == " + one + ") or == " + two,
            "not (not _) or == " + one,
            "{} or == " + one,
            "not ({} or == " + one + ")",
            "(_ and == " + one + ") or == " + two,
            "not (not == " + one + ") or == " + two,
            "_",
            "not _",
            "not (not _)",
            "{}"
        }
        var source = `import ElementEvaluation
import System
import System.Threading.Tasks
async func Value(n int32) Task[int32] {
    Items[int32].Events += "v"
    await Task.Yield()
    return n
}
`
        for var i = 0; i < patterns.Length; i++ {
            source += modifier + "func Check" + i.ToString() +
                "(items Items[int32]) " +
                result +
                " -> items is [" +
                patterns[i] +
                "]\n"
        }
        source += "func Run() {\nlet items = Items[int32](2)\n"
        for var i = 0; i < patterns.Length; i++ {
            source += "{\nItems[int32].Events = \"\"\n" + "let matched = Check" + i.ToString() +
                "(items)" +
                call +
                "\n" +
                `Console.Write("${matched}:${Items[int32].Events}|")` +
                "\n}\n"
        }
        source += "}\nRun()\n"
        let expected = if suspending {
            "True:ivv|False:iv|True:|False:|True:iv|True:|True:|False:|True:ivv|True:ivv|True:|False:|True:|True:|"
        } else {
            "True:i|False:i|True:|False:|True:i|True:|True:|False:|True:i|True:i|True:|False:|True:|True:|"
        }
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            expected,
            "5807",
            reference,
            implementation
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NestedElementsAndSlices_ResetCachesOnEachEvaluation(suspending bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "NestedElements.ref.dll")
        let implementation = fixture.CompileCSharpWithReference(`namespace NestedElements {
public sealed class Items<T> {
    public static string Events = "";
    public T[] Values;
    public int Count => Values.Length;
    public Items(T[] values) { Values = values; }
    public T this[int index] { get { Events += index; return Values[index]; } }
}
public struct Pair {
    public int X;
    public int Y;
}
public sealed class PairBox {
    public int X;
    public int Y;
}
}`, "NestedElements", reference)
        let modifier = if suspending {
            "async "
        } else {
            ""
        }
        let result = if suspending {
            "Task[bool]"
        } else {
            "bool"
        }
        let one = if suspending {
            "await Value(1)"
        } else {
            "1"
        }
        let two = if suspending {
            "await Value(2)"
        } else {
            "2"
        }
        let call = if suspending {
            ".Result"
        } else {
            ""
        }
        let source = `import NestedElements
import System
import System.Threading.Tasks
async func Value(n int32) Task[int32] {
    await Task.Yield()
    return n
}
` + modifier + `func Slices(items Items[int32]) ` + result + ` {
    var matched = true
    for var n = 0; n < 2; n++ {
        matched = (items is [== ` + one + ` or == ` + two + `, .., > 0 and < ` + two + `]) && matched
    }
    return matched
}
` + modifier + `func Fields(items Items[Pair]) ` + result + ` -> items is [{ X: == ` + one + `, Y: 2 }]
` + modifier + `func Nested(items Items[Items[int32]]) ` + result + ` -> items is [[== ` + one + ` or == ` + two + `]]
` + modifier + `func Empty(items Items[Pair]) ` + result + ` -> items is [{} or { X: == ` + one + ` }]
` + modifier + `func SkippedFields(items Items[Pair]) ` + result + ` -> items is [{ X: not _, Y: == ` + one + ` } or { X: == ` + one + ` }]
` + modifier + `func UnusedFields(items Items[Pair]) ` + result + ` -> items is [{ X: not _ and == ` + one + ` }]
` + modifier + `func Array(items Items[[]int32]) ` + result + ` -> items is [[== ` + one + ` or == ` + two + `]]
` + modifier + `func Nullable(items Items[Pair?]) ` + result + ` -> items is [{} or { X: == ` + one + ` }]
` + modifier + `func Reference(items Items[PairBox]) ` + result + ` -> items is [{} and { X: == ` + one + `, Y: 2 }]
func Run() {
    let items = Items[int32]([]int32{2, 1})
    Console.Write("${Slices(items)` + call + `}|")
    Console.Write("${Items[int32].Events}|")
    let pairs = Items[Pair]([]Pair{Pair{X: 1, Y: 2}})
    Console.Write("${Fields(pairs)` + call + `}:${Items[Pair].Events}|")
    Items[Pair].Events = ""
    Console.Write("${Empty(pairs)` + call + `}:${Items[Pair].Events}|")
    Console.Write("${SkippedFields(pairs)` + call + `}:${Items[Pair].Events}|")
    Items[Pair].Events = ""
    Console.Write("${UnusedFields(pairs)` + call + `}:${Items[Pair].Events}|")
    Items[int32].Events = ""
    let nested = Items[Items[int32]]([]Items[int32]{Items[int32]([]int32{2})})
    Console.Write("${Nested(nested)` + call + `}:${Items[Items[int32]].Events}:${Items[int32].Events}|")
    let arrays = Items[[]int32]([][]int32{[]int32{2}})
    Console.Write("${Array(arrays)` + call + `}:${Items[[]int32].Events}|")
    let missing = Items[Pair?]([]Pair?{nil})
    Console.Write("${Nullable(missing)` + call + `}:${Items[Pair?].Events}|")
    let present = Items[PairBox]([]PairBox{PairBox{X: 1, Y: 2}})
    Console.Write("${Reference(present)` + call + `}:${Items[PairBox].Events}|")
    Items[PairBox].Events = ""
    let absent = Items[PairBox]([]PairBox{default(PairBox)})
    Console.Write("${Reference(absent)` + call + `}:${Items[PairBox].Events}")
}
Run()
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            "True|0101|True:0|True:|True:0|False:|True:0:0|True:0|False:0|True:0|False:0",
            "5807",
            reference,
            implementation
        )
    }
}
