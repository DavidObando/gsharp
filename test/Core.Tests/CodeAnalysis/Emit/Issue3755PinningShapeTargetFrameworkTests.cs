// <copyright file="Issue3755PinningShapeTargetFrameworkTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3755 (issue #3705, family 3 — the load-context family; remedy from
/// #3754). The <c>fixed</c> lowering resolved two well-known members off live
/// host <c>typeof</c>s:
/// <c>typeof(System.Runtime.CompilerServices.Unsafe).GetMethods(...)</c> for
/// <c>AsPointer&lt;T&gt;</c>, which every pin form emits, and
/// <c>typeof(string).GetMethod("GetPinnableReference", ...)</c> for the
/// string-pin form. Both answered for the SDK <em>hosting</em> gsc rather than
/// for the framework being compiled against.
/// <para>
/// #3755 ranked both as hygiene because "none of the types involved is
/// plausibly absent from a target framework". Measured against the targeting
/// packs the .NET SDK ships, that ranking does not hold:
/// <see cref="NetStandardDeclaresNeitherPinningMember_ButTheHostDeclaresBoth"/>
/// pins the two facts it missed —
/// <c>System.Runtime.CompilerServices.Unsafe</c> is absent from
/// <c>NETStandard.Library.Ref/2.1.0</c> outright, and
/// <c>String.GetPinnableReference()</c> is absent from it even though
/// <c>System.String</c> is present. The second is invisible to "is the TYPE
/// absent?" reasoning by construction, which is how the ranking missed it.
/// </para>
/// <para>
/// Shaped like <c>Issue3730InterpolatedStringHandlerTargetFrameworkTests</c> and
/// <c>Issue3705LoadContextDifferentialTests</c>: the reflection context never
/// appears on the right-hand side of an expectation. Each row states one answer
/// and it is asserted for the host runtime and every installed
/// <c>Microsoft.NETCore.App.Ref</c> targeting pack alike.
/// </para>
/// </summary>
public class Issue3755PinningShapeTargetFrameworkTests
{
    private const string FixedArraySource = @"package Issue3755
func Head(values []int32) int32 {
    unsafe {
        fixed p *int32 = values {
            return *p
        }
    }
}
Console.WriteLine(Head([]int32{41, 7}) + 1)
";

    private const string FixedStringSource = @"package Issue3755
func FirstChar(s string) char {
    unsafe {
        fixed p *char = s {
            return *p
        }
    }
}
Console.WriteLine(FirstChar(""gsharp""))
";

    /// <summary>
    /// The shape questions the pinning emit asks of the target framework.
    /// </summary>
    public enum Query
    {
        /// <summary>The open <c>Unsafe.AsPointer&lt;T&gt;(ref T)</c> definition's signature.</summary>
        UnsafeAsPointerOpen,

        /// <summary>
        /// <c>AsPointer&lt;T&gt;</c> closed over <c>int</c>. The substituted
        /// parameter must read back as <c>System.Int32&amp;</c>: closing a method
        /// from one reflection context over a type argument from another yields a
        /// <c>MethodBuilderInstantiation</c> whose <c>GetParameters()</c> still
        /// answers the unsubstituted <c>T</c> — the artefact #3752 hit through
        /// <c>MakeGenericType</c> and #3754 through <c>MakeGenericMethod</c>.
        /// </summary>
        UnsafeAsPointerClosedOverInt32,

        /// <summary><c>String.GetPinnableReference()</c>'s signature.</summary>
        StringGetPinnableReference,
    }

    /// <summary>
    /// The differential table: one answer per row, asserted for every closure
    /// that provides the pinning surface at all. The closure is deliberately
    /// absent from the right-hand side.
    /// </summary>
    /// <returns>The xUnit member-data rows.</returns>
    public static TheoryData<Query, string> ShapeRows() => new()
    {
        { Query.UnsafeAsPointerOpen, "System.Void*(T&)" },
        { Query.UnsafeAsPointerClosedOverInt32, "System.Void*(System.Int32&)" },
        { Query.StringGetPinnableReference, "System.Char&()" },
    };

    /// <summary>
    /// The invariant: the pinning surface is a property of the referenced
    /// framework, and every framework that provides it provides the same shape —
    /// so the answer must never depend on which reflection context the
    /// <see cref="Type"/> came from.
    /// </summary>
    /// <param name="query">The shape question.</param>
    /// <param name="expected">The single expected answer, for every closure.</param>
    [Theory]
    [MemberData(nameof(ShapeRows))]
    public void SamePinningShape_ForHostRuntime_AndEveryTargetingPack(Query query, string expected)
    {
        var contexts = 0;
        foreach (var (label, resolver) in PinningCapableClosures())
        {
            using (resolver)
            {
                Assert.Equal(expected, Ask(query, label, resolver));
                contexts++;
            }
        }

        // Anti-vacuity: the host runtime alone would let every row pass while
        // proving nothing about a target framework, so require at least one
        // MetadataLoadContext closure to have participated.
        Assert.True(contexts >= 2, $"expected the host closure plus at least one targeting pack, saw {contexts}");
    }

