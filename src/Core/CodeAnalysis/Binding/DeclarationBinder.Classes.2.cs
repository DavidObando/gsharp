// <copyright file="DeclarationBinder.Classes.2.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Extracted from <see cref="Binder"/> in PR-B-8. Owns every per-declaration-kind
/// binder: type aliases, named delegates, enums, structs (including the large
/// <c>BindStructDeclarationBody</c> driver and its interface-implementation
/// verification pass), interfaces, free / member / extension functions,
/// constructors (<c>init</c>) plus the <c>: base(...)</c> initializer
/// resolver, the two symbol-construction <c>BindVariableDeclaration</c>
/// overloads, generic-parameter binding (<c>BindTypeParameterList</c>), the
/// declaration-side attribute binder (<c>BindAttributes</c>/<c>BindAttribute</c>),
/// and the queue of pending struct→interface implementation checks. The
/// expression binder and most type-name resolution remain on
/// <see cref="Binder"/> and are invoked via the delegate callbacks supplied to
/// the constructor; the same is true for <c>BindBlockStatement</c>-driven
/// body binding (which happens later, in <c>BindProgram</c>, not here).
/// </summary>

internal sealed partial class DeclarationBinder
{


    /// <summary>
    /// Issue #1069 (phase 1): declares the type-name shells of the nested types
    /// declared in <paramref name="containerSyntax"/> and records the enclosing
    /// type on each via <c>SetContainingType</c>, BEFORE any member body of the
    /// enclosing type is bound. This makes every nested type resolvable by simple
    /// name from within the enclosing type (and as a CLR nested type by qualified
    /// name from outside) regardless of declaration order, mirroring the
    /// two-phase scheme used for top-level types (#973).
    /// <list type="bullet">
    /// <item><c>struct</c>/<c>class</c>/<c>data struct</c>: a shell is declared
    /// (fields/base bound later) and its own nested shells are declared
    /// recursively.</item>
    /// <item><c>enum</c>: fully bound now — enum members reference no user types,
    /// so there is nothing to defer.</item>
    /// <item><c>interface</c>: a shell is declared; its method signatures are
    /// bound later by <see cref="BindNestedTypeBodies"/>.</item>
    /// </list>
    /// </summary>
    internal void DeclareNestedTypeShells(StructDeclarationSyntax containerSyntax, TypeSymbol containerSymbol, PackageSymbol package)
    {
        if (containerSyntax.NestedTypes.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var nested in containerSyntax.NestedTypes)
        {
            switch (nested)
            {
                case StructDeclarationSyntax nestedStruct:
                    var nestedStructSymbol = DeclareStructShell(nestedStruct, package, containerSymbol);
                    if (nestedStructSymbol != null)
                    {
                        nestedStructShells[nestedStruct] = nestedStructSymbol;
                        DeclareNestedTypeShells(nestedStruct, nestedStructSymbol, package);
                    }

                    break;

                case EnumDeclarationSyntax nestedEnum:
                    BindEnumDeclaration(nestedEnum, package, containerSymbol);
                    break;

                case InterfaceDeclarationSyntax nestedInterface:
                    var nestedInterfaceSymbol = DeclareInterfaceSymbol(nestedInterface, package, containerSymbol);
                    if (nestedInterfaceSymbol != null)
                    {
                        nestedInterfaceShells[nestedInterface] = nestedInterfaceSymbol;
                    }

                    break;
            }
        }
    }

