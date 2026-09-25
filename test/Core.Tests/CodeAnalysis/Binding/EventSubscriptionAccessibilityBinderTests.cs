// <copyright file="EventSubscriptionAccessibilityBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4394: every event-subscription path checks that the subscribing
/// code can reach the event, as <c>base.E += h</c> has since #4380. C#
/// reports CS0122 for these; gsc reports its usual inaccessible-member
/// diagnostics (GS0472 for <c>private</c>, GS0379 for <c>protected</c>).
/// <list type="bullet">
///   <item>source events: <c>obj.E += h</c>, <c>-=</c>, a bare
///   <c>E += h</c> in a derived class, and a class-constrained type
///   parameter receiver;</item>
///   <item>imported events: an event that exists but is not reachable is
///   reported as inaccessible rather than "cannot find member" (GS0158); a
///   <c>protected</c> one is reachable from a derived class through its own
///   instance.</item>
/// </list>
/// The reachable cells are compiled, verified and run in Compiler.Tests'
/// <c>EventAndBaseMethodGroupEmitTests</c>.
/// </summary>
public sealed class EventSubscriptionAccessibilityBinderTests
{
    private const string AssemblyName = "EventAccess.Consumer";

    private const string SourceDeclarations = """
        import System

        open class Source {
            private event Priv EventHandler?
            protected event Prot EventHandler?
            internal event Intl EventHandler?
            event Pub EventHandler?
        }

        """;

    private const string CSharpLibrarySource = """
        using System;

        namespace EventAccess.Library
        {
            public class CSource
            {
                private event EventHandler? Priv;
                protected event EventHandler? Prot;
                internal event EventHandler? Intl;
                public event EventHandler? Pub;
                protected internal event EventHandler? ProtIntl;
                private protected event EventHandler? PrivProt;

                public event EventHandler? Split
                {
                    add { }
                    remove { }
                }

                public void Fire()
                {
                    Priv?.Invoke(this, EventArgs.Empty);
                    Prot?.Invoke(this, EventArgs.Empty);
                    Intl?.Invoke(this, EventArgs.Empty);
                    Pub?.Invoke(this, EventArgs.Empty);
                    ProtIntl?.Invoke(this, EventArgs.Empty);
                    PrivProt?.Invoke(this, EventArgs.Empty);
                }
            }
        }
        """;

    [Theory]
    [InlineData("s.Priv += h", "GS0472", "Priv")]
    [InlineData("s.Priv -= h", "GS0472", "Priv")]
    [InlineData("s.Prot += h", "GS0379", "Prot")]
    [InlineData("s.Prot -= h", "GS0379", "Prot")]
    public void SourceEvent_FromUnrelatedClass_IsReportedInaccessible(string statement, string id, string eventName)
    {
        var source = SourceDeclarations + $$"""
            class Other {
                func Hook(s Source, h EventHandler) {
                    {{statement}}
                }
            }
            """;

        AssertSingleError(source, id, eventName);
    }

    [Theory]
    [InlineData("Priv += h")]
    [InlineData("this.Priv += h")]
    [InlineData("this.Priv -= h")]
    [InlineData("other.Priv += h")]
    public void PrivateSourceEvent_FromDerivedClass_IsReportedInaccessible(string statement)
    {
        var source = SourceDeclarations + $$"""
            class Derived : Source {
                func Hook(other Derived, h EventHandler) {
                    {{statement}}
                }
            }
            """;

        AssertSingleError(source, "GS0472", "Priv");
    }

    [Fact]
    public void PrivateSourceEvent_ThroughClassConstrainedTypeParameter_IsReportedInaccessible()
    {
        var source = SourceDeclarations + """
            class Other {
                func Hook[T Source](t T, h EventHandler) {
                    t.Priv += h
                }
            }
            """;

        AssertSingleError(source, "GS0472", "Priv");
    }

    [Fact]
    public void ReachableSourceEvents_Bind()
    {
        var source = SourceDeclarations + """
            open class Declaring {
                private event Own EventHandler?
                func Hook(other Declaring, h EventHandler) {
                    other.Own += h
                    Own += h
                    this.Own -= h
                }
            }

            class Derived : Source {
                func Hook(other Derived, h EventHandler) {
                    Prot += h
                    this.Prot += h
                    other.Prot -= h
                    this.Intl += h
                }
            }

            class Other {
                func Hook(s Source, h EventHandler) {
                    s.Intl += h
                    s.Pub += h
                    s.Pub -= h
                }
            }
            """;

        var errors = EmittedOracle.Evaluate(source).Diagnostics.Where(d => d.IsError).ToArray();
        Assert.Empty(errors);
    }

