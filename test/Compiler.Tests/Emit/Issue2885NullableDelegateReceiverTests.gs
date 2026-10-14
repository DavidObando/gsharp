// <copyright file="Issue2885NullableDelegateReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis

/// Issue #2885 — direct invocation must not accept a nullable CLR-delegate
/// receiver when no valid smart-cast narrowing is in force.
open class Issue2885NullableDelegateReceiverTests {
    @Theory
    @InlineData("mutable-field", "Src", "Mutable")
    @InlineData("custom-property", "Src", "Custom")
    @InlineData("shared-var", "Src", "SharedVar")
    @InlineData("shared-let", "Src", "SharedLet")
    @InlineData("invalidated-local", "Src", "n")
    @InlineData("mutable-field", "int32", "Mutable")
    @InlineData("custom-property", "int32", "Custom")
    @InlineData("shared-var", "int32", "SharedVar")
    @InlineData("shared-let", "int32", "SharedLet")
    @InlineData("invalidated-local", "int32", "n")
    func DirectInvocation_WithoutValidNarrowing_ReportsNullableReceiver(
        receiverShape string,
        typeArgument string,
        receiverName string
    ) {
        let source = BuildRejectedSource(receiverShape, typeArgument)
        let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(source)))
        let errors = compilation
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
            .ToArray()
        let diagnostic = Assert.Single(errors)
        Assert.Equal("GS0503", diagnostic.Id)
        Assert.Equal(receiverName, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Contains("'$receiverName'", diagnostic.Message, StringComparison.Ordinal)
        Assert.Contains("'?(...)'", diagnostic.Message, StringComparison.Ordinal)
        Assert.Contains("'if let'", diagnostic.Message, StringComparison.Ordinal)
        Assert.Contains("'!!'", diagnostic.Message, StringComparison.Ordinal)
        Assert.DoesNotContain("stable non-null local", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func QualifiedGSharpDelegateMembers_WithoutNarrowing_ReportNullableReceiver() {
        const importedDelegate = `package Issue2885Qualified
import System

class Holder {
    var Mutable System.Action[int32]?
}

func RunQualified(holder Holder) {
    if holder.Mutable != nil {
        holder.Mutable(1)
    }
}`
        AssertSingleGs0503(importedDelegate, "Mutable")
        const namedDelegate = `package Issue2885QualifiedNamed

delegate Handler(value int32) void;

class Holder {
    var Named Handler?
}

func RunQualified(holder Holder) {
    if holder.Named != nil {
        holder.Named(1)
    }
}`
        AssertSingleGs0503(namedDelegate, "Named")
    }

    @Theory
    @InlineData("array-index", "arr[0]")
    @InlineData("call-result", "Get()")
    @InlineData("explicit-invoke", "d")
    @InlineData("indexed-explicit-invoke", "arr[0]")
    @InlineData("result-explicit-invoke", "Get()")
    @InlineData("qualified-explicit-invoke", "Handler")
    @InlineData("named-delegate", "h")
    func OtherNullableDelegateCallPaths_ReportNullableReceiver(shape string, receiverName string) {
        let source = switch shape {
            case "array-index": `package Issue2885Array
import System

func RunArray() {
    let arr = [1]System.Action[int32]?
    arr[0](1)
}`
            case "call-result": `package Issue2885Result
import System

func Get() System.Action[int32]? -> nil
func RunResult() { Get()(1) }`
            case "explicit-invoke": `package Issue2885Invoke
import System

func RunInvoke(d System.Action[int32]?) { d.Invoke(1) }`
            case "indexed-explicit-invoke": `package Issue2885IndexedInvoke
import System

func RunInvoke() {
    let arr = [1]System.Action[int32]?
    arr[0].Invoke(1)
}`
            case "result-explicit-invoke": `package Issue2885ResultInvoke
import System

func Get() System.Action[int32]? -> nil
func RunInvoke() { Get().Invoke(1) }`
            case "qualified-explicit-invoke": `package Issue2885QualifiedInvoke
import System

class Holder {
    var Handler System.Action[int32]?
}

func RunInvoke(holder Holder) { holder.Handler.Invoke(1) }`
            case "named-delegate": `package Issue2885Named

delegate Handler(value int32) void;
func RunNamed(h Handler?) { h(1) }`
            default: throw ArgumentOutOfRangeException("shape", shape, nil)
        }
        AssertSingleGs0503(source, receiverName)
    }

    @Fact
    func ImportedClrMutableDelegateMember_ReportsNullableReceiver() {
        const rejected = `package Issue2885ImportedRejected
import Issue2885Fixture

func RunImported(box Box) {
    if box.Mutable != nil {
        box.Mutable(1)
    }
}`
        AssertSingleGs0503(rejected, "Mutable", ImportedFixture)
    }

    @Fact
    func ImportedClrReadonlyDelegateField_NarrowsAndRuns() {
        const source = `package Issue2885ImportedReadonly
import System
import Issue2885Fixture

func Main() {
    let write System.Action[int32] = (value int32) -> Console.WriteLine(value)
    let box = Box(write)
    if box.Readonly != nil {
        box.Readonly(41)
    }
}`
        Assert.Equal("41${Environment.NewLine}", CompileAndRun(source, "imported-readonly", ImportedFixture))
    }

    @Fact
    func ImportedClrGetOnlyDelegateProperty_NarrowsAndRuns() {
        const source = `package Issue2885ImportedGetOnly
import System
import Issue2885Fixture

func Main() {
    let write System.Action[int32] = (value int32) -> Console.WriteLine(value)
    let box = Box(write)
    if box.GetOnly != nil {
        box.GetOnly(42)
    }
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source, "imported-get-only", ImportedFixture))
    }

    @Fact
    func ImportedClrMutableDelegateField_IfLetRuns() {
        const source = `package Issue2885ImportedIfLet
import System
import Issue2885Fixture

func Main() {
    let write System.Action[int32] = (value int32) -> Console.WriteLine(value)
    let box = Box(write)
    if let mutable = box.Mutable {
        mutable(43)
    }
}`
        Assert.Equal("43${Environment.NewLine}", CompileAndRun(source, "imported-if-let", ImportedFixture))
    }

    @Fact
    func ImportedClrMutableDelegateField_NullAssertionRuns() {
        const source = `package Issue2885ImportedAssertion
import System
import Issue2885Fixture

func Main() {
    let write System.Action[int32] = (value int32) -> Console.WriteLine(value)
    let box = Box(write)
    box.Mutable!!(44)
}`
        Assert.Equal("44${Environment.NewLine}", CompileAndRun(source, "imported-assertion", ImportedFixture))
    }

    @Theory
    @InlineData("while-local", "1\n")
    @InlineData("for-condition-local", "2\n")
    @InlineData("for-clause-local", "3\n")
    @InlineData("nested-while", `4
5
`)
    @InlineData("stable-member", "6\n")
    @InlineData("nullable-class", "class\n")
    @InlineData("and-condition", "7\n")
    @InlineData("source-type-while", "8\n")
    @InlineData("source-type-for", "9\n")
    @InlineData("type-test-while", "4\n")
    func LoopConditionNarrowing_CompilesAndRuns(shape string, expectedOutput string) {
        Assert.Equal(expectedOutput, CompileAndRun(BuildLoopGuardSource(shape), "loop-" + shape))
    }

    @Fact
    func DoWhileCondition_DoesNotNarrowFirstIteration() {
        const source = `package Issue2885DoWhile
import System

func Run(d System.Action[int32]?) {
    do {
        d(1)
    } while d != nil
}`
        AssertSingleGs0503(source, "d")
    }

    @Fact
    func LoopGuardedUnstableMember_RemainsRejected() {
        const source = `package Issue2885LoopMember
import System

class Holder {
    var Handler System.Action[int32]?
}

func Run(holder Holder) {
    while holder.Handler != nil {
        holder.Handler(1)
        break
    }
}`
        AssertSingleGs0503(source, "Handler")
    }

    @Fact
    func DiagnosticAdvice_UsesGeneralNullConditionalInvocation() {
        let AssertNameAdvice = func (source string) {
            let message = GetGs0503(source).Message
            Assert.Contains("'?(...)'", message, StringComparison.Ordinal)
            Assert.DoesNotContain("'?.Invoke(...)'", message, StringComparison.Ordinal)
        }
        const named = `package Issue2885AdviceNamed
import System
func Run(d System.Action[int32]?) { d(1) }`
        const member = `package Issue2885AdviceMember
import System
class Holder { var Handler System.Action[int32]? }
func Run(holder Holder) { holder.Handler(1) }`
        const indexed = `package Issue2885AdviceIndexed
import System
func Run(values []System.Action[int32]?) { values[0](1) }`
        const namedInvoke = `package Issue2885AdviceNamedInvoke
import System
func Run(d System.Action[int32]?) { d.Invoke(1) }`
        const memberInvoke = `package Issue2885AdviceMemberInvoke
import System
class Holder { var Handler System.Action[int32]? }
func Run(holder Holder) { holder.Handler.Invoke(1) }`
        const result = `package Issue2885AdviceResult
import System
func Get() System.Action[int32]? -> nil
func Run() { Get()(1) }`
        const indexedInvoke = `package Issue2885AdviceIndexedInvoke
import System
func Run(values []System.Action[int32]?) { values[0].Invoke(1) }`
        const resultInvoke = `package Issue2885AdviceResultInvoke
import System
func Get() System.Action[int32]? -> nil
func Run() { Get().Invoke(1) }`
        AssertNameAdvice(named)
        AssertNameAdvice(member)
        AssertNameAdvice(namedInvoke)
        AssertNameAdvice(memberInvoke)
        AssertNameAdvice(indexed)
        AssertNameAdvice(result)
        AssertNameAdvice(indexedInvoke)
        AssertNameAdvice(resultInvoke)
    }

    @Fact
    func NullSafeInvokeRemedy_ForIndexedAndCallResultReceivers_LoadsAndRuns() {
        const source = `package Issue2885NullSafeInvokeRemedy
import System

func Get(handler System.Action[int32]) System.Action[int32]? -> handler

func Main() {
    let write System.Action[int32] = (value int32) -> Console.WriteLine(value)
    var values = [1]System.Action[int32]?
    values[0] = write
    values[0]?(1)
    Get(write)?(2)
}`
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", CompileAndRun(source, "nullsafe-invoke-remedy"))
    }

    @Fact
    func IfLetAndNullAssertion_RemediesVerifyLoadAndRunAcrossCallPaths() {
        const source = `package Issue2885Remedies
import System

delegate Handler(value int32) void;

func Get(write System.Action[int32]) System.Action[int32]? -> write
func WriteNamed(value int32) { Console.WriteLine(value) }

class Holder {
    var Mutable System.Action[int32]?
    var Named Handler?

    func RunBare() {
        if let handler = Mutable {
            handler(41)
        }
        Mutable!!(42)
    }
}

func Main() {
    let write System.Action[int32] = (value int32) -> Console.WriteLine(value)
    let holder = Holder()
    holder.Mutable = write
    let named Handler = WriteNamed
    holder.Named = named

    holder.RunBare()
    if let qualified = holder.Mutable {
        qualified(43)
    }
    holder.Mutable!!(44)
    if let qualifiedNamed = holder.Named {
        qualifiedNamed(45)
    }
    holder.Named!!(46)

    let arr = [1]System.Action[int32]?
    arr[0] = write
    if let indexed = arr[0] {
        indexed(47)
    }
    arr[0]!!(48)

    if let returned = Get(write) {
        returned(49)
    }
    Get(write)!!(50)

    var direct System.Action[int32]? = write
    if let invoked = direct {
        invoked.Invoke(51)
    }
    direct!!.Invoke(52)
}`
        Assert.Equal(
            "41${Environment.NewLine}42${Environment.NewLine}43${Environment.NewLine}44${Environment.NewLine}45${Environment.NewLine}46${Environment.NewLine}47${Environment.NewLine}48${Environment.NewLine}49${Environment.NewLine}50${Environment.NewLine}51${Environment.NewLine}52${Environment.NewLine}",
            CompileAndRun(source, "remedies")
        )
    }

    @Theory
    @InlineData("mutable-field")
    @InlineData("custom-property")
    @InlineData("shared-var")
    @InlineData("shared-let")
    @InlineData("invalidated-local")
    func IfLetAndNullAssertion_RemediesRunForOriginalReceiverShapes(receiverShape string) {
        Assert.Equal(
            "61${Environment.NewLine}62${Environment.NewLine}",
            CompileAndRun(BuildRemedySource(receiverShape), "remedy-" + receiverShape)
        )
    }

    @Theory
    @InlineData("Src", "Src()", `2
2
2
2
2
2
2
`)
    @InlineData("int32", "3", `3
3
3
3
3
3
3
`)
    func EndToEnd_StableAndNullSafeControls_VerifyLoadAndRun(
        typeArgument string,
        valueExpression string,
        expectedOutput string
    ) {
        let sourceType = if typeArgument == "Src" {
            "class Src { prop N int32 -> 2 }\n"
        } else {
            string.Empty
        }
        let valueRead = if typeArgument == "Src" {
            "value.N"
        } else {
            "value"
        }
        let source = (`package Issue2885Controls
import System

` + "$sourceType" + `
class Holder {
    let Field System.Action[` + "$typeArgument" + `]?
    prop Property System.Action[` + "$typeArgument" + `]? { get; init; }

    init(value System.Action[` + "$typeArgument" + `]?) {
        Field = value
        Property = value
    }

    func Run(value ` + "$typeArgument" + `) {
        if Field != nil {
            Field(value)
        }
        if Property != nil {
            Property(value)
        }
    }
}

func Main() {
    let write System.Action[` + "$typeArgument" + `] =
        (value ` + "$typeArgument" + `) -> System.Console.WriteLine(` + "$valueRead" + `)

    let direct System.Action[` + "$typeArgument" + `] = write
    direct(` + "$valueExpression" + `)

    var nonNull System.Action[` + "$typeArgument" + `] = write
    nonNull(` + "$valueExpression" + `)

    var optional System.Action[` + "$typeArgument" + `]? = write
    if optional != nil {
        optional(` + "$valueExpression" + `)
    }
    if optional != nil {
        let captured System.Action[` + "$typeArgument" + `] = optional
        captured(` + "$valueExpression" + `)
    }

    Holder(write).Run(` + "$valueExpression" + `)

    var safe System.Action[` + "$typeArgument" + `]? = write
    safe?(` + "$valueExpression" + `)
    var safeNil System.Action[` + "$typeArgument" + `]? = nil
    safeNil?(` + "$valueExpression" + `)
}`)
        Assert.Equal(expectedOutput, CompileAndRun(source, typeArgument))
    }

    shared {
        private const ImportedFixture string = `#nullable enable
using System;

namespace Issue2885Fixture;

public sealed class Box
{
    public Action<int>? Mutable;
    public readonly Action<int>? Readonly;
    public Action<int>? GetOnly { get; }

    public Box(Action<int>? value)
    {
        Mutable = value;
        Readonly = value;
        GetOnly = value;
    }
}`

        private func BuildRejectedSource(receiverShape string, typeArgument string) string {
            let sourceType = if typeArgument == "Src" {
                "class Src { prop N int32 -> 2 }\n"
            } else {
                string.Empty
            }
            let body = switch receiverShape {
                case "mutable-field": (`class Holder {
    var Mutable System.Action[` + "$typeArgument" + `]?

    func Run(value ` + "$typeArgument" + `) {
        if Mutable != nil {
            Mutable(value)
        }
    }
}`)
                case "custom-property": (`class Holder {
    var Backing System.Action[` + "$typeArgument" + `]?
    prop Custom System.Action[` + "$typeArgument" + `]? -> Backing

    func Run(value ` + "$typeArgument" + `) {
        if Custom != nil {
            Custom(value)
        }
    }
}`)
                case "shared-var": (`class Holder {
    shared {
        var SharedVar System.Action[` + "$typeArgument" + `]?
    }

    func Run(value ` + "$typeArgument" + `) {
        if SharedVar != nil {
            SharedVar(value)
        }
    }
}`)
                case "shared-let": (`class Holder {
    shared {
        let SharedLet System.Action[` + "$typeArgument" + `]? = nil
    }

    func Run(value ` + "$typeArgument" + `) {
        if SharedLet != nil {
            SharedLet(value)
        }
    }
}`)
                case "invalidated-local": (
                    `func Run(write System.Action[` + "$typeArgument" + `], value ` + "$typeArgument" + `) {
    var n System.Action[` + "$typeArgument" + `]? = write
    if n != nil {
        n = nil
        n(value)
    }
}`
                )
                default: throw ArgumentOutOfRangeException("receiverShape", receiverShape, nil)
            }
            return (`package Issue2885Rejected
import System

` + "$sourceType" + `
` + "$body")
        }

        private func BuildLoopGuardSource(shape string) string {
            let body = switch shape {
                case "while-local": `func Main() {
    var d System.Action[int32]? = Write
    while d != nil {
        d(1)
        break
    }
}`
                case "for-condition-local": `func Main() {
    var d System.Action[int32]? = Write
    for d != nil {
        d(2)
        break
    }
}`
                case "for-clause-local": `func Main() {
    var d System.Action[int32]? = Write
    for var i = 0; d != nil; i++ {
        d(3)
        break
    }
}`
                case "nested-while": `func Main() {
    var first System.Action[int32]? = Write
    var second System.Action[int32]? = Write
    while first != nil {
        while second != nil {
            first(4)
            second(5)
            break
        }
        break
    }
}`
                case "stable-member": `class Holder {
    let Handler System.Action[int32]?
    init(handler System.Action[int32]?) { Handler = handler }
}

func Main() {
    let holder = Holder(Write)
    while holder.Handler != nil {
        holder.Handler(6)
        break
    }
}`
                case "nullable-class": `class C {
    func M() { Console.WriteLine("class") }
}

func Main() {
    var c C? = C()
    while c != nil {
        c.M()
        break
    }
}`
                case "and-condition": `func Main() {
    var d System.Action[int32]? = Write
    var i = 0
    while d != nil && i < 1 {
        d(7)
        i++
    }
}`
                case "source-type-while": `class Src { prop N int32 -> 8 }

func Main() {
    let write System.Action[Src] = (value Src) -> Console.WriteLine(value.N)
    var d System.Action[Src]? = write
    while d != nil {
        d(Src())
        break
    }
}`
                case "source-type-for": `class Src { prop N int32 -> 9 }

func Main() {
    let write System.Action[Src] = (value Src) -> Console.WriteLine(value.N)
    var d System.Action[Src]? = write
    for var i = 0; d != nil && i < 1; i++ {
        d(Src())
    }
}`
                case "type-test-while": `func Main() {
    var value object? = "text"
    while value is string {
        Console.WriteLine(value.Length)
        break
    }
}`
                default: throw ArgumentOutOfRangeException("shape", shape, nil)
            }
            return (`package Issue2885Loop
import System

func Write(value int32) { Console.WriteLine(value) }

` + "$body")
        }

        private func BuildRemedySource(receiverShape string) string {
            let body = switch receiverShape {
                case "mutable-field": `class Holder {
    var Mutable System.Action[int32]?

    init(value System.Action[int32]) { Mutable = value }

    func Run() {
        if let handler = Mutable {
            handler(61)
        }
        Mutable!!(62)
    }
}

func Main() { Holder(Write).Run() }`
                case "custom-property": `class Holder {
    var Backing System.Action[int32]?
    prop Custom System.Action[int32]? -> Backing

    init(value System.Action[int32]) { Backing = value }

    func Run() {
        if let handler = Custom {
            handler(61)
        }
        Custom!!(62)
    }
}

func Main() { Holder(Write).Run() }`
                case "shared-var": `class Holder {
    shared {
        var SharedVar System.Action[int32]?

        func Run() {
            if let handler = SharedVar {
                handler(61)
            }
            SharedVar!!(62)
        }
    }
}

func Main() {
    Holder.SharedVar = Write
    Holder.Run()
}`
                case "shared-let": `class Holder {
    shared {
        let SharedLet System.Action[int32]? = Write

        func Run() {
            if let handler = SharedLet {
                handler(61)
            }
            SharedLet!!(62)
        }
    }
}

func Main() { Holder.Run() }`
                case "invalidated-local": `func Run(incoming System.Action[int32]?) {
    var handler System.Action[int32]? = Write
    if handler != nil {
        handler = incoming
        if let narrowed = handler {
            narrowed(61)
        }
        handler!!(62)
    }
}

func Main() { Run(Write) }`
                default: throw ArgumentOutOfRangeException("receiverShape", receiverShape, nil)
            }
            return (`package Issue2885RemedyShape
import System

func Write(value int32) { Console.WriteLine(value) }

` + "$body")
        }

        private func AssertSingleGs0503(source string, receiverName string, fixtureSource string? = nil) {
            if fixtureSource == nil {
                let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(source)))
                AssertGs0503(compilation, receiverName)
                return
            }
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "issue2885-bind-fixtures",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let fixturePath = Path.Combine(directory, "Issue2885Fixture.dll")
                EmitCSharpFixture(fixturePath, fixtureSource)
                using let resolver = ReferenceResolver.WithReferences([]string{fixturePath})
                let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
                AssertGs0503(compilation, receiverName)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func AssertGs0503(compilation GsCompilation, receiverName string) {
            let diagnostic = Assert.Single(
                compilation.BoundProgram.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            )
            Assert.Equal("GS0503", diagnostic.Id)
            Assert.Contains("'$receiverName'", diagnostic.Message, StringComparison.Ordinal)
        }

        private func GetGs0503(source string) GSharp.Core.CodeAnalysis.Diagnostic {
            let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(source)))
            let diagnostic = Assert.Single(
                compilation.BoundProgram.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            )
            Assert.Equal("GS0503", diagnostic.Id)
            return diagnostic
        }

        private func CompileAndRun(source string, caseName string, fixtureSource string? = nil) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "issue2885-artifacts",
                caseName + "-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let assemblyPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                var fixturePath string? = nil
                if fixtureSource != nil {
                    fixturePath = Path.Combine(directory, "Issue2885Fixture.dll")
                    EmitCSharpFixture(fixturePath, fixtureSource)
                }
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                try {
                    let arguments = List[string]{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0"}
                    if fixturePath != nil {
                        arguments.Add("/reference:" + fixturePath)
                    }
                    arguments.Add(sourcePath)
                    let exitCode = Program.Main(arguments.ToArray())
                    Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                IlVerifier.Verify(
                    assemblyPath,
                    additionalReferences: if fixturePath == nil {
                        default([]?string)
                    } else {
                        []string{fixturePath}
                    }
                )
                // One context for the reference fixture and the emitted
                // assembly that imports it.
                let assembly = if fixturePath == nil {
                    EmittedFixture.Load(assemblyPath)
                } else {
                    EmittedFixture.LoadTogether(fixturePath, assemblyPath)[1]
                }
                let _ = assembly.GetTypes()
                using let process Process? = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                            assemblyPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                )
                Assert.NotNull(process)
                let outputTask = process!!.StandardOutput.ReadToEndAsync()
                let errorTask = process!!.StandardError.ReadToEndAsync()
                if !process!!.WaitForExit(30_000) {
                    process!!.Kill(entireProcessTree: true)
                    process!!.WaitForExit()
                    Assert.Fail("dotnet exec timed out")
                }
                let output = outputTask.GetAwaiter().GetResult()
                let error = errorTask.GetAwaiter().GetResult()
                Assert.True(process!!.ExitCode == 0, error)
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func EmitCSharpFixture(path string?, source string) {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!))
                .Split(Path.PathSeparator)
                .Where(File.Exists)
                .Select((reference string) -> MetadataReference.CreateFromFile(reference))
            let compilation = CSharpCompilation.Create(
                "Issue2885Fixture",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            using let stream = File.Create(path!!)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
    }
}
