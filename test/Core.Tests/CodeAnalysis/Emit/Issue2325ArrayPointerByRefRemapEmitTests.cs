// <copyright file="Issue2325ArrayPointerByRefRemapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2325 follow-up: <c>ReflectionMetadataEmitter.MapToReferenceClrType</c>
/// (the single recursive reference-context remapper introduced by the main
/// #2325 fix — see <c>Issue2325NestedDelegateEmitTests</c> in
/// Compiler.Tests) must also correctly rebuild an array (including its exact
/// rank and the vector-vs-general-rank-1 distinction), pointer, or byref
/// shape from a recursively remapped element type, whenever one of those
/// shapes appears inside — or as — a constructed generic/delegate argument.
///
/// A host-context array/pointer/byref `Type` built over an unmapped element
/// (e.g. `hostInt32Type.MakeArrayType()`) still carries the host identity;
/// combining it with a reference-context (MetadataLoadContext) open generic
/// definition via <c>MakeGenericType</c> throws the same GS9998
/// cross-context mismatch an unmapped constructed-generic argument did
/// before the main fix.
///
/// <c>Type.MakePointerType()</c> and <c>Type.MakeByRefType()</c> cannot
/// legally appear as a generic type argument (CLR generics forbid pointer,
/// byref, and byref-like type arguments — ECMA-335 §I.9.4), so no G# source
/// program can drive a pointer or byref shape through this helper via a
/// delegate's generic argument the way an array legitimately can (e.g.
/// <c>Action&lt;int[], object&gt;</c>). Array coverage is therefore proven
/// both by direct unit test AND by an explicit-/reference end-to-end
/// compile/ILVerify/run test in Compiler.Tests
/// (<c>Issue2325NestedArrayDelegateEmitTests</c>); pointer/byref coverage —
/// unreachable from G# delegate syntax, but still handled by the shared
/// helper for any other caller that passes such a shape directly — is
/// proven at this, the smallest level that can actually reach the code:
/// a direct call to the internal helper (obtained via reflection over its
/// private constructor, since <c>ReflectionMetadataEmitter</c> only exposes
/// a static <c>Emit</c> entry point) with host-runtime pointer/byref
/// <see cref="Type"/>s built directly via <see cref="Type.MakePointerType"/>
/// and <see cref="Type.MakeByRefType"/>.
///
/// Every test drives a real explicit-<c>/reference:</c>-style
/// <see cref="ReferenceResolver"/> (the <c>Microsoft.NETCore.App.Ref</c>
/// targeting-pack facades — the same MetadataLoadContext-backed mode cs2gs
/// drives gsc with) rather than the default host-runtime resolver, so the
/// assertions genuinely prove the remapped element resolves to the
/// reference context's own <c>System.Int32</c>, not the test host's.
/// </summary>
public class Issue2325ArrayPointerByRefRemapEmitTests
{
    [Fact]
    public void SzArray_RemapsElementAndPreservesVectorShape()
    {
        var emitter = CreateEmitter(out var references);
        var hostArray = typeof(int).MakeArrayType();

        var mapped = emitter.signatures.MapToReferenceClrType(hostArray);

        Assert.True(mapped.IsArray);
        Assert.True(mapped.IsSZArray);
        Assert.Equal(1, mapped.GetArrayRank());
        AssertMappedInt32(references, mapped.GetElementType());
        Assert.NotEqual(typeof(int).Assembly.FullName, mapped.GetElementType().Assembly.FullName);
    }

    [Fact]
    public void GeneralRank1Array_PreservesNonVectorShape()
    {
        var emitter = CreateEmitter(out var references);

        // `Type.MakeArrayType(1)` builds the general (non-vector) rank-1
        // array `int[*]`, distinct from the vector `int[]` produced by the
        // parameterless overload — reflection keeps these as separate array
        // kinds sharing rank 1 (`Type.IsSZArray` tells them apart).
        var hostArray = typeof(int).MakeArrayType(1);
        Assert.False(hostArray.IsSZArray);

        var mapped = emitter.signatures.MapToReferenceClrType(hostArray);

        Assert.True(mapped.IsArray);
        Assert.False(mapped.IsSZArray);
        Assert.Equal(1, mapped.GetArrayRank());
        AssertMappedInt32(references, mapped.GetElementType());
    }

