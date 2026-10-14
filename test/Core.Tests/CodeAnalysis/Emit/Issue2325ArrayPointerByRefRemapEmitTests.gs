// <copyright file="Issue2325ArrayPointerByRefRemapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #2325 follow-up: `ReflectionMetadataEmitter.MapToReferenceClrType`
/// (the single recursive reference-context remapper introduced by the main
/// #2325 fix — see `Issue2325NestedDelegateEmitTests` in
/// Compiler.Tests) must also correctly rebuild an array (including its exact
/// rank and the vector-vs-general-rank-1 distinction), pointer, or byref
/// shape from a recursively remapped element type, whenever one of those
/// shapes appears inside — or as — a constructed generic/delegate argument.
///
/// A host-context array/pointer/byref `Type` built over an unmapped element
/// (e.g. `hostInt32Type.MakeArrayType()`) still carries the host identity;
/// combining it with a reference-context (MetadataLoadContext) open generic
/// definition via `MakeGenericType` throws the same GS9998
/// cross-context mismatch an unmapped constructed-generic argument did
/// before the main fix.
///
/// `Type.MakePointerType()` and `Type.MakeByRefType()` cannot
/// legally appear as a generic type argument (CLR generics forbid pointer,
/// byref, and byref-like type arguments — ECMA-335 §I.9.4), so no G# source
/// program can drive a pointer or byref shape through this helper via a
/// delegate's generic argument the way an array legitimately can (e.g.
/// `Action<int[], object>`). Array coverage is therefore proven
/// both by direct unit test AND by an explicit-/reference end-to-end
/// compile/ILVerify/run test in Compiler.Tests
/// (`Issue2325NestedArrayDelegateEmitTests`); pointer/byref coverage —
/// unreachable from G# delegate syntax, but still handled by the shared
/// helper for any other caller that passes such a shape directly — is
/// proven at this, the smallest level that can actually reach the code:
/// a direct call to the internal helper (obtained via reflection over its
/// private constructor, since `ReflectionMetadataEmitter` only exposes
/// a static `Emit` entry point) with host-runtime pointer/byref
/// (cref:Type)s built directly via (cref:Type.MakePointerType)
/// and (cref:Type.MakeByRefType).
///
/// Every test drives a real explicit-`/reference:`-style
/// (cref:ReferenceResolver) (the `Microsoft.NETCore.App.Ref`
/// targeting-pack facades — the same MetadataLoadContext-backed mode cs2gs
/// drives gsc with) rather than the default host-runtime resolver, so the
/// assertions genuinely prove the remapped element resolves to the
/// reference context's own `System.Int32`, not the test host's.
open class Issue2325ArrayPointerByRefRemapEmitTests {
    @Fact
    func SzArray_RemapsElementAndPreservesVectorShape() {
        let emitter = CreateEmitter(out var references)
        let hostArray = typeof(int32).MakeArrayType()
        let mapped Type? = emitter.signatures.MapToReferenceClrType(hostArray)
        Assert.True(mapped!!.IsArray)
        Assert.True(mapped!!.IsSZArray)
        Assert.Equal(1, mapped!!.GetArrayRank())
        AssertMappedInt32(references, mapped!!.GetElementType())
        Assert.NotEqual(typeof(int32).Assembly.FullName, mapped!!.GetElementType()!!.Assembly.FullName)
    }

    @Fact
    func GeneralRank1Array_PreservesNonVectorShape() {
        let emitter = CreateEmitter(out var references)
        // `Type.MakeArrayType(1)` builds the general (non-vector) rank-1
        // array `int[*]`, distinct from the vector `int[]` produced by the
        // parameterless overload — reflection keeps these as separate array
        // kinds sharing rank 1 (`Type.IsSZArray` tells them apart).
        let hostArray = typeof(int32).MakeArrayType(1)
        Assert.False(hostArray.IsSZArray)
        let mapped Type? = emitter.signatures.MapToReferenceClrType(hostArray)
        Assert.True(mapped!!.IsArray)
        Assert.False(mapped!!.IsSZArray)
        Assert.Equal(1, mapped!!.GetArrayRank())
        AssertMappedInt32(references, mapped!!.GetElementType())
    }

    @Fact
    func MultiDimensionalArray_PreservesRank() {
        let emitter = CreateEmitter(out var references)
        let hostArray = typeof(int32).MakeArrayType(3)
        let mapped Type? = emitter.signatures.MapToReferenceClrType(hostArray)
        Assert.True(mapped!!.IsArray)
        Assert.Equal(3, mapped!!.GetArrayRank())
        AssertMappedInt32(references, mapped!!.GetElementType())
    }

