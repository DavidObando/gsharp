// <copyright file="Issue3755PinningShapeTargetFrameworkTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
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

/// Issue #3755 (issue #3705, family 3 — the load-context family; remedy from
/// #3754). The `fixed` lowering resolved two well-known members off live
/// host `typeof`s:
/// `typeof(System.Runtime.CompilerServices.Unsafe).GetMethods(...)` for
/// `AsPointer<T>`, which every pin form emits, and
/// `typeof(string).GetMethod("GetPinnableReference", ...)` for the
/// string-pin form. Both answered for the SDK <em>hosting</em> gsc rather than
/// for the framework being compiled against.
///
/// #3755 ranked both as hygiene because "none of the types involved is
/// plausibly absent from a target framework". Measured against the targeting
/// packs the .NET SDK ships, that ranking does not hold:
/// (cref:NetStandardDeclaresNeitherPinningMember_ButTheHostDeclaresBoth)
/// pins the two facts it missed —
/// `System.Runtime.CompilerServices.Unsafe` is absent from
/// `NETStandard.Library.Ref/2.1.0` outright, and
/// `String.GetPinnableReference()` is absent from it even though
/// `System.String` is present. The second is invisible to "is the TYPE
/// absent?" reasoning by construction, which is how the ranking missed it.
///
/// Shaped like `Issue3730InterpolatedStringHandlerTargetFrameworkTests` and
/// `Issue3705LoadContextDifferentialTests`: the reflection context never
/// appears on the right-hand side of an expectation. Each row states one answer
/// and it is asserted for the host runtime and every installed
/// `Microsoft.NETCore.App.Ref` targeting pack alike.
open class Issue3755PinningShapeTargetFrameworkTests {
    /// The shape questions the pinning emit asks of the target framework.
    enum Query {
        UnsafeAsPointerOpen,
        UnsafeAsPointerClosedOverInt32,
        StringGetPinnableReference
    }

    /// The invariant: the pinning surface is a property of the referenced
    /// framework, and every framework that provides it provides the same shape —
    /// so the answer must never depend on which reflection context the
    /// (cref:Type) came from.
    /// @param query The shape question.
    /// @param expected The single expected answer, for every closure.
    @Theory
    @MemberData("ShapeRows")
    func SamePinningShape_ForHostRuntime_AndEveryTargetingPack(
        query Issue3755PinningShapeTargetFrameworkTests.Query,
        expected string
    ) {
        var contexts = 0
        for (label, resolver) in PinningCapableClosures() {
            {
                using let _ = resolver
                Assert.Equal(expected, Ask(query, label, resolver))
                contexts++
            }
        }
        // Anti-vacuity: the host runtime alone would let every row pass while
        // proving nothing about a target framework, so require at least one
        // MetadataLoadContext closure to have participated.
        Assert.True(contexts >= 2, "expected the host closure plus at least one targeting pack, saw $contexts")
    }

    /// Every resolved member must belong to the closure that resolved it. This
    /// is the property that was violated: on `main` both members came off
    /// the host's `System.Private.CoreLib` no matter which framework was
    /// referenced.
    @Fact
    func ResolvedPinningMembers_BelongToTheReferencedClosure() {
        var sawMetadataLoadContext = false
        for (label, resolver) in PinningCapableClosures() {
            {
                using let _ = resolver
                let asPointer = AsPointerOrFail(label, resolver)
                let getPinnableReference = GetPinnableReferenceOrFail(label, resolver)
                // Module.Assembly rather than DeclaringType.Assembly: it asks the
                // same question without a nullable hop (ADR-0155).
                for member in[]MethodInfo{asPointer, getPinnableReference} {
                    let assembly = member.Module.Assembly
                    if object.ReferenceEquals(assembly, typeof(object).Assembly) {
                        continue
                    }
                    sawMetadataLoadContext = true
                    Assert.NotEqual("System.Private.CoreLib", assembly.GetName().Name)
                }
            }
        }
        Assert.True(sawMetadataLoadContext, "no targeting pack participated; the differential is vacuous")
    }

