// <copyright file="Issue5332AsyncSpanTemporaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.IO
import Xunit

class Issue5332AsyncSpanTemporaryTests {
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
}
