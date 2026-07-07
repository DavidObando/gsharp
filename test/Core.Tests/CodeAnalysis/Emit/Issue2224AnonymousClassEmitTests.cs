// <copyright file="Issue2224AnonymousClassEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2224: end-to-end emission of the <c>interface { ... }</c>
/// anonymous-class-literal expression. The synthesized backing type reuses
/// the existing <c>data class</c> emission pipeline (ADR-0029) verbatim —
/// this test exercises that a real CLR TypeDef is produced, member access
/// works, and the synthesized <c>Equals</c>/<c>GetHashCode</c>/<c>ToString</c>
/// match C# anonymous-type semantics closely enough for LINQ/EF-style
/// projection use.
/// </summary>
public class Issue2224AnonymousClassEmitTests
{
    [Fact]
    public void AnonymousClass_MemberAccess_EmitsAndRuns()
    {
        const string source = """
            package Corpus.Issue2224

            import System

            var x = interface { Name = "Foo", Age = 42 }
            Console.WriteLine(x.Name)
            Console.WriteLine(x.Age.ToString())
            """;

        var output = CompileAndRun("Issue2224MemberAccess", ReferenceResolver.Default(), source);
        Assert.Equal("Foo" + Environment.NewLine + "42" + Environment.NewLine, output);
    }

    // Coverage for the actual reported GS0473-inside-expression-tree scenario
    // lives in AnonymousClassExpressionTests.AnonymousClass_InsideExpressionTreeLambda_DoesNotReportGS0473
    // (binding-level diagnostics test, matching the existing
    // Issue2130ExpressionTreeBindingTests style).

    [Fact]
    public void AnonymousClass_StructuralEquality_MatchesCSharpAnonymousTypeSemantics()
    {
        const string source = """
            package Corpus.Issue2224

            import System

            var a = interface { Id = 1, Alias = "x" }
            var b = interface { Id = 1, Alias = "x" }
            var c = interface { Id = 2, Alias = "x" }
            Console.WriteLine((a == b).ToString())
            Console.WriteLine((a == c).ToString())
            Console.WriteLine(a.GetHashCode() == b.GetHashCode())
            """;

        var output = CompileAndRun("Issue2224StructuralEquality", ReferenceResolver.Default(), source);
        var lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("True", lines[0]);
        Assert.Equal("False", lines[1]);
        Assert.Equal("True", lines[2]);
    }

    /// <summary>
    /// Compiles and emits <paramref name="source"/>, loads the resulting PE,
    /// invokes its entry point, and returns captured console output.
    /// </summary>
    private static string CompileAndRun(string contextName, ReferenceResolver references, string source)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(references, tree);
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
            catch (TargetInvocationException ex) when (ex.InnerException is AggregateException agg)
            {
                throw agg.InnerException ?? agg;
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
