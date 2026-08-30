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
/// The guard rails are half the point: <c>private</c> and <c>protected</c>
/// must stay invisible to a friend, and a non-friend must see neither those
/// nor <c>internal</c>.
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

            public event Action PublicEvent;
            internal event Action InternalEvent;
            private event Action PrivateEvent;
            protected event Action ProtectedEvent;

            public int PublicProperty { get; set; }
            internal int InternalProperty { get; set; }
            private int PrivateProperty { get; set; }
            protected int ProtectedProperty { get; set; }

            public int PublicMethod() => 1;
            internal int InternalMethod() => 1;
            private int PrivateMethod() => 1;
            protected int ProtectedMethod() => 1;

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
