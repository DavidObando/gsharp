// <copyright file="Issue3730InterpolatedStringHandlerTargetFrameworkTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit
import Xunit.Sdk

/// Issue #3730 (issue #3705, family 3 — the load-context family).
/// `InterpolatedStringHandlerLowerer` held
/// `static readonly Type HandlerType = typeof(DefaultInterpolatedStringHandler)`
/// and reflected the constructor, `AppendLiteral`, `ToStringAndClear`
/// and the four `AppendFormatted<T>` overloads off it — a live host
/// `typeof` that answers for the SDK <em>hosting</em> gsc rather than for
/// the framework being compiled against.
///
/// Shaped like `Issue3705LoadContextDifferentialTests`: the reflection
/// context never appears on the right-hand side of an expectation. Each row
/// states one answer about the handler surface, and it is asserted for every
/// reference closure that provides a handler at all — the host runtime and
/// every installed `Microsoft.NETCore.App.Ref` targeting pack. The
/// (cref:EmitTargetsTheReferencedFrameworksHandler) rows are the
/// end-to-end half and are what fails on `main`: compiled against a
/// `netstandard2.x` closure, which declares no handler at all, gsc used to
/// lower onto the host's handler regardless and emit an assembly carrying a
/// `TypeRef` scoped to `System.Private.CoreLib` — the exact leak
/// #3729 closed on the paths it could see — while reporting success.
///
/// Note for future readers: the differential-conformance harness (#3717) will
/// not catch this family. Both of its modes run on the same host, so a
/// host-versus-target divergence is invisible to it by construction.
open class Issue3730InterpolatedStringHandlerTargetFrameworkTests {
    /// The shape questions the lowering asks of the handler before emitting a
    /// call to it.
    enum Query {
        Constructor,
        AppendLiteral,
        ToStringAndClear,
        AppendFormattedValue,
        AppendFormattedAlign,
        AppendFormattedFormat,
        AppendFormattedAlignFormat,
        ClosedOverString
    }

    /// The invariant: the handler surface the lowering targets is a property of
    /// the referenced framework, and every framework that declares the handler
    /// declares the same shape — so the answer must never depend on which
    /// reflection context the (cref:Type) came from.
    /// @param query The shape question.
    /// @param expected The single expected answer, for every closure.
    @Theory
    @MemberData("ShapeRows")
    func SameHandlerShape_ForHostRuntime_AndEveryTargetingPack(
        query Issue3730InterpolatedStringHandlerTargetFrameworkTests.Query,
        expected string
    ) {
        var contexts = 0
        for (label, resolver) in HandlerBearingClosures() {
            {
                using let _ = resolver
                Assert.Equal(expected, Ask(query, ResolveOrFail(label, resolver)))
                contexts++
            }
        }
        // Anti-vacuity: the host runtime alone would let every row pass while
        // proving nothing about a target framework, so require at least one
        // MetadataLoadContext closure to have participated.
        Assert.True(contexts >= 2, "expected the host closure plus at least one targeting pack, saw $contexts")
    }

    /// Every resolved member must belong to the closure that resolved it. This
    /// is the property that was actually violated: on `main` the members
    /// came off the host's `System.Private.CoreLib` no matter which
    /// framework was referenced.
    @Fact
    func ResolvedHandlerMembers_BelongToTheReferencedClosure() {
        var sawMetadataLoadContext = false
        for (label, resolver) in HandlerBearingClosures() {
            {
                using let _ = resolver
                let shape = ResolveOrFail(label, resolver)
                // MemberInfo.Module.Assembly rather than DeclaringType.Assembly:
                // it asks the same question without a nullable hop (ADR-0155).
                let handlerAssembly = shape.HandlerType.Assembly
                Assert.Same(handlerAssembly, shape.Constructor.Module.Assembly)
                Assert.Same(handlerAssembly, shape.AppendLiteral.Module.Assembly)
                Assert.Same(handlerAssembly, shape.ToStringAndClear.Module.Assembly)
                Assert.Same(handlerAssembly, AppendFormattedValueOf(shape).Module.Assembly)
                if !object.ReferenceEquals(handlerAssembly, typeof(object).Assembly) {
                    sawMetadataLoadContext = true
                    Assert.NotEqual("System.Private.CoreLib", handlerAssembly.GetName().Name)
                }
            }
        }
        Assert.True(sawMetadataLoadContext, "no targeting pack participated; the differential is vacuous")
    }

