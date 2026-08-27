// <copyright file="Issue3595SelfPackageImportedTypeTests.cs" company="GSharp">
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
/// Issue #3595 (#3501): CLR namespaces merge across assemblies, and a G#
/// package is the same construct — a file in <c>package X</c> must see a
/// REFERENCED assembly's exported types in namespace X without spelling
/// <c>import X</c>. The C#→G# self-migration splits one namespace across
/// project boundaries (Cs2Gs.ProjectLoading declares types in the referenced
/// Translator assembly's <c>Cs2Gs.Translator.Loading</c> namespace), and the
/// missing merge made every such cross-assembly reference GS0113.
/// </summary>
public class Issue3595SelfPackageImportedTypeTests
{
    [Fact]
    public void SamePackage_TypeFromReferencedAssembly_ResolvesWithoutImport()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue3595");
        Directory.CreateDirectory(outputDir);

        var libraryPath = Path.Combine(outputDir, "Issue3595.Library.dll");
        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Shared.Loading

                open class Doc {
                    prop Path string -> "p"
                }

                open class Doc2[T] {
                    prop Value T? -> nil
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libraryResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue3595.Library");
            Assert.True(libraryResult.Success, string.Join(Environment.NewLine, libraryResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Issue3595.Consumer";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Shared.Loading

                class Holder {
                    func Describe(d Doc) string {
                        return d.Path
                    }

                    func First(d Doc2[string]) string? {
                        return d.Value
                    }
                }
                """)))
        {
            IsLibrary = true,
        };

        using var consumerStream = new MemoryStream();
        var result = consumer.Emit(consumerStream, pdbStream: null, refStream: null, assemblyName: "Issue3595.Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
