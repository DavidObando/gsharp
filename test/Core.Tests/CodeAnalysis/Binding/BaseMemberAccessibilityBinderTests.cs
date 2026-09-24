// <copyright file="BaseMemberAccessibilityBinderTests.cs" company="GSharp">
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
/// Accessibility of base members reached through <c>base.E += h</c> and
/// <c>base.P ??= v</c>. The nearest member of the name still hides farther
/// ones, but a member the derived class cannot reach is reported rather than
/// bound: a <c>private</c> source event, a <c>private</c> or non-friend
/// <c>internal</c> imported event (whose accessor call would otherwise fail
/// at run time with MethodAccessException). A friend assembly's
/// <c>internal</c> event or setter is reachable, as for plain
/// <c>base.P = v</c>.
/// </summary>
public sealed class BaseMemberAccessibilityBinderTests
{
    private const string FriendName = "BaseAccess.Friend";
    private const string StrangerName = "BaseAccess.Stranger";

    private const string CSharpLibrarySource = """
        using System;
        using System.Runtime.CompilerServices;

        [assembly: InternalsVisibleTo("BaseAccess.Friend")]

        namespace BaseAccess.Library;

        public class Source
        {
            private event EventHandler? PrivateChanged;
            internal event EventHandler? InternalChanged;
            protected event EventHandler? ProtectedChanged;

            public string? Label { get; internal set; }

            public string? Tag { get; private set; }

            public void Touch()
            {
                PrivateChanged?.Invoke(this, EventArgs.Empty);
            }
        }
        """;

    [Fact]
    public void PrivateSourceBaseEvent_IsReportedInaccessible()
    {
        const string source = """
            import System

            open class Base {
                private event Changed EventHandler?
                protected event Guarded EventHandler?
            }

            class Derived : Base {
                func Go() {
                    base.Changed += func (s object?, e EventArgs) { }
                    base.Guarded += func (s object?, e EventArgs) { }
                }
            }
            """;

        var diagnostics = EmittedOracle.Evaluate(source).Diagnostics.Where(d => d.IsError).ToArray();
        var inaccessible = Assert.Single(diagnostics);
        Assert.Equal("GS0472", inaccessible.Id);
        Assert.Contains("Changed", inaccessible.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("PrivateChanged", FriendName)]
    [InlineData("InternalChanged", StrangerName)]
    public void UnreachableImportedBaseEvent_IsRejected(string eventName, string assemblyName)
    {
        var result = CompileAgainstLibrary(
            $$"""
            import System
            import BaseAccess.Library

            class Derived : Source {
                func Go() {
                    base.{{eventName}} += func (s object?, e EventArgs) { }
                }
            }
            """,
            assemblyName);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains(eventName, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("InternalChanged", FriendName)]
    [InlineData("ProtectedChanged", StrangerName)]
    public void ReachableImportedBaseEvent_Binds(string eventName, string assemblyName)
    {
        var result = CompileAgainstLibrary(
            $$"""
            import System
            import BaseAccess.Library

            class Derived : Source {
                func Go() {
                    base.{{eventName}} += func (s object?, e EventArgs) { }
                    base.{{eventName}} -= func (s object?, e EventArgs) { }
                }
            }
            """,
            assemblyName);

        Assert.True(result.Success, Describe(result));
    }

    [Fact]
    public void NullCoalescingAssignment_ImportedBaseInternalSetter_FriendBinds()
    {
        var result = CompileAgainstLibrary(
            """
            import BaseAccess.Library

            class Derived : Source {
                func Go() {
                    base.Label = "plain"
                    base.Label ??= "coalesced"
                }
            }
            """,
            FriendName);

        Assert.True(result.Success, Describe(result));
    }

    [Theory]
    [InlineData("Label", StrangerName)]
    [InlineData("Tag", FriendName)]
    public void NullCoalescingAssignment_UnreachableImportedBaseSetter_IsRejected(string property, string assemblyName)
    {
        var result = CompileAgainstLibrary(
            $$"""
            import BaseAccess.Library

            class Derived : Source {
                func Go() {
                    base.{{property}} ??= "coalesced"
                }
            }
            """,
            assemblyName);

        Assert.False(result.Success);
    }

    private static string Describe(CompileResult result)
        => string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.Id + ": " + d.Message));

    private static CompileResult CompileAgainstLibrary(string body, string assemblyName)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(BaseMemberAccessibilityBinderTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "BaseAccess.Library", CSharpLibrarySource);
            using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
            resolver.CurrentAssemblyName = assemblyName;
            var compilation = new GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From("package " + assemblyName + "\n" + body)))
            {
                AssemblyName = assemblyName,
                IsLibrary = true,
            };

            using var output = new MemoryStream();
            var emit = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: assemblyName);
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
