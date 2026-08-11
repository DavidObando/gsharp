// <copyright file="Issue2947ImportedNestedGenericTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #2947: imported nested types retain symbolic enclosing arguments.</summary>
public class Issue2947ImportedNestedGenericTypeTests
{
    [Fact]
    public void ImportedNestedEnumLiterals_RetainSymbolicOuterArgumentAtBothDepths()
    {
        var directory = CreateEmptyTestDirectory();
        try
        {
            var libraryPath = Path.Combine(directory, "glib.dll");
            EmitLibrary(libraryPath);

            using (var resolver = ReferenceResolver.WithReferences(new[] { libraryPath }))
            {
                var compilation = new Compilation(
                    resolver,
                    SyntaxTree.Parse(SourceText.From(
                        """
                        package consumer

                        func Take[T]() {
                            var direct glib.Outer[T].Color = glib.Outer[T].Color.Green
                            var deep glib.Outer[T].Mid.Tone = glib.Outer[T].Mid.Tone.Green
                            var invalid int32 = direct
                        }
                        """)));

                var errors = compilation.GlobalScope.Diagnostics
                    .Concat(compilation.BoundProgram.Diagnostics)
                    .Where(diagnostic => diagnostic.IsError)
                    .ToArray();
                var error = Assert.Single(errors);
                Assert.Equal("GS0156", error.Id);
                Assert.Equal(
                    "Cannot convert type 'glib.Outer[T].Color' to 'int32'. An explicit conversion exists (are you missing a cast?)",
                    error.Message);

                var function = compilation.BoundProgram.Functions.Keys.Single(symbol => symbol.Name == "Take");
                var collector = new EnumLiteralCollector();
                collector.Visit(compilation.BoundProgram.Functions[function]);

                AssertSymbolicImportedType(collector.Literals.Single(literal => Equals(literal.Value, 5)), "type glib.Outer[T].Color", compilation);
                AssertSymbolicImportedType(collector.Literals.Single(literal => Equals(literal.Value, 8)), "type glib.Outer[T].Mid.Tone", compilation);
            }

            _ = Assembly.LoadFrom(libraryPath);
            var runtimeCompilation = new Compilation(
                SyntaxTree.Parse(SourceText.From(
                    """
                    package consumer

                    struct Holder[T] {
                        func Take() {
                            var direct glib.Outer[T].Color = glib.Outer[T].Color.Green
                            var invalid int32 = direct
                        }
                    }
                    """)));
            var runtimeErrors = runtimeCompilation.GlobalScope.Diagnostics
                .Concat(runtimeCompilation.BoundProgram.Diagnostics)
                .Where(diagnostic => diagnostic.IsError)
                .ToArray();
            Assert.Equal(
                new[]
                {
                    "Cannot convert type 'glib.Outer[T].Color' to 'int32'. An explicit conversion exists (are you missing a cast?)",
                },
                runtimeErrors.Select(diagnostic => diagnostic.Message));
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static void AssertSymbolicImportedType(
        BoundLiteralExpression literal,
        string expectedDisplay,
        Compilation compilation)
    {
        var imported = Assert.IsType<ImportedTypeSymbol>(literal.Type);
        Assert.True(imported.HasTypeParameterArgument);
        Assert.Equal("T", Assert.Single(imported.TypeArguments).Name);
        Assert.Equal(
            expectedDisplay,
            SymbolDisplay.ToDisplayString(imported, SymbolDisplayFormat.Signature, compilation));
    }

    private static void EmitLibrary(string outputPath)
    {
        var compilation = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package glib

                public struct Outer[T] {
                    public enum Color { Red = 4, Green = 5, Blue = 6 }

                    public struct Mid {
                        public enum Tone { Red = 7, Green = 8, Blue = 9 }
                    }
                }
                """)))
        {
            IsLibrary = true,
        };

        using var output = File.Create(outputPath);
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "glib");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string CreateEmptyTestDirectory()
    {
        var root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, $"{nameof(Issue2947ImportedNestedGenericTypeTests)}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        Assert.Empty(Directory.GetFileSystemEntries(path));
        return path;
    }

    private sealed class EnumLiteralCollector : BoundTreeWalker
    {
        public List<BoundLiteralExpression> Literals { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundLiteralExpression literal)
            {
                Literals.Add(literal);
            }

            base.VisitExpression(node);
        }
    }
}