    /// The anti-vacuity row that carries the whole severity argument, and the
    /// two facts #3755's ranking missed. The host declares both pinning members;
    /// `NETStandard.Library.Ref/2.1.0` declares neither — and the second
    /// absence is a MEMBER on a type that is present, which no amount of
    /// "is the type absent?" reasoning or #3729 type projection can see.
    @Fact
    func NetStandardDeclaresNeitherPinningMember_ButTheHostDeclaresBoth() {
        {
            using let host = ReferenceResolver.Default()
            Assert.True(PinningShapes.TryGetUnsafeAsPointer(host, out _))
            Assert.True(PinningShapes.TryGetStringGetPinnableReference(CoreStringOf(host), out _))
        }
        using let netStandard = NetStandardClosure()
        // The type is absent outright — #3730's shape exactly.
        Assert.False(netStandard.TryResolveType(PinningShapes.UnsafeTypeFullName, out _))
        Assert.False(PinningShapes.TryGetUnsafeAsPointer(netStandard, out _))
        // The type is PRESENT and the member is absent. #3729's GetTypeReference
        // projection is a type-level repair and cannot reach this at all.
        Assert.True(netStandard.TryResolveType("System.String", out _))
        Assert.False(PinningShapes.TryGetStringGetPinnableReference(CoreStringOf(netStandard), out _))
    }

    /// The end-to-end half, and the half that fails on `main`: what the
    /// compiled assembly actually references. A closure that provides the
    /// pinning surface must produce `TypeRef`s scoped to <em>that
    /// closure's</em> assemblies and must never mention the host's
    /// `System.Private.CoreLib`; a closure that does not must produce
    /// GS0546 rather than an assembly.
    @Fact
    func EmitTargetsTheReferencedFrameworksPinningMembers() {
        var packs = 0
        for (label, resolver) in TargetingPackClosures() {
            {
                using let _ = resolver
                for source in[]string{FixedArraySource, FixedStringSource} {
                    let (diagnostics, image) = Compile(resolver, source)
                    Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0546")
                    let (assemblyRefs, unsafeScopes) = ReadUnsafeReferences(
                        Required(image, "an emitted assembly for closure '$label'")
                    )
                    // Anti-vacuity: the fixture must really have emitted a pin,
                    // otherwise "no leaked reference" is trivially satisfied by
                    // an assembly that references nothing.
                    Assert.Equal("System.Runtime", Assert.Single(unsafeScopes))
                    Assert.DoesNotContain("System.Private.CoreLib", assemblyRefs)
                }
                packs++
            }
        }
        Assert.True(packs >= 1, "no Microsoft.NETCore.App.Ref targeting pack was available")
        // The pinning-less target. On main both of these compiled successfully:
        // the array form emitted a TypeRef into the host's
        // System.Private.CoreLib, and the string form emitted a MemberRef
        // naming a method netstandard2.1 does not declare.
        using let netStandard = NetStandardClosure()
        let (arrayDiagnostics, arrayImage) = Compile(netStandard, FixedArraySource)
        Assert.Contains(
            PinningShapes.UnsafeAsPointerSignature,
            Assert.Single(arrayDiagnostics, (d Diagnostic) -> d.Id == "GS0546").Message,
            StringComparison.Ordinal
        )
        Assert.Null(arrayImage)
        let (stringDiagnostics, stringImage) = Compile(netStandard, FixedStringSource)
        Assert.Contains(
            PinningShapes.StringGetPinnableReferenceSignature,
            Assert.Single(stringDiagnostics, (d Diagnostic) -> d.Id == "GS0546").Message,
            StringComparison.Ordinal
        )
        Assert.Null(stringImage)
    }

    /// Executes the emitted code. Binding cleanly with zero diagnostics is not
    /// evidence that the emitted `MethodSpec` is right: closing
    /// `AsPointer<T>` across reflection contexts produces a method
    /// whose parameters read back unsubstituted, and an emit built on that can
    /// still verify, load, and then fault at the first call. Only running it
    /// settles the question.
    @Fact
    func EmittedPinsExecuteAgainstTheHostRuntime() {
        Assert.Equal("42", Run(FixedArraySource, "FixedArraySource"))
        Assert.Equal("g", Run(FixedStringSource, "FixedStringSource"))
    }

