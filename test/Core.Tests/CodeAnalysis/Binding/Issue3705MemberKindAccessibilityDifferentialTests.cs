// <copyright file="Issue3705MemberKindAccessibilityDifferentialTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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
/// Issue #3705: the "inconsistent sibling probe" differential gate.
/// <para>
/// Seven defects in one week (#3693, #3702, #3703 ×2, #3680, #3667, #3697)
/// shared one shape — a metadata probe omitting something a sibling probe a
/// few lines away already did. Three of them were literally the same omission
/// found three times: a member-lookup probe that enumerated
/// <c>BindingFlags.Public</c> only, so a friend assembly's <c>internal</c>
/// member of ONE kind was invisible while the same member of ANOTHER kind
/// resolved fine. Each site looked locally reasonable; only the disagreement
/// between kinds was wrong.
/// </para>
/// <para>
/// So rather than one test per site, this fixture asserts the INVARIANT the
/// sites are supposed to share: across method / property / field / event /
/// indexer, read and write, the answer to "can this compilation see the
/// member?" depends only on the member's accessibility and on whether the
/// declaring assembly named this one in an <c>InternalsVisibleTo</c> — never
/// on the member's kind. It is issue #3705's prevention option (3), and it
/// fails on <c>main</c> for the event, indexer and property/field-write rows
/// while passing for the method and property/field-read rows.
/// </para>
/// <para>
/// The guard rails are half the point: outside a derived type,
/// <c>private</c> and <c>protected</c> stay invisible to a friend, and a
/// non-friend sees neither those nor <c>internal</c>. Derived-type probes below
/// separately assert the CLR family-access rules.
/// </para>
/// </summary>
public sealed class Issue3705MemberKindAccessibilityDifferentialTests
{
    private const string FriendAssemblyName = "Issue3705.Friend";
    private const string StrangerAssemblyName = "Issue3705.Stranger";
    private const string LibraryAssemblyName = "Issue3705.Library";

    /// <summary>
    /// One member of every kind at every accessibility. Indexer accessibility
    /// is discriminated by the index parameter type, since a type may declare
    /// only one indexer per signature.
    /// </summary>
    private const string CSharpLibrarySource = """
        using System;
        using System.Runtime.CompilerServices;

        [assembly: InternalsVisibleTo("Issue3705.Friend")]

        namespace Issue3705.Library;

        public class Surface
        {
            public int PublicField;
            internal int InternalField;
            private int PrivateField;
            protected int ProtectedField;
            protected internal int ProtectedInternalField;
            private protected int PrivateProtectedField;

            public event Action PublicEvent;
            internal event Action InternalEvent;
            private event Action PrivateEvent;
            protected event Action ProtectedEvent;

            public int PublicProperty { get; set; }
            internal int InternalProperty { get; set; }
            private int PrivateProperty { get; set; }
            protected int ProtectedProperty { get; set; }
            protected internal int ProtectedInternalProperty { get; set; }
            private protected int PrivateProtectedProperty { get; set; }
            public int PublicSetterPrivateGetter { private get; set; }

            public int PublicMethod() => 1;
            internal int InternalMethod() => 1;
            private int PrivateMethod() => 1;
            protected int ProtectedMethod() => 1;
            protected internal int ProtectedInternalMethod() => 1;
            private protected int PrivateProtectedMethod() => 1;

            public int this[int index] { get => 0; set { } }
            internal int this[string index] { get => 0; set { } }
            private int this[bool index] { get => 0; set { } }
            protected int this[double index] { get => 0; set { } }

            public int Touch()
                => PrivateField + PrivateProperty + PrivateMethod() + this[true]
                    + (PrivateEvent == null ? 0 : 1);
        }
        """;

