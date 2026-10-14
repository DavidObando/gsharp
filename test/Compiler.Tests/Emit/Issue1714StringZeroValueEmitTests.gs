// <copyright file="Issue1714StringZeroValueEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests
import System.Collections.Generic
import System.Runtime.CompilerServices

/// Issue #1714: language zero values and CLR storage defaults are distinct.
/// Map misses retain the language's empty-string zero value, while fields and
/// auto-property backing fields retain the CLR default for their storage type.
/// Asserts against the emitted program only; the interpreter parity arm was
/// retired with the evaluator in ADR-0156 Phase 3c (#3176).
/// Each source uses unique package/type names because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
///
/// Issue #3324 (ADR-0008) added a THIRD zero-value bucket alongside the two
/// above: a genuine function-local `var s string` / `let s string` declared
/// without an initializer. ADR-0008 documents that as the language's
/// Go-style `""` zero value (same as the map-miss case), distinct from the
/// field/property/`default(string)`/top-level-`var` bucket above, which stays
/// at the CLR storage default (`null`) by the already-settled #1714/#2788
/// contract. See the `Local*`-prefixed facts below.
open class Issue1714StringZeroValueEmitTests {
    @Fact
    func EndToEnd_MapStringStringMiss_YieldsEmptyString() {
        const source = `package i1714mapmiss
import System

func Main() {
    var m = map[string,string]{}
    let v = m["missing"]
    System.Console.WriteLine(v == "")
    System.Console.WriteLine(v == nil)
    System.Console.WriteLine("[${v}]")
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}[]${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_StructStringField_DefaultsToNull() {
        const source = `package i1714structfield
import System

struct Point { var Label string var X int32 }

func Main() {
    let p = Point{X: 5}
    System.Console.WriteLine(p.Label == "")
    System.Console.WriteLine(p.Label == nil)
    System.Console.WriteLine(p.X)
}`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ClassStringField_DefaultsToNull() {
        const source = `package i1714classfield
import System

class Widget { var Name string }

func Main() {
    let w = Widget{}
    System.Console.WriteLine(w.Name == "")
    System.Console.WriteLine(w.Name == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ClassStringAutoProperty_DefaultsToNull() {
        const source = `package i1714autoprop
import System

class Widget { prop Name string { get; set; } }

func Main() {
    let w = Widget{}
    System.Console.WriteLine(w.Name == "")
    System.Console.WriteLine(w.Name == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DefaultStringExpression_IsNull() {
        const source = `package i1714defaultexpr
import System

func Main() {
    let s string = default(string)
    System.Console.WriteLine(s == "")
    System.Console.WriteLine(s == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_LocalStringDeclaration_LenIsZero() {
        // Issue #3324: `s.Length` on a bare `var s string` local used to NRE —
        // the CLR-default `null` fell straight into `.Length`. Direct
        // repro from the issue.
        const source = `package i3324locallen
import System

func Main() {
    var s string
    Console.WriteLine(s.Length)
}`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_LocalStringDeclaration_DefaultsToEmptyString() {
        // Issue #3324 / ADR-0008: a genuine function-local `var s string`
        // zero-inits to `""`, matching the language's documented Go-style
        // string zero value — the opposite pin from
        // EndToEnd_StructStringField_DefaultsToNull /
        // EndToEnd_ClassStringField_DefaultsToNull above, which are fields
        // and stay CLR-null by design (#1714/#2788).
        const source = `package i3324locallet
import System

func Main() {
    let s string = default(string)
    var t string
    System.Console.WriteLine(t == "")
    System.Console.WriteLine(t == nil)
    System.Console.WriteLine(s == nil)
}`
        let output = CompileAndRun(source)
        // `t` (bare `var t string`) is the ADR-0008 local zero value: `""`,
        // non-null. `s` (`default(string)`, unchanged by #3324) stays the
        // CLR-default `null` — same source, two different initializer forms,
        // two different documented contracts.
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_LocalStringDeclaration_ComparisonAndConcatenation() {
        // Issue #3324 witness matrix: comparison against `""` and direct
        // concatenation/interpolation both observe the sound `""` value
        // rather than crashing or observing `null`.
        const source = `package i3324localops
import System

func Main() {
    var s string
    System.Console.WriteLine(s == "")
    var concatenated = "[" + s + "]"
    System.Console.WriteLine(concatenated)
    System.Console.WriteLine("<${s}>")
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}[]${Environment.NewLine}<>${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_TopLevelStringDeclaration_StaysNull() {
        // Issue #3324 scoping pin: a top-level `var g string` binds a
        // GlobalVariableSymbol, emitted as a static field — the same
        // #1714/#2788 CLR-null contract as an explicit field, NOT the
        // function-local `""` contract above. This must NOT change.
        const source = `package i3324localglobal
import System

var g string
Console.WriteLine(g == nil)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NestedStructStringFields_DefaultToNull() {
        const source = `package i1714nestedstruct
import System

struct Inner2 { var Str string var Tag int32 }
struct Inner { var Str string var Deep Inner2 }
struct Outer { var Inner Inner var Code int32 }

func Main() {
    let o = default(Outer)
    System.Console.WriteLine(o.Inner.Str == "")
    System.Console.WriteLine(o.Inner.Str == nil)
    System.Console.WriteLine(o.Inner.Deep.Str == "")
    System.Console.WriteLine(o.Inner.Deep.Str == nil)
    System.Console.WriteLine("[${o.Inner.Str}][${o.Inner.Deep.Str}]")
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}[][]${Environment.NewLine}",
            output
        )
    }

    @Fact
    func EndToEnd_InstanceAndStaticReferenceFields_MatchClrDefaults() {
        const source = `package i1714references
import System

class Child {}

struct StructHolder {
    var Empty string = ""
}

class Holder {
    var Text string
    var MaybeText string?
    var Value object
    var Items []int32
    var ChildValue Child
    var Empty string = ""

    func InstanceDefaultsAreCorrect() bool {
        return Text == nil && MaybeText == nil && ChildValue == nil && Empty == ""
    }

    shared {
        var SharedText string
        var SharedValue object
        var SharedItems []int32
        var SharedChild Child?

        func DefaultsAreCorrect() bool {
            return SharedText == nil && SharedChild == nil
        }
    }
}

func Main() {
    Console.WriteLine(Holder{}.InstanceDefaultsAreCorrect())
    Console.WriteLine(Holder.DefaultsAreCorrect())
    Console.WriteLine(StructHolder{}.Empty == "")
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func Reflection_ReferenceFields_UseClrNullAndPreserveAnnotationsAndInitializer() {
        const source = `package i1714reflection

class Child {}

class ClassFields {
    public var Text string
    public var MaybeText string?
    public var Value object
    public var Items []int32
    public var ChildValue Child
    public var Empty string = ""
    shared {
        public var SharedText string
        public var SharedValue object
        public var SharedItems []int32
        public var SharedChild Child?
    }
}

struct StructFields {
    public var Text string
    public var MaybeText string?
    public var Value object
    public var Items []int32
    public var ChildValue Child
}`
        let assembly = CompileToAssembly(source)
        let classType = assembly.GetTypes().Single((t Type) -> t.Name == "ClassFields")
        let classValue object? = Activator.CreateInstance(classType)
        let structType = assembly.GetTypes().Single((t Type) -> t.Name == "StructFields")
        let structValue object? = Activator.CreateInstance(structType)
        for name in[]string{"Text", "MaybeText", "Value", "ChildValue"} {
            Assert.Null(classType.GetField(name)!!.GetValue(classValue))
            Assert.Null(structType.GetField(name)!!.GetValue(structValue))
        }
        // ADR-0159: bare (non-nullable) slice fields zero-init to an empty
        // instance, not CLR null, so `[]int32` slots are always safely usable.
        // Class instance fields go through the emitted instance ctor, which the
        // synthesized initializer hooks into. StructFields has no explicit
        // members needing a synthesized ctor (#3219: all-public structs keep
        // byte-identical emission with no ctor), and `Activator.CreateInstance`
        // for a value type with no ctor bypasses G# initializer logic entirely
        // (matching C#'s own `default(structWithList)` semantics) -- this
        // reflects the CLR/raw-default case, not a G#-observed declaration.
        // Struct-local zero-value initialization (`var s S` where S has a
        // slice field, a G#-OBSERVED declaration going through the G# binder
        // and emitter) was closed by issue #3319 — see
        // Issue3319StructLocalZeroValueEmitTests. This assertion's own
        // scenario is unaffected: `Activator.CreateInstance` bypasses G#
        // initializer logic entirely, as noted above.
        Assert.Empty(cast[Array](classType.GetField("Items")!!.GetValue(classValue)!!))
        Assert.Null(structType.GetField("Items")!!.GetValue(structValue))
        // ClassFields' shared block has no explicit `init()`, so per ADR-0155 it
        // stays beforefieldinit; reflection-based static field access does not
        // reliably trigger a beforefieldinit type's initializer, so force it
        // before observing SharedItems' ADR-0159 zero-value initializer.
        RuntimeHelpers.RunClassConstructor(classType.TypeHandle)
        Assert.Null(classType.GetField("SharedText")!!.GetValue(nil))
        Assert.Null(classType.GetField("SharedValue")!!.GetValue(nil))
        Assert.Empty(cast[Array](classType.GetField("SharedItems")!!.GetValue(nil)!!))
        Assert.Null(classType.GetField("SharedChild")!!.GetValue(nil))
        Assert.Equal(string.Empty, classType.GetField("Empty")!!.GetValue(classValue))
        let nullability = NullabilityInfoContext()
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("Text")!!).ReadState)
        Assert.Equal(NullabilityState.Nullable, nullability.Create(classType.GetField("MaybeText")!!).ReadState)
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("Value")!!).ReadState)
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("Items")!!).ReadState)
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("ChildValue")!!).ReadState)
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("SharedText")!!).ReadState)
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("SharedValue")!!).ReadState)
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("SharedItems")!!).ReadState)
        Assert.Equal(NullabilityState.Nullable, nullability.Create(classType.GetField("SharedChild")!!).ReadState)
        Assert.Equal(NullabilityState.NotNull, nullability.Create(structType.GetField("Text")!!).ReadState)
        Assert.Equal(NullabilityState.Nullable, nullability.Create(structType.GetField("MaybeText")!!).ReadState)
    }

    @Fact
    func FieldDefaults_DoNotChangeDefiniteAssignmentDiagnostics() {
        const fields = `package i1714fielddiagnostics
class Child {}
class Box {
    var Text string
    var ChildValue Child
}`
        let fieldsDiagnostics = CollectCompileDiagnostics(fields)
        Assert.Empty(fieldsDiagnostics)
        const unassignedOut = `package i1714outdiagnostics
func bad(out value string) {
    return
}`
        let outDiagnostics = CollectCompileDiagnostics(unassignedOut)
        Assert.Contains(outDiagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    shared {
        /// Collects compile-time diagnostics (parse, global scope, and bound
        /// program) for [`source`](paramref) without executing it.
        private func CollectCompileDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation
                .SyntaxTrees
                .SelectMany(
                func (t SyntaxTree) IEnumerable[Diagnostic] {
                    return t.Diagnostics
                }
            )
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToImmutableArray()
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_1714_reflection_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let exitCode = Program.Main(
                    []string{"/out:" + dllPath, "/target:library", "/targetframework:net10.0", srcPath}
                )
                Assert.Equal(0, exitCode)
                IlVerifier.Verify(dllPath)
                return EmittedFixture.Load(dllPath)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1714_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