    /// <summary>
    /// Every resolved member must belong to the closure that resolved it. This
    /// is the property that was violated: on <c>main</c> both members came off
    /// the host's <c>System.Private.CoreLib</c> no matter which framework was
    /// referenced.
    /// </summary>
    [Fact]
    public void ResolvedPinningMembers_BelongToTheReferencedClosure()
    {
        var sawMetadataLoadContext = false;
        foreach (var (label, resolver) in PinningCapableClosures())
        {
            using (resolver)
            {
                var asPointer = AsPointerOrFail(label, resolver);
                var getPinnableReference = GetPinnableReferenceOrFail(label, resolver);

                // Module.Assembly rather than DeclaringType.Assembly: it asks the
                // same question without a nullable hop (ADR-0155).
                foreach (var member in new MethodInfo[] { asPointer, getPinnableReference })
                {
                    var assembly = member.Module.Assembly;
                    if (ReferenceEquals(assembly, typeof(object).Assembly))
                    {
                        continue;
                    }

                    sawMetadataLoadContext = true;
                    Assert.NotEqual("System.Private.CoreLib", assembly.GetName().Name);
                }
            }
        }

        Assert.True(sawMetadataLoadContext, "no targeting pack participated; the differential is vacuous");
    }

    /// <summary>
    /// The anti-vacuity row that carries the whole severity argument, and the
    /// two facts #3755's ranking missed. The host declares both pinning members;
    /// <c>NETStandard.Library.Ref/2.1.0</c> declares neither — and the second
    /// absence is a MEMBER on a type that is present, which no amount of
    /// "is the type absent?" reasoning or #3729 type projection can see.
    /// </summary>
    [Fact]
    public void NetStandardDeclaresNeitherPinningMember_ButTheHostDeclaresBoth()
    {
        using (var host = ReferenceResolver.Default())
        {
            Assert.True(PinningShapes.TryGetUnsafeAsPointer(host, out _));
            Assert.True(PinningShapes.TryGetStringGetPinnableReference(CoreStringOf(host), out _));
        }

        using var netStandard = NetStandardClosure();

        // The type is absent outright — #3730's shape exactly.
        Assert.False(netStandard.TryResolveType(PinningShapes.UnsafeTypeFullName, out _));
        Assert.False(PinningShapes.TryGetUnsafeAsPointer(netStandard, out _));

        // The type is PRESENT and the member is absent. #3729's GetTypeReference
        // projection is a type-level repair and cannot reach this at all.
        Assert.True(netStandard.TryResolveType("System.String", out _));
        Assert.False(PinningShapes.TryGetStringGetPinnableReference(CoreStringOf(netStandard), out _));
    }

    /// <summary>
    /// The end-to-end half, and the half that fails on <c>main</c>: what the
    /// compiled assembly actually references. A closure that provides the
    /// pinning surface must produce <c>TypeRef</c>s scoped to <em>that
    /// closure's</em> assemblies and must never mention the host's
    /// <c>System.Private.CoreLib</c>; a closure that does not must produce
    /// GS0546 rather than an assembly.
    /// </summary>
    [Fact]
    public void EmitTargetsTheReferencedFrameworksPinningMembers()
    {
        var packs = 0;
        foreach (var (label, resolver) in TargetingPackClosures())
        {
            using (resolver)
            {
                foreach (var source in new[] { FixedArraySource, FixedStringSource })
                {
                    var (diagnostics, image) = Compile(resolver, source);
                    Assert.DoesNotContain(diagnostics, d => d.Id == "GS0546");

                    var (assemblyRefs, unsafeScopes) = ReadUnsafeReferences(
                        Required(image, $"an emitted assembly for closure '{label}'"));

                    // Anti-vacuity: the fixture must really have emitted a pin,
                    // otherwise "no leaked reference" is trivially satisfied by
                    // an assembly that references nothing.
                    Assert.Equal("System.Runtime", Assert.Single(unsafeScopes));

                    Assert.DoesNotContain("System.Private.CoreLib", assemblyRefs);
                }

                packs++;
            }
        }

        Assert.True(packs >= 1, "no Microsoft.NETCore.App.Ref targeting pack was available");

        // The pinning-less target. On main both of these compiled successfully:
        // the array form emitted a TypeRef into the host's
        // System.Private.CoreLib, and the string form emitted a MemberRef
        // naming a method netstandard2.1 does not declare.
        using var netStandard = NetStandardClosure();

        var (arrayDiagnostics, arrayImage) = Compile(netStandard, FixedArraySource);
        Assert.Contains(
            PinningShapes.UnsafeAsPointerSignature,
            Assert.Single(arrayDiagnostics, d => d.Id == "GS0546").Message,
            StringComparison.Ordinal);
        Assert.Null(arrayImage);

        var (stringDiagnostics, stringImage) = Compile(netStandard, FixedStringSource);
        Assert.Contains(
            PinningShapes.StringGetPinnableReferenceSignature,
            Assert.Single(stringDiagnostics, d => d.Id == "GS0546").Message,
            StringComparison.Ordinal);
        Assert.Null(stringImage);
    }

