// <copyright file="Issue3501ImportedBaseConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3501 (the GSharpAnalyzerVerifier wall): two composed gaps around a
/// class constraint whose base lives in a REFERENCED assembly.
/// (1) `SatisfiesClassConstraint` never walked a SOURCE class's base chain to
/// its <c>ImportedBaseType</c>, so `class Derived : ImportedBase` failed
/// `[T ImportedBase]` (GS0152). (2) A <c>T</c>-typed argument erased to bare
/// <c>object</c> in overload gating, so `ImmutableArray.Create[ImportedBase](T())`
/// found no applicable overload (GS0159); it now erases to the constraint's
/// CLR class.
/// </summary>
public class Issue3501ImportedBaseConstraintTests
{
    [Fact]
    public void SourceClassDerivingImportedBase_SatisfiesConstraint_AndTTypedArgumentBinds()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue3501ImportedBase");
        Directory.CreateDirectory(outputDir);

        var libraryPath = Path.Combine(outputDir, "Issue3501.Base.dll");
        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package IC.Analyzers

                open class Base {
                    prop Id string -> "b"
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libraryResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue3501.Base");
            Assert.True(libraryResult.Success, string.Join(Environment.NewLine, libraryResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Issue3501.Consumer";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package IC.Consumer

                import IC.Analyzers
                import System.Collections.Immutable

                class Derived : Base {
                }

                class Runner[T Base init()] {
                    func Go() int32 {
                        let items = ImmutableArray.Create[Base](T())
                        return items.Length
                    }
                }

                class Entry {
                    func Use() int32 {
                        return Runner[Derived]().Go()
                    }
                }
                """)))
        {
            IsLibrary = true,
        };

        using var consumerStream = new MemoryStream();
        var result = consumer.Emit(consumerStream, pdbStream: null, refStream: null, assemblyName: "Issue3501.Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
