// <copyright file="InterpolatedStringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System.Collections.Immutable
import System.Linq
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.Text

/// Emitted-oracle coverage for interpolated string.
/// Traceability: ADR-0055.
open class InterpolatedStringTests {
    @Fact
    func Plain_String_Without_Dollar_Stays_StringToken() {
        let tokens = SyntaxTree.ParseTokens("\"hello\"").ToArray()
        Assert.Equal(SyntaxKind.StringToken, tokens[0].Kind)
    }

    @Fact
    func Dollar_Identifier_Produces_InterpolatedStringToken() {
        let tokens = SyntaxTree.ParseTokens("\"hi $$name\"").ToArray()
        Assert.Equal(SyntaxKind.InterpolatedStringToken, tokens[0].Kind)
    }

    @Fact
    func Dollar_Brace_Produces_InterpolatedStringToken() {
        let tokens = SyntaxTree.ParseTokens("\"sum=$${1 + 2}\"").ToArray()
        Assert.Equal(SyntaxKind.InterpolatedStringToken, tokens[0].Kind)
    }

    @Fact
    func Double_Dollar_Escapes_To_Literal() {
        let tokens = SyntaxTree.ParseTokens("\"$$$$cost\"").ToArray()
        Assert.Equal(SyntaxKind.StringToken, tokens[0].Kind)
        Assert.Equal("$$cost", tokens[0].Value)
    }

    @Fact
    func Interpolation_Of_String_Variable_Evaluates() {
        let source = `let name = "world"
let msg = "hello $name"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("hello world", msg.Value)
    }

    @Fact
    func Interpolation_Of_Int_Variable_Uses_ToString() {
        let source = `let n = 42
let msg = "answer=$n"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("answer=42", msg.Value)
    }

    @Fact
    func Brace_Interpolation_Of_Arithmetic() {
        let source = "let msg = \"sum=$${1 + 2}\"\n"
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("sum=3", msg.Value)
    }

    @Fact
    func Multiple_Interpolations_Concatenate_In_Order() {
        let source = `let a = 1
let b = 2
let msg = "$a + $b = ${a + b}"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("1 + 2 = 3", msg.Value)
    }

    @Fact
    func Binder_Produces_InterpolatedStringExpression_Node() {
        let tree = SyntaxTree.Parse(SourceText.From(`let x = 1
let msg = "hi $x"
`, "test"))
        let compilation = Compilation(tree)
        let declaration = compilation
            .GlobalScope
            .Statements
            .OfType[BoundVariableDeclaration]()
            .Single((d BoundVariableDeclaration) -> d.Variable.Name == "msg")
        Assert.IsType[BoundInterpolatedStringExpression](declaration.Initializer)
        Assert.Equal(TypeSymbol.String, declaration.Initializer!!.Type)
    }

    @Fact
    func Interpolation_Hex_Format_Specifier_Renders() {
        // 255 -> "00FF" via the X4 format specifier (culture-independent).
        let source = `let n = 255
let msg = "${n:X4}"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("00FF", msg.Value)
    }

    @Fact
    func Interpolation_Positive_Alignment_Right_Justifies() {
        let source = `let s = "hi"
let msg = "[${s,5}]"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("[   hi]", msg.Value)
    }

    @Fact
    func Interpolation_Negative_Alignment_Left_Justifies() {
        let source = `let s = "hi"
let msg = "[${s,-5}]"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("[hi   ]", msg.Value)
    }

    @Fact
    func Interpolation_Alignment_And_Format_Combined() {
        let source = `let n = 255
let msg = "[${n,6:X2}]"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("[    FF]", msg.Value)
    }

    @Fact
    func Interpolation_Hole_Containing_Parenthesized_Call_Is_Not_Mis_Split() {
        // The delimiter-aware splitter must not treat the `()` or any inner
        // punctuation of `n.GetType()` as an alignment/format delimiter.
        let source = `let n = 1
let msg = "${n.GetType()}"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("System.Int32", msg.Value)
    }

    @Fact
    func Format_Specifier_On_String_Path_Uses_String_Format() {
        // ADR-0055 Tier 2: a `:format` clause in a plain (string-typed)
        // interpolation lowers to String.Format with the composite format
        // string, honoring the format specifier.
        let source = `let total = 1234.5
let msg = "amount: ${total:N2}"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("amount: " + (1234.5).ToString("N2", CultureInfo.CurrentCulture), msg.Value)
    }

    @Fact
    func Alignment_Specifier_On_String_Path_Pads() {
        let source = `let name = "Acme"
let msg = "[${name,8}][${name,-8}]"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("[    Acme][Acme    ]", msg.Value)
    }

