// <copyright file="Issue1638ClrCallPipelineDriftTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1638: the five CLR call-construction pipeline copies (ctor, static,
/// instance, inherited-instance, imported extension) had drifted — some
/// skipped a step the others ran. Two of those drifts were genuine latent
/// bugs, now fixed by routing every site through the shared
/// <c>BuildResolvedClrCallArguments</c> helper:
/// <list type="bullet">
///   <item>The CTOR path never ran <c>RebindFunctionLiteralDelegateArguments</c>,
///   so a value-returning arrow-lambda argument could not target a
///   delegate-typed constructor parameter (issue #889's fix never reached
///   ctors).</item>
///   <item>The INHERITED-INSTANCE path never ran
///   <c>RebindFormattableInterpolationArguments</c>, so an interpolated
///   string argument could not target an
///   <c>IFormattable</c>/<c>FormattableString</c> parameter of a method
///   inherited (unoverridden) from an imported CLR base class.</item>
/// </list>
/// The (intentionally unchanged) imported-extension path still narrows its
/// delegate-rebind step to numeric-return-widening only (issues #1150/#1334);
/// that divergence is preserved via the helper's
/// <c>ClrCallDelegateRebindMode</c> parameter, not treated as drift.
/// </summary>
public class Issue1638ClrCallPipelineDriftTests
{
    [Fact]
    public void Ctor_ArrowLambda_ValueReturning_ToActionParameter_VoidizesAndRuns()
    {
        const string Source = @"package Issue1638Ctor
import System
import GSharp.Core.Tests.Fixtures

var called = 0
let x = Issue1638ActionCtorFixture(() -> called = called + 1)
Console.WriteLine(called)
Console.WriteLine(x.Invoked)
";
        var output = CompileAndRun(Source, "Issue1638Ctor");
        Assert.Equal("1\nTrue\n", output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void InheritedInstance_InterpolatedString_ToFormattableStringParameter_Rebinds()
    {
        const string Source = @"package Issue1638Inherited
import System
import GSharp.Core.Tests.Fixtures

class MyRenderer : Issue1638FormattableBaseFixture {
}

let r = MyRenderer()
let n = 42
let s = r.Render(""n=${n:D3}"")
Console.WriteLine(s)
";
        var output = CompileAndRun(Source, "Issue1638Inherited");
        Assert.Equal("n=042\n", output.Replace("\r\n", "\n"));
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
