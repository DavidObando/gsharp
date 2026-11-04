// <copyright file="Issue4964ConditionalNarrowingParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #4964: the conditional operator (`c ? a : b`) and the
/// if-expression (`if c { a } else { b }`) are two spellings of one value
/// form, and both lower to `BoundConditionalExpression`. Only the
/// if-expression bound its branches under the smart-cast narrowing its
/// condition implies, so `s != nil ? s.Length : 0` reported GS0158 while
/// `if s != nil { s.Length } else { 0 }` compiled.
///
/// Both binders now take their branch frames from one helper,
/// `ExpressionBinder.ClassifyConditionalNarrowing`. The parity theory binds
/// each case in both spellings and requires the same diagnostics, so the
/// two forms cannot drift apart again. The execution facts run the
/// value-type `Nullable<T>` shapes through ilverify, because a narrowed
/// value-type read that skips the `BuildNarrowedRead` unwrap leaves a
/// `Nullable<T>` on the stack.
open class Issue4964ConditionalNarrowingParityTests {
    /// The issue's repro, verbatim: every `?:` variant reported GS0158.
    @Fact
    func Issue_Repro_Compiles_Verifies_And_Prints_21() {
        let result = CompileAndRun(`import System
func ifx(s string?) int32 -> if s != nil { s.Length } else { 0 }
func ifs(s string?) int32 {
    if s != nil { return s.Length } else { return 0 }
}
func ter(s string?) int32 -> s != nil ? s.Length : 0
func terNeg(s string?) int32 -> s == nil ? 0 : s.Length
func terAnd(s string?, t string?) int32 -> (s != nil && t != nil) ? s.Length + t.Length : 0
func ifType(o object) int32 -> if o is string { o.Length } else { 0 }
func terType(o object) int32 -> (o is string) ? o.Length : 0
Console.WriteLine(ifx("abc") + ifs("abc") + ter("abc") + terNeg("abc") + terAnd("a", "bc") + ifType("abc") + terType("abc"))
`)
        Assert.Equal("21" + Environment.NewLine, result.Output)
    }

    /// A narrowed `int32?` read in a `?:` branch must be unwrapped from its
    /// `Nullable<int32>` storage. ilverify rejects the method if it is not,
    /// and the emitter throws GS9998 first. Covers `!= nil`, `== nil`, a
    /// nested ternary, the nil branch at run time, and a user struct and
    /// enum (the `IsUserValueTypeNullable` path).
    @Fact
    func Value_Type_Nullable_Branches_Unwrap_Verify_And_Run() {
        let result = CompileAndRun(`import System
struct Point {
    var X int32
    var Y int32
}
enum Color { Red, Green }
func plusOne(n int32?) int32 -> n != nil ? n + 1 : -1
func twice(n int32?) int32 -> n == nil ? -1 : n * 2
func nested(a int32?, b int32?) int32 -> a != nil ? (b != nil ? a + b : a) : 0
func sum(p Point?) int32 -> p != nil ? p.X + p.Y : -1
func name(c Color?) string -> c == nil ? "none" : c.ToString()
func pass(n int32?) int64 -> n != nil ? n : 7
Console.WriteLine("${plusOne(4)} ${plusOne(nil)} ${twice(4)} ${twice(nil)}")
Console.WriteLine("${nested(2, 3)} ${nested(2, nil)} ${nested(nil, 3)}")
Console.WriteLine("${sum(Point{X: 2, Y: 5})} ${sum(nil)} ${name(Color.Green)} ${name(nil)}")
Console.WriteLine(pass(9) + pass(nil))
`)
        Assert.Equal(
            string.Join(Environment.NewLine, "5 -1 8 -1", "5 2 0", "7 -1 Green none", "16") + Environment.NewLine,
            result.Output
        )
    }

