// <copyright file="SynthesizedClosureReifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable

/// Issue #1477: shared helper that makes a synthesized closure / capture-box
/// class generic over the enclosing generic type / method type parameters its
/// members reference. When a lambda inside a generic type (or generic method)
/// captures a value whose type references an enclosing type parameter (a
/// `T`-typed value, or `this` of `G<T>`), the synthesized
/// display / box class must declare its OWN type parameters that mirror those
/// enclosing parameters 1:1; otherwise its capture field's `VAR` slot has
/// no generic parameter in scope, producing an illegal field type
/// (`System.TypeLoadException` at load) and unverifiable IL.
/// @remarks The reification mirrors the iterator / async state-machine treatment
/// (`RegisterStateMachineEnclosingGenerics`): the synthesized class is
/// reified over fresh class-level type parameters that clone each referenced
/// enclosing parameter, and the original parameters are recorded on
/// (cref:StructSymbol.ReifiedFromTypeParameters) so the emitter can build
/// the outer-TP → own-TP-ordinal remap that routes every member signature
/// through a valid `VAR(idx)` slot. A constructed instance carrying the
/// original parameters as type arguments is returned for use at the capture
/// site (so the `newobj` / field stores reference
/// `DisplayClass<…enclosing args…>`).
internal shared class SynthesizedClosureReifier {
    /// Collects, in a stable canonical order (enclosing TYPE parameters first
    /// by ordinal, then enclosing METHOD parameters by ordinal), the distinct
    /// type parameters referenced by [`types`](paramref) and their transitive constraints.
    /// @param types The member / signature types to scan.
    /// @returns The ordered distinct referenced type parameters; empty when none.
    func CollectOrdered(types IEnumerable[TypeSymbol]) ImmutableArray[TypeParameterSymbol] {
        let referenced = List[TypeParameterSymbol]()
        for t in types {
            TypeSymbol.CollectReferencedTypeParameters(t, referenced)
        }
        // A cloned constraint must not reference an undeclared original parameter.
        // The collector deduplicates entries, including self-referential constraints.
        for var i = 0; i < referenced.Count; i++ {
            let parameter = referenced[i]
            TypeSymbol.CollectReferencedTypeParameters(parameter.TypeParameterBound, referenced)
            TypeSymbol.CollectReferencedTypeParameters(parameter.ClassConstraint, referenced)
            TypeSymbol.CollectReferencedTypeParameters(parameter.InterfaceConstraint, referenced)
            TypeSymbol.CollectReferencedTypeParameters(parameter.ClrInterfaceConstraint, referenced)
        }
        if referenced.Count == 0 {
            return ImmutableArray[TypeParameterSymbol].Empty
        }
        // Canonical order: class type parameters (Var) before method type
        // parameters (MVar), each by their original ordinal. This keeps the
        // synthesized class's parameter list deterministic regardless of the
        // member-scan order.
        referenced.Sort(
            (a TypeParameterSymbol, b TypeParameterSymbol) -> {
                let ak = if a.IsMethodTypeParameter {
                    1
                } else {
                    0
                }
                let bk = if b.IsMethodTypeParameter {
                    1
                } else {
                    0
                }
                if ak != bk {
                    return ak - bk
                }
                return a.Ordinal - b.Ordinal
            }
        )
        return referenced.ToImmutableArray()
    }

    /// Issue #1499: clones [`origTPs`](paramref) 1:1 as class-level type
    /// parameters whose constraint reference types are remapped from the
    /// originals onto the freshly cloned set. Uses a TWO-PASS approach:
    /// (1) create every clone (name / ordinal / kind / reference-, value- and
    /// default-constructor-constraint flags / optional variance) and build the
    /// `original → clone` substitution map; (2) for each clone substitute
    /// that map into the original's (cref:TypeParameterSymbol.InterfaceConstraint),
    /// (cref:TypeParameterSymbol.ClrInterfaceConstraint) and
    /// (cref:TypeParameterSymbol.ClassConstraint) so a constraint that
    /// references an original parameter (self-referential `T IComparable[T]`,
    /// cross-referential `T IEnumerable[U]` / `T Base[U]`, or nested
    /// `T Base[Dict[T, U]]`) instead references the corresponding clone(s).
    /// Because all clones exist before any constraint is rebuilt, interdependent
    /// constraints across the set resolve correctly. Reuses the symbol layer's
    /// (cref:StructSymbol.SubstituteTypeParameters) so the remap walks
    /// generic arguments recursively rather than hand-rolling a partial clone.
    /// @param origTPs The ordered enclosing type parameters to clone.
    /// @param ordinalOffset Issue #4223: the first clone's ordinal. Non-zero when the clones are
    /// appended AFTER a function's own declared type parameters (a generic
    /// local function that ALSO references an enclosing type parameter) —
    /// the clones must occupy CLR generic-parameter slots past the function's
    /// own, not restart at 0 and collide with them.
    /// @param additionalSubstitution Existing original-to-shell parameter mappings that appended
    /// constraints
    /// may reference.
    /// @param preserveVariance Whether to copy declaration-site variance. Synthesized classes and
    /// methods must pass `false` because CLR variance is valid
    /// only on interface and delegate type parameters.
    /// @returns The cloned type parameters with remapped constraints.
    func CloneWithRemappedConstraints(
        origTPs ImmutableArray[TypeParameterSymbol],
        ordinalOffset int32 = 0,
        additionalSubstitution IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]? = nil,
        preserveVariance bool = true
    ) ImmutableArray[TypeParameterSymbol] {
        if origTPs.IsDefaultOrEmpty {
            return ImmutableArray[TypeParameterSymbol].Empty
        }
        let clones = [origTPs.Length]TypeParameterSymbol
        let subst = Dictionary[TypeParameterSymbol, TypeSymbol](origTPs.Length)
        for var i = 0; i < origTPs.Length; i++ {
            let src = origTPs[i]
            // Pass 1: create the clone with its simple flags. Constraint
            // reference types are deferred to pass 2 so cross-referential
            // constraints can see every clone before being rebuilt.
            clones[i] = TypeParameterSymbol(
                src.Name,
                ordinalOffset + i,
                src.Constraint,
                if preserveVariance {
                    src.Variance
                } else {
                    TypeParameterVariance.None
                }
            ){
                HasReferenceTypeConstraint = src.HasReferenceTypeConstraint,
                HasValueTypeConstraint = src.HasValueTypeConstraint,
                HasDefaultConstructorConstraint = src.HasDefaultConstructorConstraint,
                HasUnmanagedConstraint = src.HasUnmanagedConstraint,
                IsMethodTypeParameter = false
            }
            subst[src] = clones[i]
        }
        if additionalSubstitution != nil {
            for pair in additionalSubstitution {
                subst.TryAdd(pair.Key, pair.Value)
            }
        }
        for var i = 0; i < origTPs.Length; i++ {
            let src = origTPs[i]
            let clone = clones[i]
            if src.InterfaceConstraint != nil {
                clone.InterfaceConstraint = StructSymbol.SubstituteTypeParameters(
                    src.InterfaceConstraint,
                    subst
                ) as InterfaceSymbol ??
                    src.InterfaceConstraint
            }
            clone.ClrInterfaceConstraint = if src.ClrInterfaceConstraint is {} clrInterfaceConstraint {
                StructSymbol.SubstituteTypeParameters(clrInterfaceConstraint, subst)
            } else {
                default(TypeSymbol?)
            }
            clone.ClassConstraint = if src.ClassConstraint is {} classConstraint {
                StructSymbol.SubstituteTypeParameters(classConstraint, subst)
            } else {
                default(TypeSymbol?)
            }
            // Issue #4043: a DEPENDENT bound must point at the CLONED sibling,
            // not at the original. Ordinal-based VAR/MVAR encoding would come
            // out right either way, but every identity comparison downstream
            // (constraint propagation, partial-declaration equivalence) reads
            // the symbol, so a bound left pointing into the source set silently
            // stops matching. A bound on a parameter OUTSIDE this set is not in
            // `subst`; it is carried through unchanged.
            clone.TypeParameterBound = if src.TypeParameterBound is {} dependentBound {
                (
                    if subst.TryGetValue(dependentBound, out var clonedBound) {
                        clonedBound as TypeParameterSymbol ?? dependentBound
                    } else {
                        dependentBound
                    }
                )
            } else {
                default(TypeParameterSymbol?)
            }
        }
        return ImmutableArray.Create(clones)
    }

    /// Reifies [`definition`](paramref) generic over the
    /// [`origTPs`](paramref) it references: declares fresh class type
    /// parameters that clone them 1:1, records the originals via
    /// (cref:StructSymbol.SetReifiedFromTypeParameters), and returns a
    /// constructed instance whose type arguments are the originals (for use at
    /// the capture site). The definition's member signatures continue to
    /// reference the original parameters; the emitter's remap routes them
    /// through the new class slots.
    /// @param definition The synthesized closure / box class definition.
    /// @param origTPs The ordered referenced enclosing type parameters.
    /// @param mapClrType Issue #2037: optional projector applied to the constructed instance's
    /// CLR type arguments before `MakeGenericType` (mirrors #1958's
    /// (cref:StructSymbol.Construct(StructSymbol, ImmutableArray{TypeSymbol}, System.Func{System.Type,
    /// System.Type}))
    /// fix). Needed when a hoisted capture/state field is typed as an
    /// imported constructed generic over one of [`origTPs`](paramref)
    /// and the compilation runs under a cross-reflection-context (MLC)
    /// reference set (cs2gs); `null` preserves the
    /// erase-on-mismatch fallback for same-compilation-only callers.
    /// @returns The constructed instance over the original parameters.
    func Reify(
        definition StructSymbol,
        origTPs ImmutableArray[TypeParameterSymbol],
        mapClrType((Type) -> Type)? = nil
    ) StructSymbol {
        let clones = CloneWithRemappedConstraints(origTPs, preserveVariance: false)
        definition.SetTypeParameters(clones)
        definition.SetReifiedFromTypeParameters(origTPs)
        let args = ImmutableArray.CreateBuilder[TypeSymbol](origTPs.Length)
        for tp in origTPs {
            args.Add(tp)
        }
        let typeArguments = args.MoveToImmutable()
        return if mapClrType == nil {
            StructSymbol.Construct(definition, typeArguments)!!
        } else {
            StructSymbol.Construct(definition, typeArguments, mapClrType)!!
        }
    }

    /// Appends cloned enclosing parameters after generic parameters already
    /// declared by a synthesized shell, then constructs the combined type over
    /// the shell arguments followed by the appended enclosing arguments.
    /// @param definition The synthesized shell definition to extend.
    /// @param existingArguments Arguments corresponding to the shell's existing parameters.
    /// @param origTPs Additional enclosing parameters referenced by late-bound members.
    /// @param mapClrType Optional CLR type projector for constructed generic arguments.
    /// @returns The constructed shell over existing and appended arguments.
    func ReifyAppending(
        definition StructSymbol,
        existingArguments ImmutableArray[TypeSymbol],
        origTPs ImmutableArray[TypeParameterSymbol],
        mapClrType((Type) -> Type)? = nil
    ) StructSymbol {
        let offset = definition.TypeParameters.Length
        let existingSubstitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
        for var i = 0; i < existingArguments.Length && i < definition.TypeParameters.Length; i++ {
            if existingArguments[i] is TypeParameterSymbol original {
                existingSubstitution[original] = definition.TypeParameters[i]
            }
        }
        let clones = CloneWithRemappedConstraints(origTPs, offset, existingSubstitution, preserveVariance: false)
        definition.SetTypeParameters(definition.TypeParameters.AddRange(clones))
        definition.SetReifiedFromTypeParameters(origTPs, offset)
        let argumentBuilder = existingArguments.ToBuilder()
        for parameter in origTPs {
            argumentBuilder.Add(parameter)
        }
        let arguments = argumentBuilder.ToImmutable()
        return if mapClrType == nil {
            StructSymbol.Construct(definition, arguments)!!
        } else {
            StructSymbol.Construct(definition, arguments, mapClrType)!!
        }
    }
}