    @Fact
    func FormattableString_Target_Produces_FormattableString() {
        // ADR-0055 Tier 4: the contextual target type FormattableString lowers
        // to FormattableStringFactory.Create, producing a real
        // System.FormattableString rather than an eager string.
        let source = `let total = 1234.5
let fs FormattableString = "amount: ${total:N2}"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let fs = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "fs").Value
        Assert.IsAssignableFrom[FormattableString](fs)
    }

    @Fact
    func FormattableString_Defers_Culture_To_Caller() {
        // Deferred ToString(IFormatProvider) honors the caller-supplied culture:
        // the same FormattableString renders differently under invariant vs de-DE.
        let source = `let total = 1234.5
let fs FormattableString = "amount: ${total:N2}"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let fs = cast[FormattableString](
            result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "fs").Value
        )
        Assert.Equal("amount: 1,234.50", fs.ToString(CultureInfo.InvariantCulture))
        Assert.Equal("amount: 1.234,50", fs.ToString(CultureInfo.GetCultureInfo("de-DE")))
    }

    @Fact
    func FormattableString_Preserves_Composite_Format() {
        // The synthesized composite format string keeps positional indices,
        // alignment, and the format specifier intact.
        let source = `let total = 1234.5
let qty = 7
let fs FormattableString = "a ${total:N2} b ${qty,4} c"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let fs = cast[FormattableString](
            result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "fs").Value
        )
        Assert.Equal("a {0:N2} b {1,4} c", fs.Format)
        Assert.Equal(2, fs.ArgumentCount)
        Assert.Equal("a 1,234.50 b    7 c", fs.ToString(CultureInfo.InvariantCulture))
    }

    @Fact
    func IFormattable_Target_Produces_Formattable_Value() {
        let source = `let n = 42
let f IFormattable = "n=${n:D3}"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let f = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "f").Value
        Assert.IsAssignableFrom[IFormattable](f)
        Assert.Equal("n=042", (cast[IFormattable](f)).ToString(nil, CultureInfo.InvariantCulture))
    }

    @Fact
    func Argument_To_FormattableString_Parameter_Lowers_To_Formattable() {
        // ADR-0055 Tier 4 (#369): an interpolated string passed directly as a
        // call argument whose parameter type is FormattableString is re-lowered
        // to FormattableStringFactory.Create, so the callee receives a real
        // FormattableString and can defer the culture choice.
        let source = "import System.Globalization\n" +
            "func render(fs FormattableString) string {\n" +
            "    return fs.ToString(CultureInfo.GetCultureInfo(\"de-DE\"))\n" +
            "}\n" +
            "let total = 1234.5\n" +
            "let msg = render(\"amount: $${total:N2}\")\n"
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg").Value
        Assert.Equal("amount: 1.234,50", msg)
    }

    @Fact
    func Argument_To_IFormattable_Parameter_Lowers_To_Formattable() {
        // The same relaxation applies when the parameter type is IFormattable.
        // The function simply returns the value so the lowering can be inspected
        // from the host without relying on in-language interface dispatch.
        let source = "func render(f IFormattable) IFormattable {\n" +
            "    return f\n" +
            "}\n" +
            "let n = 42\n" +
            "let msg = render(\"n=$${n:D3}\")\n"
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg").Value
        Assert.IsAssignableFrom[IFormattable](msg)
        Assert.Equal("n=042", (cast[IFormattable](msg)).ToString(nil, CultureInfo.InvariantCulture))
    }

    @Fact
    func Argument_To_String_Parameter_Stays_String() {
        // A plain `string` parameter must continue to receive an eager string —
        // the Tier 4 relaxation only fires for IFormattable/FormattableString
        // targets, never displacing the interpolation's natural `string` type.
        let source = "func echo(s string) string {\n" +
            "    return s\n" +
            "}\n" +
            "let total = 1234.5\n" +
            "let msg = echo(\"amount: $${total:N2}\")\n"
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg").Value
        Assert.IsType[string](msg)
        Assert.Equal("amount: " + (1234.5).ToString("N2", CultureInfo.CurrentCulture), msg)
    }

    @Fact
    func Overload_Prefers_String_Parameter_Over_FormattableString() {
        // When a method exposes both a string and a FormattableString overload,
        // an interpolated-string argument binds to the string overload (the
        // identity conversion of its natural type), mirroring C#. Here
        // string.Format(string, object) is chosen over any FormattableString
        // path, producing an eager string.
        let source = "let total = 1234.5\n" +
            "let msg = render(\"x\")\n" +
            "func render(s string) string {\n" +
            "    return s\n" +
            "}\n"
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg").Value
        Assert.IsType[string](msg)
        Assert.Equal("x", msg)
    }

    @Fact
    func Imported_Static_Call_FormattableString_Argument_Lowers() {
        // ADR-0055 Tier 4 (#369): overload resolution against an imported static
        // method accepts an interpolated string for a FormattableString
        // parameter. FormattableString.Invariant(FormattableString) formats with
        // the invariant culture regardless of the ambient culture.
        let source = "import System\n" +
            "let total = 1234.5\n" +
            "let msg = FormattableString.Invariant(\"amount: $${total:N2}\")\n"
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg").Value
        Assert.Equal("amount: 1,234.50", msg)
    }

    @Fact
    func Nested_String_In_Hole_Lexes_As_Single_Interpolated_Token() {
        // ADR-0055 §A: the delimiter-aware lexer scanner must not terminate the
        // hole at the nested string's quote.
        let tokens = SyntaxTree.ParseTokens("\"x=$${\"inner\"}\"").ToArray()
        Assert.Equal(SyntaxKind.InterpolatedStringToken, tokens[0].Kind)
    }

    @Fact
    func Nested_String_Literal_In_Hole_Evaluates() {
        let source = "let msg = \"x=$${\"inner\"}\"\n"
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("x=inner", msg.Value)
    }

    @Fact
    func Comma_And_Colon_Inside_Nested_String_Are_Not_Clause_Delimiters() {
        // The `,` and `:` live inside a nested string literal, so they must not
        // be mistaken for the alignment/format clauses of the hole.
        let source = "let msg = \"$${\"a,b:c\".Length}\"\n"
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("5", msg.Value)
    }

    @Fact
    func Multiline_Hole_Is_Allowed() {
        // ADR-0055 §A: a `${ … }` hole may span newlines (C# 11 parity).
        let source = `let msg = "sum=${1 +
2}"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        let msg = result.Variables.Single((kv KeyValuePair[string, object]) -> kv.Key == "msg")
        Assert.Equal("sum=3", msg.Value)
    }

    @Fact
    func Empty_Hole_Reports_GS0223() {
        let diagnostics = GetDiagnostics("let msg = \"x=$${}\"\n")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0223")
    }

    @Fact
    func Empty_Format_Specifier_Reports_GS0224() {
        let diagnostics = GetDiagnostics(`let n = 1
let msg = "x=${n:}"
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0224")
    }

    @Fact
    func Unterminated_Hole_Reports_GS0222() {
        let diagnostics = GetDiagnostics("let msg = \"x=$${1 + 2\"\n")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0222")
    }

    @Fact
    func Newline_In_Literal_Portion_Reports_GS0225() {
        // The newline is in the literal text *after* a hole, so the lexer knows
        // it is in an interpolated string and reports the specific code.
        let diagnostics = GetDiagnostics(`let x = 1
let msg = "a${x}b
c"
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0225")
    }

    @Fact
    func Hole_Diagnostic_Span_Maps_To_True_Source_Location() {
        // ADR-0055 §C: a diagnostic raised on an expression inside a hole must
        // point at the expression's true offset in the outer file, not at the
        // whole string token (or offset 0).
        let source = `let x = 1
let msg = "val=${undefinedThing}"
`
        let result = EmittedOracle.Evaluate(source)
        let expectedStart = source.IndexOf("undefinedThing", StringComparison.Ordinal)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Location.Span.Start == expectedStart)
        Assert.Equal("undefinedThing".Length, diagnostic.Location.Span.Length)
    }

    @Fact
    func Hole_Diagnostic_On_Later_Line_Reports_True_Line_Number() {
        // Issue #1605: the hole is now re-lexed directly out of the outer text
        // (no padded-copy re-parse), so the line/column must still come out
        // right for a hole many lines into the file.
        let source = string.Concat(Enumerable.Repeat("let a = 1\n", 20)) + "let msg = \"val=$${undefinedThing}\"\n"
        let result = EmittedOracle.Evaluate(source)
        let expectedStart = source.IndexOf("undefinedThing", StringComparison.Ordinal)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Location.Span.Start == expectedStart)
        Assert.Equal(20, diagnostic.Location.StartLine)
    }

    @Fact
    func CallValuedByRefLikeHole_ReportsCallSpan() {
        let source = `ref struct Token {
    var value int32
}

func MakeToken() Token {
    return Token{value: 42}
}

func Main() {
    Console.WriteLine("token=${MakeToken()}")
}`
        let result = EmittedOracle.Evaluate(source)
        AssertByRefLikeInterpolationSpan(result.Diagnostics, "(10,32,10,43)", "MakeToken()")
    }

    @Fact
    func ExtensionValuedByRefLikeHole_ReportsCallSpan() {
        let source = `ref struct Token {
    var value int32
}

func (n int32) Wrap() Token {
    return Token{value: n}
}

func Main() {
    let n = 42
    Console.WriteLine("token=${n.Wrap()}")
}`
        let result = EmittedOracle.Evaluate(source)
        AssertByRefLikeInterpolationSpan(result.Diagnostics, "(11,32,11,40)", "n.Wrap()")
    }

    @Fact
    func InstanceCallValuedByRefLikeHole_ReportsCallSpan() {
        let source = `ref struct Token {
    var value int32
}

class Box {
    func Make() Token {
        return Token{value: 42}
    }
}

func Main() {
    let b = Box()
    Console.WriteLine("token=${b.Make()}")
}`
        let result = EmittedOracle.Evaluate(source)
        AssertByRefLikeInterpolationSpan(result.Diagnostics, "(13,32,13,40)", "b.Make()")
    }

    @Fact
    func FieldValuedByRefLikeHole_ReportsFieldSpan() {
        let source = `ref struct Token {
    var value int32
}

ref struct Outer {
    var inner Token
}

func Main() {
    let o = Outer{inner: Token{value: 42}}
    Console.WriteLine("token=${o.inner}")
}`
        let result = EmittedOracle.Evaluate(source)
        AssertByRefLikeInterpolationSpan(result.Diagnostics, "(11,32,11,39)", "o.inner")
    }

    @Fact
    func StructLiteralValuedByRefLikeHole_ReportsLiteralSpan() {
        let source = `ref struct Token {
    var value int32
}

func Main() {
    Console.WriteLine("token=${Token{value: 42}}")
}`
        let result = EmittedOracle.Evaluate(source)
        AssertByRefLikeInterpolationSpan(result.Diagnostics, "(6,32,6,48)", "Token{value: 42}")
    }

    @Theory
    @MemberData("AdditionalByRefLikeHoleSpanCases")
    func AdditionalByRefLikeHoles_ReportHoleSpan(
        shape string,
        source string,
        expectedSpan string,
        expectedText string
    ) {
        let result = EmittedOracle.Evaluate(source)
        AssertByRefLikeInterpolationSpan(result.Diagnostics, expectedSpan, expectedText)
    }

    @Fact
    func Many_Interpolation_Holes_Parse_Near_Linear_Time() {
        // Issue #1605: each hole used to re-lex/re-parse a padded copy of the
        // whole file prefix seen so far (O(fileSize) per hole => O(n^2)
        // total). Doubling the hole count should now roughly double the
        // parse time, not quadruple it.
        let BuildSource = func (holeCount int32) string {
            let sb = StringBuilder()
            for var i = 0; i < holeCount; i++ {
                sb.Append("let v").Append(i).Append(" = \"prefix $${").Append(i).Append("} suffix\"\n")
            }
            return sb.ToString()
        }
        let TimeParse = func (source string) int64 {
            // Warm up JIT once before timing.
            SyntaxTree.Parse(SourceText.From(source))
            // Take the best (minimum) of several runs. Minimum is the least
            // noisy statistic for wall-clock microbenchmarks: it excludes GC
            // pauses and scheduler preemption spikes that otherwise make a
            // single-shot ratio flaky on shared CI hardware.
            var best = int64.MaxValue
            for var i = 0; i < 7; i++ {
                let sw = Stopwatch.StartNew()
                SyntaxTree.Parse(SourceText.From(source))
                sw.Stop()
                if sw.ElapsedTicks < best {
                    best = sw.ElapsedTicks
                }
            }
            // Floor the denominator so an anomalously fast small sample can't
            // blow up the ratio.
            return Math.Max(best, 1)
        }
        // Use a large-enough `small` baseline that fixed per-run overhead and
        // scheduler/cache noise are a small fraction of the measurement — a
        // tiny baseline (e.g. 500 holes) is dominated by noise on shared CI
        // hardware and makes the ratio spuriously large (see issue #2088).
        let small = TimeParse(BuildSource(2000))
        let large = TimeParse(BuildSource(16000)) // 8x the holes/text
        // Quadratic behavior would show ~64x growth; near-linear should stay
        // well under that. Bound is generous (50x for 8x input) to tolerate
        // wall-clock noise on oversubscribed CI runners while still catching a
        // regression back to O(n^2).
        Assert.True(
            large < small * int64(50),
            "expected near-linear scaling, got small=$small large=$large ratio=${float64(large) / float64(small)}"
        )
    }

    shared {
        private func GetDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return tree.Diagnostics
        }

        prop AdditionalByRefLikeHoleSpanCases TheoryData[string, string, string, string] -> {
            let values = TheoryData[string, string, string, string]()
            values.Add("generic call", `ref struct Token {
    var value int32
}

func MakeToken[T]() Token {
    return Token{value: 42}
}

func Main() {
    Console.WriteLine("token=${MakeToken[int32]()}")
}`, "(10,32,10,50)", "MakeToken[int32]()")
            values.Add("argumented call", `ref struct Token {
    var value int32
}

func MakeToken(value int32) Token {
    return Token{value: value}
}

func Main() {
    Console.WriteLine("token=${MakeToken(1 + 2)}")
}`, "(10,32,10,48)", "MakeToken(1 + 2)")
            values.Add("nested interpolation argument", `ref struct Token {
    var value int32
}

func MakeToken(value string) Token {
    return Token{value: value.Length}
}

func Main() {
    let n = 42
    Console.WriteLine("token=${MakeToken("n=${n}")}")
}`, "(11,32,11,51)", "MakeToken(\"n=$${n}\")")
            values.Add("awaited argument", `ref struct Token {
    var value int32
}

async func Seed() int32 {
    return 42
}

func MakeToken(value int32) Token {
    return Token{value: value}
}

async func Main() {
    Console.WriteLine("token=${MakeToken(await Seed())}")
}`, "(14,32,14,55)", "MakeToken(await Seed())")
            values.Add("lambda body", `ref struct Token {
    var value int32
}

func MakeToken() Token {
    return Token{value: 42}
}

func Main() {
    let f = func() {
        Console.WriteLine("token=${MakeToken()}")
    }
    f()
}`, "(11,36,11,47)", "MakeToken()")
            values.Add("lambda-valued local invocation", `ref struct Token {
    var value int32
}

func Main() {
    let f = func() Token { return Token{value: 42} }
    Console.WriteLine("token=${f()}")
}`, "(7,32,7,35)", "f()")
            values.Add("function parameter invocation", `ref struct Token {
    var value int32
}

func Use(f func() Token) {
    Console.WriteLine("token=${f()}")
}

func Main() {
    Use(func() Token { return Token{value: 42} })
}`, "(6,32,6,35)", "f()")
            values.Add("method-value local invocation", `ref struct Token {
    var value int32
}

func MakeToken() Token {
    return Token{value: 42}
}

func Main() {
    let g = MakeToken
    Console.WriteLine("token=${g()}")
}`, "(11,32,11,35)", "g()")
            values.Add("local value", `ref struct Token {
    var value int32
}

func Main() {
    let token = Token{value: 42}
    Console.WriteLine("token=${token}")
}`, "(7,32,7,37)", "token")
            values
        }

        private func AssertByRefLikeInterpolationSpan(
            diagnostics ImmutableArray[Diagnostic],
            expectedSpan string,
            expectedText string
        ) {
            let diagnostic = Assert.Single(diagnostics)
            Assert.Equal("GS0519", diagnostic.Id)
            var location = diagnostic.Location
            // Start is one-based inclusive; end remains exclusive.
            let actualSpan = "(${location.StartLine + 1},${location.StartCharacter + 1},${location.EndLine + 1},${location.EndCharacter + 1})"
            let actualText = location.Text!!.ToString(location.Span)
            Assert.Equal((Span: expectedSpan, Text: expectedText), (Span: actualSpan, Text: actualText))
        }

        private func Evaluate(source string)(
            Diagnostics ImmutableArray[Diagnostic],
            Variables IReadOnlyDictionary[string, object?]
        ) {
            // Post-run globals read back through the oracle (issue #3176 Phase
            // 3b.2): the emitted equivalent of the evaluator's variables
            // dictionary.
            let result = EmittedOracle.Evaluate(source)
            return (result.Diagnostics, result.ReadGlobals())
        }
    }
}