    /// `&&`, `||`, `!` and `!is` compose in a `?:` condition exactly as they
    /// do in an if-expression condition, and the branch that is taken at
    /// run time reads the narrowed value.
    @Fact
    func Composed_Conditions_Narrow_And_Run() {
        let result = CompileAndRun(`import System
func both(s string?, t string?) int32 -> (s != nil && t != nil) ? s.Length + t.Length : 0
func either(s string?, t string?) int32 -> (s == nil || t == nil) ? 0 : s.Length + t.Length
func negated(o object) int32 -> !(o is string) ? 0 : o.Length
func isNot(o object) int32 -> (o !is string) ? 0 : o.Length
func mixed(o object, s string?) int32 -> (o is string && s != nil) ? o.Length + s.Length : -1
Console.WriteLine("${both("a", "bc")} ${both(nil, "bc")} ${either("a", "bc")} ${either("a", nil)}")
Console.WriteLine("${negated("abc")} ${negated(1)} ${isNot("abcd")} ${isNot(1)} ${mixed("ab", "c")} ${mixed(1, "c")}")
`)
        Assert.Equal(string.Join(Environment.NewLine, "3 0 3 0", "3 0 4 0 3 -1") + Environment.NewLine, result.Output)
    }

    /// Narrowing changes a branch's type, so it can change the conditional's
    /// result type: `n != nil ? n : 0` is now `int32` (it was `int32?`), as
    /// the if-expression already was. The overload chosen for the result
    /// follows, in both spellings.
    @Fact
    func Narrowed_Result_Type_Selects_The_Same_Overload_In_Both_Forms() {
        let result = CompileAndRun(`import System
func pick(x int32) string -> "int32"
func pick(x int32?) string -> "int32?"
func viaTernary(n int32?) string -> pick(n != nil ? n : 0)
func viaIf(n int32?) string -> pick(if n != nil { n } else { 0 })
Console.WriteLine("${viaTernary(1)} ${viaIf(1)} ${viaTernary(nil)} ${viaIf(nil)}")
`)
        Assert.Equal("int32 int32 int32 int32" + Environment.NewLine, result.Output)
    }

    /// Binds each case as `(c) ? a : b` and as `if c { a } else { b }` and
    /// requires identical diagnostics (id and the text each one covers).
    /// `expected` pins the result too, so a change that broke both forms the
    /// same way would still fail.
    @Theory
    @InlineData("s string?", "int32", "s != nil", "s.Length", "0", "")
    @InlineData("s string?", "int32", "s == nil", "0", "s.Length", "")
    @InlineData("s string?", "int32", "nil != s", "s.Length", "0", "")
    @InlineData("s string?, t string?", "int32", "s != nil && t != nil", "s.Length + t.Length", "0", "")
    @InlineData("s string?, t string?", "int32", "s == nil || t == nil", "0", "s.Length + t.Length", "")
    @InlineData("o object", "int32", "o is string", "o.Length", "0", "")
    @InlineData("o object", "int32", "!(o is string)", "0", "o.Length", "")
    @InlineData("o object", "int32", "(o !is string)", "0", "o.Length", "")
    @InlineData("o object, s string?", "int32", "o is string && s != nil", "o.Length + s.Length", "0", "")
    @InlineData("n int32?", "int32", "n != nil", "n + 1", "-1", "")
    @InlineData("n int32?", "int32", "n == nil", "-1", "n", "")
    @InlineData("s string?", "string", "s != nil", "s", "\"x\"", "")
    // A guard narrows only the branch it proves: the other branch keeps
    // the declared nullable type.
    @InlineData("s string?", "int32", "s == nil", "s.Length", "0", "GS0158:Length")
    @InlineData("s string?", "int32", "s != nil", "0", "s.Length", "GS0158:Length")
    @InlineData("o object", "int32", "o is string", "0", "o.Length", "GS0158:Length")
    @InlineData("s string?, t string?", "int32", "s != nil || t != nil", "s.Length", "0", "GS0158:Length")
    // A `Nullable<T>` member the narrowed type does not have binds against
    // the `Nullable<T>` storage, in both forms (issue #4986).
    @InlineData("n int32?", "int32", "n != nil", "n.Value", "0", "")
    @InlineData("n int32?", "int32", "n != nil", "n.GetValueOrDefault()", "0", "")
    @InlineData("n int32?", "bool", "n == nil", "false", "n.HasValue", "")
    // A narrowed value makes a user `!!` redundant (GS0536) in both forms,
    // including an ADR-0186 platform (`T!`) value, which a nil guard
    // narrows to `T`.
    @InlineData("s string?", "int32", "s != nil", "s!!.Length", "0", "GS0536:!!")
    @InlineData("@Oblivious s string", "int32", "s != nil", "s!!.Length", "0", "GS0536:!!")
    @InlineData("@Oblivious s string", "int32", "s == nil", "0", "s!!.Length", "GS0536:!!")
    @InlineData("@Oblivious s string", "int32", "s != nil", "0", "s!!.Length", "")
    // Composed nil guards over a VALUE-type nullable do not narrow in
    // either form (the short-circuit classifier is reference-only, issue #4969); the
    // forms still agree.
    @InlineData("n int32?", "int32", "!(n == nil)", "n", "-1", "GS0156:n")
    func Ternary_And_If_Expression_Report_The_Same_Diagnostics(
        parameters string,
        returnType string,
        condition string,
        whenTrue string,
        whenFalse string,
        expected string
    ) {
        // The condition is parenthesized because `o is string ? 0 : …` does
        // not parse as a conditional (issue #4970).
        let ternary = Diagnose(parameters, returnType, "(${condition}) ? ${whenTrue} : ${whenFalse}")
        let ifExpression = Diagnose(parameters, returnType, "if ${condition} { ${whenTrue} } else { ${whenFalse} }")
        Assert.Equal(ifExpression, ternary)
        Assert.Equal(expected, ternary)
    }

