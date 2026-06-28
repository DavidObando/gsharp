// <copyright file="ReflectionMetadataEmitter.Types.2.cs" company="GSharp">
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
    /// ADR-0089 / issue #1030: returns a <c>MemberRef</c> handle for a static
    /// field on a user-declared generic interface, parented at the
    /// <c>TypeSpec</c> for <paramref name="containingInterface"/>. Mirrors
    /// <see cref="GetUserStructFieldRef"/>. The field signature is encoded from
    /// the open definition's field type.
    /// </summary>
    /// <param name="containingInterface">The constructed (or open) interface reference.</param>
    /// <param name="fieldOnContaining">The static field being referenced.</param>
    /// <returns>The MemberRef token parented at the interface TypeSpec.</returns>
    internal EntityHandle GetUserInterfaceFieldRef(InterfaceSymbol containingInterface, FieldSymbol fieldOnContaining)
    {
        var def = containingInterface.Definition ?? containingInterface;
        var defField = def.GetStaticField(fieldOnContaining.Name) ?? fieldOnContaining;

        var key = (containingInterface, defField);
        if (this.userInterfaceFieldRefCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var parent = this.GetUserInterfaceTypeSpec(containingInterface);
        var sigBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), defField.Type);

        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(defField.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userInterfaceFieldRefCache[key] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// Issue #989: resolves the right token for a call to a user property's
    /// get/set accessor. For a non-generic containing type returns the bare
    /// accessor <c>MethodDef</c>; for a constructed generic containing type
    /// returns a <c>MemberRef</c> parented at the constructed <c>TypeSpec</c>
    /// so a property whose type mentions a class type parameter (e.g.
    /// <c>prop Value T</c> on <c>Box[int32]</c>) is accessed with <c>T</c>
    /// substituted by the runtime. The MemberRef signature mirrors the open
    /// accessor MethodDef emitted by <c>MemberDefEmitter</c> (which encodes the
    /// property type with <c>VAR(idx)</c> placeholders).
    /// </summary>
    internal EntityHandle ResolveUserPropertyAccessorToken(StructSymbol containingType, PropertySymbol property, bool wantSetter)
    {
        // Property accessor MethodDef rows are planned against the OPEN
        // definition's property (the only type that is emitted), so map the
        // possibly-substituted constructed property back to the definition's
        // property by name before consulting PropertyAccessorHandles.
        var defType = containingType.Definition ?? containingType;
        var defProp = property;
        if (!ReferenceEquals(defType, containingType))
        {
            foreach (var candidate in property.IsStatic ? defType.StaticProperties : defType.Properties)
            {
                if (candidate.Name == property.Name && candidate.IsIndexer == property.IsIndexer)
                {
                    defProp = candidate;
                    break;
                }
            }
        }

        if (!this.cache.PropertyAccessorHandles.TryGetValue(defProp, out var handles))
        {
            throw new InvalidOperationException(
                $"Property '{property.Name}' has no emitted accessor handles.");
        }

        var accessor = wantSetter ? handles.Setter : handles.Getter;
        if (!accessor.HasValue)
        {
            throw new InvalidOperationException(
                $"Property '{property.Name}' has no emitted {(wantSetter ? "setter" : "getter")} MethodDef.");
        }

        if (!IsUserGenericTypeReference(containingType))
        {
            return accessor.Value;
        }

        var accessorName = (wantSetter ? "set_" : "get_") + defProp.Name;
        return this.GetUserStructMethodRef(
            containingType,
            accessor.Value,
            accessorName,
            this.EncodeOpenPropertyAccessorSignature(defProp, wantSetter));
    }

    /// <summary>
    /// Issue #989: encodes the open accessor signature for a user property,
    /// matching the MethodDef shape emitted by <c>MemberDefEmitter</c>: a
    /// getter is <c>instance PropertyType get_Name(indexParams...)</c>; a setter
    /// is <c>instance void set_Name(indexParams..., PropertyType)</c>. The open
    /// definition's property type is used so type parameters encode as
    /// <c>VAR(idx)</c>.
    /// </summary>
    private BlobBuilder EncodeOpenPropertyAccessorSignature(PropertySymbol property, bool wantSetter)
    {
        var sigBlob = new BlobBuilder();
        var indexParams = property.Parameters.IsDefaultOrEmpty
            ? ImmutableArray<ParameterSymbol>.Empty
            : property.Parameters;

        // Issue #1209: a static (`shared`) property accessor on a generic user
        // type has no `this` — the MemberRef signature must NOT set HASTHIS, or
        // the runtime fails to bind the accessor (MissingMethodException).
        var isInstanceAccessor = !property.IsStatic;
        if (wantSetter)
        {
            new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: isInstanceAccessor)
                .Parameters(
                    indexParams.Length + 1,
                    r => r.Void(),
                    ps =>
                    {
                        foreach (var p in indexParams)
                        {
                            EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                        }

                        EncodeTypeSymbol(ps.AddParameter().Type(), property.Type);
                    });
        }
        else
        {
            new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: isInstanceAccessor)
                .Parameters(
                    indexParams.Length,
                    r => EncodeTypeSymbol(r.Type(), property.Type),
                    ps =>
                    {
                        foreach (var p in indexParams)
                        {
                            EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                        }
                    });
        }

        return sigBlob;
    }

    /// <summary>
    /// ADR-0091: returns <see langword="true"/> when
    /// <paramref name="ifaceSym"/> is a user-declared generic interface
    /// reference whose method references must be parented at a
    /// <c>TypeSpec</c> rather than the bare TypeDef row.
    /// </summary>
    internal static bool IsUserGenericInterfaceReference(InterfaceSymbol ifaceSym)
    {
        if (ifaceSym == null)
        {
            return false;
        }

        if (!ifaceSym.TypeArguments.IsDefaultOrEmpty)
        {
            return true;
        }

        var def = ifaceSym.Definition ?? ifaceSym;
        return !def.TypeParameters.IsDefaultOrEmpty;
    }

    /// <summary>
    /// ADR-0091: returns a <c>TypeSpec</c> EntityHandle for a
    /// user-declared generic interface — analogue of
    /// <see cref="GetUserStructTypeSpec"/> for <see cref="InterfaceSymbol"/>.
    /// </summary>
    internal EntityHandle GetUserInterfaceTypeSpec(InterfaceSymbol ifaceSym)
    {
        if (this.userInterfaceTypeSpecCache.TryGetValue(ifaceSym, out var cached))
        {
            return cached;
        }

        var def = ifaceSym.Definition ?? ifaceSym;
        if (!this.cache.InterfaceTypeDefs.TryGetValue(def, out var defHandle))
        {
            throw new InvalidOperationException(
                $"User generic interface '{def.Name}' has no emitted TypeDef when constructing TypeSpec.");
        }

        ImmutableArray<TypeSymbol> typeArgs;
        if (!ifaceSym.TypeArguments.IsDefaultOrEmpty)
        {
            typeArgs = ifaceSym.TypeArguments;
        }
        else
        {
            var defTps = def.TypeParameters;
            var bld = ImmutableArray.CreateBuilder<TypeSymbol>(defTps.Length);
            foreach (var tp in defTps)
            {
                bld.Add(tp);
            }

            typeArgs = bld.MoveToImmutable();
        }

        var sigBlob = new BlobBuilder();
        var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
        var gi = encoder.GenericInstantiation(defHandle, typeArgs.Length, isValueType: false);
        foreach (var arg in typeArgs)
        {
            this.EncodeTypeSymbol(gi.AddArgument(), arg);
        }

        var spec = (EntityHandle)this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userInterfaceTypeSpecCache[ifaceSym] = spec;
        return spec;
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for a type operation
    /// (<c>isinst</c>, <c>unbox</c>, <c>unbox.any</c>, <c>initobj</c>,
    /// <c>castclass</c>) against a user-declared type. Returns the
    /// bare <c>TypeDef</c> for a non-generic type, or a <c>TypeSpec</c>
    /// for a generic type.
    /// </summary>
    internal EntityHandle ResolveUserTypeToken(StructSymbol structType)
    {
        if (IsUserGenericTypeReference(structType))
        {
            return this.GetUserStructTypeSpec(structType);
        }

        return this.cache.StructTypeDefs[structType];
    }

    private bool TryCreateMemberReferenceForConstructedSymbolicContainer(
        MethodInfo method,
        TypeSymbol containingTypeSymbol,
        out MemberReferenceHandle handle)
    {
        handle = default;
        if (method == null
            || !TryNormalizeToSymbolicContainer(containingTypeSymbol, out var openDefinition, out var typeArguments)
            || typeArguments.IsDefaultOrEmpty
            || !(typeArguments.Any(TypeSymbol.ContainsTypeParameter) || typeArguments.Any(ArgIsSymbolicUserDefined)))
        {
            return false;
        }

        // Issue #774: when the method is declared on a non-generic base
        // (e.g. `IEnumerator.MoveNext()` inherited via `IEnumerator<T>`, or
        // `IDisposable.Dispose()` on the same enumerator), encoding a
        // symbolic generic parent TypeSpec produces a verifier-rejected
        // MemberRef (`MoveNext` is not declared on `IEnumerator<>`). Let the
        // plain MemberRef path encode the parent as the actual non-generic
        // declaring type by short-circuiting here.
        var methodDecl = method.DeclaringType;
        if (methodDecl != null && !methodDecl.IsGenericType && methodDecl != openDefinition)
        {
            return false;
        }

        // Issue #774: when the method is declared on a generic interface or
        // base type that the receiver's openDefinition implements (e.g.
        // `IEnumerable<object>.GetEnumerator()` called on a
        // `Dictionary[K, V]`), the parent TypeSpec must be the substituted
        // interface — not the receiver's own openDefinition. Otherwise
        // ResolveMethodOnOpenDefinition would pick the receiver's hiding
        // method (e.g. Dictionary's struct-returning GetEnumerator) and the
        // verifier would see a struct value where an interface reference is
        // expected.
        if (methodDecl != null
            && methodDecl.IsGenericType
            && openDefinition != null)
        {
            var methodDeclOpen = methodDecl.IsGenericTypeDefinition ? methodDecl : methodDecl.GetGenericTypeDefinition();
            if (methodDeclOpen != openDefinition)
            {
                if (TryFindImplementedInterfaceInstantiation(openDefinition, methodDeclOpen, out var ifaceInstantiation))
                {
                    var ifaceArgs = ifaceInstantiation.GetGenericArguments();
                    var symbolicIfaceArgs = ImmutableArray.CreateBuilder<TypeSymbol>(ifaceArgs.Length);
                    foreach (var ifa in ifaceArgs)
                    {
                        symbolicIfaceArgs.Add(MemberLookup.MapOpenClrTypeToSymbolic(ifa, openDefinition, typeArguments));
                    }

                    openDefinition = methodDeclOpen;
                    typeArguments = symbolicIfaceArgs.MoveToImmutable();
                }
            }
        }

        // Synthesize an ImportedTypeSymbol view of the receiver so the
        // parent TypeSpec encoder reaches the existing
        // `ImportedTypeSymbol with HasTypeParameterArgument` branch in
        // EncodeTypeSymbol uniformly — regardless of whether the actual
        // receiver was an ImportedTypeSymbol, a SequenceTypeSymbol with
        // null ClrType (issue #774), or an AsyncSequenceTypeSymbol with
        // null ClrType.
        var symbolicView = ImportedTypeSymbol.GetConstructed(
            openDefinition.MakeGenericType(this.GetErasedObjectArgs(openDefinition)),
            openDefinition,
            typeArguments);

        var parentBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), symbolicView);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));
        var openMethod = ResolveMethodOnOpenDefinition(openDefinition, method);
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
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return true;
    }

    /// <summary>
    /// Walks <paramref name="openDefinition"/>'s implemented interfaces and
    /// returns the constructed instance that uses
    /// <paramref name="targetOpenInterface"/> as its open definition. The
    /// returned <see cref="Type"/>'s generic arguments are still in terms of
    /// <paramref name="openDefinition"/>'s generic parameters so they can be
    /// substituted via <see cref="MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol})"/>.
    /// </summary>
    private static bool TryFindImplementedInterfaceInstantiation(Type openDefinition, Type targetOpenInterface, out Type instantiation)
    {
        foreach (var iface in openDefinition.GetInterfaces())
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition() == targetOpenInterface)
            {
                instantiation = iface;
                return true;
            }

            if (!iface.IsGenericType && iface == targetOpenInterface)
            {
                instantiation = iface;
                return true;
            }
        }

        instantiation = null;
        return false;
    }

    private Type ChooseErasedValueTypeType(Type openDefinition)
    {
        var hostInt = typeof(int);
        if (openDefinition?.Assembly == hostInt.Assembly)
        {
            return hostInt;
        }

        return this.emitCtx.CoreInt32Type ?? hostInt;
    }

    private Type ChooseErasedObjectType(Type openDefinition)
    {
        // Same context as the open def → cheap path.
        var hostObject = typeof(object);
        if (openDefinition?.Assembly == hostObject.Assembly)
        {
            return hostObject;
        }

        return this.emitCtx.CoreObjectType ?? hostObject;
    }

    private static PropertyInfo ResolvePropertyOnOpenDefinition(Type openDefinition, PropertyInfo property)
    {
        if (openDefinition == null)
        {
            return property;
        }

        if (property.DeclaringType == openDefinition)
        {
            return property;
        }

        foreach (var candidate in openDefinition.GetProperties(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == property.MetadataToken && candidate.Module == property.Module)
            {
                return candidate;
            }
        }

        return openDefinition.GetProperty(
            property.Name,
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
    }

    /// <summary>
    /// Issue #774: when emitting a property read on a symbolic open-generic
    /// receiver (e.g. <c>IEnumerator[T].Current</c> or
    /// <c>KeyValuePair[K, V].Key</c>), the runtime stack value after the
    /// symbolic getter MemberRef call is the substituted symbolic type, not
    /// the closed CLR <c>object</c> that the type-erased getter declares.
    /// Returning that symbolic type to the body emitter lets the widening
    /// short-circuit, avoiding a verifier-breaking <c>unbox.any</c> on a
    /// value-type <c>T</c>.
    /// </summary>
    /// <param name="receiverType">The receiver's type as seen by the body emitter.</param>
    /// <param name="property">The closed-CLR property selected by the lowerer.</param>
    /// <param name="substitutedReturn">The substituted symbolic return type, on success.</param>
    /// <returns><see langword="true"/> when the receiver is a symbolic
    /// open-generic container and the substituted return differs from the
    /// closed CLR <c>object</c> shape.</returns>
    internal bool TryGetSymbolicSubstitutedPropertyReturn(
        TypeSymbol receiverType,
        PropertyInfo property,
        out TypeSymbol substitutedReturn)
    {
        substitutedReturn = null;
        if (property == null
            || !TryNormalizeToSymbolicContainer(receiverType, out var openDef, out var typeArguments)
            || typeArguments.IsDefaultOrEmpty
            || !(typeArguments.Any(TypeSymbol.ContainsTypeParameter) || typeArguments.Any(ArgIsSymbolicUserDefined)))
        {
            return false;
        }

        var openProp = ResolvePropertyOnOpenDefinition(openDef, property);
        if (openProp == null)
        {
            return false;
        }

        substitutedReturn = MemberLookup.MapOpenClrTypeToSymbolic(openProp.PropertyType, openDef, typeArguments);
        return substitutedReturn != null && substitutedReturn != TypeSymbol.Error;
    }

    /// <summary>
    /// Phase 4 emit parity: get a MemberRef for a CLR field on a possibly
    /// generic declaring type (e.g. <c>KeyValuePair&lt;K, V&gt;.Key</c>).
    /// </summary>
    internal MemberReferenceHandle GetFieldReference(FieldInfo field)
    {
        if (this.cache.FieldRefs.TryGetValue(field, out var existing))
        {
            return existing;
        }

        var declaring = field.DeclaringType
            ?? throw new InvalidOperationException("Imported field has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);

        // Use the open field's FieldType so it encodes as !N when applicable.
        var openField = declaring.IsConstructedGenericType
            ? declaring.GetGenericTypeDefinition().GetField(
                field.Name,
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                ?? field
            : field;

        var sigBlob = new BlobBuilder();
        this.EncodeClrType(new BlobEncoder(sigBlob).FieldSignature(), openField.FieldType);

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(field.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.FieldRefs[field] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a field on a constructed generic type without
    /// calling <c>.GetField()</c> on the closed generic (which throws
    /// <see cref="NotSupportedException"/> when type arguments are MLC-loaded or
    /// TypeBuilder-backed). Resolves the field from the open generic type definition.
    /// </summary>
    internal MemberReferenceHandle GetFieldReferenceOnConstructedGeneric(Type closedGenericType, string fieldName)
    {
        var openType = closedGenericType.GetGenericTypeDefinition();
        var openField = openType.GetField(
            fieldName,
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException(
                $"Open generic type '{openType.FullName}' has no field '{fieldName}'.");

        var parent = this.GetTypeHandleForMember(closedGenericType);

        var sigBlob = new BlobBuilder();
        this.EncodeClrType(new BlobEncoder(sigBlob).FieldSignature(), openField.FieldType);

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(fieldName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return handle;
    }

    /// <summary>
    /// Issue #649: Gets the TypeSpec handle for a <c>ValueTuple&lt;...&gt;</c> whose element
    /// types include G#-defined types (StructSymbol) that lack a CLR backing type.
    /// Encodes each element type via <see cref="EncodeTypeSymbol"/> so user-defined types
    /// are correctly referenced by their TypeDef handles.
    /// </summary>
    private EntityHandle GetTupleTypeSpec(TupleTypeSymbol tupleType)
    {
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
                $"Symbolic tuple TypeSpec not supported for arity {arity}."),
        };

        var sigBlob = new BlobBuilder();
        var genInst = new BlobEncoder(sigBlob).TypeSpecificationSignature()
            .GenericInstantiation(
                this.GetTypeReference(openType),
                arity,
                isValueType: true);
        foreach (var elemType in tupleType.ElementTypes)
        {
            this.EncodeTypeSymbol(genInst.AddArgument(), elemType);
        }

        return this.emitCtx.Metadata.AddTypeSpecification(
            this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a tuple field (<c>Item1</c>...<c>Item7</c>) when
    /// the tuple's <see cref="TypeSymbol.ClrType"/> is null (element types include
    /// G#-defined types). Builds the field MemberRef against the symbolically-constructed
    /// <c>ValueTuple</c> TypeSpec.
    /// </summary>
    internal MemberReferenceHandle GetTupleFieldReference(TupleTypeSymbol tupleType, string fieldName)
    {
        var parent = this.GetTupleTypeSpec(tupleType);

        // Get the open field from the BCL ValueTuple generic definition for signature encoding.
        var openType = tupleType.Arity switch
        {
            2 => typeof(ValueTuple<,>),
            3 => typeof(ValueTuple<,,>),
            4 => typeof(ValueTuple<,,,>),
            5 => typeof(ValueTuple<,,,,>),
            6 => typeof(ValueTuple<,,,,,>),
            7 => typeof(ValueTuple<,,,,,,>),
            _ => throw new NotSupportedException(
                $"Symbolic tuple field ref not supported for arity {tupleType.Arity}."),
        };

        var openField = openType.GetField(
            fieldName,
            BindingFlags.Instance | BindingFlags.Public)
            ?? throw new InvalidOperationException(
                $"Open ValueTuple type has no field '{fieldName}'.");

        var sigBlob = new BlobBuilder();
        this.EncodeClrType(new BlobEncoder(sigBlob).FieldSignature(), openField.FieldType);

        return this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(fieldName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }
}
