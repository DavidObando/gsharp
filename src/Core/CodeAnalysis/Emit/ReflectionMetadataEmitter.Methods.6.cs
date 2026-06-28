// <copyright file="ReflectionMetadataEmitter.Methods.6.cs" company="GSharp">
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
    /// ADR-0087 §3 R6: returns the MemberRef handle for the reified
    /// delegate's <c>Invoke</c> method, parented at the <c>TypeSpec</c>
    /// for <paramref name="fnType"/>. The signature uses <c>VAR(i)</c>
    /// slots referencing the delegate type's own class-generic
    /// parameters (e.g. <c>Func`2::Invoke</c> is encoded as
    /// <c>!0 Invoke(!0)</c> wait — actually
    /// <c>!1 Invoke(!0)</c>). When the runtime resolves this MemberRef
    /// through the constructed parent <c>TypeSpec</c> (e.g.
    /// <c>Func&lt;int32, int32&gt;</c>), the VAR slots get substituted
    /// to the concrete arguments. No <see cref="System.Delegate.DynamicInvoke"/>
    /// is required.
    /// </summary>
    internal EntityHandle GetFunctionDelegateInvokeRef(FunctionTypeSymbol fnType)
    {
        if (this.functionDelegateInvokeRefCache.TryGetValue(fnType, out var cached))
        {
            return cached;
        }

        var parent = this.GetFunctionDelegateTypeSpec(fnType);

        bool isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType);
        int arity = fnType.ParameterTypes.Length;

        // The MemberRef signature for a method on a generic TypeSpec
        // parent must reference the parent type's *class-generic*
        // type parameters via VAR slots (`!0`..`!N-1`). The runtime
        // substitutes them against the parent's instantiation when
        // dispatching the call. For Func`N the slots are
        // `(!0,...,!N-1) -> !N`; for Action`N they are
        // `(!0,...,!N-1) -> void`.
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                arity,
                returnType: r =>
                {
                    if (isVoid)
                    {
                        r.Void();
                    }
                    else
                    {
                        r.Type().GenericTypeParameter(arity);
                    }
                },
                parameters: ps =>
                {
                    for (int i = 0; i < arity; i++)
                    {
                        ps.AddParameter().Type().GenericTypeParameter(i);
                    }
                });

        var handle = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("Invoke"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.functionDelegateInvokeRefCache[fnType] = handle;
        return handle;
    }

    // PR-E-11: BodyEmitter promoted to top-level MethodBodyEmitter
    // (src/Core/CodeAnalysis/Emit/MethodBodyEmitter.cs and partials).
    // PR-E-2: MethodSpecSymbolKey moved into MetadataTokenCache.

    /// <summary>
    /// Issue #985: emit MethodImpl rows for covariant-return interface bridges.
    /// A method whose <see cref="FunctionSymbol.ExplicitInterfaceSlot"/> is set
    /// explicitly implements a specific (typically inherited, non-generic) CLR
    /// interface slot — e.g. the private non-generic
    /// <c>IEnumerable.GetEnumerator()</c> alongside the public generic
    /// <c>IEnumerable&lt;T&gt;.GetEnumerator()</c>. A private bridge method
    /// cannot implicitly implement an interface slot, so the explicit row is
    /// required for the resulting type to load.
    /// </summary>
    /// <param name="structSymbol">The implementing class or struct.</param>
    private void EmitExplicitInterfaceMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Methods.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var method in structSymbol.Methods)
        {
            var slot = method.ExplicitInterfaceSlot;
            if (slot == null)
            {
                continue;
            }

            if (!this.cache.MethodHandles.TryGetValue(method, out var implHandle))
            {
                continue;
            }

            var slotRef = this.GetMethodReference(slot);
            this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, slotRef);
        }
    }

    /// <summary>
    /// ADR-0089 / issue #755: emit MethodImpl rows binding each declared
    /// static-virtual interface slot to the implementer's matching static
    /// method on <paramref name="structSymbol"/>. Best-effort match — if
    /// the implementer is missing the slot, the binder has already issued
    /// GS0331/GS0332 and we skip silently here.
    /// </summary>
    private void EmitStaticVirtualMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Interfaces.IsDefaultOrEmpty || structSymbol.StaticMethods.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var iface in structSymbol.Interfaces)
        {
            if (iface.StaticMethods.IsDefaultOrEmpty)
            {
                continue;
            }

            // Issue #1268: when the implemented interface is a constructed
            // generic (e.g. `TrackNumber : IData[TrackNumber]`), its
            // `StaticMethods` are substituted instances that are NOT keyed in
            // `MethodHandles`; only the open definition's slots are. Resolve
            // each substituted slot back to its open counterpart for the
            // MethodDef lookup, and parent the MethodImpl's declaration at the
            // constructed interface's TypeSpec (a MemberRef) so the runtime can
            // pair the override against `IData`1<TrackNumber>::Method`.
            var isGenericIface = IsUserGenericInterfaceReference(iface);
            foreach (var slot in iface.StaticMethods)
            {
                var openSlot = ResolveOpenInterfaceStaticMethod(iface, slot);
                if (!this.cache.MethodHandles.TryGetValue(openSlot, out var slotDefHandle))
                {
                    continue;
                }

                EntityHandle slotHandle = isGenericIface
                    ? this.ResolveUserInterfaceInstanceMethodToken(iface, openSlot)
                    : slotDefHandle;

                FunctionSymbol implMatch = null;
                foreach (var candidate in structSymbol.GetStaticMethods(slot.Name))
                {
                    if (StaticVirtualSignatureEquals(slot, candidate))
                    {
                        implMatch = candidate;
                        break;
                    }
                }

                if (implMatch == null)
                {
                    continue;
                }

                if (!this.cache.MethodHandles.TryGetValue(implMatch, out var implHandle))
                {
                    continue;
                }

                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, slotHandle);
            }
        }
    }

    /// <summary>
    /// Issue #1268: maps a (possibly substituted) static-virtual method slot
    /// on a constructed generic interface back to its open declaration on the
    /// interface definition. Returns <paramref name="slot"/> unchanged when the
    /// interface is not a constructed instance, or when no open counterpart is
    /// found.
    /// </summary>
    private static FunctionSymbol ResolveOpenInterfaceStaticMethod(InterfaceSymbol iface, FunctionSymbol slot)
    {
        var def = iface.Definition ?? iface;
        if (ReferenceEquals(def, iface))
        {
            return slot;
        }

        var constructedStatics = iface.StaticMethods;
        var defStatics = def.StaticMethods;
        for (var i = 0; i < constructedStatics.Length; i++)
        {
            if (ReferenceEquals(constructedStatics[i], slot) && i < defStatics.Length)
            {
                return defStatics[i];
            }
        }

        foreach (var m in defStatics)
        {
            if (m.Name == slot.Name && m.Parameters.Length == slot.Parameters.Length)
            {
                return m;
            }
        }

        return slot;
    }

    /// <summary>
    /// ADR-0089 / issue #1019: emit <c>MethodImpl</c> rows pairing the
    /// implementer's static property accessor methods (<c>get_Name</c> /
    /// <c>set_Name</c>) to the matching static-virtual interface property
    /// accessor slots. Mirrors <see cref="EmitStaticVirtualMethodImpls"/> but
    /// resolves accessor MethodDef handles through
    /// <c>PropertyAccessorHandles</c> (static properties are tracked on
    /// <see cref="StructSymbol.StaticProperties"/>, not <c>StaticMethods</c>).
    /// </summary>
    /// <param name="structSymbol">The implementer struct/class.</param>
    private void EmitStaticVirtualPropertyMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Interfaces.IsDefaultOrEmpty || structSymbol.StaticProperties.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var iface in structSymbol.Interfaces)
        {
            // Issue #1268: a constructed generic interface does not surface its
            // declared properties on the constructed instance (only methods are
            // substituted) — walk the open definition's property table so the
            // static-virtual property slots are found, and parent the
            // MethodImpl declaration at the constructed TypeSpec for generic
            // interfaces.
            var defIface = iface.Definition ?? iface;
            if (defIface.Properties.IsDefaultOrEmpty)
            {
                continue;
            }

            var isGenericIface = IsUserGenericInterfaceReference(iface);
            foreach (var slotProp in defIface.Properties)
            {
                if (!slotProp.IsStatic)
                {
                    continue;
                }

                if (!this.cache.PropertyAccessorHandles.TryGetValue(slotProp, out var slotAccessors))
                {
                    continue;
                }

                PropertySymbol implProp = null;
                foreach (var candidate in structSymbol.StaticProperties)
                {
                    if (candidate.Name == slotProp.Name
                        && (ReferenceEquals(candidate.Type, slotProp.Type) || candidate.Type?.Name == slotProp.Type?.Name))
                    {
                        implProp = candidate;
                        break;
                    }
                }

                if (implProp == null
                    || !this.cache.PropertyAccessorHandles.TryGetValue(implProp, out var implAccessors))
                {
                    continue;
                }

                if (slotProp.HasGetter && slotAccessors.Getter.HasValue && implAccessors.Getter.HasValue)
                {
                    EntityHandle getterDecl = isGenericIface && slotProp.GetterSymbol != null
                        ? this.ResolveUserInterfaceInstanceMethodToken(iface, slotProp.GetterSymbol)
                        : slotAccessors.Getter.Value;
                    this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Getter.Value, getterDecl);
                }

                if (slotProp.HasSetter && slotAccessors.Setter.HasValue && implAccessors.Setter.HasValue)
                {
                    EntityHandle setterDecl = isGenericIface && slotProp.SetterSymbol != null
                        ? this.ResolveUserInterfaceInstanceMethodToken(iface, slotProp.SetterSymbol)
                        : slotAccessors.Setter.Value;
                    this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Setter.Value, setterDecl);
                }
            }
        }
    }
}