    /// Narrowing is scoped to the branch: a guarded read after the
    /// conditional is not narrowed in either form.
    @Theory
    @InlineData("s != nil ? s.Length : 0")
    @InlineData("if s != nil { s.Length } else { 0 }")
    func Narrowing_Does_Not_Leak_Past_The_Conditional(conditional string) {
        let source = (`package Issue4964.Leak
func f(s string?) int32 {
    let n = ` + conditional + `
    return n + s.Length
}
`)
        Assert.Equal("GS0158:Length", DiagnoseSource(source))
    }

    /// Issue #4974: in an expression-tree lambda a narrowed value-type nullable
    /// read lowers its synthesized unwrap to `Expression.Convert` in both
    /// conditional forms, while an explicit user `!!` on a nullable value type
    /// remains rejected with GS0473.
    @Theory
    @InlineData("v != nil ? v + 1 : 0")
    @InlineData("if v != nil { v + 1 } else { 0 }")
    func Expression_Tree_Narrowed_Value_Type_Read_Compiles_And_Runs_In_Both_Forms(conditional string) {
        let result = CompileAndRun(`import System
import System.Linq.Expressions
let e Expression[Func[int32?, int32]] = (v int32?) -> ` + conditional + `
let fn = e.Compile()
Console.WriteLine("${fn(4)} ${fn(nil)}")
`)
        Assert.Equal("5 0" + Environment.NewLine, result.Output)
    }