    shared {
        private const FixedArraySource string = `package Issue3755
func Head(values []int32) int32 {
    unsafe {
        fixed p *int32 = values {
            return *p
        }
    }
}
Console.WriteLine(Head([]int32{41, 7}) + 1)
`

        private const FixedStringSource string = `package Issue3755
func FirstChar(s string) char {
    unsafe {
        fixed p *char = s {
            return *p
        }
    }
}
Console.WriteLine(FirstChar("gsharp"))
`

        /// The differential table: one answer per row, asserted for every closure
        /// that provides the pinning surface at all. The closure is deliberately
        /// absent from the right-hand side.
        /// @returns The xUnit member-data rows.
        func ShapeRows() TheoryData[Issue3755PinningShapeTargetFrameworkTests.Query, string] -> TheoryData[
            Issue3755PinningShapeTargetFrameworkTests.Query,
            string
        ]{
            Issue3755PinningShapeTargetFrameworkTests.Query.UnsafeAsPointerOpen: "System.Void*(T&)",
            Issue3755PinningShapeTargetFrameworkTests
                .Query
                .UnsafeAsPointerClosedOverInt32: "System.Void*(System.Int32&)",
            Issue3755PinningShapeTargetFrameworkTests.Query.StringGetPinnableReference: "System.Char&()"
        }

        private func Ask(
            query Issue3755PinningShapeTargetFrameworkTests.Query,
            label string,
            resolver ReferenceResolver
        ) string -> switch query {
            case Issue3755PinningShapeTargetFrameworkTests
                .Query
                .UnsafeAsPointerOpen: Signature(AsPointerOrFail(label, resolver))
            case Issue3755PinningShapeTargetFrameworkTests
                .Query
                .UnsafeAsPointerClosedOverInt32: Signature(
                PinningShapes.CloseOver(AsPointerOrFail(label, resolver), typeof(int32))
            )
            case Issue3755PinningShapeTargetFrameworkTests
                .Query
                .StringGetPinnableReference: Signature(GetPinnableReferenceOrFail(label, resolver))
            default: throw ArgumentOutOfRangeException("query")
        }

        /// Resolves `Unsafe.AsPointer<T>` or fails the test naming the
        /// closure. Consuming the `[NotNullWhen(true)]` annotation is the
        /// narrowing form of the assertion, so no null-forgiving operator is needed
        /// (ADR-0155).
        /// @param label The closure's label, for the failure message.
        /// @param resolver The reference closure.
        /// @returns The open generic definition.
        private func AsPointerOrFail(
            label string,
            resolver ReferenceResolver
        ) MethodInfo -> if PinningShapes.TryGetUnsafeAsPointer(resolver, out var asPointer) {
            asPointer
        } else {
            throw XunitException("closure '$label' should declare ${PinningShapes.UnsafeAsPointerSignature}")
            default(MethodInfo)
        }

        private func GetPinnableReferenceOrFail(
            label string,
            resolver ReferenceResolver
        ) MethodInfo -> if PinningShapes.TryGetStringGetPinnableReference(CoreStringOf(resolver), out var method) {
            method
        } else {
            throw XunitException("closure '$label' should declare ${PinningShapes.StringGetPinnableReferenceSignature}")
            default(MethodInfo)
        }

        /// The closure's `System.String` — what `EmitContext.CoreStringType`
        /// resolves to for a compilation against that closure.
        /// @param resolver The reference closure.
        /// @returns The target framework's string type.
        private func CoreStringOf(resolver ReferenceResolver) Type -> if resolver.TryResolveType(
            "System.String",
            out var stringType
        ) {
            stringType
        } else {
            throw XunitException("every closure declares System.String")
            default(Type)
        }

        private func Required[T class](value T?, what string) T -> value ??
            throw XunitException("expected $what, but it was null")

        private func Signature(method MethodInfo) string -> Name(method.ReturnType) + "(" + string.Join(
            ", ",
            method.GetParameters().Select((p ParameterInfo) -> Name(p.ParameterType))
        ) +
            ")"

        private func Name(type Type) string -> type.FullName ?? type.Name

        private func Compile(resolver ReferenceResolver, source string)(
            Diagnostics IReadOnlyList[Diagnostic],
            Image[]?uint8
        ) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
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

        private func Run(source string, contextName string) string {
            using let resolver = ReferenceResolver.Default()
            let (diagnostics, image) = Compile(resolver, source)
            Assert.True(
                image != nil,
                "emit diagnostics:\n  " + string.Join(
                    "\n  ",
                    diagnostics.Select((d Diagnostic) -> d.Id + ": " + d.Message)
                )
            )
            let loadContext = AssemblyLoadContext(contextName + "-3755", isCollectible: true)
            try {
                using let peStream = MemoryStream(Required(image, "an emitted assembly"))
                let assembly = loadContext.LoadFromStream(peStream)
                let programType = Required(
                    assembly.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>"),
                    "the synthesized <Program> type"
                )
                let entry = Required(
                    programType.GetMethod(
                        "<Main>$$",
                        BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                    ),
                    "the synthesized entry point"
                )
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry.Invoke(
                        nil,
                        if entry.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString().Trim()
            } finally {
                loadContext.Unload()
            }
        }

        private func ReadUnsafeReferences(image[]uint8)(
            AssemblyRefs IReadOnlyList[string],
            UnsafeScopes IReadOnlyList[string]
        ) {
            using let peReader = PEReader(ImmutableArray.Create(image))
            let metadata = PEReaderExtensions.GetMetadataReader(peReader)
            let assemblyRefs = metadata
                .AssemblyReferences
                .Select(
                (handle AssemblyReferenceHandle) -> metadata.GetString(metadata.GetAssemblyReference(handle).Name)
            )
                .ToList()
            let unsafeScopes = List[string]()
            for handle in metadata.TypeReferences {
                let typeRef = metadata.GetTypeReference(handle)
                let name = metadata.GetString(typeRef.Namespace) + "." + metadata.GetString(typeRef.Name)
                if name != PinningShapes.UnsafeTypeFullName {
                    continue
                }
                unsafeScopes.Add(
                    if typeRef.ResolutionScope.Kind == HandleKind.AssemblyReference {
                        metadata.GetString(
                            metadata.GetAssemblyReference(AssemblyReferenceHandle(typeRef.ResolutionScope)).Name
                        )
                    } else {
                        typeRef.ResolutionScope.Kind.ToString()
                    }
                )
            }
            return (assemblyRefs, unsafeScopes)
        }

        private func PinningCapableClosures() sequence[(Label string, Resolver ReferenceResolver)] {
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

        /// A reference closure for a target framework that provides neither pinning
        /// member. `NETStandard.Library.Ref` ships inside the .NET SDK, so this
        /// needs no extra install.
        /// @returns The netstandard reference closure.
        private func NetStandardClosure() ReferenceResolver {
            let packRoot = Path.Combine(DotnetRoot(), "packs", "NETStandard.Library.Ref")
            let refDirectory string? = if Directory.Exists(packRoot) {
                Directory
                    .EnumerateDirectories(packRoot)
                    .OrderBy((d string) -> d, StringComparer.Ordinal)
                    .Select(
                    (version string) -> Directory
                        .EnumerateDirectories(Path.Combine(version, "ref"))
                        .OrderBy((d string) -> d, StringComparer.Ordinal)
                        .LastOrDefault()
                )
                    .LastOrDefault((d string?) -> d != nil)
            } else {
                default(string?)
            }
            if refDirectory == nil {
                throw XunitException(
                    "prerequisite missing: no NETStandard.Library.Ref targeting pack under '$packRoot'"
                )
            }
            return ReferenceResolver.WithReferences(Directory.EnumerateFiles(refDirectory, "*.dll"))
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
