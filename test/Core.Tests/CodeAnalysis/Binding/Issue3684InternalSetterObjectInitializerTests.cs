// <copyright file="Issue3684InternalSetterObjectInitializerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3684 (family F7): an object initializer must honour a friend-visible
/// <c>internal</c> setter of a referenced assembly's property.
/// <para>
/// #3693 taught the CLR instance-call and imported-static probes to admit
/// <c>assembly</c> accessibility when the declaring assembly names this
/// compilation in an <c>InternalsVisibleTo</c>. The object-initializer member
/// path kept its own writability test — <c>GetSetMethod(nonPublic: false)</c>
/// — so <c>{ get; internal set; }</c> still reported GS0127 "read-only and
/// cannot be assigned to" across a friend boundary. Only <c>assembly</c>
/// accessibility is admitted: <c>private</c>, <c>protected</c> and
/// <c>private protected</c> setters stay rejected however the friendship is
/// declared, and a non-friend consumer sees none of them.
/// </para>
/// </summary>
public sealed class Issue3684InternalSetterObjectInitializerTests
{
    private const string CSharpLibrarySource = """
        using System.Runtime.CompilerServices;

        [assembly: InternalsVisibleTo("Issue3684.Friend")]

        namespace Issue3684.Library;

        public class Bag
        {
            public int Open { get; set; }

            public int Restricted { get; internal set; }

            public int Secret { get; private set; }

            public int Guarded { get; protected set; }
        }
        """;

    [Fact]
    public void FriendAssembly_ObjectInitializer_Assigns_Internal_Setter()
    {
        RunFriend(
            "Restricted",
            result =>
            {
                Assert.True(result.Success, Describe(result));

                // Binding alone is not the contract: the emitted body must
                // actually CALL the internal accessor, not silently drop the
                // member. The setter's name is interned in the image's string
                // heap by the memberref the assignment emits.
                Assert.Contains("set_Restricted", Encoding.UTF8.GetString(result.Image), StringComparison.Ordinal);
            });
    }

    /// <summary>
    /// The same widening on the PLAIN assignment path — a friend writing
    /// <c>bag.Restricted = 1</c> — which shares the binder's writability test
    /// with the object-initializer path and was equally rejected.
    /// </summary>
    [Fact]
    public void FriendAssembly_Assignment_Writes_Internal_Setter()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource);
            var result = CompileGSharp(
                """
                package Issue3684.Friend
                import Issue3684.Library

                func Run() Bag {
                    let bag = Bag()
                    bag.Restricted = 1
                    return bag
                }
                """,
                "Issue3684.Friend",
                libraryPath);

            Assert.True(result.Success, Describe(result));
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    /// <summary>
    /// The plain-assignment counterpart of the accessibility guard: a
    /// <c>private</c> setter is not writable even for a friend.
    /// </summary>
    [Fact]
    public void FriendAssembly_Assignment_Still_Rejects_Private_Setter()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource);
            var result = CompileGSharp(
                """
                package Issue3684.Friend
                import Issue3684.Library

                func Run() Bag {
                    let bag = Bag()
                    bag.Secret = 1
                    return bag
                }
                """,
                "Issue3684.Friend",
                libraryPath);

            Assert.False(result.Success, Describe(result));
            Assert.Contains(result.Diagnostics, d => d.Id == "GS0127");
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    [Fact]
    public void FriendAssembly_ObjectInitializer_Assigns_Public_Setter()
    {
        RunFriend(
            "Open",
            result => Assert.True(result.Success, Describe(result)));
    }

    [Fact]
    public void FriendAssembly_ObjectInitializer_Still_Rejects_Private_Setter()
    {
        RunFriend(
            "Secret",
            result =>
            {
                Assert.False(result.Success, Describe(result));
                Assert.Contains(result.Diagnostics, d => d.Id == "GS0127");
            });
    }

    [Fact]
    public void FriendAssembly_ObjectInitializer_Still_Rejects_Protected_Setter()
    {
        RunFriend(
            "Guarded",
            result =>
            {
                Assert.False(result.Success, Describe(result));
                Assert.Contains(result.Diagnostics, d => d.Id == "GS0127");
            });
    }

    [Fact]
    public void NonFriendAssembly_ObjectInitializer_Still_Rejects_Internal_Setter()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource);
            var result = CompileGSharp(
                Consumer("Issue3684.Stranger", "Restricted"),
                "Issue3684.Stranger",
                libraryPath);

            Assert.False(result.Success, Describe(result));
            Assert.Contains(result.Diagnostics, d => d.Id == "GS0127");
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    /// <summary>
    /// The shape #3684 actually hit: FOUR initializer members in one literal,
    /// every one of them <c>{ get; internal set; }</c>. Every member must bind;
    /// the original defect reported on some and not others purely because the
    /// binder's per-member fallbacks differ.
    /// </summary>
    [Fact]
    public void FriendAssembly_ObjectInitializer_Assigns_Every_Internal_Setter_In_One_Literal()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(
                directory,
                "Issue3684.Library",
                """
                using System.Collections.Immutable;
                using System.Runtime.CompilerServices;

                [assembly: InternalsVisibleTo("Issue3684.Friend")]

                namespace Issue3684.Library;

                public class Program
                {
                    public ImmutableArray<string> Imports { get; internal set; } = ImmutableArray<string>.Empty;

                    public ImmutableArray<string> FriendAssemblies { get; internal set; } = ImmutableArray<string>.Empty;

                    public ImmutableArray<string> AssemblyAttributes { get; internal set; } = ImmutableArray<string>.Empty;

                    public ImmutableArray<string> ModuleAttributes { get; internal set; } = ImmutableArray<string>.Empty;
                }
                """);
            var result = CompileGSharp(
                """
                package Issue3684.Friend
                import Issue3684.Library
                import System.Collections.Immutable

                func Run(source Program) Program {
                    return Program{
                        Imports: source.Imports,
                        FriendAssemblies: source.FriendAssemblies,
                        AssemblyAttributes: source.AssemblyAttributes,
                        ModuleAttributes: source.ModuleAttributes,
                    }
                }
                """,
                "Issue3684.Friend",
                libraryPath);

            Assert.True(result.Success, Describe(result));
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    private static string Consumer(string assemblyName, string memberName)
        => $$"""
            package {{assemblyName}}
            import Issue3684.Library

            func Run() Bag {
                return Bag{{{memberName}}: 1}
            }
            """;

    private static void RunFriend(string memberName, Action<CompileResult> assert)
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource);
            assert(CompileGSharp(
                Consumer("Issue3684.Friend", memberName),
                "Issue3684.Friend",
                libraryPath));
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
            emit.Diagnostics.Select(d => new DiagnosticInfo(d.Id, d.Message)).ToArray(),
            output.ToArray());
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
            nameof(Issue3684InternalSetterObjectInitializerTests),
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

    private readonly record struct CompileResult(bool Success, DiagnosticInfo[] Diagnostics, byte[] Image);

    private readonly record struct DiagnosticInfo(string Id, string Message);
}
