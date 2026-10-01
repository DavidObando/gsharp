// <copyright file="ClrInterfaceClosure.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// The imported CLR interfaces a G# type's metadata lists: every declared CLR
/// interface followed by its transitive base interfaces, as csc emits them
/// (issue #4601). It is the single source for both the type's
/// <c>InterfaceImpl</c> rows and the <c>MethodImpl</c> rows of the
/// interfaces' static-virtual slots (issue #4614), so the two can never
/// disagree about which interfaces the type implements.
/// </summary>
/// <remarks>
/// Each interface is keyed on its emitted metadata identity, so it appears
/// once and two distinct interfaces are never conflated. Concrete interfaces
/// use the assembly-qualified comparer the emitter's own TypeRef/TypeSpec
/// token caches use (a same-named interface from another assembly is a
/// different interface). Symbolic generic ones (<c>IList[Shape]</c>,
/// <c>IList[T]</c>) use the bytes of their TypeSpec signature (a display name
/// would conflate <c>Shape</c> with <c>Outer.Shape</c>).
/// </remarks>
internal sealed class ClrInterfaceClosure
{
    private readonly SignatureEncoder signatures;
    private readonly HashSet<Type> concreteKeys = new HashSet<Type>(TypeIdentityComparer.Instance);
    private readonly HashSet<string> symbolicKeys = new HashSet<string>(StringComparer.Ordinal);
    private readonly List<(TypeSymbol? Symbolic, Type? Concrete)> entries = new List<(TypeSymbol? Symbolic, Type? Concrete)>();

    private ClrInterfaceClosure(SignatureEncoder signatures)
    {
        this.signatures = signatures;
    }

    /// <summary>
    /// Gets the interfaces in emission order. Exactly one of each entry's two
    /// positions is set: <c>Symbolic</c> for a generic interface closed over
    /// G# types (emitted through its symbolic TypeSpec), <c>Concrete</c>
    /// otherwise.
    /// </summary>
    public IReadOnlyList<(TypeSymbol? Symbolic, Type? Concrete)> Entries => this.entries;

    /// <summary>
    /// Builds the closure of <paramref name="type"/>'s declared CLR
    /// interfaces.
    /// </summary>
    /// <param name="type">The G# type being emitted.</param>
    /// <param name="signatures">The emitter's signature encoder (symbolic keys).</param>
    /// <returns>The closure.</returns>
    public static ClrInterfaceClosure Build(StructSymbol type, SignatureEncoder signatures)
    {
        var closure = new ClrInterfaceClosure(signatures);
        if (type.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            return closure;
        }

        foreach (var declared in type.ImplementedClrInterfaces)
        {
            // Issue #949: a CLR generic interface closed over a user G# type
            // (e.g. `IEquatable[Shape]`) carries symbolic type arguments
            // alongside its type-erased ClrType; it is emitted over the real
            // constructed shape, never the erased `IEquatable<object>`.
            if (MemberLookup.TryGetSymbolicClrGenericInterface(declared, out var openIface, out var symbolicArgs))
            {
                closure.TryAddSymbolic(declared);
                foreach (var baseIface in ClrTypeUtilities.SafeGetInterfaces(openIface))
                {
                    var baseSym = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                        baseIface,
                        openIface,
                        symbolicArgs,
                        NullabilityFreeReason.TypeStructure);
                    if (MemberLookup.TryGetSymbolicClrGenericInterface(baseSym, out _, out _))
                    {
                        closure.TryAddSymbolic(baseSym);
                    }
                    else if (baseSym.ClrType is Type concreteBase)
                    {
                        closure.TryAddConcrete(concreteBase);
                    }
                }

                continue;
            }

            if (declared?.ClrType is Type clrIface)
            {
                closure.TryAddConcrete(clrIface);
                foreach (var baseIface in ClrTypeUtilities.SafeGetInterfaces(clrIface))
                {
                    closure.TryAddConcrete(baseIface);
                }
            }
        }

        return closure;
    }

    /// <summary>
    /// Adds a concrete interface unless it is already present.
    /// </summary>
    /// <param name="iface">The interface.</param>
    /// <returns><see langword="true"/> when it was added.</returns>
    public bool TryAddConcrete(Type iface)
    {
        if (!this.concreteKeys.Add(iface))
        {
            return false;
        }

        this.entries.Add((null, iface));
        return true;
    }

    /// <summary>
    /// Adds a symbolic generic interface unless one with the same TypeSpec
    /// signature is already present.
    /// </summary>
    /// <param name="iface">The interface.</param>
    /// <returns><see langword="true"/> when it was added.</returns>
    public bool TryAddSymbolic(TypeSymbol iface)
    {
        var signature = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(signature).TypeSpecificationSignature(), iface);
        if (!this.symbolicKeys.Add(Convert.ToBase64String(signature.ToArray())))
        {
            return false;
        }

        this.entries.Add((iface, null));
        return true;
    }
}
