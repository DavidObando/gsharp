// <copyright file="Issue3730InterpolatedStringHandlerTargetFrameworkTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering;

/// <summary>
/// Issue #3730 (issue #3705, family 3 — the load-context family).
/// <c>InterpolatedStringHandlerLowerer</c> held
/// <c>static readonly Type HandlerType = typeof(DefaultInterpolatedStringHandler)</c>
/// and reflected the constructor, <c>AppendLiteral</c>, <c>ToStringAndClear</c>
/// and the four <c>AppendFormatted&lt;T&gt;</c> overloads off it — a live host
/// <c>typeof</c> that answers for the SDK <em>hosting</em> gsc rather than for
/// the framework being compiled against.
/// <para>
/// Shaped like <c>Issue3705LoadContextDifferentialTests</c>: the reflection
/// context never appears on the right-hand side of an expectation. Each row
/// states one answer about the handler surface, and it is asserted for every
/// reference closure that provides a handler at all — the host runtime and
/// every installed <c>Microsoft.NETCore.App.Ref</c> targeting pack. The
/// <see cref="EmitTargetsTheReferencedFrameworksHandler"/> rows are the
/// end-to-end half and are what fails on <c>main</c>: compiled against a
/// <c>netstandard2.x</c> closure, which declares no handler at all, gsc used to
/// lower onto the host's handler regardless and emit an assembly carrying a
/// <c>TypeRef</c> scoped to <c>System.Private.CoreLib</c> — the exact leak
/// #3729 closed on the paths it could see — while reporting success.
/// </para>
/// <para>
/// Note for future readers: the differential-conformance harness (#3717) will
/// not catch this family. Both of its modes run on the same host, so a
/// host-versus-target divergence is invisible to it by construction.
/// </para>
/// </summary>
public class Issue3730InterpolatedStringHandlerTargetFrameworkTests
{
    private const string InterpolationSource = @"package Issue3730
let count = 3
let label = ""value""
let text = ""$label = $count""

class Formatter {
    func Describe(label string, count int32) string {
        return ""$label = $count""
    }
}
";

    /// <summary>
    /// The shape questions the lowering asks of the handler before emitting a
    /// call to it.
    /// </summary>
    public enum Query
    {
        /// <summary>The <c>(literalLength, formattedCount)</c> constructor's parameter list.</summary>
        Constructor,

        /// <summary><c>AppendLiteral</c>'s return type and parameter list.</summary>
        AppendLiteral,

        /// <summary><c>ToStringAndClear</c>'s return type and parameter list.</summary>
        ToStringAndClear,

        /// <summary>The bare <c>AppendFormatted&lt;T&gt;(T)</c> overload.</summary>
        AppendFormattedValue,

        /// <summary>The <c>AppendFormatted&lt;T&gt;(T, int)</c> overload.</summary>
        AppendFormattedAlign,

        /// <summary>The <c>AppendFormatted&lt;T&gt;(T, string)</c> overload.</summary>
        AppendFormattedFormat,

        /// <summary>The <c>AppendFormatted&lt;T&gt;(T, int, string)</c> overload.</summary>
        AppendFormattedAlignFormat,

        /// <summary>
        /// <c>AppendFormatted&lt;T&gt;</c> closed over a <c>string</c> hole. The
        /// substituted parameter must read back as <c>System.String</c>: closing
        /// a method from one reflection context over a type argument from
        /// another yields a <c>MethodBuilderInstantiation</c> whose
        /// <c>GetParameters()</c> still answers the unsubstituted <c>T</c>, the
        /// same cross-context artefact #3752 hit through <c>MakeGenericType</c>.
        /// </summary>
        ClosedOverString,
    }

    /// <summary>
    /// The differential table: one answer per row, asserted for every reference
    /// closure that declares a handler. The closure is deliberately absent from
    /// the right-hand side.
    /// </summary>
    /// <returns>The xUnit member-data rows.</returns>
    public static TheoryData<Query, string> ShapeRows()
    {
        var data = new TheoryData<Query, string>
        {
            { Query.Constructor, "(System.Int32, System.Int32)" },
            { Query.AppendLiteral, "System.Void(System.String)" },
            { Query.ToStringAndClear, "System.String()" },
            { Query.AppendFormattedValue, "System.Void(T)" },
            { Query.AppendFormattedAlign, "System.Void(T, System.Int32)" },
            { Query.AppendFormattedFormat, "System.Void(T, System.String)" },
            { Query.AppendFormattedAlignFormat, "System.Void(T, System.Int32, System.String)" },
            { Query.ClosedOverString, "System.Void(System.String)" },
        };

        return data;
    }