    /// The end-to-end half, and the half that fails on `main`: what the
    /// compiled assembly actually references. A closure that declares the
    /// handler must produce a `TypeRef` scoped to <em>that closure's</em>
    /// `System.Runtime` and must never mention the host's
    /// `System.Private.CoreLib`; a closure that declares no handler must
    /// fall back to target-compatible composite formatting.
    @Fact
    func EmitTargetsTheReferencedFrameworksHandler() {
        var packs = 0
        for (label, resolver) in TargetingPackClosures() {
            {
                using let _ = resolver
                let (diagnostics, image) = Compile(resolver)
                Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0545")
                let (assemblyRefs, handlerScopes) = ReadHandlerReferences(
                    Required(image, "an emitted assembly for closure '$label'")
                )
                // Anti-vacuity: the fixture must really have lowered an
                // interpolation, otherwise "no leaked reference" is trivially
                // satisfied by an assembly that references nothing.
                Assert.Equal("System.Runtime", Assert.Single(handlerScopes))
                Assert.DoesNotContain("System.Private.CoreLib", assemblyRefs)
                packs++
            }
        }
        Assert.True(packs >= 1, "no Microsoft.NETCore.App.Ref targeting pack was available")
        // The handler-less target uses String.Format rather than failing or
        // lowering onto the host's handler.
        using let netStandard = NetStandardClosure()
        let (netStandardDiagnostics, netStandardImage) = Compile(netStandard)
        Assert.DoesNotContain(netStandardDiagnostics, (d Diagnostic) -> d.Id == "GS0545")
        let netStandardBytes = Required(netStandardImage, "an emitted assembly for netstandard")
        let (_, netStandardHandlerScopes) = ReadHandlerReferences(netStandardBytes)
        Assert.Empty(netStandardHandlerScopes)
        Assert.NotEqual("System.Private.CoreLib", Assert.Single(ReadStringFormatScopes(netStandardBytes)))
        Assert.Equal("value = 3", ExecuteDescribe(netStandardBytes))
    }

    /// The hazard pinned directly, and the proof that the netstandard closure is
    /// a genuine handler-less target rather than a fixture artefact: the host
    /// declares the handler, that closure does not, and only a target-resolved
    /// probe can tell the two apart.
    @Fact
    func HostFallbackHandler_IsObservableAndNotATargetHandler() {
        Assert.NotNull(Type.GetType(DefaultInterpolatedStringHandlerShape.HandlerTypeFullName))
        using let netStandard = NetStandardClosure()
        Assert.True(
            netStandard.TryResolveType(DefaultInterpolatedStringHandlerShape.HandlerTypeFullName, out var handler)
        )
        Assert.True(
            netStandard.IsHostFallback(handler),
            "resolved from unexpected assembly '${handler.Assembly.FullName}'"
        )
        Assert.False(DefaultInterpolatedStringHandlerShape.TryResolve(netStandard, out _, out var missing))
        Assert.Equal(DefaultInterpolatedStringHandlerShape.HandlerTypeFullName, missing)
    }

