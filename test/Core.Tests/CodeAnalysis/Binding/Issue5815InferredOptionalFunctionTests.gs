package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Linq
import Xunit

class Issue5815InferredOptionalFunctionTests {
    @Theory
    @InlineData("let f = func(x int32 = 7) int32 { return x }\nf()", 7)
    @InlineData("(func(x int32 = 7) int32 { return x })()", 7)
    @InlineData("var f = (x int32 = 7) -> x\nf()", 7)
    @InlineData("let f = (x int32 = 7) -> x\nlet alias = f\n(alias)()", 7)
    @InlineData("let f = (x int32 = 7, y int32) -> x + y\nf(y: 3)", 10)
    @InlineData("let f = (x int32 = 7, y int32 = 8) -> x + y\nf(y: 3)", 10)
    @InlineData("let f = (x int32 = 7, tail ...int32) -> x + tail.Length\nf()", 7)
    @InlineData("let f = (x int32 = 7, tail ...int32) -> x + tail.Length\nf(tail: []int32{1, 2})", 9)
    @InlineData("let f = (x int32 = 7) -> x\nlet g = (x int32 = 9) -> x\nf() + g()", 16)
    @InlineData("var f = (x int32 = 7) -> x\nf = (x int32 = 7) -> x + 1\nf()", 8)
    @InlineData("let f = func(x int32? = 7) int32 { return x ?? -1 }\nf()", 7)
    @InlineData("struct Point { var X int32 }\nlet f = (x Point = default(Point)) -> x.X\nf()", 0)
    @InlineData("enum Choice { A, B }\nlet f = (x Choice = Choice.B) -> int32(x)\nf()", 1)
    @InlineData("let f = (x decimal = default(decimal)) -> int32(x)\nf()", 0)
    @InlineData("let outer = () -> (x int32 = 7) -> x\nouter()()", 7)
    @InlineData(`var trace = 0
let next = func() int32 {
    trace += 1
    return trace
}
let f = (x int32 = 7, y int32 = 8, z int32 = 9) -> x * 100 + y * 10 + z
f(z: next(), y: next()) + trace * 1000`, 2721)
    func OmittedArgumentsUseTheInferredContract(source string, expected int32) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func DeclaredFunctionTypesEraseLiteralDefaults() {
        let inferred = EmittedOracle.Evaluate("let f = (x int32 = 7) -> x\nf()")
        Assert.Empty(inferred.Diagnostics)
        Assert.Equal(7, inferred.Value)
        let widened = EmittedOracle.Evaluate(
            "let f = (x int32 = 7) -> x\nlet erased = cast[(int32) -> int32](f)\nerased(3)"
        )
        Assert.Empty(widened.Diagnostics)
        Assert.Equal(3, widened.Value)
        for source in[]string{
            "let f (int32) -> int32 = (x int32 = 7) -> x\nf()",
            "func Apply(f (int32) -> int32) int32 { return f() }\nApply((x int32 = 7) -> x)",
            "let f = (x int32 = 7) -> x\nlet erased = cast[(int32) -> int32](f)\nerased()"
        } {
            let result = EmittedOracle.Evaluate(source)
            let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Equal("GS0144", diagnostic.Id)
        }
    }

    @Fact
    func ReassignmentCannotChangeAnInferredOptionalContract() {
        let valid = EmittedOracle.Evaluate("var f = (x int32 = 7) -> x\nf = (x int32 = 7) -> x + 1\nf()")
        Assert.Empty(valid.Diagnostics)
        Assert.Equal(8, valid.Value)
        for replacement in[]string{"(x int32 = 9) -> x", "(x int32) -> x"} {
            let result = EmittedOracle.Evaluate("var f = (x int32 = 7) -> x\nf = " + replacement)
            let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Equal("GS0155", diagnostic.Id)
            Assert.Equal(1, diagnostic.Location.StartLine)
        }
    }
}

class Issue5864HeaderInitializerParsingTests {
    @Theory
    @InlineData("[]Item{Item{Value: 1}}")
    @InlineData("[1]Item{Item{Value: 1}}")
    @InlineData("[][]Item{[]Item{Item{Value: 1}}}")
    @InlineData("map[int32,Item]{1: Item{Value: 1}}")
    @InlineData("map[Item,int32]{Item{Value: 1}: 1}")
    @InlineData("[]Outer{Outer{Inner: Item{Value: 1}}}")
    @InlineData("[]List[Item]{List[Item]{Item{Value: 1}}}")
    func NestedLiteralsStayInsideEveryHeaderInitializer(initializer string) {
        for header in[]string{
            "for item in " + initializer,
            "if " + initializer + ".Length > 0",
            "while " + initializer + ".Length > 0",
            "switch " + initializer
        } {
            let tree = SyntaxTree.Parse("func Run() { " + header + " { } }")
            Assert.Empty(tree.Diagnostics)
        }
    }
}

class Issue5872SignedInt64BoundaryTests {
    @Theory
    @InlineData("9223372036854775808L")
    @InlineData("9223372036854775808l")
    @InlineData("9_223_372_036_854_775_808L")
    func OnlyDirectUnaryMinusAcceptsTheSignedBoundary(magnitude string) {
        let result = EmittedOracle.Evaluate("-" + magnitude)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int64.MinValue, result.Value)
        for prefix in[]string{"", "+", "-("} {
            let expression = prefix +
                magnitude +
                (
                if prefix == "-(" {
                    ")"
                } else {
                    ""
                }
            )
            let tree = SyntaxTree.Parse("let value = " + expression)
            let diagnostic = Assert.Single(tree.Diagnostics)
            Assert.Equal("GS0004", diagnostic.Id)
            Assert.Equal(0, diagnostic.Location.StartLine)
            Assert.Equal(12 + prefix.Length, diagnostic.Location.StartCharacter)
            Assert.Equal(magnitude.Length, diagnostic.Location.Span.Length)
        }
        let array = SyntaxTree.Parse("let values = [" + magnitude + "]int32")
        let arrayDiagnostic = Assert.Single(array.Diagnostics)
        Assert.Equal("GS0004", arrayDiagnostic.Id)
        Assert.Equal(14, arrayDiagnostic.Location.StartCharacter)
    }
}
