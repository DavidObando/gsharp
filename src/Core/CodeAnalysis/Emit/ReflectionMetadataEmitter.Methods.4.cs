// <copyright file="ReflectionMetadataEmitter.Methods.4.cs" company="GSharp">
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


    /// <summary>
    /// ADR-0092 / issue #758: emits an <c>@LibraryImport</c> function as a
    /// pair of MethodDef rows — the user-visible managed stub (planned at
    /// <c>cache.FunctionHandles[function]</c>) and a hidden blittable inner
    /// P/Invoke (planned at <c>cache.LibraryImportInnerHandles[function]</c>).
    /// The stub:
    /// <list type="bullet">
    ///   <item>For each <c>string</c> parameter, marshals it explicitly into
    ///         a CoTaskMem buffer (UTF-8 or UTF-16 per the resolved
    ///         <see cref="System.Runtime.InteropServices.StringMarshalling"/>
    ///         mode) and stores the resulting <c>IntPtr</c> in a local.</item>
    ///   <item>Calls the inner P/Invoke inside a <c>try</c> block, passing
    ///         the marshalled <c>IntPtr</c> in place of each <c>string</c>
    ///         parameter.</item>
    ///   <item>Frees the marshalled buffers in a <c>finally</c> block via
    ///         <see cref="Marshal.FreeCoTaskMem(IntPtr)"/>, which is a no-op
    ///         on <see cref="IntPtr.Zero"/>.</item>
    /// </list>
    /// The result is verifiable IL that has no runtime marshalling stub —
    /// every transition is explicit and AOT-publishable.
    /// </summary>
    /// <param name="function">The <c>@LibraryImport</c> function symbol.</param>
    /// <returns>The handle of the emitted outer managed stub.</returns>
    private MethodDefinitionHandle EmitLibraryImportFunction(FunctionSymbol function)
    {
        var pInvoke = function.PInvokeMetadata;

        // Plan which parameters need string marshalling. Indices are into
        // the function's parameter list.
        var stringParamIndices = new List<int>();
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            if (function.Parameters[i].Type == TypeSymbol.String)
            {
                stringParamIndices.Add(i);
            }
        }

        var innerMethodRef = this.cache.LibraryImportInnerHandles[function];

        // === Outer managed stub ===
        var outerSigBlob = new BlobBuilder();
        new BlobEncoder(outerSigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                function.Parameters.Length,
                r => EncodeReturnSymbol(r, function.Type, function.ReturnRefKind),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });

        var outerVisibility = AccessibilityMap.ToMethodVisibility(function.Accessibility, AccessibilityMap.IsTopLevelProgramMember(function));
        var outerMethodAttrs = outerVisibility | MethodAttributes.HideBySig | MethodAttributes.Static;
        var outerImplAttrs = MethodImplAttributes.IL | MethodImplAttributes.Managed;

        // Allocate outer Parameter rows BEFORE the inner ones so they
        // line up with the outer MethodDef row.
        var outerFirstParam = this.customAttrEncoder.NextParameterHandle();
        var outerParamHandles = new List<(ParameterSymbol Symbol, ParameterHandle Handle)>();
        var outerSeq = 1;
        foreach (var p in function.Parameters)
        {
            // ADR-0096 / issue #762: stamp HasFieldMarshal on the outer
            // Param row when the parameter carries an `@MarshalAs(...)`
            // override. The outer stub uses the user-visible managed
            // type (e.g. `int32`) so the override applies here; the
            // inner blittable P/Invoke has no FieldMarshal row.
            var outerParamAttrs = ParameterAttributes.None;
            if (p.MarshalAsMetadata != null)
            {
                outerParamAttrs |= ParameterAttributes.HasFieldMarshal;
            }

            var paramHandle = this.emitCtx.Metadata.AddParameter(
                attributes: outerParamAttrs,
                name: this.emitCtx.Metadata.GetOrAddString(p.Name ?? string.Empty),
                sequenceNumber: outerSeq++);
            outerParamHandles.Add((p, paramHandle));

            if (p.MarshalAsMetadata != null)
            {
                EmitFieldMarshalRow(paramHandle, p.MarshalAsMetadata);
            }
        }

        // Build the IL body of the outer stub.
        var (outerBodyOffset, outerLocalsSig) = EmitLibraryImportOuterBody(function, stringParamIndices, innerMethodRef);

        var outerMethodHandle = this.emitCtx.Metadata.AddMethodDefinition(
            attributes: outerMethodAttrs,
            implAttributes: outerImplAttrs,
            name: this.emitCtx.Metadata.GetOrAddString(function.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(outerSigBlob),
            bodyOffset: outerBodyOffset,
            parameterList: outerFirstParam);

        // Surface user-written method-target attributes other than the
        // @LibraryImport itself (which is fully consumed by the inner
        // ImplMap row — duplicating it as a CustomAttribute would create
        // a misleading reflection view).
        this.customAttrEncoder.EmitUserAttributesExcept(outerMethodHandle, function, AttributeTargetKind.Method, KnownAttributes.IsLibraryImport);

        foreach (var (paramSym, paramHandle) in outerParamHandles)
        {
            this.customAttrEncoder.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param);
        }

        // === Inner blittable P/Invoke ===
        var innerSigBlob = new BlobBuilder();
        new BlobEncoder(innerSigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                function.Parameters.Length,
                r => EncodeReturnSymbol(r, function.Type, function.ReturnRefKind),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        var slot = ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None);
                        if (p.Type == TypeSymbol.String)
                        {
                            // Marshal-as-IntPtr — the blittable form the
                            // outer stub passes after explicit marshalling.
                            slot.IntPtr();
                        }
                        else
                        {
                            EncodeTypeSymbol(slot, p.Type);
                        }
                    }
                });

        // The inner method is private static, PinvokeImpl, PreserveSig.
        // No body. PinvokeImpl with no managed IL: bodyOffset = -1, IL +
        // Managed + PreserveSig (matching the @DllImport emit shape).
        var innerMethodAttrs = MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.Static | MethodAttributes.PinvokeImpl;
        var innerImplAttrs = MethodImplAttributes.IL | MethodImplAttributes.Managed | MethodImplAttributes.PreserveSig;

        var innerFirstParam = this.customAttrEncoder.NextParameterHandle();
        var innerSeq = 1;
        foreach (var p in function.Parameters)
        {
            this.emitCtx.Metadata.AddParameter(
                attributes: ParameterAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(p.Name ?? string.Empty),
                sequenceNumber: innerSeq++);
        }

        var innerName = "<" + function.Name + ">g__PInvoke|0_0";
        var innerMethodHandle = this.emitCtx.Metadata.AddMethodDefinition(
            attributes: innerMethodAttrs,
            implAttributes: innerImplAttrs,
            name: this.emitCtx.Metadata.GetOrAddString(innerName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(innerSigBlob),
            bodyOffset: -1,
            parameterList: innerFirstParam);

        // Sanity check: the planned row must match the row we just emitted.
        if (innerMethodHandle != innerMethodRef)
        {
            throw new InvalidOperationException(
                $"LibraryImport inner-method row mismatch for '{function.Name}': planned {MetadataTokens.GetRowNumber(innerMethodRef)}, emitted {MetadataTokens.GetRowNumber(innerMethodHandle)}.");
        }

        // ModuleRef (deduplicated by library name, same cache as @DllImport).
        if (!this.cache.PInvokeModuleRefs.TryGetValue(pInvoke.LibraryName, out var moduleRef))
        {
            moduleRef = this.emitCtx.Metadata.AddModuleReference(this.emitCtx.Metadata.GetOrAddString(pInvoke.LibraryName));
            this.cache.PInvokeModuleRefs[pInvoke.LibraryName] = moduleRef;
        }

        var importAttrs = MapPInvokeImportAttributes(pInvoke);
        this.emitCtx.Metadata.AddMethodImport(
            innerMethodHandle,
            importAttrs,
            this.emitCtx.Metadata.GetOrAddString(pInvoke.EntryPoint ?? function.Name),
            moduleRef);

        return outerMethodHandle;
    }

    // -----------------------------------------------------------------
    // ADR-0087 §3 R3: user-defined generic-type TypeSpec / MemberRef
    // plumbing. After R1 a user-declared generic TypeDef carries
    // GenericParam rows and a backtick-arity name; after R2 its
    // field/parameter/return signatures encode VAR(idx)/MVAR(idx).
    // CLR verification then rejects any body reference (`ldfld`,
    // `stfld`, `call`, `newobj`, `callvirt`, `isinst`, `unbox`,
    // `unbox.any`) that targets the bare TypeDef row or a bare
    // FieldDef/MethodDef on it — every such reference must go through
    // a MemberRef parented at a TypeSpec naming the instantiation
    // (the self-instantiation `Box`1<!0,...>` for the type's own
    // bodies, the constructed instantiation `Box`1<int32>` for
    // external uses). The helpers below provide that routing.
    // -----------------------------------------------------------------

    /// <summary>
    /// ADR-0087 §3 R3+R4: builds a MethodSpec for a generic G# user
    /// function call. Derives the type arguments from the call's
    /// arguments and substituted return type. Required because the
    /// post-R2 MethodDef carries MVAR slots; the call site must
    /// reference a MethodSpec naming the substituted instantiation.
    /// </summary>
    internal EntityHandle BuildMethodSpecForGenericCall(EntityHandle openMethod, BoundCallExpression call)
    {
        var tps = call.Function.TypeParameters;
        var args = new TypeSymbol[tps.Length];
        for (int i = 0; i < tps.Length; i++)
        {
            args[i] = InferMethodTypeArgument(call.Function, call.Arguments, call.ReturnType, tps[i]);
        }

        return this.BuildMethodSpec(openMethod, args);
    }

    /// <summary>
    /// ADR-0087 §3 R3+R4: builds a MethodSpec for a generic G# user
    /// instance method call (`h.Box[int32](42)`). Same inference rules
    /// as <see cref="BuildMethodSpecForGenericCall"/>.
    /// </summary>
    internal EntityHandle BuildMethodSpecForGenericInstanceCall(EntityHandle openMethod, BoundUserInstanceCallExpression call)
    {
        var tps = call.Method.TypeParameters;
        var args = new TypeSymbol[tps.Length];
        var calleeParameterOffset = call.Method.ExplicitReceiverParameter == null ? 0 : 1;

        // The user-instance call's Arguments excludes the receiver,
        // but Method.Parameters includes the explicit receiver (when
        // present) at index 0. We pass a sliced view to the inference
        // helper so positional indices line up.
        var userParams = call.Method.Parameters;
        if (calleeParameterOffset > 0)
        {
            userParams = call.Method.Parameters.RemoveAt(0);
        }

        for (int i = 0; i < tps.Length; i++)
        {
            args[i] = InferMethodTypeArgument(userParams, call.Arguments, call.Type, call.Method.Type, tps[i]);
        }

        return this.BuildMethodSpec(openMethod, args);
    }

    private EntityHandle BuildMethodSpec(EntityHandle openMethod, TypeSymbol[] args)
    {
        var sigBlob = new BlobBuilder();
        var argsEnc = new BlobEncoder(sigBlob).MethodSpecificationSignature(args.Length);
        for (int i = 0; i < args.Length; i++)
        {
            this.EncodeTypeSymbol(argsEnc.AddArgument(), args[i]);
        }

        return this.emitCtx.Metadata.AddMethodSpecification(openMethod, this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    private static TypeSymbol InferMethodTypeArgument(FunctionSymbol fn, ImmutableArray<BoundExpression> args, TypeSymbol substitutedReturn, TypeParameterSymbol tp)
    {
        return InferMethodTypeArgument(fn.Parameters, args, substitutedReturn, fn.Type, tp);
    }

    private static TypeSymbol InferMethodTypeArgument(
        ImmutableArray<ParameterSymbol> formalParams,
        ImmutableArray<BoundExpression> actualArgs,
        TypeSymbol substitutedReturn,
        TypeSymbol formalReturn,
        TypeParameterSymbol tp)
    {
        // ADR-0087 §3 R3+R4: structural unification across the formal/
        // actual parameter shapes finds the substituted type for `tp`.
        // Covers `Id[T](x T) T`, `Pair[A,B](first A, second B)`,
        // `Echo[T](s []T) []T`, `Wrap[T](b Box[T])`, etc. Recursive
        // higher-kinded unification (e.g. `MakeList[T]() List[T]`) is
        // R5 territory and stays out of scope here.
        for (int i = 0; i < formalParams.Length && i < actualArgs.Length; i++)
        {
            // The binder may insert a `BoundConversionExpression` widening
            // the actual to the (erased) formal type — that conversion's
            // `.Type` is the formal type, which would defeat unification.
            // Peel off the conversion to see the underlying expression's
            // pre-widening type. (We still pass the formal as-is.)
            var actualType = StripConversion(actualArgs[i]).Type;
            if (TryUnify(formalParams[i].Type, actualType, tp, out var inferred))
            {
                return inferred;
            }
        }

        if (formalReturn != null && substitutedReturn != null &&
            TryUnify(formalReturn, substitutedReturn, tp, out var fromReturn))
        {
            return fromReturn;
        }

        throw new InvalidOperationException(
            $"Cannot infer type argument for '{tp.Name}'; "
            + "the type parameter does not appear in any parameter or return shape.");
    }

    /// <summary>
    /// ADR-0087 §3 R3: returns a <c>MemberRef</c> handle for an
    /// instance method or ctor on a user-declared generic type,
    /// parented at the <c>TypeSpec</c> for <paramref name="containingType"/>.
    /// The signature is supplied by the caller (already encoded against
    /// the open definition with <c>VAR</c> slots).
    /// </summary>
    internal EntityHandle GetUserStructMethodRef(
        StructSymbol containingType,
        EntityHandle openMethodDef,
        string methodName,
        BlobBuilder signature)
    {
        var key = (containingType, openMethodDef);
        if (this.userStructMethodRefCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var parent = this.GetUserStructTypeSpec(containingType);
        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(methodName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(signature));
        this.userStructMethodRefCache[key] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// ADR-0087 §3 R3: encodes a method signature blob from a
    /// <see cref="FunctionSymbol"/>, using the OPEN definition's type
    /// information so <c>VAR(idx)</c> placeholders are produced for
    /// in-scope type-type parameters. Used to back the MemberRef
    /// signature returned by <see cref="GetUserStructMethodRef"/>.
    /// </summary>
    internal BlobBuilder EncodeOpenMethodSignature(FunctionSymbol openMethod)
    {
        var sigBlob = new BlobBuilder();
        var paramCount = openMethod.Parameters.Length - (openMethod.ExplicitReceiverParameter == null ? 0 : 1);
        new BlobEncoder(sigBlob)
            .MethodSignature(
                isInstanceMethod: openMethod.IsInstanceMethod,
                genericParameterCount: openMethod.TypeParameters.IsDefaultOrEmpty ? 0 : openMethod.TypeParameters.Length)
            .Parameters(
                paramCount,
                r => EncodeReturnSymbol(r, openMethod.Type, openMethod.ReturnRefKind),
                ps =>
                {
                    foreach (var p in openMethod.Parameters)
                    {
                        if (ReferenceEquals(p, openMethod.ThisParameter))
                        {
                            continue;
                        }

                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });
        return sigBlob;
    }

    internal EntityHandle ResolveUserInstanceMethodToken(StructSymbol containingType, FunctionSymbol method)
    {
        if (!this.cache.MethodHandles.TryGetValue(method, out var openDef))
        {
            throw new InvalidOperationException(
                $"Instance method '{method.Name}' has no emitted handle.");
        }

        if (!IsUserGenericTypeReference(containingType))
        {
            return openDef;
        }

        return this.GetUserStructMethodRef(containingType, openDef, method.Name, this.EncodeOpenMethodSignature(method));
    }

    /// <summary>
    /// Issue #1209: resolves the token for a call to a user <c>shared</c>
    /// (static) method whose declaring type is a constructed generic user type
    /// (<c>Box[int32].Make()</c>). A bare <c>MethodDef</c> token is invalid for a
    /// method of a generic type, so a <c>MemberRef</c> parented at the
    /// construction's <c>TypeSpec</c> is emitted (mirroring the static-field and
    /// static-property paths). The MemberRef signature is the open static method
    /// signature (no <c>this</c>) produced by <see cref="EncodeOpenMethodSignature"/>.
    /// </summary>
    internal EntityHandle ResolveUserStaticMethodToken(StructSymbol containingType, FunctionSymbol method)
    {
        if (!this.cache.MethodHandles.TryGetValue(method, out var openDef)
            && !this.cache.FunctionHandles.TryGetValue(method, out openDef))
        {
            throw new InvalidOperationException(
                $"Static method '{method.Name}' has no emitted handle.");
        }

        if (!IsUserGenericTypeReference(containingType))
        {
            return openDef;
        }

        return this.GetUserStructMethodRef(containingType, openDef, method.Name, this.EncodeOpenMethodSignature(method));
    }

    /// <summary>
    /// ADR-0091: returns the right token for an instance call into a
    /// user-declared interface from a derived (implementing) type — used
    /// for the <c>base[IFoo].M(...)</c> explicit-base call. Returns the
    /// bare <c>MethodDef</c> for a non-generic interface, or a
    /// <c>MemberRef</c> parented at the constructed (or self-)
    /// <c>TypeSpec</c> for a generic interface.
    /// </summary>
    internal EntityHandle ResolveUserInterfaceInstanceMethodToken(InterfaceSymbol containingInterface, FunctionSymbol openMethod)
    {
        if (!this.cache.MethodHandles.TryGetValue(openMethod, out var openDef))
        {
            throw new InvalidOperationException(
                $"Interface method '{openMethod.Name}' on '{containingInterface?.Name}' has no emitted handle.");
        }

        if (!IsUserGenericInterfaceReference(containingInterface))
        {
            return openDef;
        }

        var key = (containingInterface, openDef);
        if (this.userInterfaceMethodRefCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var parent = this.GetUserInterfaceTypeSpec(containingInterface);
        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(openMethod.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(this.EncodeOpenMethodSignature(openMethod)));
        this.userInterfaceMethodRefCache[key] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for a <c>newobj</c>
    /// against a user-declared primary ctor. Returns the bare
    /// <c>MethodDef</c> for a non-generic type, or a MemberRef
    /// parented at the constructed <c>TypeSpec</c> for a generic type.
    /// </summary>
    internal EntityHandle ResolveUserCtorTokenForPrimary(StructSymbol structType)
    {
        if (!this.cache.ClassPrimaryCtorHandles.TryGetValue(structType, out var primaryDef))
        {
            throw new InvalidOperationException($"Type '{structType.Name}' has no emitted primary ctor.");
        }

        if (!IsUserGenericTypeReference(structType))
        {
            return primaryDef;
        }

        var def = structType.Definition ?? structType;
        var defParams = def.PrimaryConstructorParameters;
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob)
            .MethodSignature(isInstanceMethod: true)
            .Parameters(
                defParams.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in defParams)
                    {
                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });
        return this.GetUserStructMethodRef(structType, primaryDef, ".ctor", sigBlob);
    }

    /// <summary>
    /// Issue #1254: resolves the base-constructor token for an explicit
    /// <c>: base(args)</c> initializer whose base is a CONSTRUCTED generic user
    /// class (e.g. <c>Derived : Base[int32]</c> chaining to <c>Base</c>'s
    /// primary or an explicit <c>init(...)</c> ctor). The base ctor's MethodDef
    /// is keyed by the open definition, so a bare token is invalid for a generic
    /// type; a MemberRef parented at the constructed base's TypeSpec is emitted
    /// with the open ctor's signature (type-parameter slots encode as VAR).
    /// </summary>
    internal EntityHandle ResolveConstructedBaseExplicitCtorToken(StructSymbol constructedBase, ConstructorSymbol ctor)
    {
        if (ctor == null || !this.cache.ExplicitCtorHandles.TryGetValue(ctor, out var ctorDef))
        {
            return this.ResolveConstructedBaseParameterlessCtorToken(constructedBase);
        }

        var function = ctor.Function;

        // The receiver `this` is not part of the encoded parameter list. It may
        // or may not appear in Function.Parameters, so count (and emit) only the
        // non-receiver parameters rather than assuming a fixed offset.
        var paramCount = 0;
        foreach (var p in function.Parameters)
        {
            if (!ReferenceEquals(p, function.ThisParameter))
            {
                paramCount++;
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob)
            .MethodSignature(isInstanceMethod: true)
            .Parameters(
                paramCount,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        if (ReferenceEquals(p, function.ThisParameter))
                        {
                            continue;
                        }

                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });
        return this.GetUserStructMethodRef(constructedBase, ctorDef, ".ctor", sigBlob);
    }

    /// <summary>
    /// Issue #1055: resolves the parameter-less base constructor token for a
    /// class whose base is a CONSTRUCTED generic user class (e.g.
    /// <c>Derived : Base[int32]</c>). The base ctor's MethodDef is keyed by the
    /// open definition, so the token is emitted as a MemberRef parented at the
    /// constructed base's TypeSpec via <see cref="GetUserStructMethodRef"/> so
    /// the chained <c>call</c> targets the correct instantiated base subobject
    /// and the assembly verifies.
    /// </summary>
    internal EntityHandle ResolveConstructedBaseParameterlessCtorToken(StructSymbol constructedBase)
    {
        var def = constructedBase.Definition ?? constructedBase;

        if (this.cache.ClassPrimaryCtorHandles.TryGetValue(def, out var primaryDef))
        {
            var defParams = def.PrimaryConstructorParameters;
            var primarySig = new BlobBuilder();
            new BlobEncoder(primarySig)
                .MethodSignature(isInstanceMethod: true)
                .Parameters(
                    defParams.IsDefaultOrEmpty ? 0 : defParams.Length,
                    r => r.Void(),
                    ps =>
                    {
                        if (defParams.IsDefaultOrEmpty)
                        {
                            return;
                        }

                        foreach (var p in defParams)
                        {
                            EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                        }
                    });
            return this.GetUserStructMethodRef(constructedBase, primaryDef, ".ctor", primarySig);
        }

        if (this.cache.ClassCtorHandles.TryGetValue(def, out var defaultDef))
        {
            var defaultSig = new BlobBuilder();
            new BlobEncoder(defaultSig)
                .MethodSignature(isInstanceMethod: true)
                .Parameters(0, r => r.Void(), _ => { });
            return this.GetUserStructMethodRef(constructedBase, defaultDef, ".ctor", defaultSig);
        }

        return this.wellKnown.ObjectCtorRef;
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for a <c>newobj</c>
    /// against a user-declared default (parameter-less) ctor.
    /// </summary>
    internal EntityHandle ResolveUserCtorTokenForDefault(StructSymbol structType)
    {
        // Issue #810: the kickoff body may pass a CONSTRUCTED StructSymbol
        // (e.g. `<Empty>d__1<MVar(0)>`); the ctor's MethodDef is keyed by
        // the OPEN definition, so look up via Definition when present.
        var ctorKey = structType.Definition ?? structType;
        if (!this.cache.ClassCtorHandles.TryGetValue(ctorKey, out var defaultDef))
        {
            throw new InvalidOperationException($"Type '{structType.Name}' has no emitted default ctor.");
        }

        if (!IsUserGenericTypeReference(structType))
        {
            return defaultDef;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob)
            .MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });
        return this.GetUserStructMethodRef(structType, defaultDef, ".ctor", sigBlob);
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for a <c>newobj</c>
    /// against a user-declared explicit (<c>init(...)</c>) ctor
    /// (ADR-0063 §9).
    /// </summary>
    internal EntityHandle ResolveUserCtorTokenForExplicit(StructSymbol structType, ConstructorSymbol ctor)
    {
        if (!this.cache.ExplicitCtorHandles.TryGetValue(ctor, out var explicitDef))
        {
            throw new InvalidOperationException($"Constructor on '{ctor?.DeclaringType?.Name}' has no emitted handle.");
        }

        if (!IsUserGenericTypeReference(structType))
        {
            return explicitDef;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob)
            .MethodSignature(isInstanceMethod: true)
            .Parameters(
                ctor.Parameters.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in ctor.Parameters)
                    {
                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });
        return this.GetUserStructMethodRef(structType, explicitDef, ".ctor", sigBlob);
    }

    /// <summary>
    /// For a method on a constructed generic type, return the corresponding
    /// method on the open generic definition; for non-generic declaring types,
    /// returns the input. The open method's parameter / return types reference
    /// the declaring type's generic parameters as <c>GenericTypeParameter</c>,
    /// which <see cref="EncodeClrType"/> emits as <c>!N</c>.
    /// </summary>
    private static MethodInfo GetOpenMethod(MethodInfo method)
    {
        var declaring = method.DeclaringType;
        if (declaring is null || !declaring.IsConstructedGenericType)
        {
            return method;
        }

        var open = declaring.GetGenericTypeDefinition();
        foreach (var candidate in open.GetMethods(
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module)
            {
                return candidate;
            }
        }

        return method;
    }

    private static ConstructorInfo GetOpenCtor(ConstructorInfo ctor)
    {
        var declaring = ctor.DeclaringType;
        if (declaring is null || !declaring.IsConstructedGenericType)
        {
            return ctor;
        }

        var open = declaring.GetGenericTypeDefinition();
        foreach (var candidate in open.GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == ctor.MetadataToken && candidate.Module == ctor.Module)
            {
                return candidate;
            }
        }

        return ctor;
    }

    internal MemberReferenceHandle GetMethodReference(MethodInfo method)
    {
        if (this.cache.MethodRefs.TryGetValue(method, out var existing))
        {
            return existing;
        }

        var declaring = method.DeclaringType
            ?? throw new InvalidOperationException("Imported method has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);

        // For instance methods on constructed generic types, encode the signature
        // from the OPEN definition so parameters/returns reference declaring-type
        // generic params by position (!0, !1, ...). For non-generic declarings,
        // open == closed and parameter types are concrete.
        var openMethod = GetOpenMethod(method);

        // When the method itself is generic (e.g. Channel.CreateUnbounded<T>),
        // encode the MemberRef against its generic definition so `!!N` placeholders
        // referenced in the signature resolve correctly. The caller wraps the
        // resulting handle in a MethodSpecification.
        var openForMethodGenerics = openMethod.IsGenericMethod
            ? openMethod.GetGenericMethodDefinition()
            : openMethod;

        var sigBlob = new BlobBuilder();
        var sigEncoder = new BlobEncoder(sigBlob).MethodSignature(
            isInstanceMethod: !method.IsStatic,
            genericParameterCount: openForMethodGenerics.IsGenericMethodDefinition ? openForMethodGenerics.GetGenericArguments().Length : 0);
        sigEncoder.Parameters(
                openForMethodGenerics.GetParameters().Length,
                returnType: r => this.EncodeReturnClr(r, openForMethodGenerics.ReturnParameter, openForMethodGenerics.ReturnType),
                parameters: ps =>
                {
                    foreach (var p in openForMethodGenerics.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            // out / ref parameters: encode as managed pointer to the element type.
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
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.MethodRefs[method] = handle;
        return handle;
    }

    // Phase E: returns a callable EntityHandle for any MethodInfo, wrapping
    // constructed generic methods in a MethodSpecification per ECMA-335 II.23.2.15.
    internal EntityHandle GetMethodEntityHandle(MethodInfo method)
    {
        return this.GetMethodEntityHandle(method, default(ImmutableArray<TypeSymbol>));
    }

    internal EntityHandle GetMethodEntityHandle(MethodInfo method, TypeSymbol containingTypeSymbol)
    {
        return this.GetMethodEntityHandle(method, default(ImmutableArray<TypeSymbol>), containingTypeSymbol);
    }

    // Issue #320: callable EntityHandle for a constructed generic method whose
    // explicit type arguments may include user-defined types. User-defined type
    // arguments have no reference-context CLR type, so the method was closed with
    // a System.Object placeholder; the real type-argument symbols are encoded into
    // the method specification here (as their own TypeDef tokens) instead of the
    // placeholder. When typeArgSymbols is default the placeholder CLR arguments are
    // encoded, preserving the BCL-only behavior.
    internal EntityHandle GetMethodEntityHandle(MethodInfo method, ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        return this.GetMethodEntityHandle(method, typeArgSymbols, null);
    }
}
