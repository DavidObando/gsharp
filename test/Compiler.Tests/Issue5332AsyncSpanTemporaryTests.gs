// <copyright file="Issue5332AsyncSpanTemporaryTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.Collections.Generic
import System.IO
import Xunit

class Issue5332AsyncSpanTemporaryTests {
    @Fact
    func NestedAsyncLiteralInNonSuspendingExpressionBlockIsChecked() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package NestedBlock
import System
import System.Threading.Tasks
func Make() ReadOnlySpan[byte] -> ReadOnlySpan[byte]([]byte{65})
func Consume(value ReadOnlySpan[byte], extra int32) int32 -> value.Length * 100 + extra
func Create() (Task[int32]) -> Task[int32] {
    return {
        let marker = 0
        async func(pending Task[int32]) int32 {
            return Consume(Make(), await pending)
        }
    }
}
func Main() {
    let gate = TaskCompletionSource[int32]()
    let pending = Create()(gate.Task)
    Console.WriteLine(pending.IsCompleted)
    gate.SetResult(1)
    Console.WriteLine(pending.GetAwaiter().GetResult())
}`
        let (code, output) = fixture.TryCompile(source, "NestedBlock", true)
        Assert.NotEqual(0, code)
        Assert.Contains(".gs(10,36,10,49): error GS0219:", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "NestedBlock.dll")))
    }

    @Fact
    func ExpressionScopedSpanIsConsumedBeforeOuterSuspension() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package ScopedBlock
import System
import System.Threading.Tasks
func Make() ReadOnlySpan[byte] {
    Console.Write("make;")
    return ReadOnlySpan[byte]([]byte{65})
}
func Combine(first int32, second int32) int32 -> first + second
async func Read(pending Task[int32]) int32 -> Combine({ let value = Make() value.Length * 100 }, await pending)
func Main() {
    let gate = TaskCompletionSource[int32]()
    let pending = Read(gate.Task)
    Console.WriteLine(pending.IsCompleted)
    gate.SetResult(1)
    Console.WriteLine(pending.GetAwaiter().GetResult())
    Console.WriteLine(Read(Task.FromResult(1)).GetAwaiter().GetResult())
}`, "ScopedBlock", true)
        Assert.Equal("make;False\n101\nmake;101\n", fixture.Run(assembly))
    }

    @Theory
    @InlineData("pending Task[int32]", "await pending")
    @InlineData("ch chan[int32]", "<-ch")
    func SyntheticTemporaryDiagnosticPrefersSuspensionOverAssignment(parameter string, suspension string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package AssignmentSuspension
import System
import System.Threading.Tasks
func Make() ReadOnlySpan[byte] -> ReadOnlySpan[byte]([]byte{65})
func Consume(value ReadOnlySpan[byte], extra int32) int32 -> value.Length * 100 + extra
async func Read(PARAMETER) int32 -> Consume(Make(), {
    var extra = 0
    extra = SUSPENSION
    extra
})`.Replace("PARAMETER", parameter).Replace("SUSPENSION", suspension)
        let (code, output) = fixture.TryCompile(source, "AssignmentSuspension", false)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0219:", output, StringComparison.Ordinal)
        let prefix = source.Substring(0, source.IndexOf(suspension, StringComparison.Ordinal))
        let line = prefix.Split('\n').Length
        let column = prefix.Length - prefix.LastIndexOf('\n')
        Assert.Contains(".gs($line,$column,$line,${column + suspension.Length})", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "AssignmentSuspension.dll")))
    }

    @Theory
    @MemberData("InitializerHosts")
    func InitializerHostedAsyncLiteralRejectsLiveTemporary(declaration string, access string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = InitializerProgram(declaration, access, "return Consume(Make(), await pending)")
        let (code, output) = fixture.TryCompile(source, "InitializerSpanTemporary", true)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0219:", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        let prefix = source.Substring(0, source.IndexOf("await pending", StringComparison.Ordinal))
        let line = prefix.Split('\n').Length
        let column = prefix.Length - prefix.LastIndexOf('\n')
        Assert.Contains(".gs($line,$column,$line,${column + "await pending".Length})", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "InitializerSpanTemporary.dll")))
    }

    @Theory
    @MemberData("InitializerHosts")
    func InitializerHostedAsyncLiteralConsumesLocalBeforeSuspending(declaration string, access string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = InitializerProgram(
            declaration,
            access,
            "let value = Make()\nlet before = Consume(value, 0)\nreturn before + await pending"
        )
        let assembly = fixture.Compile(source, "InitializerSpanTemporary", true)
        Assert.Equal("make;False\n101\nmake;101\n", fixture.Run(assembly))
    }

    @Fact
    func PreparationFailureReportsSourceAnchoredDiagnosticThroughDriver() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package GuardDiagnostic
import System.Threading.Tasks
async func Read(pending Task[bool]) int32 {
    return switch 1 {
        case 1 when await pending: 10
        default: 0
    }
}`
        let (code, output) = fixture.TryCompile(source, "GuardDiagnostic", false)
        Assert.NotEqual(0, code)
        Assert.Contains(".gs(5,21,5,34): error GS9998:", output, StringComparison.Ordinal)
        Assert.Contains(
            "'await' inside a switch-expression 'when' guard is not yet supported",
            output,
            StringComparison.Ordinal
        )
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "GuardDiagnostic.dll")))
    }

    @Theory
    @InlineData("async func Read(ch chan[int32]) int32 -> Consume(Make(), Take(ch))")
    @InlineData(`func Create() {
    let read = async func(ch chan[int32]) int32 {
        return Consume(Make(), Take(ch))
    }
}`)
    func InferredCalleeSuspensionChecksAlreadyAsyncScopes(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package InferredSpanTemporary
import System
func Make() ReadOnlySpan[byte] -> ReadOnlySpan[byte]([]byte{65})
func Consume(value ReadOnlySpan[byte], extra int32) int32 -> value.Length * 100 + extra
func Take(ch chan[int32]) int32 -> <-ch
` + declaration
        let (code, output) = fixture.TryCompile(source, "InferredSpanTemporary", false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0219", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        let prefix = source.Substring(0, source.LastIndexOf("Take(ch)", StringComparison.Ordinal))
        let line = prefix.Split('\n').Length
        let column = prefix.Length - prefix.LastIndexOf('\n')
        let endColumn = column + "Take(ch)".Length
        Assert.Contains(".gs($line,$column,$line,$endColumn)", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "InferredSpanTemporary.dll")))
    }

    @Fact
    func RewrittenCallsReportEachUnsafeSuspensionOnlyOnce() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package InferredSpanDiagnostics
import System
import System.Threading.Tasks
func Make() ReadOnlySpan[byte] -> ReadOnlySpan[byte]([]byte{65})
func Consume(value ReadOnlySpan[byte], extra int32) int32 -> value.Length + extra
func After(extra int32, value ReadOnlySpan[byte]) int32 -> value.Length + extra
func Take(ch chan[int32]) int32 -> <-ch
async func Read(ch chan[int32], pending Task[int32]) int32 {
    let safe = After(Take(ch), Make())
    let first = Consume(Make(), await pending)
    return safe + first + Consume(Make(), Take(ch))
}
`, "InferredSpanDiagnostics", false)
        Assert.NotEqual(0, code)
        Assert.Equal(2, output.Split("error GS0219:", StringSplitOptions.None).Length - 1)
        Assert.Contains(".gs(10,33,10,46)", output, StringComparison.Ordinal)
        Assert.Contains(".gs(11,43,11,51)", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "InferredSpanDiagnostics.dll")))
    }

    @Fact
    func GatedHandlerConsumesSpanBeforeLaterSuspension() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`using System;
using System.Runtime.CompilerServices;
namespace HandlerFixture;
[InterpolatedStringHandler]
public struct GateHandler {
    private bool appendNext;
    public GateHandler(int literalLength, int formattedCount, bool enabled, bool appendNext, out bool shouldAppend) {
        this.appendNext = appendNext;
        shouldAppend = enabled;
        Console.Write("ctor;");
    }
    public bool AppendLiteral(string value) { Console.Write("literal;"); return true; }
    public bool AppendFormatted(ReadOnlySpan<byte> value) {
        Console.Write("span:" + value.Length + ";");
        return appendNext;
    }
    public bool AppendFormatted(int value) { Console.Write("int:" + value + ";"); return true; }
}
public static class HandlerApi {
    public static void Write(bool enabled, bool appendNext,
        [InterpolatedStringHandlerArgument("enabled", "appendNext")] GateHandler handler) {
        Console.WriteLine("done");
    }
}`, "SpanHandler")
        let assembly = fixture.Compile(`package SpanHandlerAwait
import System
import System.Threading.Tasks
import HandlerFixture
func Make() ReadOnlySpan[byte] {
    Console.Write("make;")
    return ReadOnlySpan[byte]([]byte{65})
}
async func Read(pending Task[int32], enabled bool, appendNext bool) {
    HandlerApi.Write(enabled, appendNext, "${Make()}${await pending}")
}
func Check(enabled bool, appendNext bool) {
    let gate = TaskCompletionSource[int32]()
    let pending = Read(gate.Task, enabled, appendNext)
    Console.WriteLine(pending.IsCompleted)
    gate.SetResult(7)
    pending.GetAwaiter().GetResult()
}
func Main() {
    Check(false, true)
    Check(true, false)
    Check(true, true)
    Read(Task.FromResult(7), true, true).GetAwaiter().GetResult()
}`, "SpanHandlerAwait", true, "/r:" + library)
        Assert.Equal(
            "ctor;done\nTrue\nctor;make;span:1;done\nTrue\nctor;make;span:1;False\nint:7;done\nctor;make;span:1;int:7;done\n",
            fixture.Run(assembly)
        )
    }

    @Theory
    @InlineData("return Consume(Make(), await pending)", "await pending")
    @InlineData("return Consume(ReadOnlySpan[byte]([]byte{65}), await pending)", "await pending")
    @InlineData("return Consume((if flag { Make() } else { Make() }), await pending)", "await pending")
    @InlineData("return Make().Slice(await pending, 0).Length", "await pending")
    @InlineData("try { return Consume(Make(), await pending) } catch { return 0 }", "await pending")
    @InlineData("try { return 0 } finally { Consume(Make(), await pending) }", "await pending")
    @InlineData("return Consume(Make(), await Task.FromResult(1))", "await Task.FromResult(1)")
    @InlineData("return Consume(Make(), <-ch)", "<-ch")
    @InlineData("return Make().Slice(<-ch, 0).Length", "<-ch")
    func RefLikeOperandsAcrossSuspensionReportLocatedDiagnostic(body string, suspension string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package SpanTemporary
import System
import System.Threading.Tasks
func Make() ReadOnlySpan[byte] -> ReadOnlySpan[byte]([]byte{65})
func Consume(value ReadOnlySpan[byte], extra int32) int32 -> value.Length * 100 + extra
async func Read(pending Task[int32], ch chan[int32], flag bool) int32 {
    BODY
}
`.Replace("BODY", body)
        let (code, output) = fixture.TryCompile(source, "SpanTemporary", false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0219", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        let column = 5 + body.IndexOf(suspension, StringComparison.Ordinal)
        let endColumn = column + suspension.Length
        Assert.Contains(".gs(7,$column,7,$endColumn)", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "SpanTemporary.dll")))
    }

    @Theory
    @InlineData("async func Read(ch chan[int32]) int32 -> Consume(Make(), <-ch)")
    @InlineData("func Read(ch chan[int32]) int32 -> Consume(Make(), <-ch)")
    @InlineData(`func Create() {
    let read = async func(ch chan[int32]) int32 {
        return Consume(Make(), <-ch)
    }
}`)
    func ImplicitSuspensionUsesCompilationReferencesInEveryScope(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package SpanChannelTemporary
import System
func Make() ReadOnlySpan[byte] -> ReadOnlySpan[byte]([]byte{65})
func Consume(value ReadOnlySpan[byte], extra int32) int32 -> value.Length * 100 + extra
` + declaration
        let (code, output) = fixture.TryCompile(source, "SpanChannelTemporary", false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0219", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        let prefix = source.Substring(0, source.IndexOf("<-ch", StringComparison.Ordinal))
        let line = prefix.Split('\n').Length
        let column = prefix.Length - prefix.LastIndexOf('\n')
        let endColumn = column + "<-ch".Length
        Assert.Contains(".gs($line,$column,$line,$endColumn)", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "SpanChannelTemporary.dll")))
    }

    @Theory
    @InlineData("let value = Make()\n    return Consume(value, <-ch)", "GS0219", "7,27,7,31")
    @InlineData(
        "let ref readonly value = Make()[0]\n    let extra = <-ch\n    return int32(value) + extra",
        "GS0258",
        "6,22,6,27"
    )
    func SourceLocalsAndAliasesCannotCrossImplicitSuspension(body string, diagnostic string, location string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package SpanChannelLocal
import System
func Make() ReadOnlySpan[byte] -> ReadOnlySpan[byte]([]byte{65})
func Consume(value ReadOnlySpan[byte], extra int32) int32 -> value.Length * 100 + extra
async func Read(ch chan[int32]) int32 {
    BODY
}
`.Replace("BODY", body), "SpanChannelLocal", false)
        Assert.NotEqual(0, code)
        Assert.Contains(diagnostic, output, StringComparison.Ordinal)
        Assert.Contains(".gs($location)", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "SpanChannelLocal.dll")))
    }

    shared {
        func InitializerHosts() IEnumerable[[]object] {
            yield[]object{"class Holder { public var Read (Task[int32]) -> Task[int32] = LAMBDA }", "Holder().Read"}
            yield[]object{
                "class Holder { shared { public var Read (Task[int32]) -> Task[int32] = LAMBDA } }",
                "Holder.Read"
            }
            yield[]object{
                "interface Holder { shared { var Read (Task[int32]) -> Task[int32] = LAMBDA } }",
                "Holder.Read"
            }
            yield[]object{
                "class Holder { shared { public var Read (Task[int32]) -> Task[int32]\ninit { Read = LAMBDA } } }",
                "Holder.Read"
            }
            yield[]object{"class Holder() : Parent(LAMBDA) {}", "Holder().Read"}
            yield[]object{"class Holder : Parent { init() : base(LAMBDA) {} }", "Holder().Read"}
        }

        private func InitializerProgram(declaration string, access string, body string) string -> `package InitializerSpanTemporary
import System
import System.Threading.Tasks
class Helpers {
    shared {
        public func Make() ReadOnlySpan[byte] {
            Console.Write("make;")
            return ReadOnlySpan[byte]([]byte{65})
        }
        public func Consume(value ReadOnlySpan[byte], extra int32) int32 -> value.Length * 100 + extra
    }
}
open class Parent {
    public var Read (Task[int32]) -> Task[int32]
    init(read (Task[int32]) -> Task[int32]) { Read = read }
}
DECLARATION
func Main() {
    let read = ACCESS
    let gate = TaskCompletionSource[int32]()
    let pending = read(gate.Task)
    Console.WriteLine(pending.IsCompleted)
    gate.SetResult(1)
    Console.WriteLine(pending.GetAwaiter().GetResult())
    Console.WriteLine(read(Task.FromResult(1)).GetAwaiter().GetResult())
}`.Replace(
            "DECLARATION",
            declaration.Replace(
                "LAMBDA",
                "async func(pending Task[int32]) int32 {\n" + body.Replace("Make()", "Helpers.Make()").Replace(
                    "Consume(",
                    "Helpers.Consume("
                ) +
                    "\n}"
            )
        )
            .Replace("ACCESS", access)
    }
}
