// <copyright file="Issue3712InstanceGenericCallMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #3712, "Related (distinct, not fixed here)": the INSTANCE generic-call
/// path (`tokens.ConvertAll(Helper.ToRange)`).
///
/// Two independent defects met on that path, and only the second is the one
/// #3712 predicted:
///
/// 1. `ResolveInstanceReturnTypeFromReceiver` (issue #794) projects the OPEN declaring type's return
/// type through the receiver's symbolic type arguments, but never substituted the selected method's OWN
/// generic parameters. For `List<T>.ConvertAll<TOutput>` that yields the open `List[TOutput]`, and
/// because the override is consulted BEFORE the plain CLR return type it became the call's bound type —
/// `GS0156: Cannot convert type 'List[TOutput]' to …`. This has nothing to do with method groups: it
/// fires for a plain lambda argument too, and even with an explicit `[string]` type-argument list. The
/// discriminator is a receiver whose type arguments are symbolic (a same-compilation user class such as
/// `List[Token]`).
/// 2. the #3712 gap proper: a user method group has no natural type until the target delegate is known,
/// so its slot in the pre-resolution symbolic vector is the Error sentinel and the group's
/// same-compilation return type is lost. The extension-call path recovers it (#3713); the instance,
/// inherited-instance and imported-static paths did not. With defect 1 fixed but this one still open
/// the same programs would compile clean and emit `ConvertAll<object>` into an `IEnumerable[Range]`
/// slot — silently unverifiable IL — so every test here runs ilverify AND executes the program.
open class Issue3712InstanceGenericCallMethodGroupEmitTests {
    /// The issue's own instance-path repro: an overloaded `shared` group
    /// returning a same-compilation class, projected by `List[T].ConvertAll`
    /// over a receiver whose element type is also same-compilation.
    @Fact
    func InstanceGenericCall_OverloadedGroup_ReturningSameCompilationClass_EmitsClosedOverRealType() {
        let source = `package P
import System
import System.Collections.Generic

class Token {
    var Text string
    init(text string) { Text = text }
}

class Range {
    var Label string
    init(label string) { Label = label }
}

class Holder {
    var Items IEnumerable[Range]
}

class Helper {
    shared {
        func ToRange(token Token) Range { return Range(token.Text) }
        func ToRange(text string, extra int32) Range { return Range(text) }
    }
}

func Build(tokens List[Token]) Holder {
    return Holder{Items: tokens.ConvertAll(Helper.ToRange)}
}

var tokens = List[Token]()
tokens.Add(Token("a"))
tokens.Add(Token("b"))
for item in Build(tokens).Items {
    Console.WriteLine(item.Label)
}`
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}", CompileAndRun(source))
    }

    /// The same shape with a SINGLE-candidate group. #3712 framed the instance
    /// gap as the overloaded case; it is not — a single-candidate group whose
    /// return type is a same-compilation class also has no CLR-expressible
    /// natural type, so it reaches the symbolic vector erased exactly like an
    /// overloaded one.
    @Fact
    func InstanceGenericCall_SingleCandidateGroup_ReturningSameCompilationClass_EmitsClosedOverRealType() {
        let source = `package P
import System
import System.Collections.Generic

class Token {
    var Text string
    init(text string) { Text = text }
}

class Range {
    var Label string
    init(label string) { Label = label }
}

class Holder {
    var Items IEnumerable[Range]
}

class Helper {
    shared {
        func ToRange(token Token) Range { return Range(token.Text) }
    }
}

func Build(tokens List[Token]) Holder {
    return Holder{Items: tokens.ConvertAll(Helper.ToRange)}
}

var tokens = List[Token]()
tokens.Add(Token("a"))
for item in Build(tokens).Items {
    Console.WriteLine(item.Label)
}`
        Assert.Equal("a${Environment.NewLine}", CompileAndRun(source))
    }

    /// Defect 1 in isolation: no method group at all — a plain lambda whose
    /// return type is a BCL type. The receiver's symbolic element type is the
    /// only unusual ingredient, and the call still failed to bind, which is
    /// what disproves the issue's method-group framing for this path.
    @Fact
    func InstanceGenericCall_LambdaArgument_SymbolicReceiver_BindsAndRuns() {
        let source = `package P
import System
import System.Collections.Generic

class Token {
    var Text string
    init(text string) { Text = text }
}

func Build(tokens List[Token]) IEnumerable[string] {
    return tokens.ConvertAll(func(t Token) string { return t.Text })
}

var tokens = List[Token]()
tokens.Add(Token("a"))
for item in Build(tokens) {
    Console.WriteLine(item)
}`
        Assert.Equal("a${Environment.NewLine}", CompileAndRun(source))
    }

    /// Defect 1 with an EXPLICIT type-argument list. Inference is bypassed
    /// entirely here, so this pins the failure on the receiver-driven
    /// return-type override rather than on any inference step.
    @Fact
    func InstanceGenericCall_ExplicitTypeArgument_SymbolicReceiver_BindsAndRuns() {
        let source = `package P
import System
import System.Collections.Generic

class Token {
    var Text string
    init(text string) { Text = text }
}

func Build(tokens List[Token]) IEnumerable[string] {
    return tokens.ConvertAll[string](func(t Token) string { return t.Text })
}

var tokens = List[Token]()
tokens.Add(Token("a"))
for item in Build(tokens) {
    Console.WriteLine(item)
}`
        Assert.Equal("a${Environment.NewLine}", CompileAndRun(source))
    }

    /// Defect 1 with a value-type result, so the projected type argument is a
    /// struct rather than a reference type (a wrong instantiation here would
    /// box and fail verification instead of merely mistyping).
    @Fact
    func InstanceGenericCall_ValueTypeResult_SymbolicReceiver_BindsAndRuns() {
        let source = `package P
import System
import System.Collections.Generic

class Token {
    var Text string
    init(text string) { Text = text }
}

func Build(tokens List[Token]) IEnumerable[int32] {
    return tokens.ConvertAll(func(t Token) int32 { return t.Text.Length })
}

var tokens = List[Token]()
tokens.Add(Token("ab"))
for item in Build(tokens) {
    Console.WriteLine(item)
}`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    /// The imported-STATIC sibling of the #3712 gap
    /// (`ImportedClassSymbol.TryLookupFunction`): the same overloaded group
    /// through `Array.ConvertAll` reported
    /// `GS0155: Cannot convert type 'object[]' to '[]Range'` because the
    /// group's symbolic slot was never refined there either.
    @Fact
    func ImportedStaticGenericCall_OverloadedGroup_ReturningSameCompilationClass_EmitsClosedOverRealType() {
        let source = `package P
import System

class Range {
    var Label string
    init(label string) { Label = label }
}

class Helper {
    shared {
        func ToRange(value int32) Range { return Range(value.ToString()) }
        func ToRange(text string, extra int32) Range { return Range(text) }
    }
}

func Build(values []int32) []Range {
    return Array.ConvertAll(values, Helper.ToRange)
}

for item in Build([]int32{1, 2}) {
    Console.WriteLine(item.Label)
}`
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", CompileAndRun(source))
    }

    /// The SILENT half of the instance gap. With a BCL element type in the
    /// receiver (`List[int32]`) defect 1 never fires, so the program
    /// compiled clean on main — and emitted `ConvertAll<object>`,
    /// storing a `List<object>` into an `IEnumerable<Range>`
    /// slot. On `origin/main` this test fails only at the ilverify step
    /// (`StackUnexpected`), which is why these tests must verify and
    /// execute rather than count diagnostics.
    @Fact
    func InstanceGenericCall_ClrReceiverElement_OverloadedGroup_EmitsClosedOverRealType() {
        let source = `package P
import System
import System.Collections.Generic

class Range {
    var Label string
    init(label string) { Label = label }
}

class Helper {
    shared {
        func ToRange(value int32) Range { return Range(value.ToString()) }
        func ToRange(text string, extra int32) Range { return Range(text) }
    }
}

func Build(values List[int32]) IEnumerable[Range] {
    return values.ConvertAll(Helper.ToRange)
}

var values = List[int32]()
values.Add(7)
for item in Build(values) {
    Console.WriteLine(item.Label)
}`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    /// Anti-vacuity control: an overloaded group whose candidates all share
    /// the target arity stays ambiguous by arity alone, so the refinement must
    /// decline it and leave the existing erasure path to decide. The program
    /// must still bind and pick the `int32` candidate.
    @Fact
    func InstanceGenericCall_SameArityOverloads_StayOnTheErasurePath() {
        let source = `package P
import System
import System.Collections.Generic

class Helper {
    shared {
        func Describe(value int32) string { return "i" + value.ToString() }
        func Describe(value string) string { return "s" + value }
    }
}

func Build(values List[int32]) List[string] {
    return values.ConvertAll(Helper.Describe)
}

var values = List[int32]()
values.Add(3)
for item in Build(values) {
    Console.WriteLine(item)
}`
        Assert.Equal("i3${Environment.NewLine}", CompileAndRun(source))
    }

    /// Anti-vacuity guard-rail: a genuinely inapplicable method group must
    /// still be REJECTED. The refinement widens what the symbolic vector can
    /// recover; it must not make an incompatible group bind. `ToRange` has
    /// no one-parameter candidate that accepts a `Token`, so the call has
    /// to report a diagnostic rather than silently pick something.
    @Fact
    func InstanceGenericCall_IncompatibleGroup_StillFailsToBind() {
        let source = `package P
import System
import System.Collections.Generic

class Token {
    var Text string
    init(text string) { Text = text }
}

class Range {
    var Label string
    init(label string) { Label = label }
}

class Helper {
    shared {
        func ToRange(first Range, second Range) Range { return first }
    }
}

func Build(tokens List[Token]) IEnumerable[Range] {
    return tokens.ConvertAll(Helper.ToRange)
}

Console.WriteLine(Build(List[Token]()))`
        let (exitCode, output) = Compile(source)
        Assert.True(exitCode != 0, "an inapplicable method group must not bind; got a clean compile:\n" + output)
    }

    shared {
        private func Compile(source string)(ExitCode int32, Output string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_3712_inst_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                try {
                    return (Program.Main(args), compileOut.ToString() + compileErr.ToString())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
            } finally {
                TryDelete(tempDir)
            }
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3712_inst_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // (a) A generic call closed over the `object` erasure binds and
                // compiles clean — only IL verification catches it.
                IlVerifier.Verify(outPath)
                // (b) Verifiable-but-wrong is worse than the bug, so the program
                // must also produce the right values.
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi) ?? throw XunitException("failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                TryDelete(tempDir)
            }
        }

        private func TryDelete(tempDir string) {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
