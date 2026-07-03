// <copyright file="Issue1852ConstrainedInterfaceCallRebindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1852 (follow-up N1 from #1812 / PR #1848): the CONSTRAINED CLR
/// INTERFACE-CALL path (<c>ExpressionBinder.TryBindConstrainedClrInterfaceCall</c>)
/// is the sixth CLR-call construction shape — a generic method dispatching a
/// call on a type-parameter receiver constrained to an imported CLR
/// interface (e.g. <c>func Render[T IIssue1852Renderer](x T) string</c>).
/// #1812 deliberately left this path's <c>interpolatedStringArgs</c> flag
/// unset because the path skips the whole CLR parameter-conversion pipeline
/// (the emitted MemberRef parameter is the interface type-variable
/// <c>!0</c>, passed unconverted). This fix passes the flag to
/// <c>OverloadResolution.Resolve</c> and, after the interface method is
/// selected, re-lowers any interpolated-string argument whose resolved
/// parameter is IFormattable/FormattableString-shaped via
/// <c>RebindFormattableInterpolationArguments</c> — mirroring the
/// instance/extension/base-ctor rebind step — WITHOUT running the rest of
/// the conversion pipeline that path exists to avoid.
/// </summary>
public class Issue1852ConstrainedInterfaceCallRebindTests
{
    [Fact]
    public void ConstrainedInterfaceCall_InterpolatedString_ToFormattableStringParameter_Rebinds()
    {
        const string Source = @"package Issue1852Constrained
import System
import GSharp.Core.Tests.Fixtures

func Render[T IIssue1852Renderer](x T) string {
    let n = 42
    return x.Render(""n=${n:D3}"")
}

let s = Render(Issue1852RendererFixture())
Console.WriteLine(s)
";
        var output = CompileAndRun(Source, "Issue1852Constrained");
        Assert.Equal("n=042\n", output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void ConstrainedInterfaceCall_MixedInterpolatedAndPlainArgs_RebindsOnlyHandlerArg()
    {
        // Generalization: a non-handler positional argument (`tag`, a plain
        // `string` parameter) precedes the handler-shaped one. Only the
        // interpolated-string argument bound to the FormattableString
        // parameter should rebind; the plain-string argument and its
        // parameter index must be unaffected.
        const string Source = @"package Issue1852ConstrainedMixed
import System
import GSharp.Core.Tests.Fixtures

func RenderTwo[T IIssue1852Renderer](x T) string {
    let n = 42
    return x.RenderTwo(""tag"", ""n=${n:D3}"")
}

let s = RenderTwo(Issue1852RendererFixture())
Console.WriteLine(s)
";
        var output = CompileAndRun(Source, "Issue1852ConstrainedMixed");
        Assert.Equal("tag:n=042\n", output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void ConstrainedInterfaceCall_OrdinaryNonHandlerCall_OverloadChoiceUnchanged()
    {
        // Regression guard (per #1812 N1's concern): an ordinary constrained
        // interface call with no interpolated-string argument at all — the
        // #1336 `T IComparable[T]` shape — must still resolve/bind/evaluate
        // identically now that `interpolatedStringArgs` is threaded through.
        const string source = @"
package p
import System
class C {
    func Cmp[T IComparable[T]](a T, b T) int32 {
        return a.CompareTo(b)
    }
    func Ok() int32 { return Cmp[int32](1, 2) }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { IsLibrary = true };
        Assert.Empty(compilation.GlobalScope.Diagnostics);
    }

    private static string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