    /// <summary>
    /// Executes the emitted code. Binding cleanly with zero diagnostics is not
    /// evidence that the emitted <c>MethodSpec</c> is right: closing
    /// <c>AsPointer&lt;T&gt;</c> across reflection contexts produces a method
    /// whose parameters read back unsubstituted, and an emit built on that can
    /// still verify, load, and then fault at the first call. Only running it
    /// settles the question.
    /// </summary>
    [Fact]
    public void EmittedPinsExecuteAgainstTheHostRuntime()
    {
        Assert.Equal("42", Run(FixedArraySource, nameof(FixedArraySource)));
        Assert.Equal("g", Run(FixedStringSource, nameof(FixedStringSource)));
    }

    private static string Ask(Query query, string label, ReferenceResolver resolver) => query switch
    {
        Query.UnsafeAsPointerOpen => Signature(AsPointerOrFail(label, resolver)),
        Query.UnsafeAsPointerClosedOverInt32 => Signature(
            PinningShapes.CloseOver(AsPointerOrFail(label, resolver), typeof(int))),
        Query.StringGetPinnableReference => Signature(GetPinnableReferenceOrFail(label, resolver)),
        _ => throw new ArgumentOutOfRangeException(nameof(query)),
    };

    /// <summary>
    /// Resolves <c>Unsafe.AsPointer&lt;T&gt;</c> or fails the test naming the
    /// closure. Consuming the <c>[NotNullWhen(true)]</c> annotation is the
    /// narrowing form of the assertion, so no null-forgiving operator is needed
    /// (ADR-0155).
    /// </summary>
    /// <param name="label">The closure's label, for the failure message.</param>
    /// <param name="resolver">The reference closure.</param>
    /// <returns>The open generic definition.</returns>
    private static MethodInfo AsPointerOrFail(string label, ReferenceResolver resolver)
        => PinningShapes.TryGetUnsafeAsPointer(resolver, out var asPointer)
            ? asPointer
            : throw new Xunit.Sdk.XunitException(
                $"closure '{label}' should declare {PinningShapes.UnsafeAsPointerSignature}");

    private static MethodInfo GetPinnableReferenceOrFail(string label, ReferenceResolver resolver)
        => PinningShapes.TryGetStringGetPinnableReference(CoreStringOf(resolver), out var method)
            ? method
            : throw new Xunit.Sdk.XunitException(
                $"closure '{label}' should declare {PinningShapes.StringGetPinnableReferenceSignature}");

    /// <summary>
    /// The closure's <c>System.String</c> — what <c>EmitContext.CoreStringType</c>
    /// resolves to for a compilation against that closure.
    /// </summary>
    /// <param name="resolver">The reference closure.</param>
    /// <returns>The target framework's string type.</returns>
    private static Type CoreStringOf(ReferenceResolver resolver)
        => resolver.TryResolveType("System.String", out var stringType)
            ? stringType
            : throw new Xunit.Sdk.XunitException("every closure declares System.String");

    private static T Required<T>(T? value, string what)
        where T : class
        => value ?? throw new Xunit.Sdk.XunitException($"expected {what}, but it was null");

    private static string Signature(MethodInfo method)
        => Name(method.ReturnType)
           + "(" + string.Join(", ", method.GetParameters().Select(p => Name(p.ParameterType))) + ")";

    private static string Name(Type type) => type.FullName ?? type.Name;