    [Theory]
    [InlineData("s.Priv += h", "GS0472", "Priv")]
    [InlineData("s.Priv -= h", "GS0472", "Priv")]
    [InlineData("s.Prot += h", "GS0379", "Prot")]
    [InlineData("s.ProtIntl += h", "GS0379", "ProtIntl")]
    [InlineData("s.Intl += h", "GS0472", "Intl")]
    [InlineData("s.PrivProt += h", "GS0472", "PrivProt")]
    public void ImportedEvent_FromUnrelatedClass_IsReportedInaccessible(string statement, string id, string eventName)
    {
        var result = CompileAgainstLibrary($$"""
            import System
            import EventAccess.Library

            class Other {
                func Hook(s CSource, h EventHandler) {
                    {{statement}}
                }
            }
            """);

        Assert.False(result.Success);
        var error = Assert.Single(result.Diagnostics);
        Assert.Equal(id, error.Id);
        Assert.Contains(eventName, error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("this.Priv += h", "GS0472")]
    [InlineData("other.Priv -= h", "GS0472")]
    [InlineData("this.PrivProt += h", "GS0472")]
    [InlineData("s.Prot += h", "GS0379")]
    public void ImportedEvent_FromDerivedClass_UnreachableCell_IsReportedInaccessible(string statement, string id)
    {
        // A derived class reaches a protected event only through an instance
        // of its own class (C#'s rule for protected instance access); a
        // `CSource`-typed receiver may be some other subclass.
        var result = CompileAgainstLibrary($$"""
            import System
            import EventAccess.Library

            class Der : CSource {
                func Hook(other Der, s CSource, h EventHandler) {
                    {{statement}}
                }
            }
            """);

        Assert.False(result.Success);
        var error = Assert.Single(result.Diagnostics);
        Assert.Equal(id, error.Id);
    }

    [Fact]
    public void ImportedEvent_ReachableCells_Bind()
    {
        var result = CompileAgainstLibrary("""
            import System
            import EventAccess.Library

            class Der : CSource {
                func Hook(other Der, h EventHandler) {
                    this.Prot += h
                    this.Prot -= h
                    other.Prot += h
                    this.ProtIntl += h
                    this.Pub += h
                }
            }

            class Other {
                func Hook(s CSource, h EventHandler) {
                    s.Pub += h
                    s.Pub -= h
                    s.Split += h
                    s.Split -= h
                }
            }
            """);

        Assert.True(result.Success, Describe(result));
    }

    [Fact]
    public void MissingImportedEvent_StillReportsCannotFindMember()
    {
        var result = CompileAgainstLibrary("""
            import System
            import EventAccess.Library

            class Other {
                func Hook(s CSource, h EventHandler) {
                    s.Nope += h
                }
            }
            """);

        Assert.False(result.Success);
        var error = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0158", error.Id);
    }

    private static void AssertSingleError(string source, string id, string eventName)
    {
        var errors = EmittedOracle.Evaluate(source).Diagnostics.Where(d => d.IsError).ToArray();
        var error = Assert.Single(errors);
        Assert.Equal(id, error.Id);
        Assert.Contains(eventName, error.Message, StringComparison.Ordinal);
    }

    private static string Describe(CompileResult result)
        => string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.Id + ": " + d.Message));

    private static CompileResult CompileAgainstLibrary(string body)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(EventSubscriptionAccessibilityBinderTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "EventAccess.Library", CSharpLibrarySource);
            using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
            resolver.CurrentAssemblyName = AssemblyName;
            var compilation = new GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From("package " + AssemblyName + "\n" + body)))
            {
                AssemblyName = AssemblyName,
                IsLibrary = true,
            };

            using var output = new MemoryStream();
            var emit = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: AssemblyName);
            return new CompileResult(
                emit.Success,
                emit.Diagnostics.Where(d => d.IsError).Select(d => new DiagnosticInfo(d.Id, d.Message)).ToArray());
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static string EmitCSharpLibrary(string directory, string assemblyName, string source)
    {
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        var path = Path.Combine(directory, assemblyName + ".dll");
        using var output = File.Create(path);
        var emit = compilation.Emit(output);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return path;
    }

    private readonly record struct CompileResult(bool Success, DiagnosticInfo[] Diagnostics);

    private readonly record struct DiagnosticInfo(string Id, string Message);
}
