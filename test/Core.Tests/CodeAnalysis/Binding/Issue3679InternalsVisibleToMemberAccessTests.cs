// <copyright file="Issue3679InternalsVisibleToMemberAccessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3679: a friend assembly must reach the <c>internal</c> METHODS of a
/// referenced assembly, not just its internal fields and properties.
/// <para>
/// The .NET SDK turns every <c>&lt;InternalsVisibleTo Include="X" /&gt;</c>
/// msbuild item into an <c>@(AssemblyAttribute)</c> item, which
/// <c>Gsharp.NET.Sdk</c>'s <c>WriteGsharpAssemblyInfoTask</c> renders as the
/// file-level annotation <c>@assembly: System.Runtime.CompilerServices.InternalsVisibleTo("X")</c>
/// and the emitter writes as a real <c>InternalsVisibleToAttribute</c> row. All
/// of that already worked; what did not was the consumer side. The CLR
/// instance-call candidate walk
/// (<c>MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces</c>) and the
/// imported static-class probe enumerated <c>BindingFlags.Public</c> only, so
/// an internal method of a friend assembly was never even a candidate and the
/// call dead-ended at GS0159 "Cannot find function" — while an internal
/// property or field on the same type resolved fine, because those probes
/// already widened to <c>NonPublic</c> under the same friendship test. That
/// asymmetry is why every migrated <c>*.Tests</c> app lost cross-assembly
/// internal access to the project under test.
/// </para>
/// </summary>
public sealed class Issue3679InternalsVisibleToMemberAccessTests
{
    private const string CSharpLibrarySource = """
        using System.Runtime.CompilerServices;

        [assembly: InternalsVisibleTo("Issue3679.Friend")]

        namespace Issue3679.Library;

        public class Bag
        {
            public int Report() => 1;

            internal int BeginTransaction() => 42;

            internal int Hidden => 3;

            internal static int MapToReferenceClrType() => 7;

            private int Secret() => 9;
        }
        """;

    [Fact]
    public void FriendAssembly_Calls_Internal_Instance_Method_Of_Imported_CSharp_Class()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "Issue3679.Library", CSharpLibrarySource);
            var result = CompileGSharp(
                """
                package Issue3679.Friend
                import Issue3679.Library

                func Run() int32 {
                    let bag = Bag()
                    return bag.BeginTransaction()
                }
                """,
                "Issue3679.Friend",
                libraryPath);

            Assert.True(result.Success, Describe(result));
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    [Fact]
    public void FriendAssembly_Calls_Internal_Static_Method_Of_Imported_CSharp_Class()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "Issue3679.Library", CSharpLibrarySource);
            var result = CompileGSharp(
                """
                package Issue3679.Friend
                import Issue3679.Library

                func Run() int32 -> Bag.MapToReferenceClrType()
                """,
                "Issue3679.Friend",
                libraryPath);

            Assert.True(result.Success, Describe(result));
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    [Fact]
    public void NonFriendAssembly_Still_Cannot_Call_An_Internal_Method()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "Issue3679.Library", CSharpLibrarySource);
            var result = CompileGSharp(
                """
                package Issue3679.Stranger
                import Issue3679.Library

                func Run() int32 {
                    let bag = Bag()
                    return bag.BeginTransaction()
                }
                """,
                "Issue3679.Stranger",
                libraryPath);

            Assert.False(result.Success);
            Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    [Fact]
    public void FriendAssembly_Still_Cannot_Call_A_Private_Method()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "Issue3679.Library", CSharpLibrarySource);
            var result = CompileGSharp(
                """
                package Issue3679.Friend
                import Issue3679.Library

                func Run() int32 {
                    let bag = Bag()
                    return bag.Secret()
                }
                """,
                "Issue3679.Friend",
                libraryPath);

            Assert.False(result.Success);
            Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    /// <summary>
    /// The producer half of the SDK path: the friend declaration a
    /// <c>&lt;InternalsVisibleTo&gt;</c> item becomes is the FULLY QUALIFIED,
    /// suffix-less <c>System.Runtime.CompilerServices.InternalsVisibleTo</c>
    /// spelling <c>WriteGsharpAssemblyInfoTask</c> renders from
    /// <c>@(AssemblyAttribute)</c> — not the bare <c>InternalsVisibleTo</c> a
    /// hand-written G# source uses. Both must grant the same access.
    /// </summary>
    [Fact]
    public void SdkGeneratedQualifiedAnnotation_Grants_Internal_Method_Access()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitGSharpLibrary(
                directory,
                "Issue3679.GsLibrary",
                """
                package Issue3679.GsLibrary

                @assembly: System.Runtime.CompilerServices.InternalsVisibleTo("Issue3679.Friend")

                public class DiagnosticBag {
                  public func Report() int32 -> 1

                  internal func BeginTransaction() int32 -> 42
                }
                """);
            var result = CompileGSharp(
                """
                package Issue3679.Friend
                import Issue3679.GsLibrary

                func Run() int32 {
                    let bag = DiagnosticBag()
                    return bag.BeginTransaction()
                }
                """,
                "Issue3679.Friend",
                libraryPath);

            Assert.True(result.Success, Describe(result));
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    private static string Describe(CompileResult result)
        => string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.Id + ": " + d.Message));

    private static CompileResult CompileGSharp(
        string source,
        string assemblyName,
        params string[] references)
    {
        using var resolver = references.Length == 0
            ? ReferenceResolver.Default()
            : ReferenceResolver.WithReferences(references);
        resolver.CurrentAssemblyName = assemblyName;
        var compilation = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(source)))
        {
            AssemblyName = assemblyName,
        };

        using var output = new MemoryStream();
        var emit = compilation.Emit(
            output,
            pdbStream: null,
            refStream: null,
            assemblyName: assemblyName);
        return new CompileResult(
            emit.Success,
            emit.Diagnostics.Select(d => new DiagnosticInfo(d.Id, d.Message)).ToArray());
    }

    private static string EmitGSharpLibrary(string directory, string assemblyName, string source)
    {
        var path = Path.Combine(directory, assemblyName + ".dll");
        using var resolver = ReferenceResolver.Default();
        resolver.CurrentAssemblyName = assemblyName;
        var compilation = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(source)))
        {
            AssemblyName = assemblyName,
            IsLibrary = true,
        };

        using var output = File.Create(path);
        var emit = compilation.Emit(
            output,
            pdbStream: null,
            refStream: null,
            assemblyName: assemblyName);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return path;
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
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(directory, assemblyName + ".dll");
        using var output = File.Create(path);
        var emit = compilation.Emit(output);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return path;
    }

    private static string CreateOutputDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3679InternalsVisibleToMemberAccessTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static void DeleteOutputDirectory(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private readonly record struct CompileResult(bool Success, DiagnosticInfo[] Diagnostics);

    private readonly record struct DiagnosticInfo(string Id, string Message);
}
