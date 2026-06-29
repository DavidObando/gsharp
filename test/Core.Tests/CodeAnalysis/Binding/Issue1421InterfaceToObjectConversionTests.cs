// <copyright file="Issue1421InterfaceToObjectConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1421: a value of a user-declared <c>interface</c> type is
/// reference-convertible to <c>object</c> (an interface reference already IS an
/// object reference), so it must bind against an <c>object?</c> parameter such
/// as <c>ArgumentNullException.ThrowIfNull(object?)</c> — it previously failed
/// to resolve with GS0159 even though class- and slice-typed arguments worked.
/// The same implicit reference conversion also covers interface → base-interface
/// upcasts. These tests pin the binder (under both the live-reflection default
/// resolver and a MetadataLoadContext resolver) and the emitter.
/// </summary>
public class Issue1421InterfaceToObjectConversionTests
{
    [Fact]
    public void ThrowIfNull_OnUserInterfaceValue_BindsWithNoDiagnostics()
    {
        const string source = """
            package t
            import System
            interface IBox { prop Type string }
            func G(parent IBox) {
                ArgumentNullException.ThrowIfNull(parent)
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ThrowIfNull_OnUserInterfaceValue_BindsUnderMetadataLoadContext()
    {
        const string source = """
            package t
            import System
            interface IBox { prop Type string }
            func G(parent IBox) {
                ArgumentNullException.ThrowIfNull(parent)
            }
            """;
        Assert.Empty(BindWithReferences(source));
    }

    [Fact]
    public void InterfaceValue_AssignedToObject_BindsWithNoDiagnostics()
    {
        const string source = """
            package t
            interface IBox { prop Type string }
            func G(parent IBox) {
                var o object = parent
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void DerivedInterfaceValue_PassedToBaseInterfaceParameter_BindsWithNoDiagnostics()
    {
        const string source = """
            package t
            interface IAnimal { prop Name string }
            interface IDog : IAnimal { prop Breed string }
            func TakesAnimal(a IAnimal) {}
            func G(d IDog) {
                TakesAnimal(d)
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void InterfaceValue_FlowsThroughObjectAndBaseInterface_AtRuntime()
    {
        const string source = """
            package t
            import System
            interface IAnimal { prop Name string }
            interface IDog : IAnimal { prop Breed string }
            class Dog : IDog {
                prop Name string
                prop Breed string
            }
            func Describe(a IAnimal) string {
                return a.Name
            }
            func Main() {
                var d IDog = Dog{ Name: "Rex", Breed: "Lab" }
                ArgumentNullException.ThrowIfNull(d)
                var o object = d
                Console.WriteLine(o.ToString())
                Console.WriteLine(Describe(d))
            }
            """;

        var output = CompileLoadInvokeCaptureStdout(source, "Issue1421-InterfaceToObject");
        Assert.Contains("Rex", output);
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }

    private static ImmutableArray<Diagnostic> BindWithReferences(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            MetadataLoadContextResolver());
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(globalScope, MetadataLoadContextResolver());
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.ArgumentNullException).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
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
            var entry = asm.EntryPoint;
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
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
