// <copyright file="Issue2243AnonymousClassEmitTests.cs" company="GSharp">
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

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0146 (issue #2243): end-to-end emission of the richer anonymous-object
/// literal. A <c>data object { ... }</c> reuses the value-type
/// data-struct pipeline (Equals/GetHashCode/ToString/with). A plain
/// <c>object : Interface { ... }</c> / <c>object : Base(args) { ... }</c> with
/// methods or events is desugared to a synthesized reference-type class routed
/// through the ordinary named-class binder/emitter (interface-implementation
/// verification, virtual/override checking, TypeDef/MethodDef emission) — no
/// bespoke emission code. These tests exercise that the emitted IL actually
/// runs.
/// </summary>
public class Issue2243AnonymousClassEmitTests
{
    [Fact]
    public void ImplementsInterface_MethodCallableThroughInterfaceReference_EmitsAndRuns()
    {
        const string source = """
            package Corpus.Issue2243

            import System

            interface MouseListener {
                func onClick() string;
                func onHover() string;
            }

            let listener = object : MouseListener {
                func onClick() string -> "Button clicked!"
                func onHover() string -> "Button hovered!"
            }
            Console.WriteLine(listener.onClick())
            Console.WriteLine(listener.onHover())
            let asIface MouseListener = listener
            Console.WriteLine(asIface.onClick())
            """;

        var output = CompileAndRun("Issue2243Interface", source);
        var lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("Button clicked!", lines[0]);
        Assert.Equal("Button hovered!", lines[1]);
        Assert.Equal("Button clicked!", lines[2]);
    }

    [Fact]
    public void ExtendsBaseClass_OverriddenMethodRuns_EmitsAndRuns()
    {
        const string source = """
            package Corpus.Issue2243

            import System

            open class Animal(Name string) {
                open func SaySomething() string -> "generic"
            }

            let dog = object : Animal("Fluffy") {
                override func SaySomething() string -> "woof!"
            }
            Console.WriteLine(dog.SaySomething())
            """;

        var output = CompileAndRun("Issue2243Base", source);
        Assert.Equal("woof!", output.Trim());
    }

    [Fact]
    public void DataObject_With_ProducesIndependentCopy_EmitsAndRuns()
    {
        const string source = """
            package Corpus.Issue2243

            import System

            let mydata = data object { let Name = "David"; let Language = "GSharp" }
            let other = mydata with { Name = "Amelia" }
            Console.WriteLine(mydata.Name)
            Console.WriteLine(other.Name)
            Console.WriteLine(other.Language)
            """;

        var output = CompileAndRun("Issue2243With", source);
        var lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("David", lines[0]);
        Assert.Equal("Amelia", lines[1]);
        Assert.Equal("GSharp", lines[2]);
    }

    /// <summary>
    /// Compiles and emits <paramref name="source"/>, loads the resulting PE,
    /// invokes its entry point, and returns captured console output.
    /// </summary>
    /// <param name="contextName">The collectible load-context name.</param>
    /// <param name="source">The G# source to compile.</param>
    /// <returns>The captured console output.</returns>
    private static string CompileAndRun(string contextName, string source)
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
