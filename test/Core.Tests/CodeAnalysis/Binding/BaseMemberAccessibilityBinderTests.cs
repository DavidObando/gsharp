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

        namespace BaseAccess.Library
        {

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

        public class HidingFar
        {
            public event EventHandler? Count;
            public event EventHandler? Label;

            public void Fire()
            {
                Count?.Invoke(this, EventArgs.Empty);
                Label?.Invoke(this, EventArgs.Empty);
            }
        }

        public class HidingMid : HidingFar
        {
            public new int Count = 1;

            public new string Label { get; set; } = "a";
        }

        public class ReadOnlyHolder
        {
            protected readonly int Fixed = 1;
        }

        public class StaticHolder
        {
            protected static int ReadHidden { private get; set; } = 1;

            protected static int WriteHidden { get; private set; } = 2;
        }
        }

        namespace BaseAccess.Named
        {
            public static class @base
            {
                public static string M() => "imported base.M";
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

    [Fact]
    public void NearerSourceValueMember_HidesFartherBaseEvent()
    {
        // `Mid` declares value members named like `Far`'s events. The nearer
        // member hides the event, so `base.Count += 1` is integer compound
        // assignment and `base.Label += "!"` string concatenation.
        const string source = """
            import System

            open class Far {
                event Count EventHandler?
                event Label EventHandler?
            }

            open class Mid : Far {
                var Count int32 = 1
                var label string = "a"
                prop Label string {
                    get -> label
                    set { label = value }
                }
            }

            class Derived : Mid {
                func Go() string {
                    base.Count += 1
                    base.Label += "!"
                    return "${base.Count} ${base.Label}"
                }
            }

            Console.WriteLine(Derived().Go())
            """;

        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("2 a!" + Environment.NewLine, result.Output);
    }

    [Fact]
    public void NearerImportedValueMember_HidesFartherBaseEvent()
    {
        var result = CompileAgainstLibrary(
            """
            import BaseAccess.Library

            class Derived : HidingMid {
                func Go() {
                    base.Count += 1
                    base.Label += "!"
                }
            }
            """,
            StrangerName);

        Assert.True(result.Success, Describe(result));
    }

    [Fact]
    public void ImportedTypeNamedBase_StaticCall_Binds()
    {
        // `base` is contextual: an imported type named `base` keeps its
        // ordinary meaning in `base.M()`, directly and in a function literal.
        var result = CompileAgainstLibrary(
            """
            import BaseAccess.Named

            func Direct() string -> base.M()

            func InLiteral() string {
                let f = () -> base.M()
                return f()
            }
            """,
            StrangerName);

        Assert.True(result.Success, Describe(result));
    }

    [Theory]
    [InlineData("StaticHolder.ReadHidden = 3")]
    [InlineData("let w = StaticHolder.WriteHidden")]
    public void ImportedProtectedStaticProperty_VisibleAccessor_Binds(string statement)
    {
        var result = CompileAgainstLibrary(
            $$"""
            import BaseAccess.Library

            class Derived : StaticHolder {
                func Go() {
                    {{statement}}
                }
            }
            """,
            StrangerName);

        Assert.True(result.Success, Describe(result));
    }

    [Theory]
    [InlineData("let r = StaticHolder.ReadHidden")]
    [InlineData("StaticHolder.WriteHidden = 3")]
    [InlineData("StaticHolder.ReadHidden += 1")]
    [InlineData("StaticHolder.WriteHidden += 1")]
    [InlineData("Derived.ReadHidden++")]
    public void ImportedProtectedStaticProperty_HiddenAccessor_IsRejected(string statement)
    {
        // A read calls the getter and a write the setter; a compound
        // assignment needs both. A private accessor is not callable from the
        // derived class even though the property as a whole is protected.
        var result = CompileAgainstLibrary(
            $$"""
            import BaseAccess.Library

            class Derived : StaticHolder {
                func Go() {
                    {{statement}}
                }
            }
            """,
            StrangerName);

        Assert.False(result.Success);
    }

    [Fact]
    public void SourceProtectedStaticProperty_CompoundNeedsBothAccessors()
    {
        const string source = """
            open class Holder {
                shared {
                    var r int32 = 1
                    protected prop ReadHidden int32 {
                        private get -> r
                        set { r = value }
                    }
                }
            }

            class Derived : Holder {
                func Go() {
                    Holder.ReadHidden = 3
                    Holder.ReadHidden += 1
                }
            }
            """;

        var errors = EmittedOracle.Evaluate(source).Diagnostics.Where(d => d.IsError).ToArray();
        var inaccessible = Assert.Single(errors);
        Assert.Equal("GS0472", inaccessible.Id);
    }

    [Theory]
    [InlineData("base.Fixed += 1")]
    [InlineData("base.Fixed++")]
    [InlineData("--base.Fixed")]
    public void ImportedReadOnlyBaseField_CompoundIsRejected(string statement)
    {
        var result = CompileAgainstLibrary(
            $$"""
            import BaseAccess.Library

            class Derived : ReadOnlyHolder {
                func Go() {
                    {{statement}}
                }
            }
            """,
            StrangerName);

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
