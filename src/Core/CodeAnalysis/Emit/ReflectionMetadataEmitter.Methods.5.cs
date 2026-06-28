// <copyright file="ReflectionMetadataEmitter.Methods.5.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1028 // trailing whitespace
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1214 // readonly fields before non-readonly
#pragma warning disable SA1515 // single-line comment preceded by blank line
#pragma warning disable SA1201 // method should not follow a class (this file mixes private helper classes inline with methods)
#pragma warning disable SA1202 // 'internal' members should come before 'private' members (PR-E-5: IsValueTypeSymbol was widened to internal in-place for ConversionEmitter; ordering is restored once Phase 2 decomposition finishes)
#pragma warning disable SA1304 // non-private readonly field naming — PR-E-11 widened several emitter-internal fields to internal so the promoted MethodBodyEmitter can read them; ordering/casing restored after E-12 root thinning
#pragma warning disable SA1307 // field naming casing — same as SA1304
#pragma warning disable SA1401 // field should be private — same as SA1304
#pragma warning disable SA1611 // parameter documentation missing — PR-E-11 widened internal helpers used by MethodBodyEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Emits a managed PE for a <see cref="BoundProgram"/> using
/// <see cref="System.Reflection.Metadata"/> directly.
/// </summary>
/// <remarks>
/// Phase 2 (p2-langcov) coverage: locals, parameters, unary/binary operators,
/// assignments, label/goto/conditional-goto, user-defined function calls
/// (emitted as static methods on <c>&lt;Program&gt;</c>), and the imported-call
/// surface inherited from Phase 1. Per ADR-0027 the bespoke emitter is the
/// production path for v1.0; the Roslyn-fork escape valve referenced in
/// earlier comments here has been removed from the tree.
/// </remarks>

internal sealed partial class ReflectionMetadataEmitter
{


    internal EntityHandle GetMethodEntityHandle(MethodInfo method, ImmutableArray<TypeSymbol> typeArgSymbols, TypeSymbol containingTypeSymbol)
    {
        if (TryCreateMemberReferenceForConstructedSymbolicContainer(method, containingTypeSymbol, out var symbolicRef))
        {
            if (!method.IsGenericMethod || method.IsGenericMethodDefinition)
            {
                return symbolicRef;
            }

            var symbolicClosedArgs = method.GetGenericArguments();
            var symbolicSigBlob = new BlobBuilder();
            var symbolicArgsEncoder = new BlobEncoder(symbolicSigBlob).MethodSpecificationSignature(symbolicClosedArgs.Length);
            for (var i = 0; i < symbolicClosedArgs.Length; i++)
            {
                if (!typeArgSymbols.IsDefaultOrEmpty
                    && i < typeArgSymbols.Length
                    && ArgIsSymbolicUserDefined(typeArgSymbols[i]))
                {
                    this.EncodeTypeSymbol(symbolicArgsEncoder.AddArgument(), typeArgSymbols[i]);
                }
                else
                {
                    this.EncodeClrType(symbolicArgsEncoder.AddArgument(), symbolicClosedArgs[i]);
                }
            }

            return this.emitCtx.Metadata.AddMethodSpecification(symbolicRef, this.emitCtx.Metadata.GetOrAddBlob(symbolicSigBlob));
        }

        if (!method.IsGenericMethod || method.IsGenericMethodDefinition)
        {
            return this.GetMethodReference(method);
        }

        // The placeholder-closed MethodInfo is identical across distinct
        // user-type arguments (all close to <object>), so the cache must be keyed
        // by the symbol arguments too. Issue #420 (P3-7): previously this case
        // bypassed the cache entirely, producing duplicate MethodSpec rows when
        // the same generic method was referenced multiple times with the same
        // user-type generic args.
        var hasSymbolArgs = !typeArgSymbols.IsDefaultOrEmpty
            && typeArgSymbols.Any(ArgIsSymbolicUserDefined);
        if (!hasSymbolArgs)
        {
            if (this.cache.MethodSpecs.TryGetValue(method, out var existing))
            {
                return existing;
            }
        }
        else
        {
            var symbolKey = new MetadataTokenCache.MethodSpecSymbolKey(method, typeArgSymbols);
            if (this.cache.MethodSpecsWithSymbolArgs.TryGetValue(symbolKey, out var existingSym))
            {
                return existingSym;
            }
        }

        var openDef = method.GetGenericMethodDefinition();
        var openRef = this.GetMethodReference(openDef);

        var closedArgs = method.GetGenericArguments();
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(closedArgs.Length);
        for (var i = 0; i < closedArgs.Length; i++)
        {
            // Issue #320: encode a user-defined type argument via its symbol so it
            // resolves to the emitted TypeDef; BCL arguments use the closed CLR type.
            // Issue #671: also recurse through nested constructed generics so a
            // `MyGeneric<List<MyGs>>` argument is encoded symbolically rather than
            // collapsing to System.Object at the placeholder.
            if (!typeArgSymbols.IsDefaultOrEmpty
                && i < typeArgSymbols.Length
                && ArgIsSymbolicUserDefined(typeArgSymbols[i]))
            {
                this.EncodeTypeSymbol(argsEncoder.AddArgument(), typeArgSymbols[i]);
            }
            else
            {
                this.EncodeClrType(argsEncoder.AddArgument(), closedArgs[i]);
            }
        }

        var spec = this.emitCtx.Metadata.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        if (!hasSymbolArgs)
        {
            this.cache.MethodSpecs[method] = spec;
        }
        else
        {
            this.cache.MethodSpecsWithSymbolArgs[new MetadataTokenCache.MethodSpecSymbolKey(method, typeArgSymbols)] = spec;
        }

        return spec;
    }