    /// <summary>
    /// The invariant: the handler surface the lowering targets is a property of
    /// the referenced framework, and every framework that declares the handler
    /// declares the same shape — so the answer must never depend on which
    /// reflection context the <see cref="Type"/> came from.
    /// </summary>
    /// <param name="query">The shape question.</param>
    /// <param name="expected">The single expected answer, for every closure.</param>
    [Theory]
    [MemberData(nameof(ShapeRows))]
    public void SameHandlerShape_ForHostRuntime_AndEveryTargetingPack(Query query, string expected)
    {
        var contexts = 0;
        foreach (var (label, resolver) in HandlerBearingClosures())
        {
            using (resolver)
            {
                Assert.Equal(expected, Ask(query, ResolveOrFail(label, resolver)));
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
    /// is the property that was actually violated: on <c>main</c> the members
    /// came off the host's <c>System.Private.CoreLib</c> no matter which
    /// framework was referenced.
    /// </summary>
    [Fact]
    public void ResolvedHandlerMembers_BelongToTheReferencedClosure()
    {
        var sawMetadataLoadContext = false;
        foreach (var (label, resolver) in HandlerBearingClosures())
        {
            using (resolver)
            {
                var shape = ResolveOrFail(label, resolver);

                // MemberInfo.Module.Assembly rather than DeclaringType.Assembly:
                // it asks the same question without a nullable hop (ADR-0155).
                var handlerAssembly = shape.HandlerType.Assembly;
                Assert.Same(handlerAssembly, shape.Constructor.Module.Assembly);
                Assert.Same(handlerAssembly, shape.AppendLiteral.Module.Assembly);
                Assert.Same(handlerAssembly, shape.ToStringAndClear.Module.Assembly);
                Assert.Same(handlerAssembly, AppendFormattedValueOf(shape).Module.Assembly);

                if (!ReferenceEquals(handlerAssembly, typeof(object).Assembly))
                {
                    sawMetadataLoadContext = true;
                    Assert.NotEqual(
                        "System.Private.CoreLib",
                        handlerAssembly.GetName().Name);
                }
            }
        }

        Assert.True(sawMetadataLoadContext, "no targeting pack participated; the differential is vacuous");
    }

    /// <summary>
    /// The end-to-end half, and the half that fails on <c>main</c>: what the
    /// compiled assembly actually references. A closure that declares the
    /// handler must produce a <c>TypeRef</c> scoped to <em>that closure's</em>
    /// <c>System.Runtime</c> and must never mention the host's
    /// <c>System.Private.CoreLib</c>; a closure that declares no handler must
    /// fall back to target-compatible composite formatting.
    /// </summary>
    [Fact]
    public void EmitTargetsTheReferencedFrameworksHandler()
    {
        var packs = 0;
        foreach (var (label, resolver) in TargetingPackClosures())
        {
            using (resolver)
            {
                var (diagnostics, image) = Compile(resolver);

                Assert.DoesNotContain(diagnostics, d => d.Id == "GS0545");

                var (assemblyRefs, handlerScopes) = ReadHandlerReferences(
                    Required(image, $"an emitted assembly for closure '{label}'"));

                // Anti-vacuity: the fixture must really have lowered an
                // interpolation, otherwise "no leaked reference" is trivially
                // satisfied by an assembly that references nothing.
                Assert.Equal("System.Runtime", Assert.Single(handlerScopes));

                Assert.DoesNotContain("System.Private.CoreLib", assemblyRefs);
                packs++;
            }
        }

        Assert.True(packs >= 1, "no Microsoft.NETCore.App.Ref targeting pack was available");

        // The handler-less target uses String.Format rather than failing or
        // lowering onto the host's handler.
        using var netStandard = NetStandardClosure();
        var (netStandardDiagnostics, netStandardImage) = Compile(netStandard);

        Assert.DoesNotContain(netStandardDiagnostics, d => d.Id == "GS0545");
        var netStandardBytes = Required(netStandardImage, "an emitted assembly for netstandard");
        var (_, netStandardHandlerScopes) = ReadHandlerReferences(netStandardBytes);
        Assert.Empty(netStandardHandlerScopes);
        Assert.NotEqual("System.Private.CoreLib", Assert.Single(ReadStringFormatScopes(netStandardBytes)));
        Assert.Equal("value = 3", ExecuteDescribe(netStandardBytes));
    }

    /// <summary>
    /// The hazard pinned directly, and the proof that the netstandard closure is
    /// a genuine handler-less target rather than a fixture artefact: the host
    /// declares the handler, that closure does not, and only a target-resolved
    /// probe can tell the two apart.
    /// </summary>
    [Fact]
    public void HostFallbackHandler_IsObservableAndNotATargetHandler()
    {
        Assert.NotNull(Type.GetType(DefaultInterpolatedStringHandlerShape.HandlerTypeFullName));

        using var netStandard = NetStandardClosure();
        Assert.True(netStandard.TryResolveType(DefaultInterpolatedStringHandlerShape.HandlerTypeFullName, out var handler));
        Assert.True(
            netStandard.IsHostFallback(handler),
            $"resolved from unexpected assembly '{handler.Assembly.FullName}'");
        Assert.False(DefaultInterpolatedStringHandlerShape.TryResolve(netStandard, out _, out var missing));
        Assert.Equal(DefaultInterpolatedStringHandlerShape.HandlerTypeFullName, missing);
    }

    private static string Ask(Query query, DefaultInterpolatedStringHandlerShape shape) => query switch
    {
        Query.Constructor => "(" + string.Join(", ", shape.Constructor.GetParameters().Select(p => Name(p.ParameterType))) + ")",
        Query.AppendLiteral => Signature(shape.AppendLiteral),
        Query.ToStringAndClear => Signature(shape.ToStringAndClear),
        Query.AppendFormattedValue => Signature(shape.AppendFormattedValue),
        Query.AppendFormattedAlign => Signature(shape.AppendFormattedAlign),
        Query.AppendFormattedFormat => Signature(shape.AppendFormattedFormat),
        Query.AppendFormattedAlignFormat => Signature(shape.AppendFormattedAlignFormat),
        Query.ClosedOverString => Signature(shape.CloseAppendFormatted(AppendFormattedValueOf(shape), typeof(string))),
        _ => throw new ArgumentOutOfRangeException(nameof(query)),
    };

    /// <summary>
    /// Resolves the handler surface from <paramref name="resolver"/> or fails the
    /// test naming the closure. The narrowing form of the assertion: because
    /// <c>TryResolve</c> is annotated <c>[NotNullWhen(true)]</c>, callers get a
    /// non-nullable shape without a null-forgiving operator (ADR-0155).
    /// </summary>
    /// <param name="label">The closure's label, for the failure message.</param>
    /// <param name="resolver">The reference closure to resolve against.</param>
    /// <returns>The resolved handler surface.</returns>
    private static DefaultInterpolatedStringHandlerShape ResolveOrFail(string label, ReferenceResolver resolver)
        => DefaultInterpolatedStringHandlerShape.TryResolve(resolver, out var shape, out var missing)
            ? shape
            : throw new Xunit.Sdk.XunitException(
                $"closure '{label}' should declare the handler, but '{missing}' was missing");

    /// <summary>
    /// The bare <c>AppendFormatted&lt;T&gt;(T)</c> overload, which every closure
    /// under test is asserted to declare by the <see cref="Query.AppendFormattedValue"/>
    /// row. Fails rather than forgiving the null, so the absence is reported as
    /// a missing overload instead of a <see cref="NullReferenceException"/>.
    /// </summary>
    /// <param name="shape">The resolved handler surface.</param>
    /// <returns>The overload.</returns>
    private static System.Reflection.MethodInfo AppendFormattedValueOf(DefaultInterpolatedStringHandlerShape shape)
        => Required(
            shape.AppendFormattedValue,
            $"{DefaultInterpolatedStringHandlerShape.HandlerTypeFullName}.AppendFormatted<T>(T)");

    /// <summary>
    /// Fails the test when <paramref name="value"/> is null, returning it
    /// non-nullable otherwise.
    /// </summary>
    /// <typeparam name="T">The value's type.</typeparam>
    /// <param name="value">The possibly-null value.</param>
    /// <param name="what">What was expected, for the failure message.</param>
    /// <returns>The non-null value.</returns>
    private static T Required<T>(T? value, string what)
        where T : class
        => value ?? throw new Xunit.Sdk.XunitException($"expected {what}, but it was null");

    private static string Signature(System.Reflection.MethodInfo? method)
        => method == null
            ? "<none>"
            : Name(method.ReturnType) + "(" + string.Join(", ", method.GetParameters().Select(p => Name(p.ParameterType))) + ")";

    private static string Name(Type type) => type.FullName ?? type.Name;

    private static (IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> Diagnostics, byte[]? Image) Compile(ReferenceResolver resolver)
    {
        var tree = SyntaxTree.Parse(SourceText.From(InterpolationSource));
        var compilation = new Compilation(resolver, tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        return (result.Diagnostics, result.Success ? peStream.ToArray() : null);
    }

    private static (IReadOnlyList<string> AssemblyRefs, IReadOnlyList<string> HandlerScopes) ReadHandlerReferences(byte[] image)
    {
        using var peReader = new PEReader(System.Collections.Immutable.ImmutableArray.Create(image));
        var metadata = PEReaderExtensions.GetMetadataReader(peReader);

        var assemblyRefs = metadata.AssemblyReferences
            .Select(handle => metadata.GetString(metadata.GetAssemblyReference(handle).Name))
            .ToList();

        var handlerScopes = new List<string>();
        foreach (var handle in metadata.TypeReferences)
        {
            var typeRef = metadata.GetTypeReference(handle);
            var name = metadata.GetString(typeRef.Namespace) + "." + metadata.GetString(typeRef.Name);
            if (name != DefaultInterpolatedStringHandlerShape.HandlerTypeFullName)
            {
                continue;
            }

            handlerScopes.Add(typeRef.ResolutionScope.Kind == HandleKind.AssemblyReference
                ? metadata.GetString(metadata.GetAssemblyReference((AssemblyReferenceHandle)typeRef.ResolutionScope).Name)
                : typeRef.ResolutionScope.Kind.ToString());
        }

        return (assemblyRefs, handlerScopes);
    }

    private static IReadOnlyList<string> ReadStringFormatScopes(byte[] image)
    {
        using var peReader = new PEReader(System.Collections.Immutable.ImmutableArray.Create(image));
        var metadata = PEReaderExtensions.GetMetadataReader(peReader);
        var scopes = new List<string>();
        foreach (var handle in metadata.MemberReferences)
        {
            var member = metadata.GetMemberReference(handle);
            if (metadata.GetString(member.Name) != "Format" || member.Parent.Kind != HandleKind.TypeReference)
            {
                continue;
            }

            var parent = metadata.GetTypeReference((TypeReferenceHandle)member.Parent);
            if (metadata.GetString(parent.Namespace) != "System" || metadata.GetString(parent.Name) != "String")
            {
                continue;
            }

            scopes.Add(parent.ResolutionScope.Kind == HandleKind.AssemblyReference
                ? metadata.GetString(metadata.GetAssemblyReference((AssemblyReferenceHandle)parent.ResolutionScope).Name)
                : parent.ResolutionScope.Kind.ToString());
        }

        return scopes;
    }

    private static string ExecuteDescribe(byte[] image)
    {
        var context = new AssemblyLoadContext($"gs3769-{Guid.NewGuid():N}", isCollectible: true);
        try
        {
            using var stream = new MemoryStream(image);
            var assembly = context.LoadFromStream(stream);
            var formatter = Required(
                assembly.GetType("Issue3730.Formatter", throwOnError: true),
                "the emitted Formatter type");
            var instance = Required(Activator.CreateInstance(formatter), "a Formatter instance");
            var describe = Required(
                formatter.GetMethod("Describe", BindingFlags.Public | BindingFlags.Instance),
                "Formatter.Describe");
            return Assert.IsType<string>(describe.Invoke(instance, new object[] { "value", 3 }));
        }
        finally
        {
            context.Unload();
        }
    }

    /// <summary>
    /// The host runtime plus every installed targeting pack — every closure that
    /// is expected to declare a handler.
    /// </summary>
    /// <returns>Labelled resolvers; the caller disposes each.</returns>
    private static IEnumerable<(string Label, ReferenceResolver Resolver)> HandlerBearingClosures()
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
    /// A reference closure for a target framework that declares no
    /// <c>DefaultInterpolatedStringHandler</c> at all. <c>NETStandard.Library.Ref</c>
    /// ships inside the .NET SDK, so this needs no extra install.
    /// </summary>
    /// <returns>The netstandard reference closure.</returns>
    private static ReferenceResolver NetStandardClosure()
    {
        var refDirectory = typeof(Issue3730InterpolatedStringHandlerTargetFrameworkTests).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "NetStandard20ReferenceDirectory")
            .Value;

        if (string.IsNullOrEmpty(refDirectory) || !Directory.Exists(refDirectory))
        {
            throw new Xunit.Sdk.XunitException(
                $"prerequisite missing: netstandard2.0 reference directory '{refDirectory}'");
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