    private static bool StructSatisfiesClrSlot(StructSymbol structSymbol, in MemberLookup.ClrInterfaceSlot slot)
    {
        // Note: do NOT route through GetMethodsIncludingInherited here — it
        // dedups same-name overloads by parameter signature (ignoring return
        // type), which would hide the non-generic covariant bridge method that
        // shares the generic method's name and (empty) parameter list. Walk the
        // class and its base chain directly so both overloads are visible.
        for (var c = structSymbol; c != null; c = c.BaseClass)
        {
            if (c.Methods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var candidate in c.Methods)
            {
                if (candidate.Name == slot.Method.Name
                    && MemberLookup.MethodSatisfiesClrSlot(candidate, slot))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static string GetBaseClauseTypeDisplayName(TypeClauseSyntax typeClause)
    {
        if (typeClause == null)
        {
            return string.Empty;
        }

        var dotted = typeClause.DottedName;
        if (!typeClause.HasTypeArguments)
        {
            return dotted;
        }

        var args = new string[typeClause.TypeArguments.Count];
        for (var i = 0; i < typeClause.TypeArguments.Count; i++)
        {
            args[i] = GetBaseClauseTypeDisplayName(typeClause.TypeArguments[i]);
        }

        return $"{dotted}[{string.Join(", ", args)}]";
    }

    /// <summary>
    /// Issue #410 / ADR-0029: data structs synthesize the same six member
    /// names as inline structs (<c>Equals</c>, <c>GetHashCode</c>,
    /// <c>ToString</c>, <c>op_Equality</c>, <c>op_Inequality</c>,
    /// <c>Deconstruct</c>). User code may not hand-write any of them.
    /// </summary>
    private static bool IsDataStructSynthesizedMemberName(string methodName)
    {
        return IsInlineSynthesizedMemberName(methodName);
    }

    /// <summary>
    /// Issue #1055: builds the substitution mapping each base class's generic
    /// type parameters onto the concrete type arguments supplied where that base
    /// is inherited as a constructed generic. Walking the <see cref="StructSymbol.BaseClass"/>
    /// chain closest-first lets a deeper base's type arguments (which are expressed
    /// in terms of a shallower base's type parameters) resolve transitively, so a
    /// multi-level chain such as <c>Leaf : Mid[int32] : Base[T]</c> maps
    /// <c>Base.T -&gt; int32</c>. The resulting map is consumed by
    /// <see cref="SignaturesMatch(FunctionSymbol, ImmutableArray{ParameterSymbol}, TypeSymbol, RefKind, IReadOnlyDictionary{TypeParameterSymbol, TypeSymbol})"/>
    /// so an override whose concrete signature mentions the substituted types is
    /// matched against the base member's un-substituted (open) signature. Returns
    /// <c>null</c> when no constructed base contributes a substitution.
    /// </summary>
    private static IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> BuildBaseTypeArgumentSubstitution(StructSymbol derived)
    {
        Dictionary<TypeParameterSymbol, TypeSymbol> subst = null;
        for (var b = derived?.BaseClass; b != null; b = b.BaseClass)
        {
            if (b.Definition == null || b.TypeArguments.IsDefaultOrEmpty)
            {
                continue;
            }

            var defParams = b.Definition.TypeParameters;
            if (defParams.IsDefaultOrEmpty)
            {
                continue;
            }

            var count = System.Math.Min(defParams.Length, b.TypeArguments.Length);
            for (var i = 0; i < count; i++)
            {
                var arg = b.TypeArguments[i];

                // A deeper base's type argument may itself be a type parameter of
                // a shallower (already-processed) base; resolve it transitively so
                // the map always lands on the concrete type in the derived context.
                if (arg is TypeParameterSymbol tpArg && subst != null && subst.TryGetValue(tpArg, out var resolved))
                {
                    arg = resolved;
                }

                subst ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                subst[defParams[i]] = arg;
            }
        }

        return subst;
    }

    /// <summary>
    /// Issue #974: structural equivalence used by override / interface-
    /// implementation signature matching. Constructed generic types are not
    /// interned (<see cref="ImportedTypeSymbol.GetConstructed"/> and
    /// <see cref="InterfaceSymbol.Construct"/> can yield fresh instances), so a
    /// raw reference comparison wrongly rejects, for example, the class method
    /// <c>func Iter() IEnumerator[T]</c> against the interface requirement
    /// <c>ISeq[T].Iter() IEnumerator[T]</c> once the interface's type
    /// parameters have been substituted with the implementing type's
    /// arguments. Reference identity is honoured first (covering plain type
    /// parameters, primitives and cached imported types); constructed generics
    /// are then compared by definition and ordered type arguments, recursing
    /// through slice / array / nullable wrappers. The comparison stays strict —
    /// distinct type arguments (e.g. <c>IEnumerator[int32]</c> vs
    /// <c>IEnumerator[T]</c>) are not equated — so genuinely mismatched
    /// signatures are still rejected with GS0187.
    /// </summary>
    internal static bool TypeSignaturesEquivalent(TypeSymbol a, TypeSymbol b)
        => TypeSignaturesEquivalent(a, b, typeParamMap: null);

    private static bool TypeSignaturesEquivalent(
        TypeSymbol a,
        TypeSymbol b,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap)
    {
        // Issue #1007: substitute a generic interface method's type parameter
        // with the implementing method's positionally-corresponding type
        // parameter before comparing, so `T_iface` and `T_class` match.
        if (typeParamMap != null && a is TypeParameterSymbol tpa && typeParamMap.TryGetValue(tpa, out var mappedA))
        {
            a = mappedA;
        }

        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a == null || b == null)
        {
            return false;
        }

        if (a is StructSymbol sa && b is StructSymbol sb)
        {
            return ReferenceEquals(sa.Definition, sb.Definition)
                && TypeArgumentsEquivalent(sa.TypeArguments, sb.TypeArguments, typeParamMap);
        }

        if (a is InterfaceSymbol ia && b is InterfaceSymbol ib)
        {
            return ReferenceEquals(ia.Definition, ib.Definition)
                && TypeArgumentsEquivalent(ia.TypeArguments, ib.TypeArguments, typeParamMap);
        }

        if (a is ImportedTypeSymbol pa && b is ImportedTypeSymbol pb)
        {
            // Constructed imported generics carrying symbolic arguments (e.g.
            // `IEnumerator[T]`) are compared by open definition and ordered
            // arguments so an unbound type parameter compares by identity
            // rather than by its erased `object` CLR projection.
            if (pa.OpenDefinition != null
                && pb.OpenDefinition != null
                && pa.OpenDefinition == pb.OpenDefinition
                && TypeArgumentsEquivalent(pa.TypeArguments, pb.TypeArguments, typeParamMap))
            {
                return true;
            }

            // Otherwise (one or both sides expressed as a plain closed CLR
            // type, e.g. a fully concrete `IEnumerator[int32]`) fall back to a
            // closed-type comparison. This is only sound when neither side
            // carries an unbound type parameter, whose CLR shape is erased to
            // `object` and would otherwise equate distinct constructions.
            if (!TypeSymbol.ContainsTypeParameter(pa) && !TypeSymbol.ContainsTypeParameter(pb))
            {
                return pa.ClrType != null
                    && pb.ClrType != null
                    && ClrTypeUtilities.AreSame(pa.ClrType, pb.ClrType);
            }

            return false;
        }

        if (a is SliceTypeSymbol sla && b is SliceTypeSymbol slb)
        {
            return TypeSignaturesEquivalent(sla.ElementType, slb.ElementType, typeParamMap);
        }

        if (a is ArrayTypeSymbol ara && b is ArrayTypeSymbol arb)
        {
            return ara.Length == arb.Length
                && TypeSignaturesEquivalent(ara.ElementType, arb.ElementType, typeParamMap);
        }

        if (a is NullableTypeSymbol na && b is NullableTypeSymbol nb)
        {
            return TypeSignaturesEquivalent(na.UnderlyingType, nb.UnderlyingType, typeParamMap);
        }

        // Leaf fallback for non-generic types that are not reference-interned
        // (e.g. a primitive supplied as a concrete type argument such as the
        // `int32` in `ISeq[int32]`). Type parameters keep an absent ClrType so
        // distinct parameters are never wrongly equated here.
        return a.ClrType != null && b.ClrType != null && a.ClrType == b.ClrType;
    }

    private static bool TypeArgumentsEquivalent(
        ImmutableArray<TypeSymbol> a,
        ImmutableArray<TypeSymbol> b,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap)
    {
        if (a.IsDefaultOrEmpty && b.IsDefaultOrEmpty)
        {
            return true;
        }

        if (a.IsDefaultOrEmpty || b.IsDefaultOrEmpty || a.Length != b.Length)
        {
            return false;
        }

        for (var i = 0; i < a.Length; i++)
        {
            if (!TypeSignaturesEquivalent(a[i], b[i], typeParamMap))
            {
                return false;
            }
        }

        return true;
    }
}