    [Fact]
    public void MultiDimensionalArray_PreservesRank()
    {
        var emitter = CreateEmitter(out var references);
        var hostArray = typeof(int).MakeArrayType(3);

        var mapped = emitter.signatures.MapToReferenceClrType(hostArray);

        Assert.True(mapped.IsArray);
        Assert.Equal(3, mapped.GetArrayRank());
        AssertMappedInt32(references, mapped.GetElementType());
    }

    [Fact]
    public void ArrayOfArrays_RemapsEachNestingLevel()
    {
        // `int[][]` — a jagged array — nests the array shape two levels
        // deep; both the outer and inner element must resolve in the
        // reference context.
        var emitter = CreateEmitter(out var references);
        var hostArray = typeof(int).MakeArrayType().MakeArrayType();

        var mapped = emitter.signatures.MapToReferenceClrType(hostArray);

        Assert.True(mapped.IsArray);
        Assert.True(mapped.IsSZArray);
        var inner = mapped.GetElementType();
        Assert.True(inner.IsArray);
        Assert.True(inner.IsSZArray);
        AssertMappedInt32(references, inner.GetElementType());
    }

    [Fact]
    public void ArrayNestedInsideConstructedGenericArgument_RemapsBothLevels()
    {
        // Mirrors the legally-emittable Action<int[], object> shape: an
        // array as one of the outer constructed generic's type arguments —
        // exactly what the recursive constructed-generic branch feeds into
        // the array branch added by this follow-up.
        var emitter = CreateEmitter(out var references);
        var hostGeneric = typeof(Action<,>).MakeGenericType(typeof(int[]), typeof(object));

        var mapped = emitter.signatures.MapToReferenceClrType(hostGeneric);

        Assert.True(mapped.IsConstructedGenericType);
        Assert.NotEqual(typeof(Action<,>).Assembly.FullName, mapped.GetGenericTypeDefinition().Assembly.FullName);

        var args = mapped.GetGenericArguments();
        Assert.True(args[0].IsArray);
        Assert.True(args[0].IsSZArray);
        AssertMappedInt32(references, args[0].GetElementType());
    }

    [Fact]
    public void PointerType_RemapsElementInReferenceContext()
    {
        // Unreachable from G# delegate/generic-argument syntax (CLR forbids
        // pointer generic arguments), but the shared helper must still
        // rebuild the wrapper correctly for any other direct caller.
        var emitter = CreateEmitter(out var references);
        var hostPointer = typeof(int).MakePointerType();

        var mapped = emitter.signatures.MapToReferenceClrType(hostPointer);

        Assert.True(mapped.IsPointer);
        AssertMappedInt32(references, mapped.GetElementType());
        Assert.NotEqual(typeof(int).Assembly.FullName, mapped.GetElementType().Assembly.FullName);
    }

    [Fact]
    public void ByRefType_RemapsElementInReferenceContext()
    {
        // Unreachable from G# delegate/generic-argument syntax (CLR forbids
        // byref generic arguments), but the shared helper must still rebuild
        // the wrapper correctly for any other direct caller (e.g. a future
        // non-delegate byref-parameter mapping site).
        var emitter = CreateEmitter(out var references);
        var hostByRef = typeof(int).MakeByRefType();

        var mapped = emitter.signatures.MapToReferenceClrType(hostByRef);

        Assert.True(mapped.IsByRef);
        AssertMappedInt32(references, mapped.GetElementType());
        Assert.NotEqual(typeof(int).Assembly.FullName, mapped.GetElementType().Assembly.FullName);
    }

    [Fact]
    public void PointerToArray_RemapsBothWrapperLevels()
    {
        // `int[]*` — a pointer to a vector array — exercises composing two
        // of the three new wrapper kinds so the recursion genuinely nests
        // rather than only handling one level.
        var emitter = CreateEmitter(out var references);
        var hostPointerToArray = typeof(int).MakeArrayType().MakePointerType();

        var mapped = emitter.signatures.MapToReferenceClrType(hostPointerToArray);

        Assert.True(mapped.IsPointer);
        var element = mapped.GetElementType();
        Assert.True(element.IsArray);
        Assert.True(element.IsSZArray);
        AssertMappedInt32(references, element.GetElementType());
    }