    private static (IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> Diagnostics, byte[]? Image) Compile(
        ReferenceResolver resolver, string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(resolver, tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        return (result.Diagnostics, result.Success ? peStream.ToArray() : null);
    }

    private static string Run(string source, string contextName)
    {
        using var resolver = ReferenceResolver.Default();
        var (diagnostics, image) = Compile(resolver, source);
        Assert.True(
            image != null,
            "emit diagnostics:\n  " + string.Join("\n  ", diagnostics.Select(d => d.Id + ": " + d.Message)));

        var loadContext = new AssemblyLoadContext(contextName + "-3755", isCollectible: true);
        try
        {
            using var peStream = new MemoryStream(Required(image, "an emitted assembly"));
            var assembly = loadContext.LoadFromStream(peStream);
            var programType = Required(
                assembly.GetTypes().FirstOrDefault(t => t.Name == "<Program>"),
                "the synthesized <Program> type");
            var entry = Required(
                programType.GetMethod("<Main>$", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic),
                "the synthesized entry point");

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString().Trim();
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static (IReadOnlyList<string> AssemblyRefs, IReadOnlyList<string> UnsafeScopes) ReadUnsafeReferences(byte[] image)
    {
        using var peReader = new PEReader(ImmutableArray.Create(image));
        var metadata = PEReaderExtensions.GetMetadataReader(peReader);

        var assemblyRefs = metadata.AssemblyReferences
            .Select(handle => metadata.GetString(metadata.GetAssemblyReference(handle).Name))
            .ToList();

        var unsafeScopes = new List<string>();
        foreach (var handle in metadata.TypeReferences)
        {
            var typeRef = metadata.GetTypeReference(handle);
            var name = metadata.GetString(typeRef.Namespace) + "." + metadata.GetString(typeRef.Name);
            if (name != PinningShapes.UnsafeTypeFullName)
            {
                continue;
            }

            unsafeScopes.Add(typeRef.ResolutionScope.Kind == HandleKind.AssemblyReference
                ? metadata.GetString(metadata.GetAssemblyReference((AssemblyReferenceHandle)typeRef.ResolutionScope).Name)
                : typeRef.ResolutionScope.Kind.ToString());
        }

        return (assemblyRefs, unsafeScopes);
    }

    private static IEnumerable<(string Label, ReferenceResolver Resolver)> PinningCapableClosures()
    {
        yield return ("host runtime", ReferenceResolver.Default());
        foreach (var closure in TargetingPackClosures())
        {
            yield return closure;
        }
    }

    private static IEnumerable<(string Label, ReferenceResolver Resolver)> TargetingPackClosures()
    {
        var packsRoot = Path.Combine(DotnetRoot(), "packs", "Microsoft.NETCore.App.Ref");
        if (!Directory.Exists(packsRoot))
        {
            yield break;
        }

        foreach (var versionDirectory in Directory.EnumerateDirectories(packsRoot).OrderBy(d => d, StringComparer.Ordinal))
        {
            var refDirectory = Directory
                .EnumerateDirectories(Path.Combine(versionDirectory, "ref"))
                .OrderBy(d => d, StringComparer.Ordinal)
                .LastOrDefault();
            if (refDirectory == null)
            {
                continue;
            }

            yield return (
                Path.GetFileName(versionDirectory),
                ReferenceResolver.WithReferences(Directory.EnumerateFiles(refDirectory, "*.dll")));
        }
    }

    /// <summary>
    /// A reference closure for a target framework that provides neither pinning
    /// member. <c>NETStandard.Library.Ref</c> ships inside the .NET SDK, so this
    /// needs no extra install.
    /// </summary>
    /// <returns>The netstandard reference closure.</returns>
    private static ReferenceResolver NetStandardClosure()
    {
        var packRoot = Path.Combine(DotnetRoot(), "packs", "NETStandard.Library.Ref");
        var refDirectory = Directory.Exists(packRoot)
            ? Directory
                .EnumerateDirectories(packRoot)
                .OrderBy(d => d, StringComparer.Ordinal)
                .Select(version => Directory.EnumerateDirectories(Path.Combine(version, "ref")).OrderBy(d => d, StringComparer.Ordinal).LastOrDefault())
                .LastOrDefault(d => d != null)
            : null;

        if (refDirectory == null)
        {
            throw new Xunit.Sdk.XunitException(
                $"prerequisite missing: no NETStandard.Library.Ref targeting pack under '{packRoot}'");
        }

        return ReferenceResolver.WithReferences(Directory.EnumerateFiles(refDirectory, "*.dll"));
    }

    private static string DotnetRoot()
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
        return string.IsNullOrEmpty(runtimeDirectory)
            ? throw new Xunit.Sdk.XunitException("prerequisite missing: host runtime directory not resolvable")
            : Directory.GetParent(runtimeDirectory)?.Parent?.Parent?.FullName
              ?? throw new Xunit.Sdk.XunitException("prerequisite missing: dotnet root not resolvable");
    }
}