    private static MethodInfo ResolveMethodOnOpenDefinition(Type openDefinition, MethodInfo method)
    {
        if (openDefinition == null)
        {
            return method;
        }

        if (method.DeclaringType == openDefinition)
        {
            return method;
        }

        foreach (var candidate in openDefinition.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module)
            {
                return candidate;
            }
        }

        var fallback = openDefinition.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            .FirstOrDefault(candidate =>
                candidate.Name == method.Name
                && candidate.IsStatic == method.IsStatic
                && candidate.IsGenericMethod == method.IsGenericMethod
                && candidate.GetParameters().Length == method.GetParameters().Length);
        return fallback ?? method;
    }

    /// <summary>
    /// Issue #832 (mirrors the property variant above for instance method calls):
    /// when an instance method call's receiver is a symbolic open-generic
    /// container (e.g. <c>Queue[T]</c> with an in-scope <c>T</c>), the call's
    /// MemberRef parent is encoded as the symbolic generic instantiation, so
    /// the runtime stack value after <c>callvirt</c> is the substituted
    /// symbolic return type (<c>!T</c>) — NOT the closed CLR <c>object</c>
    /// that <see cref="MethodInfo.ReturnType"/> reports for the type-erased
    /// closed method. Returning that substituted return to the body emitter
    /// lets the erasure-widening short-circuit, avoiding a verifier-breaking
    /// (and runtime-crashing) <c>unbox.any T</c> when the result is discarded
    /// or otherwise consumed at the open-T slot.
    /// </summary>
    /// <param name="receiverType">The receiver's type as seen by the body emitter.</param>
    /// <param name="method">The closed-CLR method selected by the lowerer.</param>
    /// <param name="substitutedReturn">The substituted symbolic return type, on success.</param>
    /// <returns><see langword="true"/> when the receiver is a symbolic
    /// open-generic container and the substituted return resolves to a
    /// non-error symbolic type.</returns>
    internal bool TryGetSymbolicSubstitutedInstanceMethodReturn(
        TypeSymbol receiverType,
        MethodInfo method,
        out TypeSymbol substitutedReturn)
    {
        substitutedReturn = null;
        if (method == null
            || !TryNormalizeToSymbolicContainer(receiverType, out var openDef, out var typeArguments)
            || typeArguments.IsDefaultOrEmpty
            || !(typeArguments.Any(TypeSymbol.ContainsTypeParameter) || typeArguments.Any(ArgIsSymbolicUserDefined)))
        {
            return false;
        }

        var openMethod = ResolveMethodOnOpenDefinition(openDef, method);
        if (openMethod == null)
        {
            return false;
        }

        var openReturn = openMethod.ReturnType;
        if (openReturn == null || openReturn.IsSameAs(typeof(void)))
        {
            return false;
        }

        substitutedReturn = MemberLookup.MapOpenClrTypeToSymbolic(openReturn, openDef, typeArguments);
        return substitutedReturn != null && substitutedReturn != TypeSymbol.Error;
    }

    /// <summary>
    /// Issue #903: when a generic imported (extension) call — e.g. a LINQ
    /// <c>Single</c>/<c>First</c>/<c>Last</c> whose open return type is a bare
    /// method type parameter <c>TSource</c> — is closed over a
    /// same-compilation user element type (<c>List[Check].Single(…)</c> where
    /// <c>Check</c> is a <see cref="StructSymbol"/> struct/class still being
    /// compiled), <see cref="GetMethodEntityHandle(MethodInfo, ImmutableArray{TypeSymbol})"/>
    /// encodes a MethodSpec whose type argument is the symbolic <c>Check</c>
    /// (via <see cref="ArgIsSymbolicUserDefined"/>). The emitted call therefore
    /// returns the reprojected element type directly on the stack — a raw
    /// <c>Check</c> value for a struct, a <c>Check</c> reference for a class —
    /// NOT the type-erased <c>object</c> that the placeholder-closed
    /// <see cref="MethodInfo.ReturnType"/> reports.
    /// <para>
    /// Without this guard the body emitter would feed that erased
    /// <c>object</c> placeholder into <c>EmitErasedObjectReturnWidening</c>,
    /// which for a value-type element emits a spurious <c>unbox.any Check</c>
    /// against a stack slot that already holds a <c>Check</c> value (ilverify
    /// <c>StackUnexpected</c>/<c>StackObjRef</c> and a runtime crash), and for
    /// a reference-type element emits a redundant <c>castclass</c>. Returning
    /// the substituted symbolic return lets the caller short-circuit the
    /// widening, exactly as the instance-method and property variants above do
    /// for symbolic open-generic containers.
    /// </para>
    /// </summary>
    /// <param name="method">The placeholder-closed generic method selected by overload resolution.</param>
    /// <param name="typeArgSymbols">The per-MVar symbolic type arguments carried by the bound call (issue #903 surfaces same-compilation user types here).</param>
    /// <param name="substitutedReturn">The reprojected symbolic return type, on success.</param>
    /// <returns><see langword="true"/> when the call's symbolic type arguments
    /// reproject the open return type to a same-compilation user type, so the
    /// erasure-widening must be skipped.</returns>
    internal bool TryGetSymbolicSubstitutedImportedCallReturn(
        MethodInfo method,
        ImmutableArray<TypeSymbol> typeArgSymbols,
        out TypeSymbol substitutedReturn)
    {
        substitutedReturn = null;
        if (method == null
            || !method.IsGenericMethod
            || typeArgSymbols.IsDefaultOrEmpty
            || !typeArgSymbols.Any(ArgIsSymbolicUserDefined))
        {
            return false;
        }

        var openMethod = method.IsGenericMethodDefinition ? method : method.GetGenericMethodDefinition();
        var openReturn = openMethod.ReturnType;
        if (openReturn == null || openReturn.IsSameAs(typeof(void)))
        {
            return false;
        }

        // Map the open return signature through the symbolic method type
        // arguments only (no receiver/type-level substitution): a bare
        // `TSource` return resolves to the symbolic element type, while a
        // constructed `IEnumerable<TResult>` return resolves to a symbolic
        // instantiation. Either way, only a projection that actually surfaces
        // a same-compilation user type means the MethodSpec deviates from the
        // erased `object` placeholder and the widening must be suppressed.
        var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openReturn, null, default, openMethod, typeArgSymbols);
        if (mapped == null || mapped == TypeSymbol.Error)
        {
            return false;
        }

        if (!TypeSymbol.ContainsSameCompilationUserType(mapped))
        {
            return false;
        }

        substitutedReturn = mapped;
        return true;
    }

    /// <summary>
    /// Phase 4 emit parity: get a MemberRef for a CLR instance constructor on a
    /// possibly type-erased generic declaring type. When
    /// <paramref name="containingTypeSymbol"/> is an
    /// <see cref="ImportedTypeSymbol"/> whose <see cref="ImportedTypeSymbol.TypeArguments"/>
    /// contain one or more G# user-defined types (issue #671), the parent
    /// TypeSpec is encoded against those symbolic arguments (resolving to the
    /// real user-defined TypeDef tokens) instead of the type-erased
    /// <c>Open&lt;object,…&gt;</c> shape carried by <paramref name="ctor"/>.
    /// </summary>
    /// <param name="ctor">The (possibly type-erased) constructor selected by overload resolution.</param>
    /// <param name="containingTypeSymbol">The bound result type of the construction expression. May be <see langword="null"/>.</param>
    /// <returns>A MemberRef handle for the constructor on the correctly-typed parent.</returns>
    internal MemberReferenceHandle GetCtorReference(ConstructorInfo ctor, TypeSymbol containingTypeSymbol)
    {
        // Issue #671: when the containing type carries symbolic user-type
        // arguments, the cache key needs to discriminate per symbol set
        // (multiple distinct user-type closures share a single type-erased
        // ConstructorInfo).
        if (TryCreateCtorMemberReferenceForConstructedSymbolicContainer(ctor, containingTypeSymbol, out var symbolicHandle))
        {
            return symbolicHandle;
        }

        if (this.cache.CtorRefs.TryGetValue(ctor, out var existing))
        {
            return existing;
        }

        var declaring = ctor.DeclaringType
            ?? throw new InvalidOperationException("Imported constructor has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);
        var openCtor = GetOpenCtor(ctor);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            // out/ref parameter (e.g. an interpolated-string
                            // handler ctor's `out bool shouldAppend`): emit the
                            // BYREF prefix, then encode the element type.
                            this.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.CtorRefs[ctor] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #671: builds a constructor MemberRef whose parent TypeSpec is
    /// encoded from the original symbolic type arguments (resolving to G#
    /// user-defined TypeDef tokens) rather than the type-erased
    /// <c>Open&lt;object,…&gt;</c> shape baked into the constructor's
    /// <see cref="MemberInfo.DeclaringType"/>. Mirrors the method
    /// counterpart in <see cref="TryCreateMemberReferenceForConstructedSymbolicContainer"/>.
    /// </summary>
    /// <param name="ctor">The (type-erased) constructor.</param>
    /// <param name="containingTypeSymbol">The bound type of the call's result; expected to be an <see cref="ImportedTypeSymbol"/> carrying user-defined type args.</param>
    /// <param name="handle">On success, the new MemberRef handle.</param>
    /// <returns>Whether a symbolic-container MemberRef was produced.</returns>
    private bool TryCreateCtorMemberReferenceForConstructedSymbolicContainer(
        ConstructorInfo ctor,
        TypeSymbol containingTypeSymbol,
        out MemberReferenceHandle handle)
    {
        handle = default;
        if (ctor == null
            || containingTypeSymbol is not ImportedTypeSymbol imported
            || imported.OpenDefinition == null
            || imported.TypeArguments.IsDefaultOrEmpty
            || !(imported.HasTypeParameterArgument || imported.TypeArguments.Any(ArgIsSymbolicUserDefined)))
        {
            return false;
        }

        var cacheKey = new MetadataTokenCache.CtorRefSymbolKey(ctor, imported.TypeArguments);
        if (this.cache.CtorRefsWithSymbolArgs.TryGetValue(cacheKey, out var cached))
        {
            handle = cached;
            return true;
        }

        var parentBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), imported);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));
        var openCtor = ResolveCtorOnOpenDefinition(imported.OpenDefinition, ctor);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            this.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.CtorRefsWithSymbolArgs[cacheKey] = handle;
        return true;
    }

    private static ConstructorInfo ResolveCtorOnOpenDefinition(Type openDefinition, ConstructorInfo ctor)
    {
        if (openDefinition == null)
        {
            return ctor;
        }

        if (ctor.DeclaringType == openDefinition)
        {
            return ctor;
        }

        foreach (var candidate in openDefinition.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == ctor.MetadataToken && candidate.Module == ctor.Module)
            {
                return candidate;
            }
        }

        var fallback = openDefinition.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .FirstOrDefault(candidate => candidate.GetParameters().Length == ctor.GetParameters().Length);
        return fallback ?? ctor;
    }

    /// <summary>
    /// Issue #814 / ADR-0084 §L5: builds a <c>MemberRef</c> parented at the
    /// <c>TypeSpec</c> for <c>System.Nullable`1&lt;!!T&gt;</c> with signature
    /// <c>instance void .ctor(!0)</c>. The CLR substitutes <c>!0</c> against
    /// the parent's first generic argument at call time, so a single
    /// MemberRef serves every instantiation. Used by the
    /// <c>T → Nullable&lt;T&gt;</c> value-type lift when <c>T</c> is an open
    /// type parameter constrained to <c>struct</c> — the closed
    /// <see cref="ConstructorInfo"/> we normally route through
    /// <see cref="GetCtorReference(ConstructorInfo)"/> is unavailable because
    /// <see cref="TypeParameterSymbol"/> has no <see cref="Type"/>.
    /// </summary>
    /// <param name="nullableOfTp">A <see cref="NullableTypeSymbol"/> whose underlying type is an open <see cref="TypeParameterSymbol"/>.</param>
    /// <returns>The MemberRef handle for <c>Nullable&lt;!!T&gt;::.ctor(!0)</c>.</returns>
    internal MemberReferenceHandle GetNullableCtorMemberRefForOpenTypeParameter(NullableTypeSymbol nullableOfTp)
    {
        if (nullableOfTp?.UnderlyingType is not TypeParameterSymbol tp)
        {
            throw new InvalidOperationException(
                "GetNullableCtorMemberRefForOpenTypeParameter requires Nullable<TypeParameter>.");
        }

        if (this.cache.NullableOpenCtorMemberRefs.TryGetValue(tp, out var cached))
        {
            return cached;
        }

        var parentBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfTp);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameterCount: 1,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    // `!0`: the parent TypeSpec's first generic parameter
                    // (i.e. the inner type that Nullable<> is closed over).
                    ps.AddParameter().Type().GenericTypeParameter(0);
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.NullableOpenCtorMemberRefs[tp] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #1298: gets a MemberRef for <c>System.Nullable`1&lt;E&gt;::.ctor(!0)</c>
    /// where <c>E</c> is a user-declared enum emitted in this assembly. The
    /// enum has no runtime CLR type, so the BCL-backed
    /// <see cref="WellKnownReferences"/> ctor path cannot construct it; instead
    /// the parent TypeSpec closes <c>Nullable&lt;&gt;</c> over the enum's TypeDef
    /// and the ctor signature refers to that argument as <c>!0</c>. Mirrors
    /// <see cref="GetNullableCtorMemberRefForOpenTypeParameter"/>.
    /// </summary>
    /// <param name="nullableOfEnum">A <c>Nullable&lt;E&gt;</c> over a user enum.</param>
    /// <returns>The constructor MemberRef.</returns>
    internal MemberReferenceHandle GetNullableCtorMemberRefForUserEnum(NullableTypeSymbol nullableOfEnum)
    {
        if (nullableOfEnum?.UnderlyingType is not EnumSymbol enumSym)
        {
            throw new InvalidOperationException(
                "GetNullableCtorMemberRefForUserEnum requires Nullable<EnumSymbol>.");
        }

        if (this.cache.NullableUserEnumCtorMemberRefs.TryGetValue(enumSym, out var cached))
        {
            return cached;
        }

        var parentBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfEnum);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameterCount: 1,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    ps.AddParameter().Type().GenericTypeParameter(0);
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.NullableUserEnumCtorMemberRefs[enumSym] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a constructor on a constructed generic type without
    /// calling <c>.GetConstructors()</c> on the closed generic (which throws
    /// <see cref="NotSupportedException"/> when type arguments are MLC-loaded or
    /// TypeBuilder-backed). Resolves the constructor from the open generic type definition.
    /// </summary>
    internal MemberReferenceHandle GetCtorReferenceOnConstructedGeneric(Type closedGenericType, int paramCount)
    {
        var openType = closedGenericType.GetGenericTypeDefinition();
        ConstructorInfo openCtor = null;
        foreach (var c in openType.GetConstructors())
        {
            if (c.GetParameters().Length == paramCount)
            {
                openCtor = c;
                break;
            }
        }

        if (openCtor == null)
        {
            throw new InvalidOperationException(
                $"Open generic type '{openType.FullName}' has no constructor of arity {paramCount}.");
        }

        var parent = this.GetTypeHandleForMember(closedGenericType);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            this.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return handle;
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a tuple constructor when the tuple's
    /// <see cref="TypeSymbol.ClrType"/> is null (element types include G#-defined
    /// types). Builds the ctor MemberRef against the symbolically-constructed
    /// <c>ValueTuple</c> TypeSpec.
    /// </summary>
    internal MemberReferenceHandle GetTupleCtorReference(TupleTypeSymbol tupleType)
    {
        var parent = this.GetTupleTypeSpec(tupleType);
        var arity = tupleType.Arity;

        var openType = arity switch
        {
            2 => typeof(ValueTuple<,>),
            3 => typeof(ValueTuple<,,>),
            4 => typeof(ValueTuple<,,,>),
            5 => typeof(ValueTuple<,,,,>),
            6 => typeof(ValueTuple<,,,,,>),
            7 => typeof(ValueTuple<,,,,,,>),
            _ => throw new NotSupportedException(
                $"Symbolic tuple ctor ref not supported for arity {arity}."),
        };

        ConstructorInfo openCtor = null;
        foreach (var c in openType.GetConstructors())
        {
            if (c.GetParameters().Length == arity)
            {
                openCtor = c;
                break;
            }
        }

        if (openCtor == null)
        {
            throw new InvalidOperationException(
                $"Open ValueTuple type of arity {arity} has no matching constructor.");
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        this.EncodeClrType(ps.AddParameter().Type(), p.ParameterType);
                    }
                });

        return this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): encodes a single local-variable signature slot.
    /// A <see cref="ByRefTypeSymbol"/> entry signals a ref-aliasing local (<c>let ref</c> /
    /// <c>var ref</c>) whose slot must carry <c>ELEMENT_TYPE_BYREF</c> wrapping the pointee
    /// type. Non-byref entries forward to <see cref="EncodeTypeSymbol"/> unchanged.
    /// </summary>
    private void EncodeLocalVariableType(LocalVariableTypeEncoder enc, TypeSymbol t)
    {
        // ADR-0125 / issue #1026: a `fixed` statement's pinned local carries the
        // CLR `pinned` flag so the GC cannot relocate the pinned buffer. The
        // underlying storage is either a managed by-ref (`T& pinned`, string
        // form) or an ordinary managed type such as the array (`T[] pinned`,
        // array form).
        if (t is PinnedTypeSymbol pinned)
        {
            if (pinned.UnderlyingType is ByRefTypeSymbol pinnedByRef)
            {
                EncodeTypeSymbol(enc.Type(isByRef: true, isPinned: true), pinnedByRef.PointeeType);
            }
            else
            {
                EncodeTypeSymbol(enc.Type(isByRef: false, isPinned: true), pinned.UnderlyingType);
            }

            return;
        }

        if (t is ByRefTypeSymbol byRef)
        {
            EncodeTypeSymbol(enc.Type(isByRef: true), byRef.PointeeType);
        }
        else
        {
            EncodeTypeSymbol(enc.Type(), t);
        }
    }

    /// <summary>
    /// ADR-0122 §9 / issue #1035: builds a standalone method signature for a
    /// function-pointer type, used as the operand of the CIL <c>calli</c>
    /// opcode. Managed function pointers use the default managed calling
    /// convention; unmanaged ones carry their declared ABI.
    /// </summary>
    /// <param name="fnPtr">The function-pointer type to sign.</param>
    /// <returns>A standalone signature handle for <c>calli</c>.</returns>
    internal StandaloneSignatureHandle GetFunctionPointerCallSiteSignature(FunctionPointerTypeSymbol fnPtr)
    {
        var convention = fnPtr.IsManaged
            ? System.Reflection.Metadata.SignatureCallingConvention.Default
            : MapToSignatureCallingConvention(fnPtr.CallingConvention);
        var sigBlob = new BlobBuilder();
        var sig = new BlobEncoder(sigBlob).MethodSignature(convention, 0, isInstanceMethod: false);
        sig.Parameters(fnPtr.ParameterTypes.Length, out var retEnc, out var paramsEnc);
        this.EncodeReturnSymbol(retEnc, fnPtr.ReturnType);
        for (var i = 0; i < fnPtr.ParameterTypes.Length; i++)
        {
            this.EncodeTypeSymbol(paramsEnc.AddParameter().Type(), fnPtr.ParameterTypes[i]);
        }

        return this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// ADR-0095 / issue #761: maps the
    /// <see cref="System.Runtime.InteropServices.CallingConvention"/>
    /// enum (used by <c>@DllImport</c> / <c>@UnmanagedFunctionPointer</c>
    /// declarations and by <see cref="FunctionPointerTypeSymbol"/>) to
    /// the metadata-level
    /// <see cref="System.Reflection.Metadata.SignatureCallingConvention"/>
    /// enum used when encoding an ELEMENT_TYPE_FNPTR signature blob.
    /// </summary>
    private static System.Reflection.Metadata.SignatureCallingConvention MapToSignatureCallingConvention(System.Runtime.InteropServices.CallingConvention convention)
    {
        return convention switch
        {
            System.Runtime.InteropServices.CallingConvention.Cdecl => System.Reflection.Metadata.SignatureCallingConvention.CDecl,
            System.Runtime.InteropServices.CallingConvention.StdCall => System.Reflection.Metadata.SignatureCallingConvention.StdCall,
            System.Runtime.InteropServices.CallingConvention.ThisCall => System.Reflection.Metadata.SignatureCallingConvention.ThisCall,
            System.Runtime.InteropServices.CallingConvention.FastCall => System.Reflection.Metadata.SignatureCallingConvention.FastCall,
            System.Runtime.InteropServices.CallingConvention.Winapi => System.Reflection.Metadata.SignatureCallingConvention.StdCall,
            _ => System.Reflection.Metadata.SignatureCallingConvention.CDecl,
        };
    }

    /// <summary>
    /// ADR-0087 §3 R6: encodes a <see cref="FunctionTypeSymbol"/> whose
    /// shape carries type-parameter slots (e.g. <c>func(T) U</c>) as a
    /// reified <c>GENERICINST&lt;Func`N or Action`N&gt;&lt;args&gt;</c>
    /// blob. Each argument is encoded recursively through
    /// <see cref="EncodeTypeSymbol"/>, so type parameters resolve to the
    /// proper <c>Var(idx)</c> / <c>MVar(idx)</c> slots.
    /// </summary>
    internal void EncodeFunctionTypeSymbol(SignatureTypeEncoder encoder, FunctionTypeSymbol fnType)
    {
        bool isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType);
        int arity = fnType.ParameterTypes.Length;

        if (isVoid && arity == 0)
        {
            var actionType = this.emitCtx.References.GetCoreType("System.Action");
            this.EncodeClrType(encoder, actionType);
            return;
        }

        var typeName = isVoid
            ? "System.Action`" + arity.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : "System.Func`" + (arity + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var openDef = this.emitCtx.References.GetCoreType(typeName);
        var openHandle = this.GetTypeReference(openDef);
        int typeArgCount = arity + (isVoid ? 0 : 1);
        var gi = encoder.GenericInstantiation(openHandle, typeArgCount, isValueType: openDef.IsValueType);
        for (int i = 0; i < arity; i++)
        {
            this.EncodeTypeSymbol(gi.AddArgument(), fnType.ParameterTypes[i]);
        }

        if (!isVoid)
        {
            this.EncodeTypeSymbol(gi.AddArgument(), fnType.ReturnType);
        }
    }

    /// <summary>
    /// ADR-0087 §3 R6: returns a <c>TypeSpec</c> EntityHandle for the
    /// reified <c>Func&lt;...&gt;</c> / <c>Action&lt;...&gt;</c> shape
    /// backing <paramref name="fnType"/>. Type-parameter arguments encode
    /// as <c>Var(idx)</c> / <c>MVar(idx)</c>.
    /// </summary>
    internal EntityHandle GetFunctionDelegateTypeSpec(FunctionTypeSymbol fnType)
    {
        if (this.functionDelegateTypeSpecCache.TryGetValue(fnType, out var cached))
        {
            return cached;
        }

        var sigBlob = new BlobBuilder();
        this.EncodeFunctionTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), fnType);
        var spec = (EntityHandle)this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.functionDelegateTypeSpecCache[fnType] = spec;
        return spec;
    }

    /// <summary>
    /// ADR-0087 §3 R6: returns the MemberRef handle for the reified
    /// delegate's <c>.ctor(object, IntPtr)</c>, parented at the
    /// <c>TypeSpec</c> for <paramref name="fnType"/>. Used by
    /// <c>EmitFunctionLiteral</c> / <c>EmitMethodGroup</c> when the
    /// function type contains type-parameter slots.
    /// </summary>
    internal EntityHandle GetFunctionDelegateCtorRef(FunctionTypeSymbol fnType)
    {
        if (this.functionDelegateCtorRefCache.TryGetValue(fnType, out var cached))
        {
            return cached;
        }

        var parent = this.GetFunctionDelegateTypeSpec(fnType);

        // Every Func/Action delegate exposes the canonical
        // .ctor(object target, IntPtr methodPtr) signature; identical
        // for every arity so no Var/MVar slots are needed.
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                2,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    ps.AddParameter().Type().Object();
                    ps.AddParameter().Type().IntPtr();
                });

        var handle = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.functionDelegateCtorRefCache[fnType] = handle;
        return handle;
    }
}