    /// <summary>
    /// Asserts that <paramref name="mappedElementType"/> is the reference
    /// context's own <c>System.Int32</c> (obtained independently through
    /// <see cref="ReferenceResolver.TryResolveType(string, out Type)"/>) —
    /// not the test host's <see cref="int"/> — proving the element was
    /// actually remapped rather than passed through unchanged.
    /// </summary>
    private static void AssertMappedInt32(ReferenceResolver references, Type mappedElementType)
    {
        Assert.True(
            references.TryResolveType("System.Int32", out var referenceInt32),
            "expected the reference resolver to resolve System.Int32 from the ref-pack facades");
        Assert.Equal(referenceInt32, mappedElementType);
    }

    /// <summary>
    /// Builds a <see cref="ReflectionMetadataEmitter"/> wired to a real
    /// explicit-reference-style <see cref="ReferenceResolver"/> (the
    /// <c>Microsoft.NETCore.App.Ref</c> targeting-pack facades — the same
    /// MetadataLoadContext-backed mode cs2gs drives gsc with), via reflection
    /// over the private constructor (the only entry point is the static
    /// <c>Emit</c> method, which does not return the instance). The
    /// constructor only stores its arguments on <c>EmitContext</c> — it never
    /// dereferences <paramref name="references"/>'s <c>BoundProgram</c>
    /// argument — so passing <see langword="null"/> for it is safe for this
    /// narrowly-scoped unit test of <c>MapToReferenceClrType</c>, which only
    /// consults <c>emitCtx.References</c>.
    /// </summary>
    private static ReflectionMetadataEmitter CreateEmitter(out ReferenceResolver references)
    {
        references = ReferenceResolver.WithReferences(RefPackReferences());

        var ctor = typeof(ReflectionMetadataEmitter).GetConstructor(
            BindingFlags.NonPublic | BindingFlags.Instance,
            binder: null,
            types: new[] { typeof(BoundProgram), typeof(ReferenceResolver), typeof(string), typeof(bool) },
            modifiers: null)
            ?? throw new InvalidOperationException(
                "ReflectionMetadataEmitter's private constructor signature changed; update this test's reflection probe.");

        return (ReflectionMetadataEmitter)ctor.Invoke(new object[] { null, references, null, false });
    }

    /// <summary>
    /// Assembles the same reference closure the .NET SDK (and cs2gs) would
    /// pass to gsc via explicit <c>/reference:</c> flags — the
    /// <c>Microsoft.NETCore.App.Ref</c> targeting-pack facades for the
    /// running runtime. Loading these through an isolated
    /// MetadataLoadContext (rather than the host's trusted-platform
    /// assemblies) is what actually exercises the cross-context remapping
    /// this test is about — a TPA-backed resolver shares the host runtime's
    /// own <c>System.Private.CoreLib</c> identity and would make every
    /// assertion trivially true. Throws when the ref-pack is absent so a CI
    /// environment missing it surfaces a clear diagnostic instead of a false
    /// pass.
    /// </summary>
    private static string[] RefPackReferences()
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir))
        {
            throw new InvalidOperationException("host runtime directory not resolvable");
        }

        var sharedDir = Directory.GetParent(runtimeDir)?.Parent;
        var dotnetRoot = sharedDir?.Parent?.FullName;
        if (string.IsNullOrEmpty(dotnetRoot))
        {
            throw new InvalidOperationException("dotnet root not resolvable");
        }

        var tfm = $"net{Environment.Version.Major}.0";
        var packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        if (!Directory.Exists(packsRoot))
        {
            throw new InvalidOperationException($"ref pack root '{packsRoot}' missing");
        }

        var version = Environment.Version.ToString(3);
        var refDir = Path.Combine(packsRoot, version, "ref", tfm);
        if (!Directory.Exists(refDir))
        {
            var major = Environment.Version.Major.ToString();
            var candidate = Directory.EnumerateDirectories(packsRoot, major + ".*")
                .OrderByDescending(d => d, StringComparer.Ordinal)
                .Select(d => Path.Combine(d, "ref", tfm))
                .FirstOrDefault(Directory.Exists);
            if (string.IsNullOrEmpty(candidate))
            {
                throw new InvalidOperationException($"no ref pack for net{major}.0 under '{packsRoot}'");
            }

            refDir = candidate;
        }

        return Directory.EnumerateFiles(refDir, "*.dll").ToArray();
    }
}
