// <copyright file="Issue2548ImportedEnumExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2548: switch exhaustiveness includes enum members imported from
/// assembly metadata, including aliases.
/// </summary>
public sealed class Issue2548ImportedEnumExhaustivenessTests
{
    [Fact]
    public void ImportedEnum_CompleteExpressionAndStatement_CompileAndRun()
    {
        var libraryPath = EmitLibrary(nameof(this.ImportedEnum_CompleteExpressionAndStatement_CompileAndRun));
        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import System
                import Models

                func Describe(state State) string {
                    return switch state {
                        case State.Unknown: "unknown"
                        case State.Ready: "ready"
                        case State.Done: "done"
                    }
                }

                func Print(state State) {
                    switch state {
                        case State.Unknown { Console.WriteLine("unknown") }
                        case State.Ready { Console.WriteLine("ready") }
                        case State.Done { Console.WriteLine("done") }
                    }
                }

                func Main() {
                    Console.WriteLine(Describe(State.Active))
                    Print(State.Done)
                }
                """)));

        using var stream = new MemoryStream();
        var result = consumer.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2548.Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        stream.Position = 0;
        var context = new AssemblyLoadContext("Issue2548.Consumer", isCollectible: true);
        context.Resolving += (loadContext, name) =>
            string.Equals(name.Name, "Issue2548.Models", StringComparison.Ordinal)
                ? loadContext.LoadFromAssemblyPath(libraryPath)
                : null;
        try
        {
            var assembly = context.LoadFromStream(stream);
            var originalOut = Console.Out;
            var output = new StringWriter();
            Console.SetOut(output);
            try
            {
                assembly.EntryPoint!.Invoke(null, null);
            }
            finally
            {
                Console.SetOut(originalOut);
            }

            Assert.Equal("ready\ndone\n", output.ToString().Replace("\r\n", "\n", StringComparison.Ordinal));
        }
        finally
        {
            context.Unload();
        }
    }

    [Fact]
    public void ImportedEnum_IncompleteExpressionAndStatement_ReportMissingMember()
    {
        var libraryPath = EmitLibrary(nameof(this.ImportedEnum_IncompleteExpressionAndStatement_ReportMissingMember));
        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Models

                func Describe(state State) string {
                    return switch state {
                        case State.Unknown: "unknown"
                        case State.Ready: "ready"
                    }
                }

                func Observe(state State) {
                    switch state {
                        case State.Unknown { let observed = 0 }
                        case State.Active { let observed = 1 }
                    }
                }
                """)));

        Assert.Contains(
            consumer.BoundProgram.Diagnostics,
            diagnostic => diagnostic.Message == "Switch expression on enum 'Models.State' is not exhaustive: missing 'Done'.");
        Assert.Contains(
            consumer.BoundProgram.Diagnostics,
            diagnostic => diagnostic.Message == "Switch statement on enum 'Models.State' is not exhaustive: missing 'Done'.");
    }

    private static string EmitLibrary(string caseName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2548", caseName);
        Directory.CreateDirectory(directory);
        var libraryPath = Path.Combine(directory, "Issue2548.Models.dll");
        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Models

                enum State {
                    Unknown = -1,
                    Ready = 1,
                    Active = Ready,
                    Done = 2,
                }
                """)))
        {
            IsLibrary = true,
        };

        using var stream = File.Create(libraryPath);
        var result = library.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2548.Models");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }
}