    /// Issue #4974: type-test and value-type-nullable narrowed reads inside
    /// expression-tree lambdas lower to `Expression.Convert` across parameters,
    /// captured locals, and stable field/property member paths,
    /// while explicit user `!!` on a value-type nullable still reports GS0473.
    @Fact
    func Issue4974_Expression_Tree_Narrowed_Reads_Lower_To_Convert_And_Evaluate() {
        let result = CompileAndRun(`import System
import System.Linq.Expressions

open class Animal {
    let Tag int32 = 1
}

class Dog : Animal {
    let BarkLen int32 = 4
    func Bark() int32 -> this.BarkLen + this.Tag
}

struct Point {
    var X int32
    var Y int32
}

enum Color { Red, Green }

class Holder {
    let Pet Animal = Dog()
    prop CurrentPet Animal { get; init; }
    let Count int32? = 7
    prop MaybeCount int32? { get; init; }
    init() {
        this.CurrentPet = Dog()
        this.MaybeCount = 7
    }
}

func runCaptured(capturedObj object, capturedInt int32?) int32 {
    let capTree Expression[Func[int32]] = () -> ((capturedObj is string) ? capturedObj.Length : 0) + (capturedInt != nil ? capturedInt : 0)
    return capTree.Compile()()
}

let ifType Expression[Func[object, int32]] = (value object) -> if value is string { value.Length } else { 0 }
let terType Expression[Func[object, int32]] = (value object) -> (value is string) ? value.Length : 0
let andType Expression[Func[object, bool]] = (value object) -> value is string && value.Length > 1
let orType Expression[Func[object, bool]] = (value object) -> !(value is string) || value.Length > 1
let unboxInt Expression[Func[object, int32]] = (value object) -> (value is int32) ? value + 10 : -1
let derivedClass Expression[Func[Animal, int32]] = (a Animal) -> (a is Dog) ? a.Bark() : 0
let fieldPath Expression[Func[Holder, int32]] = (h Holder) -> (h.Pet is Dog) ? h.Pet.Bark() : -1
let propPath Expression[Func[Holder, int32]] = (h Holder) -> if h.CurrentPet is Dog { h.CurrentPet.Bark() } else { -1 }

let valIf Expression[Func[int32?, int32]] = (v int32?) -> if v != nil { v + 1 } else { 0 }
let valTer Expression[Func[int32?, int32]] = (v int32?) -> v != nil ? v + 1 : 0
let valElse Expression[Func[int32?, int32]] = (v int32?) -> v == nil ? -1 : v * 2
let valStruct Expression[Func[Point?, int32]] = (p Point?) -> p != nil ? p.X + p.Y : -1
let valEnum Expression[Func[Color?, string]] = (c Color?) -> c == nil ? "none" : c.ToString()
let valFieldPath Expression[Func[Holder, int32]] = (h Holder) -> h.Count != nil ? h.Count + 1 : 0
let valPropPath Expression[Func[Holder, int32]] = (h Holder) -> if h.MaybeCount != nil { h.MaybeCount + 2 } else { 0 }

Console.WriteLine("${ifType.Compile()("abc")} ${ifType.Compile()(1)} ${terType.Compile()("abcd")} ${terType.Compile()(1)}")
Console.WriteLine("${andType.Compile()("ab")} ${andType.Compile()("a")} ${andType.Compile()(1)} ${orType.Compile()(1)} ${orType.Compile()("a")} ${orType.Compile()("ab")}")
Console.WriteLine("${unboxInt.Compile()(5)} ${unboxInt.Compile()("x")} ${derivedClass.Compile()(Dog())} ${derivedClass.Compile()(Animal())}")
Console.WriteLine("${fieldPath.Compile()(Holder())} ${propPath.Compile()(Holder())}")
Console.WriteLine("${valIf.Compile()(4)} ${valIf.Compile()(nil)} ${valTer.Compile()(4)} ${valTer.Compile()(nil)} ${valElse.Compile()(4)} ${valElse.Compile()(nil)}")
Console.WriteLine("${valStruct.Compile()(Point{X: 2, Y: 5})} ${valStruct.Compile()(nil)} ${valEnum.Compile()(Color.Green)} ${valEnum.Compile()(nil)}")
Console.WriteLine("${valFieldPath.Compile()(Holder())} ${valPropPath.Compile()(Holder())} ${runCaptured("captured", 9)} ${runCaptured(42, nil)}")
`)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "3 0 4 0",
                "True False False True False True",
                "15 -1 5 0",
                "5 5",
                "5 0 5 0 8 -1",
                "7 -1 Green none",
                "8 9 17 0"
            ) +
                Environment.NewLine,
            result.Output
        )

        let explicitUserBangBang = `package Issue4974.ExplicitAssertion
import System
import System.Linq.Expressions
func f() int32 {
    let e Expression[Func[int32?, int32]] = (v int32?) -> v!! + 1
    return e.Compile()(1)
}
`
        Assert.Equal("GS0473:v!!", DiagnoseSource(explicitUserBangBang))
    }

    shared {
        /// Binds `func f(<parameters>) <returnType> -> <body>` and renders its
        /// diagnostics as `id:covered-text` entries joined by `;`.
        private func Diagnose(parameters string, returnType string, body string) string {
            let source = (`package Issue4964.Parity
import System
func f(` + parameters + ") " + returnType + " -> " + body + `
`)
            return DiagnoseSource(source)
        }

        private func DiagnoseSource(source string) string {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let diagnostics = compilation.Emit(peStream).Diagnostics
            return string.Join(
                ";",
                diagnostics.OrderBy((d Diagnostic) -> d.Location.Span.Start).Select(
                    (d Diagnostic) -> d.Id + ":" + source.Substring(d.Location.Span.Start, d.Location.Span.Length)
                )
            )
        }

        /// Compiles the program through the real driver, verifies it with
        /// ilverify, runs it and returns its standard output and the
        /// compiler's output.
        private func CompileAndRun(source string)(Output string, CompilerOutput string) {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4964ConditionalNarrowingParityTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue4964.dll")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = outputDirectory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                let (sampleExit, stdout, stderr) = IlVerifier.RunProcess(startInfo, outputPath, 30_000)
                Assert.True(sampleExit == 0, (`sample exited ` + "$sampleExit" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return (
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    standardOut.ToString() + standardError.ToString()
                )
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch { }
            }
        }
    }
}
