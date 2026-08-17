// <copyright file="Issue2809InheritedClrPropertyAccessorChainTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2809InheritedClrPropertyAccessorChainTests
{
    private static readonly string LibraryPath = EmitLibrary();

    [Fact]
    public void ImportedBaseProperty_HeadOfUnqualifiedAccessorChain_Binds()
    {
        Assert.Empty(Bind("""
            package Consumer
            import Project1

            class ChatHub : A {
                func Join() int32 {
                    return Clients.All()
                }
            }
            """));
    }

    [Fact]
    public void ImportedBaseProperty_ThroughUserBase_HeadOfUnqualifiedAccessorChain_Binds()
    {
        Assert.Empty(Bind("""
            package Consumer
            import Project1

            open class Mid : A {
            }

            class ChatHub : Mid {
                func Join() int32 {
                    return Clients.All()
                }
            }
            """));
    }

    [Fact]
    public void ImportedBaseProperty_DoesNotShadowStaticTypeMember()
    {
        Assert.Empty(Bind("""
            package Consumer
            import Project1
            import System.IO

            class ChatHub : A {
                func Join() string {
                    return Path.Combine("first", "second")
                }
            }
            """));
    }

    [Fact]
    public void ImportedBaseProperty_DoesNotShadowStaticInterfaceMember()
    {
        Assert.Empty(Bind("""
            package Consumer
            import Project1

            interface Path {
                shared {
                    const Kind string = "path"
                }
            }

            class ChatHub : A {
                func Join() string {
                    return Path.Kind
                }
            }
            """));
    }

    [Fact]
    public void ImportedGenericBaseProperty_PreservesSymbolicReceiverArgument()
    {
        Assert.Empty(Bind("""
            package Consumer
            import Project1

            class SharedOptions {
                prop Header string {
                    get -> "X-User"
                }
            }

            class Handler : GenericBase[SharedOptions] {
                func Read() string {
                    return Options.Header
                }
            }
            """));
    }

    private static IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { LibraryPath });
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GsCompilation(resolver, tree) { IsLibrary = true };
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
    }

    private static string EmitLibrary()
    {
        string outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue2809Binding");
        Directory.CreateDirectory(outputDirectory);
        string libraryPath = Path.Combine(outputDirectory, "Issue2809.Library.dll");

        const string source = """
            namespace Project1
            {
                public class A
                {
                    public B Clients { get; } = new B();
                    public B Path { get; } = new B();
                }

                public class B
                {
                    public int All() => 1;
                }

                public class GenericBase<T>
                {
                    public T Options { get; } = default!;
                }
            }
            """;

        var trustedPlatformAssemblies = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        var references = trustedPlatformAssemblies == null
            ? Array.Empty<MetadataReference>()
            : trustedPlatformAssemblies
                .Split(Path.PathSeparator)
                .Where(path => !string.IsNullOrWhiteSpace(path))
                .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
                .ToArray();

        var compilation = CSharpCompilation.Create(
            assemblyName: "Issue2809.Library",
            syntaxTrees: new[] { CSharpSyntaxTree.ParseText(source) },
            references: references,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var emit = compilation.Emit(libraryPath);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics.Select(d => d.ToString())));
        return libraryPath;
    }
}
