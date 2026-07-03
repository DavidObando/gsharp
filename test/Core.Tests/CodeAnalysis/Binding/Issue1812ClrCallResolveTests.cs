// <copyright file="Issue1812ClrCallResolveTests.cs" company="GSharp">
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
/// Issue #1812 (follow-up to #1638 / PR #1811): the STATIC and EXTENSION
/// CLR-call construction paths in <c>ExpressionBinder.Calls.cs</c> must pass
/// <c>interpolatedStringArgs</c> to their <c>OverloadResolution.Resolve</c>
/// call — the same flag the ctor, instance, and inherited-instance paths
/// already forward — so an interpolated-string argument bound to an
/// <c>IFormattable</c>/<c>FormattableString</c> parameter resolves and
/// rebinds consistently no matter which of the five call shapes dispatches
/// it. These tests mirror
/// <c>Issue1638ClrCallPipelineDriftTests.InheritedInstance_InterpolatedString_ToFormattableStringParameter_Rebinds</c>
/// for the static and extension shapes.
/// </summary>
public class Issue1812ClrCallResolveTests
{
    [Fact]
    public void StaticCall_InterpolatedString_ToFormattableStringParameter_Rebinds()
    {
        const string Source = @"package Issue1812Static
import System
import GSharp.Core.Tests.Fixtures

let n = 42
let s = Issue1812StaticFormattableFixture.Render(""n=${n:D3}"")
Console.WriteLine(s)
";
        var output = CompileAndRun(Source, "Issue1812Static");
        Assert.Equal("n=042\n", output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void ExtensionCall_InterpolatedString_ToFormattableStringParameter_Rebinds()
    {
        const string Source = @"package Issue1812Extension
import System
import GSharp.Core.Tests.Fixtures

let n = 42
let prefix = ""val:""
let s = prefix.Render(""n=${n:D3}"")
Console.WriteLine(s)
";
        var output = CompileAndRun(Source, "Issue1812Extension");
        Assert.Equal("val:n=042\n", output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void BaseCtorCall_InterpolatedString_ToFormattableStringParameter_Rebinds()
    {
        // Issue #1812 companion gap: `: base(...)` against an imported CLR base
        // constructor is a sixth CLR-call construction shape found during the
        // audit (beyond the five #1638 named). It must accept an
        // interpolated-string argument against a FormattableString parameter
        // exactly like the other five.
        const string Source = @"package Issue1812BaseCtor
import System
import GSharp.Core.Tests.Fixtures

class MyThing : Issue1812BaseCtorFormattableFixture {
    init(n int32) : base(""n=${n:D3}"") {
    }
}

let t = MyThing(42)
Console.WriteLine(t.Rendered)
";
        var output = CompileAndRun(Source, "Issue1812BaseCtor");
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