    @Fact
    func ArrayOfArrays_RemapsEachNestingLevel() {
        // `int[][]` — a jagged array — nests the array shape two levels
        // deep; both the outer and inner element must resolve in the
        // reference context.
        let emitter = CreateEmitter(out var references)
        let hostArray = typeof(int32).MakeArrayType().MakeArrayType()
        let mapped Type? = emitter.signatures.MapToReferenceClrType(hostArray)
        Assert.True(mapped!!.IsArray)
        Assert.True(mapped!!.IsSZArray)
        let inner Type? = mapped!!.GetElementType()
        Assert.True(inner!!.IsArray)
        Assert.True(inner!!.IsSZArray)
        AssertMappedInt32(references, inner!!.GetElementType())
    }

    @Fact
    func ArrayNestedInsideConstructedGenericArgument_RemapsBothLevels() {
        // Mirrors the legally-emittable Action<int[], object> shape: an
        // array as one of the outer constructed generic's type arguments —
        // exactly what the recursive constructed-generic branch feeds into
        // the array branch added by this follow-up.
        let emitter = CreateEmitter(out var references)
        let hostGeneric = typeof(Action[_, _]).MakeGenericType(typeof([]int32), typeof(object))
        let mapped Type? = emitter.signatures.MapToReferenceClrType(hostGeneric)
        Assert.True(mapped!!.IsConstructedGenericType)
        Assert.NotEqual(typeof(Action[_, _]).Assembly.FullName, mapped!!.GetGenericTypeDefinition().Assembly.FullName)
        let args = mapped!!.GetGenericArguments()
        Assert.True(args[0].IsArray)
        Assert.True(args[0].IsSZArray)
        AssertMappedInt32(references, args[0].GetElementType())
    }

    @Fact
    func PointerType_RemapsElementInReferenceContext() {
        // Unreachable from G# delegate/generic-argument syntax (CLR forbids
        // pointer generic arguments), but the shared helper must still
        // rebuild the wrapper correctly for any other direct caller.
        let emitter = CreateEmitter(out var references)
        let hostPointer = typeof(int32).MakePointerType()
        let mapped Type? = emitter.signatures.MapToReferenceClrType(hostPointer)
        Assert.True(mapped!!.IsPointer)
        AssertMappedInt32(references, mapped!!.GetElementType())
        Assert.NotEqual(typeof(int32).Assembly.FullName, mapped!!.GetElementType()!!.Assembly.FullName)
    }

    @Fact
    func ByRefType_RemapsElementInReferenceContext() {
        // Unreachable from G# delegate/generic-argument syntax (CLR forbids
        // byref generic arguments), but the shared helper must still rebuild
        // the wrapper correctly for any other direct caller (e.g. a future
        // non-delegate byref-parameter mapping site).
        let emitter = CreateEmitter(out var references)
        let hostByRef = typeof(int32).MakeByRefType()
        let mapped Type? = emitter.signatures.MapToReferenceClrType(hostByRef)
        Assert.True(mapped!!.IsByRef)
        AssertMappedInt32(references, mapped!!.GetElementType())
        Assert.NotEqual(typeof(int32).Assembly.FullName, mapped!!.GetElementType()!!.Assembly.FullName)
    }

    @Fact
    func PointerToArray_RemapsBothWrapperLevels() {
        // `int[]*` — a pointer to a vector array — exercises composing two
        // of the three new wrapper kinds so the recursion genuinely nests
        // rather than only handling one level.
        let emitter = CreateEmitter(out var references)
        let hostPointerToArray = typeof(int32).MakeArrayType().MakePointerType()
        let mapped Type? = emitter.signatures.MapToReferenceClrType(hostPointerToArray)
        Assert.True(mapped!!.IsPointer)
        let element Type? = mapped!!.GetElementType()
        Assert.True(element!!.IsArray)
        Assert.True(element!!.IsSZArray)
        AssertMappedInt32(references, element!!.GetElementType())
    }