    shared {
        private const InterpolationSource string = `package Issue3730
let count = 3
let label = "value"
let text = "$label = $count"

class Formatter {
    func Describe(label string, count int32) string {
        return "$label = $count"
    }
}
`

        /// The differential table: one answer per row, asserted for every reference
        /// closure that declares a handler. The closure is deliberately absent from
        /// the right-hand side.
        /// @returns The xUnit member-data rows.
        func ShapeRows() TheoryData[Issue3730InterpolatedStringHandlerTargetFrameworkTests.Query, string] {
            let data = TheoryData[Issue3730InterpolatedStringHandlerTargetFrameworkTests.Query, string]{
                Issue3730InterpolatedStringHandlerTargetFrameworkTests
                    .Query
                    .Constructor: "(System.Int32, System.Int32)",
                Issue3730InterpolatedStringHandlerTargetFrameworkTests
                    .Query
                    .AppendLiteral: "System.Void(System.String)",
                Issue3730InterpolatedStringHandlerTargetFrameworkTests.Query.ToStringAndClear: "System.String()",
                Issue3730InterpolatedStringHandlerTargetFrameworkTests.Query.AppendFormattedValue: "System.Void(T)",
                Issue3730InterpolatedStringHandlerTargetFrameworkTests
                    .Query
                    .AppendFormattedAlign: "System.Void(T, System.Int32)",
                Issue3730InterpolatedStringHandlerTargetFrameworkTests
                    .Query
                    .AppendFormattedFormat: "System.Void(T, System.String)",
                Issue3730InterpolatedStringHandlerTargetFrameworkTests
                    .Query
                    .AppendFormattedAlignFormat: "System.Void(T, System.Int32, System.String)",
                Issue3730InterpolatedStringHandlerTargetFrameworkTests
                    .Query
                    .ClosedOverString: "System.Void(System.String)"
            }
            return data
        }

        private func Ask(
            query Issue3730InterpolatedStringHandlerTargetFrameworkTests.Query,
            shape DefaultInterpolatedStringHandlerShape
        ) string -> switch query {
            case Issue3730InterpolatedStringHandlerTargetFrameworkTests.Query.Constructor: "(" + string.Join(
                ", ",
                shape.Constructor.GetParameters().Select((p ParameterInfo) -> Name(p.ParameterType))
            ) +
                ")"
            case Issue3730InterpolatedStringHandlerTargetFrameworkTests
                .Query
                .AppendLiteral: Signature(shape.AppendLiteral)
            case Issue3730InterpolatedStringHandlerTargetFrameworkTests
                .Query
                .ToStringAndClear: Signature(shape.ToStringAndClear)
            case Issue3730InterpolatedStringHandlerTargetFrameworkTests
                .Query
                .AppendFormattedValue: Signature(shape.AppendFormattedValue)
            case Issue3730InterpolatedStringHandlerTargetFrameworkTests
                .Query
                .AppendFormattedAlign: Signature(shape.AppendFormattedAlign)
            case Issue3730InterpolatedStringHandlerTargetFrameworkTests
                .Query
                .AppendFormattedFormat: Signature(shape.AppendFormattedFormat)
            case Issue3730InterpolatedStringHandlerTargetFrameworkTests
                .Query
                .AppendFormattedAlignFormat: Signature(shape.AppendFormattedAlignFormat)
            case Issue3730InterpolatedStringHandlerTargetFrameworkTests
                .Query
                .ClosedOverString: Signature(shape.CloseAppendFormatted(AppendFormattedValueOf(shape), typeof(string)))
            default: throw ArgumentOutOfRangeException("query")
        }

        /// Resolves the handler surface from [`resolver`](paramref) or fails the
        /// test naming the closure. The narrowing form of the assertion: because
        /// `TryResolve` is annotated `[NotNullWhen(true)]`, callers get a
        /// non-nullable shape without a null-forgiving operator (ADR-0155).
        /// @param label The closure's label, for the failure message.
        /// @param resolver The reference closure to resolve against.
        /// @returns The resolved handler surface.
        private func ResolveOrFail(
            label string,
            resolver ReferenceResolver
        ) DefaultInterpolatedStringHandlerShape -> if DefaultInterpolatedStringHandlerShape.TryResolve(
            resolver,
            out var shape,
            out var missing
        ) {
            shape
        } else {
            throw XunitException("closure '$label' should declare the handler, but '$missing' was missing")
            default(DefaultInterpolatedStringHandlerShape)
        }

        /// The bare `AppendFormatted<T>(T)` overload, which every closure
        /// under test is asserted to declare by the (cref:Query.AppendFormattedValue)
        /// row. Fails rather than forgiving the null, so the absence is reported as
        /// a missing overload instead of a (cref:NullReferenceException).
        /// @param shape The resolved handler surface.
        /// @returns The overload.
        private func AppendFormattedValueOf(shape DefaultInterpolatedStringHandlerShape) MethodInfo -> Required(
            shape.AppendFormattedValue,
            "${DefaultInterpolatedStringHandlerShape.HandlerTypeFullName}.AppendFormatted<T>(T)"
        )

        /// Fails the test when [`value`](paramref) is null, returning it
        /// non-nullable otherwise.
        /// @typeparam T The value's type.
        /// @param value The possibly-null value.
        /// @param what What was expected, for the failure message.
        /// @returns The non-null value.
        private func Required[T class](value T?, what string) T -> value ??
            throw XunitException("expected $what, but it was null")

        private func Signature(method MethodInfo?) string -> if method == nil {
            "<none>"
        } else {
            Name(method.ReturnType) + "(" + string.Join(
                ", ",
                method.GetParameters().Select((p ParameterInfo) -> Name(p.ParameterType))
            ) +
                ")"
        }

        private func Name(type Type) string -> type.FullName ?? type.Name

        private func Compile(resolver ReferenceResolver)(Diagnostics IReadOnlyList[Diagnostic], Image[]?uint8) {
            let tree = SyntaxTree.Parse(SourceText.From(InterpolationSource))
            let compilation = Compilation(resolver, tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            return (
                result.Diagnostics,
                if result.Success {
                    peStream.ToArray()
                } else {
                    default([]?uint8)
                }
            )
        }

        private func ReadHandlerReferences(image[]uint8)(
            AssemblyRefs IReadOnlyList[string],
            HandlerScopes IReadOnlyList[string]
        ) {
            using let peReader = PEReader(ImmutableArray.Create(image))
            let metadata = PEReaderExtensions.GetMetadataReader(peReader)
            let assemblyRefs = metadata
                .AssemblyReferences
                .Select(
                (handle AssemblyReferenceHandle) -> metadata.GetString(metadata.GetAssemblyReference(handle).Name)
            )
                .ToList()
            let handlerScopes = List[string]()
            for handle in metadata.TypeReferences {
                let typeRef = metadata.GetTypeReference(handle)
                let name = metadata.GetString(typeRef.Namespace) + "." + metadata.GetString(typeRef.Name)
                if name != DefaultInterpolatedStringHandlerShape.HandlerTypeFullName {
                    continue
                }
                handlerScopes.Add(
                    if typeRef.ResolutionScope.Kind == HandleKind.AssemblyReference {
                        metadata.GetString(
                            metadata.GetAssemblyReference(AssemblyReferenceHandle(typeRef.ResolutionScope)).Name
                        )
                    } else {
                        typeRef.ResolutionScope.Kind.ToString()
                    }
                )
            }
            return (assemblyRefs, handlerScopes)
        }

        private func ReadStringFormatScopes(image[]uint8) IReadOnlyList[string] {
            using let peReader = PEReader(ImmutableArray.Create(image))
            let metadata = PEReaderExtensions.GetMetadataReader(peReader)
            let scopes = List[string]()
            for handle in metadata.MemberReferences {
                let member = metadata.GetMemberReference(handle)
                if metadata.GetString(member.Name) != "Format" || member.Parent.Kind != HandleKind.TypeReference {
                    continue
                }
                let parent = metadata.GetTypeReference(TypeReferenceHandle(member.Parent))
                if metadata.GetString(parent.Namespace) != "System" || metadata.GetString(parent.Name) != "String" {
                    continue
                }
                scopes.Add(
                    if parent.ResolutionScope.Kind == HandleKind.AssemblyReference {
                        metadata.GetString(
                            metadata.GetAssemblyReference(AssemblyReferenceHandle(parent.ResolutionScope)).Name
                        )
                    } else {
                        parent.ResolutionScope.Kind.ToString()
                    }
                )
            }
            return scopes
        }

        private func ExecuteDescribe(image[]uint8) string {
            let context = AssemblyLoadContext("gs3769-${Guid.NewGuid():N}", isCollectible: true)
            try {
                using let stream = MemoryStream(image)
                let assembly = context.LoadFromStream(stream)
                let formatter = Required(
                    assembly.GetType("Issue3730.Formatter", throwOnError: true),
                    "the emitted Formatter type"
                )
                let instance = Required(Activator.CreateInstance(formatter), "a Formatter instance")
                let describe = Required(
                    formatter.GetMethod("Describe", BindingFlags.Public | BindingFlags.Instance),
                    "Formatter.Describe"
                )
                return Assert.IsType[string](describe.Invoke(instance, []object{"value", 3}))
            } finally {
                context.Unload()
            }
        }

        /// The host runtime plus every installed targeting pack — every closure that
        /// is expected to declare a handler.
        /// @returns Labelled resolvers; the caller disposes each.
        private func HandlerBearingClosures() sequence[(Label string, Resolver ReferenceResolver)] {
            yield("host runtime", ReferenceResolver.Default())
            for closure in TargetingPackClosures() {
                yield closure
            }
        }

        private func TargetingPackClosures() sequence[(Label string, Resolver ReferenceResolver)] {
            let packsRoot = Path.Combine(DotnetRoot(), "packs", "Microsoft.NETCore.App.Ref")
            if !Directory.Exists(packsRoot) {
                yield break
            }
            for versionDirectory in Directory.EnumerateDirectories(packsRoot).OrderBy(
                (d string) -> d,
                StringComparer.Ordinal
            ) {
                let refDirectory string? = Directory
                    .EnumerateDirectories(Path.Combine(versionDirectory, "ref"))
                    .OrderBy((d string) -> d, StringComparer.Ordinal)
                    .LastOrDefault()
                if refDirectory == nil {
                    continue
                }
                yield(
                    Path.GetFileName(versionDirectory),
                    ReferenceResolver.WithReferences(Directory.EnumerateFiles(refDirectory, "*.dll"))
                )
            }
        }

        /// A reference closure for a target framework that declares no
        /// `DefaultInterpolatedStringHandler` at all. `NETStandard.Library.Ref`
        /// ships inside the .NET SDK, so this needs no extra install.
        /// @returns The netstandard reference closure.
        private func NetStandardClosure() ReferenceResolver {
            let refDirectory = typeof(Issue3730InterpolatedStringHandlerTargetFrameworkTests)
                .Assembly
                .GetCustomAttributes[AssemblyMetadataAttribute]()
                .Single((attribute AssemblyMetadataAttribute) -> attribute.Key == "NetStandard20ReferenceDirectory")
                .Value
            if string.IsNullOrEmpty(refDirectory) || !Directory.Exists(refDirectory) {
                throw XunitException("prerequisite missing: netstandard2.0 reference directory '$refDirectory'")
            }
            return ReferenceResolver.WithReferences(Directory.EnumerateFiles(refDirectory!!, "*.dll"))
        }

        private func DotnetRoot() string {
            let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)
            return if string.IsNullOrEmpty(runtimeDirectory) {
                throw XunitException("prerequisite missing: host runtime directory not resolvable")
                default(string)
            } else {
                Directory
                    .GetParent(runtimeDirectory!!)
                    ?.Parent
                    ?.Parent
                    ?.FullName ??
                    throw XunitException("prerequisite missing: dotnet root not resolvable")
            }
        }
    }
}