    /// <summary>
    /// The differential matrix: member kind × accessibility × friend-vs-not.
    /// Every row's expectation is computed from accessibility and friendship
    /// ALONE — the member kind never appears in the expectation.
    /// </summary>
    /// <returns>The theory rows.</returns>
    public static IEnumerable<object[]> Matrix()
    {
        string[] accessibilities = { "Public", "Internal", "Private", "Protected" };
        string[] kinds =
        {
            "MethodCall",
            "PropertyRead",
            "PropertyWrite",
            "FieldRead",
            "FieldWrite",
            "EventSubscribe",
            "IndexerRead",
            "IndexerWrite",
        };

        foreach (var kind in kinds)
        {
            foreach (var accessibility in accessibilities)
            {
                foreach (var isFriend in new[] { true, false })
                {
                    var visible = accessibility == "Public"
                        || (accessibility == "Internal" && isFriend);
                    yield return new object[] { kind, accessibility, isFriend, visible };
                }
            }
        }
    }

    [Theory]
    [MemberData(nameof(Matrix))]
    public void MemberKinds_Agree_On_FriendAssembly_Visibility(
        string kind,
        string accessibility,
        bool isFriend,
        bool expectedVisible)
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource);
            var consumer = isFriend ? FriendAssemblyName : StrangerAssemblyName;
            var result = CompileGSharp(BuildSource(kind, accessibility, consumer), consumer, libraryPath);

            if (expectedVisible)
            {
                Assert.True(
                    result.Success,
                    $"{kind}/{accessibility}/friend={isFriend} should bind: {Describe(result)}");
            }
            else
            {
                Assert.False(
                    result.Success,
                    $"{kind}/{accessibility}/friend={isFriend} must NOT bind, but it did.");
            }
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    /// <summary>
    /// Inherited-property lookup must test the accessor used by the operation,
    /// not whichever accessor reflection happens to return first.
    /// </summary>
    /// <returns>The derived-member probe cases.</returns>
    public static IEnumerable<object[]> DerivedMemberCases()
    {
        yield return new object[] { "this-protected-read", "let value = this.ProtectedProperty", StrangerAssemblyName, true };
        yield return new object[] { "bare-protected-read", "let value = ProtectedProperty", StrangerAssemblyName, true };
        yield return new object[] { "base-protected-read", "let value = base.ProtectedProperty", StrangerAssemblyName, true };
        yield return new object[] { "this-protected-write", "this.ProtectedProperty = 7", StrangerAssemblyName, true };
        yield return new object[] { "bare-protected-write", "ProtectedProperty = 7", StrangerAssemblyName, true };
        yield return new object[] { "base-protected-write", "base.ProtectedProperty = 7", StrangerAssemblyName, true };
        yield return new object[] { "this-protected-method", "let value = this.ProtectedMethod()", StrangerAssemblyName, true };
        yield return new object[] { "bare-protected-method", "let value = ProtectedMethod()", StrangerAssemblyName, true };
        yield return new object[] { "base-protected-method", "let value = base.ProtectedMethod()", StrangerAssemblyName, true };
        yield return new object[] { "protected-internal-property", "let value = this.ProtectedInternalProperty", StrangerAssemblyName, true };
        yield return new object[] { "protected-internal-field", "let value = this.ProtectedInternalField", StrangerAssemblyName, true };
        yield return new object[] { "protected-internal-method", "let value = this.ProtectedInternalMethod()", StrangerAssemblyName, true };
        yield return new object[] { "this-private-getter-read", "let value = this.PublicSetterPrivateGetter", StrangerAssemblyName, false };
        yield return new object[] { "bare-private-getter-read", "let value = PublicSetterPrivateGetter", StrangerAssemblyName, false };
        yield return new object[] { "base-private-getter-read", "let value = base.PublicSetterPrivateGetter", StrangerAssemblyName, false };
        yield return new object[] { "this-public-setter-write", "this.PublicSetterPrivateGetter = 7", StrangerAssemblyName, true };
        yield return new object[] { "bare-public-setter-write", "PublicSetterPrivateGetter = 7", StrangerAssemblyName, true };
        yield return new object[] { "base-public-setter-write", "base.PublicSetterPrivateGetter = 7", StrangerAssemblyName, true };

        yield return new object[] { "this-friend-internal-property-read", "let value = this.InternalProperty", FriendAssemblyName, true };
        yield return new object[] { "bare-friend-internal-property-read", "let value = InternalProperty", FriendAssemblyName, true };
        yield return new object[] { "base-friend-internal-property-read", "let value = base.InternalProperty", FriendAssemblyName, true };
        yield return new object[] { "this-friend-internal-property-write", "this.InternalProperty = 7", FriendAssemblyName, true };
        yield return new object[] { "bare-friend-internal-property-write", "InternalProperty = 7", FriendAssemblyName, true };
        yield return new object[] { "base-friend-internal-property-write", "base.InternalProperty = 7", FriendAssemblyName, true };
        yield return new object[] { "this-friend-internal-field-read", "let value = this.InternalField", FriendAssemblyName, true };
        yield return new object[] { "bare-friend-internal-field-read", "let value = InternalField", FriendAssemblyName, true };
        yield return new object[] { "this-friend-internal-field-write", "this.InternalField = 7", FriendAssemblyName, true };
        yield return new object[] { "bare-friend-internal-field-write", "InternalField = 7", FriendAssemblyName, true };
        yield return new object[] { "this-friend-internal-method", "let value = this.InternalMethod()", FriendAssemblyName, true };
        yield return new object[] { "bare-friend-internal-method", "let value = InternalMethod()", FriendAssemblyName, true };
        yield return new object[] { "base-friend-internal-method", "let value = base.InternalMethod()", FriendAssemblyName, true };
        yield return new object[] { "friend-private-protected-property", "let value = this.PrivateProtectedProperty", FriendAssemblyName, false };
        yield return new object[] { "friend-private-protected-field", "let value = this.PrivateProtectedField", FriendAssemblyName, false };
        yield return new object[] { "friend-private-protected-method", "let value = this.PrivateProtectedMethod()", FriendAssemblyName, false };

        yield return new object[] { "nonfriend-internal-property-read", "let value = this.InternalProperty", StrangerAssemblyName, false };
        yield return new object[] { "nonfriend-internal-property-write", "this.InternalProperty = 7", StrangerAssemblyName, false };
        yield return new object[] { "nonfriend-internal-field-read", "let value = this.InternalField", StrangerAssemblyName, false };
        yield return new object[] { "nonfriend-internal-field-write", "this.InternalField = 7", StrangerAssemblyName, false };
        yield return new object[] { "nonfriend-internal-method", "let value = this.InternalMethod()", StrangerAssemblyName, false };
        yield return new object[] { "nonfriend-private-protected-property", "let value = this.PrivateProtectedProperty", StrangerAssemblyName, false };
        yield return new object[] { "nonfriend-private-protected-field", "let value = this.PrivateProtectedField", StrangerAssemblyName, false };
        yield return new object[] { "nonfriend-private-protected-method", "let value = this.PrivateProtectedMethod()", StrangerAssemblyName, false };
        yield return new object[] { "private-method", "let value = this.PrivateMethod()", StrangerAssemblyName, false };
    }

    /// <param name="name">The probe name.</param>
    /// <param name="body">The derived method body.</param>
    /// <param name="consumer">The consuming assembly name.</param>
    /// <param name="expectedVisible">Whether the selected member operation is visible.</param>
    [Theory]
    [MemberData(nameof(DerivedMemberCases))]
    public void InheritedMember_Uses_OperationSpecific_Visibility(
        string name,
        string body,
        string consumer,
        bool expectedVisible)
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource);
            var result = CompileGSharp(
                $$"""
                package {{consumer}}
                import Issue3705.Library

                class Derived : Surface {
                    func Probe() {
                        {{body}}
                    }
                }
                """,
                consumer,
                libraryPath);

            Assert.True(
                result.Success == expectedVisible,
                $"{name}: expected visible={expectedVisible}: {Describe(result)}");
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    /// <summary>
    /// Friendship belongs to the member's declaring assembly, not the
    /// immediate imported base through which reflection found it.
    /// </summary>
    [Fact]
    public void InheritedInternalVisibility_Uses_The_DeclaringAssembly()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var friendAncestor = EmitCSharpLibrary(
                directory,
                "Issue3705.FriendAncestor",
                """
                using System.Runtime.CompilerServices;
                [assembly: InternalsVisibleTo("Issue3705.Friend")]
                namespace Issue3705.FriendAncestor;
                public class Ancestor
                {
                    internal int ValueField = 1;
                    internal int ValueProperty => 2;
                }
                """);
            var neutralMiddle = EmitCSharpLibrary(
                directory,
                "Issue3705.NeutralMiddle",
                """
                namespace Issue3705.NeutralMiddle;
                public class Middle : Issue3705.FriendAncestor.Ancestor { }
                """,
                friendAncestor);

            var visible = CompileGSharp(
                """
                package Issue3705.Friend
                import Issue3705.NeutralMiddle
                class Derived : Middle {
                    func Read() int32 -> this.ValueField + this.ValueProperty
                }
                """,
                FriendAssemblyName,
                friendAncestor,
                neutralMiddle);
            Assert.True(visible.Success, Describe(visible));

            var noFriendAncestor = EmitCSharpLibrary(
                directory,
                "Issue3705.NoFriendAncestor",
                """
                namespace Issue3705.NoFriendAncestor;
                public class Ancestor
                {
                    internal int ValueField = 1;
                    internal int ValueProperty => 2;
                }
                """);
            var friendlyMiddle = EmitCSharpLibrary(
                directory,
                "Issue3705.FriendlyMiddle",
                """
                using System.Runtime.CompilerServices;
                [assembly: InternalsVisibleTo("Issue3705.Friend")]
                namespace Issue3705.FriendlyMiddle;
                public class Middle : Issue3705.NoFriendAncestor.Ancestor { }
                """,
                noFriendAncestor);

            var hidden = CompileGSharp(
                """
                package Issue3705.Friend
                import Issue3705.FriendlyMiddle
                class Derived : Middle {
                    func Read() int32 -> this.ValueField + this.ValueProperty
                }
                """,
                FriendAssemblyName,
                noFriendAncestor,
                friendlyMiddle);
            Assert.False(hidden.Success);
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    private static string BuildSource(string kind, string accessibility, string consumer)
    {
        // The index argument selects the overload whose accessibility is under
        // test; each literal converts to exactly one of the four index types.
        var indexArgument = accessibility switch
        {
            "Public" => "1",
            "Internal" => "\"key\"",
            "Private" => "true",
            "Protected" => "1.5",
            _ => throw new ArgumentOutOfRangeException(nameof(accessibility)),
        };

        var body = kind switch
        {
            "MethodCall" => $"    let value = surface.{accessibility}Method()",
            "PropertyRead" => $"    let value = surface.{accessibility}Property",
            "PropertyWrite" => $"    surface.{accessibility}Property = 7",
            "FieldRead" => $"    let value = surface.{accessibility}Field",
            "FieldWrite" => $"    surface.{accessibility}Field = 7",
            "EventSubscribe" => $"    surface.{accessibility}Event += () -> {{ }}",
            "IndexerRead" => $"    let value = surface[{indexArgument}]",
            "IndexerWrite" => $"    surface[{indexArgument}] = 7",
            _ => throw new ArgumentOutOfRangeException(nameof(kind)),
        };

        return $$"""
            package {{consumer}}
            import Issue3705.Library

            func Run() {
                let surface = Surface()
            {{body}}
            }
            """;
    }

    private static string Describe(CompileResult result)
        => string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.Id + ": " + d.Message));

    private static CompileResult CompileGSharp(
        string source,
        string assemblyName,
        params string[] references)
    {
        using var resolver = ReferenceResolver.WithReferences(references);
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

    private static string EmitCSharpLibrary(
        string directory,
        string assemblyName,
        string source,
        params string[] additionalReferences)
    {
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Concat(additionalReferences)
            .Distinct(StringComparer.OrdinalIgnoreCase)
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
            nameof(Issue3705MemberKindAccessibilityDifferentialTests),
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