    shared {
        private let Package PackageSymbol = PackageSymbol("main", declaration: nil)

        /// Asserts that [`mappedElementType`](paramref) is the reference
        /// context's own `System.Int32` (obtained independently through
        /// (cref:ReferenceResolver.TryResolveType(string, out Type))) —
        /// not the test host's (cref:int) — proving the element was
        /// actually remapped rather than passed through unchanged.
        private func AssertMappedInt32(references ReferenceResolver, mappedElementType Type?) {
            Assert.True(
                references.TryResolveType("System.Int32", out var referenceInt32),
                "expected the reference resolver to resolve System.Int32 from the ref-pack facades"
            )
            Assert.Equal(referenceInt32, mappedElementType)
        }

        /// Builds a (cref:ReflectionMetadataEmitter) wired to a real
        /// explicit-reference-style (cref:ReferenceResolver) (the
        /// `Microsoft.NETCore.App.Ref` targeting-pack facades — the same
        /// MetadataLoadContext-backed mode cs2gs drives gsc with), via reflection
        /// over the private constructor (the only entry point is the static
        /// `Emit` method, which does not return the instance). The
        /// constructor only stores its arguments on `EmitContext`. This test
        /// supplies an empty program because migrated G# preserves the constructor's
        /// non-null contract at runtime.
        private func CreateEmitter(out references ReferenceResolver) ReflectionMetadataEmitter {
            references = ReferenceResolver.WithReferences(RefPackReferences())
            let program = BoundProgram(
                Package,
                ImmutableArray.Create(Package),
                ImmutableArray[Diagnostic].Empty,
                ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Empty,
                entryPoint: nil,
                statement: BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty),
                structs: ImmutableArray[StructSymbol].Empty,
                interfaces: ImmutableArray[InterfaceSymbol].Empty
            )
            let ctor = typeof(ReflectionMetadataEmitter).GetConstructor(
                BindingFlags.NonPublic | BindingFlags.Instance,
                binder: nil,
                types: []Type{
                    typeof(BoundProgram),
                    typeof(ReferenceResolver),
                    typeof(string),
                    typeof(bool),
                    typeof(IReadOnlyList[(Name string, Data[]uint8, IsPublic bool)])
                },
                modifiers: nil
            ) ??
                throw InvalidOperationException(
                "ReflectionMetadataEmitter's private constructor signature changed; update this test's reflection probe."
            )
            return cast[ReflectionMetadataEmitter](ctor.Invoke([]object? {program, references, nil, false, nil}))
        }

        /// Assembles the same reference closure the .NET SDK (and cs2gs) would
        /// pass to gsc via explicit `/reference:` flags — the
        /// `Microsoft.NETCore.App.Ref` targeting-pack facades for the
        /// running runtime. Loading these through an isolated
        /// MetadataLoadContext (rather than the host's trusted-platform
        /// assemblies) is what actually exercises the cross-context remapping
        /// this test is about — a TPA-backed resolver shares the host runtime's
        /// own `System.Private.CoreLib` identity and would make every
        /// assertion trivially true. Throws when the ref-pack is absent so a CI
        /// environment missing it surfaces a clear diagnostic instead of a false
        /// pass.
        private func RefPackReferences()[]string {
            let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            if string.IsNullOrEmpty(runtimeDir) {
                throw InvalidOperationException("host runtime directory not resolvable")
            }
            let sharedDir DirectoryInfo? = Directory.GetParent(runtimeDir)?.Parent
            let dotnetRoot string? = sharedDir?.Parent?.FullName
            if string.IsNullOrEmpty(dotnetRoot) {
                throw InvalidOperationException("dotnet root not resolvable")
            }
            let tfm = "net${Environment.Version.Major}.0"
            let packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
            if !Directory.Exists(packsRoot) {
                throw InvalidOperationException("ref pack root '$packsRoot' missing")
            }
            let version = Environment.Version.ToString(3)
            var refDir string? = Path.Combine(packsRoot, version, "ref", tfm)
            if !Directory.Exists(refDir) {
                let major = Environment.Version.Major.ToString()
                let candidate string? = Directory
                    .EnumerateDirectories(packsRoot, major + ".*")
                    .OrderByDescending((d string) -> d, StringComparer.Ordinal)
                    .Select((d string) -> Path.Combine(d, "ref", tfm))
                    .FirstOrDefault(Directory.Exists)
                if string.IsNullOrEmpty(candidate) {
                    throw InvalidOperationException("no ref pack for net$major.0 under '$packsRoot'")
                }
                refDir = candidate
            }
            return Directory.EnumerateFiles(refDir, "*.dll").ToArray()
        }
    }
}
