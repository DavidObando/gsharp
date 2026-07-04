// <copyright file="Issue1928LambdaInterpolatedStringEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #1928: emit-only lowering must rewrite interpolated strings inside
/// hosted nested bodies (arrow lambdas, func literals, generic local
/// functions) the same way it already rewrites ordinary function bodies.
/// </summary>
public class Issue1928LambdaInterpolatedStringEmitTests
{
    [Fact]
    public void ArrowLambdaBody_WithInterpolatedString_EmitsAndRuns()
    {
        const string Source = @"package Issue1928Arrow
import System
import System.Linq

var xs = []int32{1, 2, 3}
var mapped = xs.Select((x int32) -> ""v=$x"")
Console.WriteLine(string.Join("","", mapped))
";

        var output = CompileAndRun(Source, nameof(ArrowLambdaBody_WithInterpolatedString_EmitsAndRuns));
        Assert.Contains("v=1,v=2,v=3", output);
    }

    [Fact]
    public void GenericLocalFunctionBody_WithInterpolatedString_EmitsAndRuns()
    {
        const string Source = @"package Issue1928Local
import System

let format[T] = func(value T) string { return ""v=$value"" }
Console.WriteLine(format(7))
";

        var output = CompileAndRun(Source, nameof(GenericLocalFunctionBody_WithInterpolatedString_EmitsAndRuns));
        Assert.Contains("v=7", output);
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

            var stdout = System.Console.Out;
            var captured = new StringWriter();
            System.Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                System.Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
