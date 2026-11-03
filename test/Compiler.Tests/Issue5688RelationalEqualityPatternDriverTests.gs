// <copyright file="Issue5688RelationalEqualityPatternDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.IO
import Xunit

/// Issue #5688: a `==` or `!=` relational pattern applies the operator that the binary expression
/// `input op value` uses, for every operand type.
class Issue5688RelationalEqualityPatternDriverTests {
    @Fact
    func StringInputs_CompareValues() {
        const source = `func Bit(value bool) string -> if value { "1" } else { "0" }
func Same(s string) bool -> s is == "abc"
func Different(s string) bool -> s is != "abc"
func NullableSame(s string?) bool -> s is == "abc"
func Missing(s string?) bool -> s is == nil
func Known(s string?) bool -> s is != nil
let built = System.String([]char{'a', 'b', 'c'})
System.Console.Write(Bit(Same(built)) + Bit(Same("x")) + Bit(Different(built)) + Bit(Different("x")) + "|")
System.Console.Write(Bit(NullableSame(built)) + Bit(NullableSame(nil)) + "|")
System.Console.Write(Bit(Missing(nil)) + Bit(Missing(built)) + Bit(Known(built)) + Bit(Known(nil)))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "1001|10|1010", "5688")
    }

    @Fact
    func StructInputs_UseDataUserAndClrEquality() {
        const source = `import System
data struct Point(X int32, Name string)
struct Code {
    var Value int32
}
func (left Code) operator ==(right Code) bool -> left.Value % 10 == right.Value % 10
func (left Code) operator !=(right Code) bool -> left.Value % 10 != right.Value % 10
func Bit(value bool) string -> if value { "1" } else { "0" }
func Origin(p Point) bool -> p is == Point(1, "a")
func Three(c Code) bool -> c is == Code{Value: 3}
func NotThree(c Code) bool -> c is != Code{Value: 3}
func NewYear(d DateTime) bool -> d is == DateTime(2020, 1, 1)
func MaybeNewYear(d DateTime?) bool -> d is == DateTime(2020, 1, 1)
func Pair(t (int32, string)) bool -> t is == (1, "a")
let a = String([]char{'a'})
System.Console.Write(Bit(Origin(Point(1, a))) + Bit(Origin(Point(2, a))) + "|")
System.Console.Write(Bit(Three(Code{Value: 13})) + Bit(Three(Code{Value: 4})) + Bit(NotThree(Code{Value: 13})) + "|")
System.Console.Write(Bit(NewYear(DateTime(2020, 1, 1))) + Bit(NewYear(DateTime(2021, 1, 1))) + "|")
System.Console.Write(Bit(MaybeNewYear(DateTime(2020, 1, 1))) + Bit(MaybeNewYear(nil)) + "|")
System.Console.Write(Bit(Pair((1, a))) + Bit(Pair((2, a))))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "10|100|10|10|10", "5688")
    }

    @Fact
    func NullableEnumAndFloatingInputs_KeepTheExpressionResult() {
        const source = `import System
enum Color { Red, Green }
func Bit(value bool) string -> if value { "1" } else { "0" }
func Same(n int32?) bool -> n is == 3
func Different(n int32?) bool -> n is != 3
func Missing(n int32?) bool -> n is == nil
func Green(c Color) bool -> c is == Color.Green
func MaybeGreen(c Color?) bool -> c is == Color.Green
func NoColor(c Color?) bool -> c is == nil
func IsNaN(x float64) bool -> x is == Double.NaN
func NotNaN(x float64) bool -> x is != Double.NaN
func MaybeNotNaN(x float64?) bool -> x is != Double.NaN
System.Console.Write(Bit(Same(3)) + Bit(Same(nil)) + Bit(Different(nil)) + Bit(Different(3)) + Bit(Missing(nil)) + Bit(Missing(3)) + "|")
System.Console.Write(Bit(Green(Color.Green)) + Bit(Green(Color.Red)) + Bit(MaybeGreen(Color.Green)) + Bit(MaybeGreen(nil)) + Bit(NoColor(nil)) + Bit(NoColor(Color.Red)) + "|")
System.Console.Write(Bit(IsNaN(Double.NaN)) + Bit(NotNaN(Double.NaN)) + Bit(MaybeNotNaN(Double.NaN)) + Bit(MaybeNotNaN(nil)))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "101010|101010|0111", "5688")
    }

    @Fact
    func PatternForms_InLambdasAsyncIteratorsAndSwitches() {
        const source = `import System.Collections.Generic
import System.Threading.Tasks
class Box {
    prop Name string { get; set; }
}
func Bit(value bool) string -> if value { "1" } else { "0" }
func Captured(s string, t string) bool {
    let f = () -> s is == t
    return f()
}
async func Either(s string?) Task[bool] {
    await Task.Yield()
    let r = s is == "abc" or == "def"
    await Task.Yield()
    return r
}
func Marks(items []string) IEnumerable[string] {
    for x in items {
        yield if x is == "abc" { "1" } else { "0" }
    }
}
func Kind(s string?) int32 {
    switch s {
        case == "a" {
            return 1
        }
        case != nil {
            return 2
        }
        default {
            return 0
        }
    }
}
func Named(b Box) string -> switch b {
    case { Name: == "abc" }: "1"
    default: "0"
}
func Other(s string) bool -> s is not == "abc"
let built = System.String([]char{'a', 'b', 'c'})
let single = System.String([]char{'a'})
var marks = ""
for m in Marks([]string{built, "x"}) {
    marks += m
}
System.Console.Write(Bit(Captured(built, "abc")) + Bit(Captured(built, "x")) + "|")
System.Console.Write(Bit(Either(built).Result) + Bit(Either("def").Result) + Bit(Either(nil).Result) + "|" + marks + "|")
System.Console.Write("${Kind(single)}${Kind("b")}${Kind(nil)}|" + Named(Box{Name: built}) + Named(Box{Name: "x"}) + "|")
System.Console.Write(Bit(Other(built)) + Bit(Other("x")))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "10|110|10|120|10|01", "5688")
    }

    @Fact
    func Operands_AreEvaluatedOnceInSourceOrder() {
        const source = `class Trace {
    shared {
        var Events string = ""
    }
}
struct Code {
    var Value int32
}
func (left Code) operator ==(right Code) bool {
    Trace.Events += "o"
    return left.Value == right.Value
}
func (left Code) operator !=(right Code) bool {
    Trace.Events += "n"
    return left.Value != right.Value
}
func Bit(value bool) string -> if value { "1" } else { "0" }
func Input(s string?) string? {
    Trace.Events += "i"
    return s
}
func Next() string {
    Trace.Events += "v"
    return System.String([]char{'a'})
}
func InputCode(v int32) Code {
    Trace.Events += "i"
    return Code{Value: v}
}
func NextCode() Code {
    Trace.Events += "v"
    return Code{Value: 1}
}
System.Console.Write(Bit(Input("a") is == Next()) + Bit(Input(nil) is != Next()) + Bit(InputCode(1) is == NextCode()) + Bit(InputCode(2) is != NextCode()))
System.Console.Write("|" + Trace.Events)
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "1111|ivivivoivn", "5688")
    }

    @Fact
    func NilAndMixedTypeValues_MatchTheExpression() {
        const source = `class Box {
    var V int32
}
func (left Box?) operator ==(right Box?) bool -> true
func (left Box?) operator !=(right Box?) bool -> false
struct Meters {
    var V int32
}
func (left Meters) operator ==(right int32) bool -> left.V == right
func (left Meters) operator !=(right int32) bool -> left.V != right
func Bit(value bool) string -> if value { "1" } else { "0" }
func NilPattern(x Box?) bool -> x is == nil
func NilExpression(x Box?) bool -> x == nil
func NotNilPattern(x Box?) bool -> x is != nil
func NotNilExpression(x Box?) bool -> x != nil
func FivePattern(m Meters) bool -> m is == 5
func FiveExpression(m Meters) bool -> m == 5
func Zero(b uint8) bool -> b is == 0
func Default(n int32) bool -> n is == default
let box = Box{V: 1}
System.Console.Write(Bit(NilPattern(box)) + Bit(NilExpression(box)) + Bit(NotNilPattern(box)) + Bit(NotNilExpression(box)) + "|")
System.Console.Write(Bit(FivePattern(Meters{V: 5})) + Bit(FiveExpression(Meters{V: 5})) + Bit(FivePattern(Meters{V: 4})) + "|")
System.Console.Write(Bit(Zero(uint8(0))) + Bit(Default(0)) + Bit(Default(1)))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "0011|110|110", "5688")
    }

    @Fact
    func UndefinedEquality_ReportsThePatternOrOperatorDiagnostic() {
        const source = `struct Plain {
    var Value int32
}
func Same(p Plain) bool -> p is == Plain{Value: 1}
func Text(n int32) bool -> n is == "x"
`
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue5688", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let sourcePath = Path.Combine(directory, "Program.gs")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            let originalOut = Console.Out
            var code int32
            try {
                Console.SetOut(stdout)
                code = Program.Main(
                    []string{"/target:library", "/out:" + Path.Combine(directory, "Program.dll"), sourcePath}
                )
            } finally {
                Console.SetOut(originalOut)
            }
            let lines = stdout.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries)
            let errors = Array.FindAll(lines, (line string) -> line.Contains(": error GS"))
            Assert.NotEqual(0, code)
            Assert.Equal(2, errors.Length)
            Assert.Contains("Program.gs(4,33,4,35): error GS0174:", errors[0])
            Assert.Contains("Program.gs(5,33,5,35): error GS0129:", errors[1])
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }
}
