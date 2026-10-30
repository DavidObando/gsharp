// <copyright file="OverloadResolver.Candidates.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.OverloadResolution

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Linq
import System.Reflection
import System.Threading.Tasks

internal partial class OverloadResolver {
    func SelectInstanceOverloadOrReport(
        overloads ImmutableArray[FunctionSymbol],
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        methodName string,
        argumentNames ImmutableArray[string],
        receiverType TypeSymbol? = nil
    ) FunctionSymbol? {
        var overloads = overloads
        if overloads.Length <= 1 {
            return if overloads.Length == 1 {
                overloads[0]
            } else {
                default(FunctionSymbol?)
            }
        }
        CallCandidateRecorder.RecordFunctions(overloads)
        // Issue #1124: a call may carry an explicit method type-argument list
        // (e.g. `Factory.Make[Box](...)`). Thread its arity into overload
        // selection so generic candidates are filtered for applicability against
        // either the explicit type arguments or, in their absence, type inference.
        let explicitTypeArgCount = ce.TypeArgumentList?.Arguments.Count ?? 0
        var boundTypeArguments = default(ImmutableArray[TypeSymbol])
        if explicitTypeArgCount > 0 {
            let explicitTypeArguments = ImmutableArray.CreateBuilder[TypeSymbol](explicitTypeArgCount)
            for explicitArgument in Invariant.Required(
                ce.TypeArgumentList,
                "an explicit type-argument count has a type-argument list",
                expression: "ce.TypeArgumentList"
            )
                .Arguments {
                let typeArgument TypeSymbol? = bindTypeClause(explicitArgument)
                if typeArgument == nil {
                    return nil
                }
                explicitTypeArguments.Add(typeArgument)
            }
            boundTypeArguments = explicitTypeArguments.MoveToImmutable()
            let constraintMatches = ImmutableArray.CreateBuilder[FunctionSymbol]()
            for candidate in overloads {
                if candidate.TypeParameters.Length != boundTypeArguments.Length {
                    continue
                }
                // Issue #4043: a DEPENDENT bound is answered on the whole
                // vector, so build the positional map before asking.
                let explicitVector = BuildTypeArgumentVector(candidate.TypeParameters, boundTypeArguments)
                var constraintsSatisfied = true
                for var i = 0; i < candidate.TypeParameters.Length; i++ {
                    constraintsSatisfied &= satisfiesConstraint(
                        boundTypeArguments[i],
                        candidate.TypeParameters[i],
                        explicitVector
                    )
                }
                if constraintsSatisfied {
                    constraintMatches.Add(candidate)
                }
            }
            if constraintMatches.Count > 0 {
                overloads = constraintMatches.ToImmutable()
            }
        }
        let selected FunctionSymbol? = SelectBestInstanceOverload(
            overloads,
            arguments.Length,
            argumentNames,
            arguments,
            out var ambiguous,
            out var nullSafetyFailure,
            explicitTypeArgCount,
            boundTypeArguments,
            ce,
            receiverType
        )
        if selected != nil {
            return selected
        }
        if nullSafetyFailure != nil {
            let argLoc = if nullSafetyFailure.Index < ce.Arguments.Count {
                ce.Arguments[nullSafetyFailure.Index].Location
            } else {
                ce.Identifier.Location
            }
            Diagnostics.ReportWrongArgumentType(
                argLoc,
                nullSafetyFailure.ParamName,
                nullSafetyFailure.ParamType,
                nullSafetyFailure.ArgType
            )
        } else if ambiguous {
            if TryGetUnconstrainedNullableIteratorTypeParameter(
                overloads,
                arguments.ToBuilder(),
                arguments.Length,
                boundTypeArguments,
                out var unconstrainedTypeParameter
            ) {
                Diagnostics.ReportUnconstrainedNullableIteratorCall(
                    ce.Identifier.Location,
                    methodName,
                    Invariant.Required(
                        unconstrainedTypeParameter,
                        "an unconstrained nullable iterator diagnostic has a type parameter",
                        expression: "unconstrainedTypeParameter"
                    )
                        .Name
                )
            } else {
                Diagnostics.ReportAmbiguousOverloadResolution(ce.Identifier.Location, methodName)
            }
        } else {
            Diagnostics.ReportNoApplicableOverload(ce.Identifier.Location, methodName)
        }
        return nil
    }

    /// Issue #1147: builds the <em>unified</em> instance + static (`shared`)
    /// method group for [`structSym`](paramref).[`methodName`](paramref)
    /// and selects the single best applicable overload across BOTH buckets,
    /// reporting the standard ambiguity / no-applicable-overload diagnostics. This
    /// implements C#'s combined instance+static overload resolution that both the
    /// "Color Color" receiver-disambiguation (ECMA-334 §12.8.7.1) and an
    /// unqualified same-named call inside an instance method reduce to. The
    /// selected method's (cref:FunctionSymbol.IsStatic) tells the caller
    /// whether to finalize the call as an instance or a static dispatch.
    /// @param structSym The user struct/class whose method group is searched.
    /// @param methodName The invoked method name.
    /// @param arguments The already-bound call arguments.
    /// @param ce The originating call syntax (for diagnostic locations / type-arg arity).
    /// @param argumentNames The named-argument layout, or default.
    /// @param hasCandidates Set to `true` when the union
    /// was non-empty. When this is `false` the caller should fall
    /// through to its existing not-found path so a genuinely-undefined name still
    /// reports GS0130.
    /// @returns The selected overload, or `null` (after a
    /// diagnostic) when the non-empty union had no applicable overload.
    func SelectUnifiedInstanceStaticOverload(
        structSym StructSymbol,
        methodName string,
        arguments ImmutableArray[BoundExpression],
        ce CallExpressionSyntax,
        argumentNames ImmutableArray[string],
        out hasCandidates bool
    ) FunctionSymbol? {
        let instanceGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Instance(MemberKinds.Method))
        let staticGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Static(MemberKinds.Method))
        let unified = if instanceGroup.IsDefaultOrEmpty {
            staticGroup
        } else {
            (
                if staticGroup.IsDefaultOrEmpty {
                    instanceGroup
                } else {
                    instanceGroup.AddRange(staticGroup)
                }
            )
        }
        hasCandidates = !unified.IsDefaultOrEmpty
        if !hasCandidates {
            return nil
        }
        return SelectInstanceOverloadOrReport(unified, arguments, ce, methodName, argumentNames, structSym)
    }

    private func SelectBestUserOverload(
        candidates ImmutableArray[FunctionSymbol],
        argumentCount int32,
        argumentNames ImmutableArray[string],
        boundArguments ImmutableArray[BoundExpression].Builder,
        callSyntax CallExpressionSyntax,
        out ambiguous bool,
        out nullSafetyFailure NullSafetyArgumentMismatch?,
        explicitTypeArgCount int32 = 0
    ) FunctionSymbol? {
        CallCandidateRecorder.RecordFunctions(candidates)
        return SelectBestUserOverloadCore(
            candidates,
            argumentCount,
            argumentNames,
            boundArguments,
            callSyntax,
            out ambiguous,
            out nullSafetyFailure,
            explicitTypeArgCount
        )
    }

    /// ADR-0063 §6: instance-method overload selection. Filters a candidate set
    /// of methods (each may or may not carry an explicit receiver parameter) by
    /// callable arity, named-argument compatibility, and optional-parameter
    /// applicability, then ranks by exact-type matches and defaulted slots.
    func SelectBestInstanceOverload(
        candidates ImmutableArray[FunctionSymbol],
        argumentCount int32,
        argumentNames ImmutableArray[string],
        boundArguments ImmutableArray[BoundExpression],
        out ambiguous bool,
        out nullSafetyFailure NullSafetyArgumentMismatch?,
        explicitTypeArgCount int32 = 0,
        explicitTypeArguments ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        callSyntax CallExpressionSyntax? = nil,
        receiverType TypeSymbol? = nil
    ) FunctionSymbol? {
        ambiguous = false
        nullSafetyFailure = nil
        if candidates.Length == 0 {
            return nil
        }
        if candidates.Length == 1 {
            return candidates[0]
        }
        CallCandidateRecorder.RecordFunctions(candidates)
        let builder = ImmutableArray.CreateBuilder[BoundExpression](boundArguments.Length)
        builder.AddRange(boundArguments)
        return SelectBestUserOverloadCore(
            candidates,
            argumentCount,
            argumentNames,
            builder,
            callSyntax,
            out ambiguous,
            out nullSafetyFailure,
            explicitTypeArgCount,
            explicitTypeArguments,
            receiverType
        )
    }

    private func SelectBestUserOverloadCore(
        candidates ImmutableArray[FunctionSymbol],
        argumentCount int32,
        argumentNames ImmutableArray[string],
        boundArguments ImmutableArray[BoundExpression].Builder,
        callSyntax CallExpressionSyntax?,
        out ambiguous bool,
        out nullSafetyFailure NullSafetyArgumentMismatch?,
        explicitTypeArgCount int32 = 0,
        explicitTypeArguments ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        receiverType TypeSymbol? = nil
    ) FunctionSymbol? {
        ambiguous = false
        nullSafetyFailure = nil
        // Issue #1632: the #1124 applicability filter and the Phase-2 scoring
        // below both infer a generic candidate's method-type-parameter
        // substitution from the SAME (candidate, boundArguments, argumentCount)
        // inputs. Memoize per candidate for this call so unification runs once
        // instead of twice per generic candidate.
        let substitutionCache = Dictionary[
            FunctionSymbol,
            (Ok bool, Substitution Dictionary[TypeParameterSymbol, TypeSymbol])
        ]()
        // Issue #3874: constructed receivers expose their definition's open
        // methods. Apply the receiver map during selection, not only after a
        // winner is chosen, and compose it with any method-level type arguments.
        let receiverSubstitution Dictionary[TypeParameterSymbol, TypeSymbol]? = if receiverType != nil {
            TryBuildReceiverSubstitution(receiverType)
        } else {
            default(Dictionary[TypeParameterSymbol, TypeSymbol]?)
        }
        let GetCandidateSubstitution = func (candidate FunctionSymbol) Dictionary[TypeParameterSymbol, TypeSymbol]? {
            var methodSubstitution Dictionary[TypeParameterSymbol, TypeSymbol]? = nil
            if !explicitTypeArguments.IsDefaultOrEmpty &&
                candidate
                .TypeParameters
                .Length == explicitTypeArguments
                .Length {
                methodSubstitution = candidate
                    .TypeParameters
                    .Select(
                    (parameter TypeParameterSymbol, index int32) -> (parameter, argument: explicitTypeArguments[index])
                )
                    .ToDictionary(
                    (pair(parameter TypeParameterSymbol, argument TypeSymbol)) -> pair.Item1,
                    (pair(parameter TypeParameterSymbol, argument TypeSymbol)) -> pair.Item2
                )
            } else if candidate.IsGeneric {
                if !GetCachedCandidateSubstitution(
                    candidate,
                    boundArguments,
                    argumentCount,
                    substitutionCache,
                    out var inferred
                ) {
                    return nil
                }
                methodSubstitution = inferred
            }
            if receiverSubstitution == nil {
                return methodSubstitution
            }
            let combined = if methodSubstitution != nil {
                Dictionary[TypeParameterSymbol, TypeSymbol](methodSubstitution)
            } else {
                Dictionary[TypeParameterSymbol, TypeSymbol]()
            }
            for pair in receiverSubstitution {
                combined[pair.Key] = pair.Value
            }
            return combined
        }
        // Phase 1: applicability.
        var applicable = List[FunctionSymbol]()
        for cand in candidates {
            if IsApplicableUserCallable(cand, argumentCount, argumentNames) {
                applicable.Add(cand)
            }
        }
        // Issue #1124: a generic candidate whose method type parameters cannot be
        // determined for the call is not applicable (C# §11.6.4.2 "if type
        // inference fails, the method is not a candidate"). Without an explicit
        // type-argument list this means every type parameter must be inferable
        // from the argument types; with an explicit list it means the candidate
        // must be generic of matching arity (a non-generic overload cannot accept
        // type arguments). Dropping such candidates here prevents a uninferable
        // generic overload from tying with — and thus being reported ambiguous
        // (GS0266) against — an otherwise-unique non-generic best match.
        if applicable.Count > 1 {
            let filtered = List[FunctionSymbol](applicable.Count)
            for cand in applicable {
                if explicitTypeArgCount > 0 {
                    if cand.IsGeneric && cand.TypeParameters.Length == explicitTypeArgCount {
                        filtered.Add(cand)
                    }
                } else if cand.IsGeneric {
                    if GetCachedCandidateSubstitution(cand, boundArguments, argumentCount, substitutionCache, out _) {
                        filtered.Add(cand)
                    }
                } else {
                    filtered.Add(cand)
                }
            }
            // Only adopt the filtered set when it leaves at least one candidate;
            // an empty result means the call shape is genuinely unsatisfiable and
            // the pre-existing diagnostics on the unfiltered set are preferable.
            if filtered.Count > 0 {
                applicable = filtered
            }
        }
        if applicable.Count > 1 {
            let constrained = List[FunctionSymbol](applicable.Count)
            for cand in applicable {
                if !cand.IsGeneric ||
                    (
                    GetCandidateSubstitution(cand) is {} substitution && cand.TypeParameters.All(
                        (tp TypeParameterSymbol) -> satisfiesConstraint(substitution[tp], tp, substitution)
                    )
                ) {
                    constrained.Add(cand)
                }
            }
            if constrained.Count > 0 {
                applicable = constrained
            }
        }
        // Issue #1154: arity/name applicability (Phase 1) does not check whether
        // each argument is type-convertible to the corresponding parameter. Per
        // C# §11.6.4.2 a candidate is NOT applicable when any argument has no
        // implicit conversion to its parameter type. Without this filter a
        // wholly-inapplicable overload (e.g. F(string) for a []uint8 argument)
        // can tie — and thus be reported ambiguous (GS0266) — with the unique
        // genuinely-applicable overload that merely needs an implicit
        // nullable/reference widening (e.g. []uint8 -> []?uint8). Drop such
        // non-convertible candidates here, conservatively (see skips below), so
        // the unique applicable overload is selected without a spurious GS0266.
        if applicable.Count > 1 {
            let convertible = List[FunctionSymbol](applicable.Count)
            for cand in applicable {
                if IsConvertibilityApplicable(
                    cand,
                    argumentCount,
                    argumentNames,
                    boundArguments,
                    GetCandidateSubstitution(cand),
                    callSyntax
                ) {
                    convertible.Add(cand)
                }
            }
            // Mirror the #1124 pattern: only adopt the narrowed set when it
            // leaves at least one candidate. An empty result means the call is
            // genuinely unsatisfiable; keep the prior list so the pre-existing
            // diagnostics (no-applicable-overload / ambiguity) are preserved.
            if convertible.Count > 0 {
                applicable = convertible
            } else {
                // Issue #1552: every arity-applicable candidate was filtered
                // out. When the reason is the Kotlin-model null-safety gate — a
                // nullable REFERENCE argument `S?` reaching a non-nullable,
                // non-`object` reference parameter — surface the SAME GS0154
                // the single-candidate path emits, rather than falling through
                // to a spurious GS0266 ambiguity or a generic
                // no-applicable-overload. This preserves null safety: the user
                // is prompted to write `!!` (or narrow) exactly as the
                // single-overload call already requires.
                nullSafetyFailure = TryFindNullSafetyArgumentMismatch(applicable, argumentCount, boundArguments)
                if nullSafetyFailure != nil {
                    return nil
                }
                // Review finding (#3988, Copilot on PR #3999): the gate above
                // now declines when the argument's NON-nullable form would not
                // reach the parameter either, because GS0154 must not prescribe
                // `!!` where `!!` cannot help. Declining alone is not enough:
                // this branch keeps the arity set precisely so the "pre-existing
                // diagnostics" survive, and for a wholly non-convertible set
                // those two candidates then TIE in the betterness ranking and
                // the call is reported GS0266 — "ambiguous … disambiguate with
                // explicit types" — which is not merely mis-framed but FALSE:
                // there is no choice to disambiguate, and no explicit type makes
                // one applicable. Measured on this branch before the fix below,
                // `func f(ch chan[string])` / `func f(xs []string)` called with a
                // `chan[T]?` reported exactly that.
                //
                // When a nullable-REFERENCE argument reaches no candidate in
                // either form, the truthful answer is the one this method's own
                // caller already emits for an empty set: GS0267, no overload is
                // applicable. Narrowly clearing the set for that case routes it
                // there. The general wholly-unsatisfiable set is untouched and
                // still reports GS0266 as before.
                if HasUnsatisfiableNullableReferenceArgument(applicable, argumentCount, boundArguments) {
                    applicable = List[FunctionSymbol]()
                }
            }
        }
        if applicable.Count == 0 {
            return nil
        }
        if applicable.Count == 1 {
            return applicable[0]
        }
        // Phase 2 (issue #1631): rank by C# §7.5.3.2 "better function member"
        // pairwise domination over per-argument conversion kind, reusing the
        // SAME ClrOverloadResolution.ImplicitConversionKind ranking (and numeric "better conversion
        // target" tie-break) the CLR-reflection resolver
        // (ClrOverloadResolution.RankApplicable/CompareConversions) uses for
        // imported-method overloads. This replaces the previous ad-hoc linear
        // score, under which any two candidates that both needed an implicit
        // conversion tied at score 0 (e.g. F(int64) / F(float64) called with an
        // int32 constant) and reported a spurious GS0266 — even though one
        // conversion is strictly "better" per C#. Only after the per-argument
        // pairwise pass survivors are narrowed do the arity tie-breakers
        // (fewest defaulted parameters, then non-variadic, then non-generic)
        // run, matching the CLR path's phase ordering.
        let data = List[UserCandidateRankData](applicable.Count)
        for cand in applicable {
            let parameterOffset = if cand.ExplicitReceiverParameter == nil {
                0
            } else {
                1
            }
            let paramLen = cand.Parameters.Length - parameterOffset
            let isVariadic = paramLen > 0 && cand.Parameters[cand.Parameters.Length - 1].IsVariadic
            let paramCountForScore = if isVariadic {
                paramLen - 1
            } else {
                paramLen
            }
            var defaultsUsed = paramCountForScore - argumentCount
            if defaultsUsed < 0 {
                defaultsUsed = 0
            }
            // Close both receiver- and method-level type parameters before
            // classifying conversions and comparing their target types.
            let candSubstitution Dictionary[TypeParameterSymbol, TypeSymbol]? = GetCandidateSubstitution(cand)
            // Classify each supplied argument's conversion to its ACTUAL
            // target slot. Issue #1628: boundArguments[i] is source order,
            // not parameter order — under named arguments the source-order
            // index does not necessarily line up with the parameter it binds
            // to (e.g. a named arg reorders a permutation-overload's
            // parameters). Map each argument to its real slot before
            // classifying, so a named call still ranks against the correct
            // parameter type.
            let kinds = [boundArguments.Count]ClrOverloadResolution.ImplicitConversionKind
            let paramTypes = [boundArguments.Count]TypeSymbol
            let openParamTypes = [boundArguments.Count]TypeSymbol
            let isTailSlot = [boundArguments.Count]bool
            var elementType TypeSymbol? = if isVariadic && VariadicCarriers.GetElementType(
                cand.Parameters[cand.Parameters.Length - 1].Type
            ) is {} variadicElement &&
                variadicElement != TypeSymbol.Error {
                variadicElement
            } else {
                default(TypeSymbol?)
            }
            // Issue #3880: the EXPANDED-form element type needs closing for the
            // same reason #3964 closed the carrier one line further down.
            // Ranking `Elem[T](values ...T)` against `Elem(values ...object)`
            // for `Elem("a", "b")` compared `string` to the OPEN `T` (which
            // erases to object) and to `object`, landed both candidates on the
            // same conversion kind, and let the later non-generic-over-generic
            // tie-break hand the call to the `object` overload — where C#
            // infers `T = string`, sees an identity, and picks the generic one.
            // Closing the element type is enough on its own: the per-argument
            // kind comparison in CompareUserConversions runs before ParamTypes
            // is ever consulted, so an expanded tail slot can misrank without
            // the reference "better conversion target" tie-break participating.
            if elementType != nil && candSubstitution != nil {
                elementType = GSharp.Core.CodeAnalysis.Binding.Binder.SubstituteType(elementType, candSubstitution)
            }
            // Issue #3880: a single trailing argument that already IS the
            // variadic carrier (`F(existingArray)` against `F(xs ...string)`)
            // binds the candidate in NORMAL form, not expanded form — the same
            // pass-through the applicability filter recognises via
            // IsVariadicCarrierPassThrough. Ranking used to classify it as an
            // expanded tail slot against the ELEMENT type, which both mis-rates
            // the conversion (`[]string -> string`) and leaves ParamTypes[i]
            // null, so the Reference "better conversion target" tie-break could
            // not run and two variadic siblings
            // (`F(xs ...string)` / `F(refs IReadOnlyList[string]?, xs ...string)`)
            // tied and reported a spurious GS0266 where C# picks the first.
            // The carrier must be CLOSED before it is compared to the argument.
            // A generic variadic candidate (`func Take[T](values ...T)`) whose
            // inference already ran declares the carrier as the open `[]T`;
            // ranking `[]string` against `[]T` classifies an identity as a
            // reference conversion and hands the call to a fixed
            // `IEnumerable[string]` sibling that C# does not choose. The
            // non-tail slots below already substitute through candSubstitution
            // for exactly this reason.
            var variadicCarrierType TypeSymbol? = if isVariadic {
                cand.Parameters[cand.Parameters.Length - 1].Type
            } else {
                default(TypeSymbol?)
            }
            if variadicCarrierType != nil && candSubstitution != nil {
                variadicCarrierType = GSharp
                    .Core
                    .CodeAnalysis
                    .Binding
                    .Binder
                    .SubstituteType(variadicCarrierType, candSubstitution)
            }
            let bindsCarrierInNormalForm = isVariadic &&
                !HasNamedArguments(argumentNames) &&
                argumentCount - paramCountForScore == 1 &&
                paramCountForScore < boundArguments.Count &&
                boundArguments[paramCountForScore]?.Type is {} carrierPassThroughArgType &&
                variadicCarrierType != nil &&
                IsVariadicCarrierPassThrough(carrierPassThroughArgType, variadicCarrierType)
            for var i = 0; i < boundArguments.Count; i++ {
                let slot = MapArgumentIndexToParameterSlot(cand, argumentNames, i, parameterOffset, paramLen)
                if slot < 0 {
                    // Unmapped (shouldn't happen for an applicable candidate) —
                    // neutral: contributes no per-argument preference.
                    kinds[i] = ClrOverloadResolution.ImplicitConversionKind.Identity
                    continue
                }
                if slot >= paramCountForScore {
                    // Issue #1631 (B1): variadic params-array tail argument.
                    // Classify against the params ELEMENT type (so a genuine
                    // widening in the tail is still visible) but flag the
                    // slot as expanded-form. IsUserCandidateAtLeastAsGoodAs
                    // below ranks an expanded-form slot strictly worse than a
                    // normal-form slot on the SAME argument regardless of
                    // conversion kind — C#'s "non-expanded form is preferred
                    // over expanded form" rule (§7.5.3.2) — so a variadic
                    // sibling can never dominate an applicable non-variadic
                    // one purely because its tail was compared favourably.
                    // Between two variadic candidates (both expanded), the
                    // element-type kind still decides genuine betterness.
                    let tailArgType = boundArguments[i]?.Type
                    if bindsCarrierInNormalForm {
                        // Normal form (issue #3880): rank against the carrier
                        // itself, in a normal-form slot, so an exact `[]string`
                        // beats a sibling's `IReadOnlyList[string]?` widening.
                        let normalFormCarrier = Invariant.Required(
                            variadicCarrierType,
                            "a carrier pass-through candidate has a variadic carrier parameter",
                            expression: "variadicCarrierType"
                        )
                        paramTypes[i] = normalFormCarrier
                        openParamTypes[i] = cand.Parameters[cand.Parameters.Length - 1].Type
                        kinds[i] = ClassifyUserArgumentConversionKind(tailArgType, normalFormCarrier)
                        continue
                    }
                    isTailSlot[i] = true
                    // Record the (closed) element type as this slot's ranking
                    // target. It was left null, which made CompareUserConversions
                    // unreachable-by-assumption for expanded slots: its
                    // NumericWidening arm dereferences BOTH parameter types, and
                    // its Reference / UserDefinedImplicit arms silently tie when
                    // either is null. Two variadic candidates whose tails
                    // classify identically therefore either crashed (numeric) or
                    // lost their "better conversion target" tie-break (reference).
                    // `G(anchor int64, values ...int64)` vs
                    // `G(anchor int64, values ...float64)` called with an int32
                    // tail crashed with GS9998 on this path before this line
                    // existed — closing the element type above widens the set of
                    // pairs that reach it, so it has to be populated here.
                    if elementType == nil {
                        // No element type to rank against: stay Identity and
                        // leave the slot's target unset. Identity never reaches
                        // an arm of CompareUserConversions that reads it.
                        kinds[i] = ClrOverloadResolution.ImplicitConversionKind.Identity
                        continue
                    }
                    paramTypes[i] = elementType
                    openParamTypes[i] = VariadicCarriers.GetElementType(
                        cand.Parameters[cand.Parameters.Length - 1].Type
                    ) ??
                        elementType
                    kinds[i] = ClassifyUserArgumentConversionKind(tailArgType, elementType)
                    continue
                }
                let argType = boundArguments[i]?.Type
                let openParamType = cand.Parameters[slot + parameterOffset].Type
                openParamTypes[i] = openParamType
                var paramType = openParamType
                if candSubstitution != nil {
                    paramType = GSharp.Core.CodeAnalysis.Binding.Binder.SubstituteType(paramType, candSubstitution)
                }
                paramTypes[i] = paramType
                // Issue #4422: a by-reference slot ranks on its storage type:
                // an exact match beats one that differs only in reference
                // nullability, as in C#.
                if cand
                    .Parameters[slot + parameterOffset]
                    .RefKind != RefKind.None &&
                    ByRefStorageMatching.TryGetStorageType(boundArguments[i]) is {} byRefStorage &&
                    !TypeSymbol
                    .ContainsTypeParameter(paramType) {
                    let exact = ByRefStorageMatching.IsExactStorageMatch(byRefStorage, paramType)
                    kinds[i] = if exact == true {
                        ClrOverloadResolution.ImplicitConversionKind.Identity
                    } else {
                        (
                            if exact == false {
                                ClrOverloadResolution.ImplicitConversionKind.Reference
                            } else {
                                ClrOverloadResolution.ImplicitConversionKind.DelegateReturnCovariance
                            }
                        )
                    }
                    continue
                }
                // Issue #1531 control: a value-returning delegate/method-group
                // argument that maps onto a `(...)->void` delegate parameter
                // discards its result. Classify it as C#'s worst-ranked
                // "lambda to void delegate" conversion so a sibling
                // `(...)->TResult` overload (whose delegate return closes to
                // the argument's actual return type) is preferred — matching
                // C#'s "better conversion from a method group" rule — instead
                // of tying and reporting a spurious GS0266.
                // An async lambda's Task/ValueTask wrapper is supplied by its
                // candidate target, so equal awaited result shapes rank equally.
                let lambdaSyntax = if callSyntax != nil && i < callSyntax.Arguments.Count {
                    GetLambdaArgumentSyntax(callSyntax.Arguments[i])
                } else {
                    default(LambdaExpressionSyntax?)
                }
                kinds[i] = if lambdaSyntax?.IsAsync == true && HasSameAsyncLambdaResultShape(argType, paramType) {
                    ClrOverloadResolution.ImplicitConversionKind.Identity
                } else {
                    (
                        if IsValueReturnDiscardedToVoidDelegate(argType, paramType, candSubstitution) {
                            ClrOverloadResolution.ImplicitConversionKind.LambdaToVoidDelegate
                        } else {
                            ClassifyUserArgumentConversionKind(argType, paramType)
                        }
                    )
                }
            }
            data.Add(
                UserCandidateRankData(cand, kinds, paramTypes, openParamTypes, isTailSlot, defaultsUsed, isVariadic)
            )
        }
        // Phase 2a: pairwise domination. A candidate survives when no other
        // candidate is "at least as good on every argument, and strictly
        // better on at least one" (C# §7.5.3.2). Two candidates whose
        // per-argument conversions are pairwise incomparable both survive —
        // exactly the non-generic-vs-generic tie the previous strict-
        // dominance-over-all-others requirement rejected.
        let argTypes = [boundArguments.Count]TypeSymbol?
        for var i = 0; i < boundArguments.Count; i++ {
            argTypes[i] = boundArguments[i]?.Type
        }
        let survivors = List[UserCandidateRankData](data.Count)
        for c in data {
            var dominated = false
            for o in data {
                if object.ReferenceEquals(c.Candidate, o.Candidate) {
                    continue
                }
                if IsUserCandidateAtLeastAsGoodAs(o, c, argTypes) {
                    dominated = true
                    break
                }
            }
            if !dominated {
                survivors.Add(c)
            }
        }
        // Domination is a strict partial order over a finite non-empty set
        // (applicable.Count > 1 here), so a maximal element always survives —
        // survivors is never empty; the old "fall back to data" branch was
        // dead code.
        Debug.Assert(survivors.Count > 0, "pairwise domination must leave at least one survivor")
        var pool = survivors
        // Phase 2b: prefer the fewest defaulted parameters (an exact-arity
        // overload beats one that relies on defaults).
        if pool.Count > 1 {
            let minDefaults = pool.Min((w UserCandidateRankData) -> w.DefaultsUsed)
            let fewestDefaults = pool.Where((w UserCandidateRankData) -> w.DefaultsUsed == minDefaults).ToList()
            if fewestDefaults.Count > 0 && fewestDefaults.Count < pool.Count {
                pool = fewestDefaults
            }
        }
        // Phase 2c: prefer a non-variadic candidate over a variadic one (per
        // ADR §6.6 — the normal-form / non-expanded-params preference).
        if pool.Count > 1 {
            let nonVariadic = pool.Where((w UserCandidateRankData) -> !w.IsVariadic).ToList()
            if nonVariadic.Count > 0 && nonVariadic.Count < pool.Count {
                pool = nonVariadic
            }
        }
        // Phase 2d: prefer a non-generic candidate over a generic one when
        // otherwise tied (C# §7.5.3.2's non-generic-over-generic tie-break).
        if pool.Count > 1 {
            let nonGeneric = pool.Where((w UserCandidateRankData) -> !w.Candidate.IsGeneric).ToList()
            if nonGeneric.Count > 0 && nonGeneric.Count < pool.Count {
                pool = nonGeneric
            }
        }
        // Phase 2e — issue #2172: when an argument is a task-returning lambda
        // (its natural function type returns Task/Task<T>), prefer a candidate
        // whose delegate parameter is shaped `(...) -> Task[TResult]` (binding
        // the whole task to a Task-typed delegate result) over one shaped
        // `(...) -> TResult` (binding the whole task to a bare method type
        // parameter). Both close to the same `(...) -> Task[X]` after inference,
        // so neither dominates on conversion kind and the earlier tie-breaks
        // cannot choose. Mirrors C#'s preference for the task-returning delegate
        // overload for an async/task-returning lambda argument, and the parallel
        // rule in ClrOverloadResolution.RankApplicable for imported (BCL) overloads.
        // Generalised: fires for ANY user overload set differing by `(...) -> X`
        // vs `(...) -> Task[X]` at a task-returning-lambda argument slot.
        if pool.Count > 1 {
            pool = PreferTaskShapedDelegateForTaskLambda(pool, boundArguments)
        }
        if pool.Count == 1 {
            return pool[0].Candidate
        }
        ambiguous = true
        return nil
    }

    /// Per-candidate data accumulated during Phase 2 user-overload ranking
    /// (issue #1631): the per-argument conversion classification plus the
    /// arity axes (defaulted-parameter count, variadic-ness) used by the
    /// tie-breakers that run after pairwise domination.
    private struct UserCandidateRankData {
        init(
            candidate FunctionSymbol,
            kinds[]ClrOverloadResolution.ImplicitConversionKind,
            paramTypes[]TypeSymbol,
            openParamTypes[]TypeSymbol,
            isTailSlot[]bool,
            defaultsUsed int32,
            isVariadic bool
        ) {
            Candidate = candidate
            Kinds = kinds
            ParamTypes = paramTypes
            OpenParamTypes = openParamTypes
            IsTailSlot = isTailSlot
            DefaultsUsed = defaultsUsed
            IsVariadic = isVariadic
        }

        prop Candidate FunctionSymbol {
            get;
        }

        prop Kinds[]ClrOverloadResolution.ImplicitConversionKind {
            get;
        }

        prop ParamTypes[]TypeSymbol {
            get;
        }

        prop OpenParamTypes[]TypeSymbol {
            get;
        }

        /// Gets per-argument flags set when the argument at that index bound
        /// to this candidate's variadic params-array tail (as opposed to a
        /// normal fixed parameter slot) (issue #1631, B1).
        prop IsTailSlot[]bool {
            get;
        }

        prop DefaultsUsed int32 {
            get;
        }

        prop IsVariadic bool {
            get;
        }
    }

    /// Issue #1631: classifies the implicit conversion from a user-symbolic
    /// argument type to a user-symbolic parameter type using the SAME
    /// (cref:ClrOverloadResolution.ImplicitConversionKind) ranking the CLR-reflection
    /// resolver ((cref:ClrOverloadResolution.ClassifyImplicit)) uses for
    /// imported-method overloads, so both resolvers agree on which conversion
    /// is "better". Bounded to the conversion shapes the user-symbolic
    /// (cref:Conversion) classifier actually distinguishes: identity,
    /// nullable-wrap (`T -> T?`), and numeric widening (via the
    /// shared (cref:NumericWideningLattice)). Every other implicit
    /// conversion (reference upcast, interface satisfaction, boxing,
    /// user-defined `op_Implicit`, …) folds into
    /// (cref:ClrOverloadResolution.ImplicitConversionKind.Reference) — the user-symbolic type
    /// model does not carry enough structure to rank those sub-kinds
    /// separately, but they still rank strictly better than the numeric/
    /// delegate special cases ranked worse below.
    private func ClassifyUserArgumentConversionKind(argType TypeSymbol?, paramType TypeSymbol?) ClrOverloadResolution
        .ImplicitConversionKind {
        if argType == nil || paramType == nil {
            return ClrOverloadResolution.ImplicitConversionKind.None
        }
        // Issue #3501: constructed imported generics over user type arguments
        // (`ImmutableArray[Loc]`) are freshly allocated per construction, so
        // reference equality misses the identity case and the argument ranked
        // as a mere reference conversion — making a same-typed normal-form
        // slot tie with a params-expanded sibling (spurious GS0266).
        if argType == paramType || DeclarationBinder.TypeSignaturesEquivalent(argType, paramType) {
            return ClrOverloadResolution.ImplicitConversionKind.Identity
        }
        if Conversion.Classify(argType, paramType).IsStructuralProjection {
            return if conversions.HasUserDefinedImplicitConversion(argType, paramType) {
                ClrOverloadResolution.ImplicitConversionKind.UserDefinedImplicit
            } else {
                ClrOverloadResolution.ImplicitConversionKind.StructuralProjection
            }
        }
        if !IsNumericPrimitive(argType) &&
            !IsNumericPrimitive(paramType) &&
            conversions
            .HasUserDefinedImplicitConversion(argType, paramType) {
            return ClrOverloadResolution.ImplicitConversionKind.UserDefinedImplicit
        }
        if paramType is NullableTypeSymbol nullableParam && argType == nullableParam.UnderlyingType {
            // Issue #2146: `T -> T?` is a genuine value-type nullable WRAP only
            // when the underlying is a value type. For a REFERENCE-type nullable
            // (e.g. `Type -> Type?`) the wrap carries no runtime cost — it is a
            // reference conversion (a nullability annotation) — and ranking it as
            // NullableWrap (worse than Reference) would make an unrelated
            // `object` reference upcast spuriously win. Classify it as Reference
            // so the reference "better conversion target" tie-break (below, in
            // CompareUserConversions) correctly prefers the more-derived `T?`
            // target over `object`.
            if NullableLifting.IsValueTypeNullable(nullableParam) {
                return ClrOverloadResolution.ImplicitConversionKind.NullableWrap
            }
            return ClrOverloadResolution.ImplicitConversionKind.Reference
        }
        let argClr = argType.ClrType
        let paramClr = paramType.ClrType
        if argClr?.FullName is string argFullName &&
            paramClr?.FullName is string paramFullName &&
            NumericWideningLattice.IsNumericPrimitive(argFullName) && NumericWideningLattice.IsNumericPrimitive(
            paramFullName
        ) &&
            NumericWideningLattice.IsWidening(argClr, paramClr) {
            return ClrOverloadResolution.ImplicitConversionKind.NumericWidening
        }
        // ponytail: object vs. an implemented interface (e.g. f(object) vs.
        // f(IInterface) for a class arg) both fold into Reference here, so
        // they tie and report GS0266 where C# would prefer the interface.
        // Pre-existing ceiling (parity with the old linear score), not a
        // #1631 regression. Upgrade path: split Reference into sub-kinds
        // (exact-interface-satisfaction vs. base-class/object upcast) sharing
        // more of Conversion.Classify's structure, if this surfaces in practice.
        return ClrOverloadResolution.ImplicitConversionKind.Reference
    }

    /// Issue #1154: convertibility-aware applicability. Returns
    /// `true` when every positional argument actually supplied
    /// is implicitly convertible to the corresponding parameter type of
    /// [`candidate`](paramref). Conservatively treats a candidate as
    /// convertible (does NOT reject) for situations where the positional
    /// index→parameter mapping or the parameter type is unreliable: generic
    /// candidates (their parameter types may contain unsubstituted method type
    /// parameters — handled by the #1124 inference filter), the variadic tail,
    /// by-ref/out/in parameters, and unknown argument/parameter types.
    private func IsConvertibilityApplicable(
        candidate FunctionSymbol,
        argumentCount int32,
        argumentNames ImmutableArray[string],
        boundArguments ImmutableArray[BoundExpression].Builder,
        substitution Dictionary[TypeParameterSymbol, TypeSymbol]? = nil,
        callSyntax CallExpressionSyntax? = nil
    ) bool {
        // Generic candidates may carry unsubstituted method type parameters in
        // their signature; rely on the existing #1124 inference filter instead.
        if candidate.IsGeneric && substitution == nil {
            return true
        }
        let parameterOffset = if candidate.ExplicitReceiverParameter == nil {
            0
        } else {
            1
        }
        let paramLen = candidate.Parameters.Length - parameterOffset
        let isVariadic = paramLen > 0 && candidate.Parameters[candidate.Parameters.Length - 1].IsVariadic
        let fixedParamCount = if isVariadic {
            paramLen - 1
        } else {
            paramLen
        }
        let count = Math.Min(argumentCount, paramLen)
        for var i = 0; i < count && i < boundArguments.Count; i++ {
            let parameterSlot = MapArgumentIndexToParameterSlot(candidate, argumentNames, i, parameterOffset, paramLen)
            if parameterSlot < 0 {
                return false
            }
            // The variadic tail binds its element(s) elsewhere; do not reject.
            if isVariadic && parameterSlot >= fixedParamCount {
                continue
            }
            let parameter = candidate.Parameters[parameterSlot + parameterOffset]
            // By-ref/out/in parameters have their own exact-type rules. Issue
            // #4422: apply them here too, so a candidate whose storage type
            // the by-ref gate would reject is not selected over one it
            // accepts (`ref int32` versus `ref int32?` for `int32?` storage).
            if parameter.RefKind != RefKind.None {
                if ByRefStorageMatching.TryGetStorageType(boundArguments[i]) is {} storageType {
                    let byRefParameterType = if substitution != nil {
                        GSharp.Core.CodeAnalysis.Binding.Binder.SubstituteType(parameter.Type, substitution)
                    } else {
                        parameter.Type
                    }
                    if !TypeSymbol.ContainsTypeParameter(byRefParameterType) &&
                        ByRefStorageMatching.IsExactStorageMatch(storageType, byRefParameterType) == nil {
                        return false
                    }
                }
                continue
            }
            let argType TypeSymbol? = boundArguments[i]?.Type
            var paramType TypeSymbol? = parameter.Type
            if substitution != nil {
                paramType = GSharp.Core.CodeAnalysis.Binding.Binder.SubstituteType(paramType!!, substitution)
            }
            if ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(boundArguments[i], out var deferredSyntax) {
                if !ExpressionBinder.CanTargetDependentBlockArgument(deferredSyntax, paramType!!) {
                    return false
                }
                continue
            }
            let lambdaSyntax LambdaExpressionSyntax? = if callSyntax != nil && i < callSyntax.Arguments.Count {
                GetLambdaArgumentSyntax(callSyntax.Arguments[i])
            } else {
                default(LambdaExpressionSyntax?)
            }
            if !IsLambdaReturnShapeCompatible(boundArguments[i], paramType!!, lambdaSyntax) {
                return false
            }
            if lambdaSyntax?.IsAsync == true &&
                bindLambdaWithTarget != nil &&
                MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(paramType!!, out var asyncTarget) &&
                !TypeSymbol
                .ContainsTypeParameter(asyncTarget!!) {
                if !IsContextuallyApplicableAsyncLambda(lambdaSyntax!!, asyncTarget!!, paramType!!) {
                    return false
                }
                continue
            }
            // A target-dependent lambda is represented by an Error-typed
            // placeholder until one candidate supplies its delegate shape.
            // Return-shape/arity checks above are the meaningful applicability
            // test; do not reject the surviving candidate merely because the
            // placeholder has no natural function type yet.
            if lambdaSyntax != nil && argType == TypeSymbol.Error {
                continue
            }
            if lambdaSyntax != nil &&
                argType is FunctionTypeSymbol{ReturnType: var lambdaReturn} argumentFunction &&
                lambdaReturn == TypeSymbol.Error &&
                MemberLookup
                .TryGetLambdaTargetFunctionTypeFromSymbol(paramType!!, out var targetFunction) {
                if argumentFunction.Arity != targetFunction!!.Arity {
                    return false
                }
                var parametersCompatible = true
                for var parameterIndex = 0; parameterIndex < argumentFunction.Arity; parameterIndex++ {
                    let writtenType = argumentFunction.ParameterTypes[parameterIndex]
                    let targetType = targetFunction!!.ParameterTypes[parameterIndex]
                    parametersCompatible &= TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                        targetType,
                        writtenType
                    ) ||
                        Conversion
                        .ClassifyNonStructural(targetType, writtenType)
                        .IsImplicit ||
                        conversions.HasUserDefinedImplicitConversion(targetType, writtenType)
                }
                if !parametersCompatible {
                    return false
                }
                continue
            }
            // Unknown argument or parameter type — be conservative, do not reject.
            if argType == nil || paramType == nil {
                continue
            }
            // Issue #1627: the #1552 point-fix gate that used to live here
            // (calling IsNullableReferenceGateRejected before classification)
            // has been removed. Conversion.Classify now rejects an imported
            // nullable-REFERENCE argument `S?` against a non-null-tolerant
            // reference parameter `S` at the classification source (see the
            // `#1627` comment in Conversion.Classify), so the general
            // convertibility check below already reports it as non-applicable
            // — consistently, in every BindConversion position, not just this
            // multi-candidate positional filter.
            let conversion = if boundArguments[i] is {} argument {
                conversions.ClassifyArgumentConversion(argument, paramType)
            } else {
                conversions.ClassifyArgumentConversion(argType, paramType)
            }
            if conversion.Exists && (conversion.IsImplicit || conversion.IsIdentity) {
                continue
            }
            // Issue #1281: a constant integer argument that fits a narrower /
            // cross-sign integer parameter is implicitly convertible there
            // (C# §10.2.11), so it must not disqualify the candidate.
            if ExpressionBinder.IsImplicitConstantNarrowingArgument(boundArguments[i], paramType) {
                continue
            }
            if conversions.TryApplyUserDefinedImplicitArgumentConversion(boundArguments[i], paramType, out _) {
                continue
            }
            return false
        }
        // Issue #1493: validate the variadic tail too, so a non-generic
        // variadic candidate is only applicable when each trailing argument
        // implicitly converts to the variadic element type — keeping
        // applicability/ranking in agreement with the final element coercion.
        if isVariadic && !HasNamedArguments(argumentNames) && VariadicCarriers.GetElementType(
            candidate.Parameters[candidate.Parameters.Length - 1].Type
        ) is {} variadicTailElement &&
            variadicTailElement != TypeSymbol
            .Error {
            let elementType = variadicTailElement
            let tailStart = fixedParamCount
            // A single trailing argument already typed as the slice itself is a
            // pass-through (`f(existingSlice)`); accept it as-is.
            let carrierType = candidate.Parameters[candidate.Parameters.Length - 1].Type
            let isSlicePassThrough = argumentCount - tailStart == 1 &&
                tailStart < boundArguments.Count &&
                boundArguments[tailStart]?.Type is {} passThroughArgumentType &&
                IsVariadicCarrierPassThrough(passThroughArgumentType, carrierType)
            // A tail element that still mentions a type parameter — `...T`, but
            // also a composite like `...in chan[T]` (ADR-0174 D9's `merge`) —
            // cannot be classified until inference has run, so applicability is
            // decided by the substituted signature instead of rejecting here.
            if !isSlicePassThrough && !TypeSymbol.ContainsTypeParameter(elementType) {
                for var i = tailStart; i < argumentCount && i < boundArguments.Count; i++ {
                    let argType TypeSymbol? = boundArguments[i]?.Type
                    if argType == nil {
                        continue
                    }
                    let conversion = if boundArguments[i] is {} argument {
                        conversions.ClassifyArgumentConversion(argument, elementType)
                    } else {
                        conversions.ClassifyArgumentConversion(argType, elementType)
                    }
                    if conversion.Exists && (conversion.IsImplicit || conversion.IsIdentity) {
                        continue
                    }
                    if ExpressionBinder.IsImplicitConstantNarrowingArgument(boundArguments[i], elementType) {
                        continue
                    }
                    if conversions.TryApplyUserDefinedImplicitArgumentConversion(
                        boundArguments[i],
                        elementType,
                        out _
                    ) {
                        continue
                    }
                    return false
                }
            }
        }
        return true
    }

    private func IsContextuallyApplicableAsyncLambda(
        lambda LambdaExpressionSyntax,
        target FunctionTypeSymbol,
        parameterType TypeSymbol
    ) bool {
        let diagnosticMark = Diagnostics.Count
        try {
            let bound = Invariant.Required(
                bindLambdaWithTarget,
                "contextual async-lambda applicability requires a lambda binder",
                expression: "bindLambdaWithTarget"
            )(lambda, target)
            let converted = conversions.BindConversion(lambda.Location, bound, parameterType)
            return !(converted is BoundErrorExpression) && !Diagnostics.Skip(diagnosticMark).Any(
                (diagnostic Diagnostic) -> diagnostic.IsError
            )
        } finally {
            Diagnostics.TruncateTo(diagnosticMark)
        }
    }

    // Issue #3465: overload applicability must honor explicit return shape
    // before a lambda has a single contextual target. A `return;` makes the
    // lambda void-only; a `return value` makes it value-returning. Returns in
    // nested lambdas/functions belong to those nested bodies and are ignored.
    private func IsLambdaReturnShapeCompatible(
        argument BoundExpression,
        parameterType TypeSymbol,
        lambdaSyntax LambdaExpressionSyntax?
    ) bool {
        let lambda LambdaExpressionSyntax? = lambdaSyntax ??
            GetLambdaArgumentSyntax(argument.Syntax as ExpressionSyntax)
        if lambda == nil || !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(parameterType, out var target) {
            return true
        }
        return IsLambdaReturnShapeCompatible(lambda, target!!, argument)
    }

    private func IsLambdaReturnShapeCompatible(
        lambda LambdaExpressionSyntax,
        target FunctionTypeSymbol,
        boundLambda BoundExpression? = nil
    ) bool {
        if lambda.Parameters.Count != target.Arity {
            return false
        }
        var hasVoidReturn = false
        var hasValueReturn = false
        let stack = Stack[SyntaxNode]()
        stack.Push(lambda.Body)
        while stack.Count > 0 {
            let node = stack.Pop()
            if (node is LambdaExpressionSyntax or FunctionLiteralExpressionSyntax or FunctionDeclarationSyntax) {
                continue
            }
            if node is ReturnStatementSyntax returnStatement {
                hasVoidReturn |= returnStatement.Expression == nil
                hasValueReturn |= returnStatement.Expression != nil
                continue
            }
            for child in node.GetChildren() {
                stack.Push(child)
            }
        }
        let targetReturnsNoValue = target.ReturnType == TypeSymbol.Void ||
            (lambda.IsAsync && IsNonGenericTaskReturnType(target.ReturnType))
        if targetReturnsNoValue {
            return !hasValueReturn
        }
        let bodyNeverCompletesNormally = !hasVoidReturn &&
            !hasValueReturn &&
            lambda.Body is BlockExpressionSyntax{Expression: nil} block &&
            (TryBoundLambdaBodyNeverCompletes(boundLambda) || IsObviouslyNonCompleting(block))
        if hasVoidReturn ||
            (
            (lambda.Body is BlockExpressionSyntax and {Expression: nil}) &&
                !hasValueReturn &&
                !bodyNeverCompletesNormally
        ) {
            return false
        }
        if !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(target.ReturnType, out var nestedTarget) {
            return true
        }
        return IsNestedLambdaResultShapeCompatible(lambda.Body, nestedTarget)
    }

    private func IsNestedLambdaResultShapeCompatible(syntax ExpressionSyntax, target FunctionTypeSymbol) bool {
        var syntax = syntax
        while syntax is ParenthesizedExpressionSyntax parenthesized {
            syntax = parenthesized.Expression
        }
        return switch syntax {
            case nestedLambda is LambdaExpressionSyntax: IsLambdaReturnShapeCompatible(nestedLambda, target)
            case block is BlockExpressionSyntax: EnumerateExplicitReturns(block).All(
                (returnStatement ReturnStatementSyntax) -> IsNestedLambdaResultShapeCompatible(
                    Invariant.Required(
                        returnStatement.Expression,
                        "explicit value-return enumeration excludes bare returns",
                        expression: "returnStatement.Expression"
                    ),
                    target
                )
            ) &&
                (block.Expression == nil || IsNestedLambdaResultShapeCompatible(block.Expression, target))
            case conditional is ConditionalExpressionSyntax: IsNestedLambdaResultShapeCompatible(
                conditional.WhenTrue,
                target
            ) &&
                IsNestedLambdaResultShapeCompatible(conditional.WhenFalse, target)
            case ifExpression is IfExpressionSyntax: IsNestedLambdaResultShapeCompatible(
                ifExpression.ThenBlock,
                target
            ) &&
                (
                ifExpression.ElseExpression == nil ||
                    IsNestedLambdaResultShapeCompatible(ifExpression.ElseExpression, target)
            )
            case ifLetExpression is IfLetExpressionSyntax: IsNestedLambdaResultShapeCompatible(
                ifLetExpression.ThenBlock,
                target
            ) &&
                (
                ifLetExpression.ElseExpression == nil ||
                    IsNestedLambdaResultShapeCompatible(ifLetExpression.ElseExpression, target)
            )
            case switchExpression is SwitchExpressionSyntax: switchExpression.Arms.All(
                (arm SwitchExpressionArmSyntax) -> IsNestedLambdaResultShapeCompatible(arm.Result, target)
            )
            case binary is BinaryExpressionSyntax when binary
                .OperatorToken
                .Kind == SyntaxKind.QuestionQuestionToken: IsNestedLambdaResultShapeCompatible(binary.Left, target) &&
                IsNestedLambdaResultShapeCompatible(binary.Right, target)
            default: true
        }
    }

    /// Issue #1552: describes a null-safety overload-resolution failure — a
    /// nullable-reference argument at (cref:Index) that no applicable
    /// overload can accept without dropping the `?`. Carries the argument
    /// and parameter types so the call site can emit GS0154 at the argument.
    internal class NullSafetyArgumentMismatch {
        init(index int32, argType TypeSymbol, paramType TypeSymbol, paramName string) {
            Index = index
            ArgType = argType
            ParamType = paramType
            ParamName = paramName
        }

        prop Index int32 {
            get;
        }

        prop ArgType TypeSymbol {
            get;
        }

        prop ParamType TypeSymbol {
            get;
        }

        prop ParamName string {
            get;
        }
    }

    /// Issue #1632: memoizing wrapper over (cref:TryInferCandidateSubstitution),
    /// keyed by candidate. Within a single (cref:SelectBestUserOverloadCore)
    /// call the #1124 applicability filter and the Phase-2 scoring pass both
    /// infer the same generic candidate's substitution from the identical
    /// [`boundArguments`](paramref)/[`argumentCount`](paramref) inputs;
    /// caching here runs unification once per candidate instead of twice.
    private func GetCachedCandidateSubstitution(
        candidate FunctionSymbol,
        boundArguments ImmutableArray[BoundExpression].Builder,
        argumentCount int32,
        cache Dictionary[FunctionSymbol, (Ok bool, Substitution Dictionary[TypeParameterSymbol, TypeSymbol])],
        out substitution Dictionary[TypeParameterSymbol, TypeSymbol]
    ) bool {
        if cache.TryGetValue(candidate, out var cached) {
            substitution = cached.Substitution
            return cached.Ok
        }
        let ok = TryInferCandidateSubstitution(candidate, boundArguments, argumentCount, out substitution)
        cache[candidate] = (ok, substitution)
        return ok
    }

    private func TryGetUnconstrainedNullableIteratorTypeParameter(
        candidates ImmutableArray[FunctionSymbol],
        boundArguments ImmutableArray[BoundExpression].Builder,
        argumentCount int32,
        explicitTypeArguments ImmutableArray[TypeSymbol],
        out typeParameter TypeParameterSymbol?
    ) bool {
        typeParameter = nil
        if candidates.Length < 2 {
            return false
        }
        let declaration = candidates[0].Declaration
        var hasReferenceVariant = false
        var hasValueVariant = false
        for candidate in candidates {
            if !object.ReferenceEquals(candidate.Declaration, declaration) {
                return false
            }
            let specializedTarget TypeParameterSymbol? = switch candidate.Type {
                case sequence_ is SequenceTypeSymbol when sequence_.ElementType is NullableTypeSymbol: (
                    cast[NullableTypeSymbol](sequence_.ElementType)
                ).UnderlyingType as TypeParameterSymbol
                case sequence_ is AsyncSequenceTypeSymbol when sequence_.ElementType is NullableTypeSymbol: (
                    cast[NullableTypeSymbol](sequence_.ElementType)
                ).UnderlyingType as TypeParameterSymbol
                default: default(TypeParameterSymbol?)
            }
            if specializedTarget == nil {
                return false
            }
            var callerType TypeSymbol?
            if !explicitTypeArguments.IsDefaultOrEmpty {
                if specializedTarget.Ordinal >= explicitTypeArguments.Length {
                    return false
                }
                callerType = explicitTypeArguments[specializedTarget.Ordinal]
            } else if !TryInferCandidateSubstitution(candidate, boundArguments, argumentCount, out var substitution) ||
                !substitution.TryGetValue(specializedTarget, out callerType) {
                return false
            }
            if callerType is not TypeParameterSymbol callerTypeParameter {
                return false
            }
            typeParameter = callerTypeParameter
            hasReferenceVariant |= candidate.NullableSequenceSpecialization == NullableSequenceSpecializationKind.ReferenceType
            hasValueVariant |= candidate.NullableSequenceSpecialization == NullableSequenceSpecializationKind.ValueType
        }
        return hasReferenceVariant && hasValueVariant
    }

    /// Computes the method-type-parameter substitution inferred from the
    /// supplied argument types for a generic [`candidate`](paramref), and
    /// reports whether every type parameter received a binding. Shared by the
    /// #1124 applicability filter ((cref:GetCachedCandidateSubstitution))
    /// and the Phase-2 exact-match scoring, which substitutes the inferred
    /// bindings into each open delegate parameter type so a value-returning
    /// delegate/method-group argument prefers the `(...)->TResult` overload over
    /// the `(...)->void` one (issue #1531 control).
    private func TryInferCandidateSubstitution(
        candidate FunctionSymbol,
        boundArguments ImmutableArray[BoundExpression].Builder,
        argumentCount int32,
        out substitution Dictionary[TypeParameterSymbol, TypeSymbol]
    ) bool {
        substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
        if !candidate.IsGeneric {
            return true
        }
        let parameterOffset = if candidate.ExplicitReceiverParameter == nil {
            0
        } else {
            1
        }
        let paramLen = candidate.Parameters.Length - parameterOffset
        let isVariadic = paramLen > 0 && candidate.Parameters[candidate.Parameters.Length - 1].IsVariadic
        let fixedParamCount = if isVariadic {
            paramLen - 1
        } else {
            paramLen
        }
        let inferenceLimit = if isVariadic {
            fixedParamCount
        } else {
            Math.Min(argumentCount, paramLen)
        }
        for var i = 0; i < inferenceLimit && i < boundArguments.Count; i++ {
            let argType TypeSymbol? = boundArguments[i]?.Type
            if argType == nil {
                continue
            }
            let parameter = candidate.Parameters[i + parameterOffset]
            inferTypeArguments(parameter.Type, RefCapabilities.GetInferenceType(parameter, argType), substitution)
        }
        if isVariadic && VariadicCarriers.GetElementType(
            candidate.Parameters[candidate.Parameters.Length - 1].Type
        ) is {} inferenceElement &&
            inferenceElement != TypeSymbol
            .Error {
            for var i = fixedParamCount; i < argumentCount && i < boundArguments.Count; i++ {
                let argType TypeSymbol? = boundArguments[i]?.Type
                if argType == nil {
                    continue
                }
                // Normalize first, so a top-level `T!` over a slice is still
                // recognised as a pass-through carrier.
                let normalized = RefCapabilities.GetValueArgumentInferenceType(argType)
                let source = if normalized is SliceTypeSymbol argSlice {
                    argSlice.ElementType
                } else {
                    normalized
                }
                inferTypeArguments(inferenceElement, source, substitution)
            }
        }
        for tp in candidate.TypeParameters {
            if !substitution.ContainsKey(tp) {
                return false
            }
        }
        return true
    }

    /// Issue #1531 control: returns `true` when
    /// [`argType`](paramref) is a value-returning delegate/function type
    /// and [`paramType`](paramref) is a delegate parameter whose return
    /// type is (or, via [`candSubstitution`](paramref), closes to)
    /// `void` — i.e. the argument's result would be discarded. Used to
    /// prefer a sibling `(...)->TResult` overload over a
    /// `(...)->void` one when a value-returning argument is supplied.
    private func IsValueReturnDiscardedToVoidDelegate(
        argType TypeSymbol?,
        paramType TypeSymbol?,
        candSubstitution Dictionary[TypeParameterSymbol, TypeSymbol]?
    ) bool {
        if argType is not FunctionTypeSymbol argFn ||
            paramType is not FunctionTypeSymbol paramFn ||
            argFn
            .ParameterTypes
            .Length != paramFn
            .ParameterTypes
            .Length {
            return false
        }
        let argReturn TypeSymbol? = argFn.ReturnType
        if argReturn == nil || argReturn == TypeSymbol.Void || argReturn == TypeSymbol.Error {
            return false
        }
        var paramReturn TypeSymbol? = paramFn.ReturnType
        if candSubstitution != nil && paramReturn != nil && TypeSymbol.ContainsTypeParameter(paramReturn) {
            paramReturn = substituteType(paramReturn, candSubstitution) ?? paramReturn
        }
        return paramReturn == TypeSymbol.Void
    }

    shared {
        /// Issue #4043: pairs a positional type-argument list with the type
        /// parameters it closes, so a DEPENDENT bound
        /// (`[TBase, TDerived TBase]`) can be answered on the whole vector.
        /// Returns `null` when the two do not line up — the
        /// constraint check then falls back to its pre-#4043 per-position answer
        /// rather than reading a mismatched map.
        /// @param typeParameters The candidate's type parameters, in order.
        /// @param typeArguments The supplied type arguments, in the same order.
        /// @returns The positional map, or `null`.
        internal func BuildTypeArgumentVector(
            typeParameters ImmutableArray[TypeParameterSymbol],
            typeArguments ImmutableArray[TypeSymbol]
        ) IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]? {
            if typeParameters.IsDefaultOrEmpty ||
                typeArguments.IsDefaultOrEmpty ||
                typeParameters.Length != typeArguments.Length {
                return nil
            }
            let vector = Dictionary[TypeParameterSymbol, TypeSymbol](typeParameters.Length)
            for var i = 0; i < typeParameters.Length; i++ {
                if typeArguments[i] != nil {
                    vector[typeParameters[i]] = typeArguments[i]
                }
            }
            return vector
        }

        /// Issue #2172: narrows [`pool`](paramref) to prefer, for each argument
        /// slot whose argument is a task-returning lambda (its function type returns
        /// `Task`/`Task<T>`), the candidates whose OPEN delegate
        /// parameter at that slot is shaped `(...) -> Task[TResult]` over
        /// those shaped `(...) -> TResult`. Only narrows when the pool
        /// genuinely splits into both shapes at such a slot, so non-task-lambda calls
        /// and single-shape overload sets are unaffected.
        private func PreferTaskShapedDelegateForTaskLambda(
            pool List[UserCandidateRankData],
            boundArguments ImmutableArray[BoundExpression].Builder
        ) List[UserCandidateRankData] {
            var current = pool
            for var argIndex = 0; argIndex < boundArguments.Count; argIndex++ {
                if current.Count <= 1 {
                    break
                }
                // The argument must itself be a task-returning function value (an
                // async / task-returning lambda's natural function type).
                if !(boundArguments[argIndex]?.Type is FunctionTypeSymbol argFn) ||
                    !IsTaskReturnTypeSymbol(argFn.ReturnType) {
                    continue
                }
                let taskShaped = List[UserCandidateRankData](current.Count)
                var bareTypeParam = false
                for w in current {
                    let openParam = if argIndex < w.OpenParamTypes.Length {
                        w.OpenParamTypes[argIndex]
                    } else {
                        default(TypeSymbol?)
                    }
                    if openParam is FunctionTypeSymbol paramFn {
                        if IsTaskReturnTypeSymbol(paramFn.ReturnType) {
                            taskShaped.Add(w)
                            continue
                        }
                        if paramFn.ReturnType is TypeParameterSymbol {
                            bareTypeParam = true
                            continue
                        }
                    }
                    // Neither shape — keep it eligible so an unrelated sibling
                    // overload is never silently dropped.
                    taskShaped.Add(w)
                }
                if bareTypeParam && taskShaped.Count >= 1 && taskShaped.Count < current.Count {
                    current = taskShaped
                }
            }
            return current
        }

        /// Issue #2172: whether [`type`](paramref) is
        /// `System.Threading.Tasks.Task`/`Task<T>` (or the
        /// `ValueTask` equivalents). Detected via the erased CLR type so it
        /// also matches an open construction like `Task[T]` (whose closed CLR
        /// form is `Task<object>`).
        private func IsTaskReturnTypeSymbol(type TypeSymbol) bool {
            let clr Type? = type?.ClrType
            if clr == nil {
                return false
            }
            if clr.IsSameAs(typeof(Task)) || clr.IsSameAs(typeof(ValueTask)) {
                return true
            }
            if clr.IsGenericType {
                let definition = clr.GetGenericTypeDefinition()
                if definition.IsSameAs(typeof(System.Threading.Tasks.Task[_])) || definition.IsSameAs(
                    typeof(System.Threading.Tasks.ValueTask[_])
                ) {
                    return true
                }
            }
            return false
        }

        /// Issue #1631: C# §7.5.3.2 "better function member" pairwise comparison —
        /// mirrors `ClrOverloadResolution.IsAtLeastAsGoodAs` for user-symbolic
        /// candidates. Returns `true` when [`a`](paramref) is
        /// not worse than [`b`](paramref) on any argument and strictly better
        /// on at least one.
        private func IsUserCandidateAtLeastAsGoodAs(
            a UserCandidateRankData,
            b UserCandidateRankData,
            argTypes[]TypeSymbol?
        ) bool {
            var hasStrictlyBetter = false
            for var i = 0; i < a.Kinds.Length; i++ {
                let cmp = CompareUserConversions(
                    a.Kinds[i],
                    a.ParamTypes[i],
                    a.IsTailSlot[i],
                    b.Kinds[i],
                    b.ParamTypes[i],
                    b.IsTailSlot[i],
                    argTypes[i]
                )
                if cmp > 0 {
                    return false
                }
                if cmp < 0 {
                    hasStrictlyBetter = true
                }
            }
            return hasStrictlyBetter
        }

        /// Issue #1631: compares two candidate conversions for the SAME argument,
        /// mirroring `ClrOverloadResolution.CompareConversions`. Different
        /// (cref:ClrOverloadResolution.ImplicitConversionKind)s rank by their declared ordinal
        /// (lower is better); same-kind numeric widenings tie-break via the
        /// shared (cref:ClrOverloadResolution.CompareNumericTargets) "better
        /// conversion target" rule (C# §7.5.3.4), reusing the exact CLR-path
        /// helper rather than reimplementing the numeric/signed-vs-unsigned
        /// lattice a second time.
        private func CompareUserConversions(
            ka ClrOverloadResolution.ImplicitConversionKind,
            paramA TypeSymbol?,
            tailA bool,
            kb ClrOverloadResolution.ImplicitConversionKind,
            paramB TypeSymbol?,
            tailB bool,
            source TypeSymbol?
        ) int32 {
            // ADR-0186 §3's tie-break, stated here because it cannot fall out of
            // the ranking below. A `T!` argument is applicable to a `T` parameter
            // and to a `T?` parameter, and when both apply the `T` parameter wins
            // — "the tie-break that keeps a platform argument behaving like the
            // non-null value it usually is."
            //
            // The ranking below cannot decide it: every conversion kind here is
            // derived from CLR types, and `string`, `string?` and `string!` are
            // one CLR type (§1), so both candidates land in the same bucket and
            // tie. Nor could the classifier decide it by making `T! -> T?` an
            // identity conversion, which is the shape that looks natural: identity
            // beats implicit in this comparison, so that would select `T?` —
            // exactly backwards — and it would also stop §4's check from ever
            // materialising (see `Conversion.PlatformChecked`).
            //
            // ADR-0186 open question 10 records that this is the one place the
            // design reproduces failure mode 5's *shape* — the same line selecting
            // a different method by typing — and accepts it deliberately: the `T`
            // overload is the one a non-nilable argument would have picked, and
            // CLR metadata cannot express such a pair, so no imported API moves.
            let platformTieBreak = ComparePlatformArgumentTargets(source, paramA, paramB)
            if platformTieBreak != 0 {
                return platformTieBreak
            }
            // Issue #1631 (B1'): per C# §7.5.3.2, "non-expanded form preferred
            // over expanded form" is a LATE tie-break applied only when per-arg
            // betterness is otherwise tied across every argument — it is not a
            // per-arg override. Per-arg comparison must rank purely on each
            // side's own conversion kind (e.g. an exact element-type match on a
            // variadic tail slot legitimately beats a widening conversion on a
            // normal-form slot). Phase 2c (prefer non-variadic) applies the
            // actual tie-break once all per-arg comparisons agree.
            let numericTarget = ClrOverloadResolution.CompareNumericConversionTargets(
                NullableLifting.GetEffectiveClrType(paramA),
                NullableLifting.GetEffectiveClrType(paramB),
                source?.ClrType
            )
            if numericTarget != 0 {
                return numericTarget
            }
            if ka != kb {
                return (int32(ka)).CompareTo(int32(kb))
            }
            if ka == ClrOverloadResolution.ImplicitConversionKind.NumericWidening {
                // The three Invariant.Required calls below asserted something this
                // function cannot actually guarantee: it is handed whatever the
                // ranking loop recorded, and expanded tail slots recorded no
                // parameter type at all. Two variadic numeric tails that classified
                // identically therefore crashed the compiler with GS9998 on source
                // that C# compiles. The ranking loop now records the element type,
                // which is the real fix; this stays a tie rather than a throw so a
                // ranking heuristic can never again take the whole compile down. A
                // tie is the honest answer when there is nothing to compare.
                if paramA?.ClrType is not{} numericTargetA ||
                    paramB?.ClrType is not{} numericTargetB ||
                    source?.ClrType is not{} numericSource {
                    return 0
                }
                return ClrOverloadResolution.CompareNumericTargets(numericTargetA, numericTargetB, numericSource)
            }
            // Issue #2146: reference "better conversion target" tie-break
            // (C# §7.5.3.2 / §7.5.3.4). When both conversions for the same argument
            // fold into the Reference bucket (both are non-identity implicit
            // reference/boxing/interface conversions, e.g. Dog->object vs
            // Dog->Animal, or Type->object vs Type->Type?), the previous code tied
            // (returned 0) and the call was reported ambiguous (GS0266) even though
            // C# prefers the MORE DERIVED target. Apply the reference-type rule:
            // target T1 is a better conversion target than T2 when an implicit
            // conversion exists from T1 to T2 but not from T2 to T1. That makes the
            // more-derived reference parameter win (Animal over object; Type? over
            // object). If neither target converts to the other (genuinely unrelated
            // reference types), leave the tie (0) so real ambiguity is preserved.
            if ka == ClrOverloadResolution
                .ImplicitConversionKind
                .Reference &&
                paramA != nil &&
                paramB != nil &&
                !object.ReferenceEquals(paramA, paramB) {
                return CompareReferenceTargets(paramA, paramB)
            }
            // Issue #3866: the user-symbolic path was missing the UserDefinedImplicit
            // arm that `ClrOverloadResolution.CompareConversions` has had since
            // Stream E. `ClassifyUserArgumentConversionKind` reports
            // UserDefinedImplicit for BOTH `Wrapped -> Payload` (a real
            // `op_Implicit`) and `Wrapped -> object` (where the operator is merely
            // one of several routes and boxing would do), so the two candidates
            // landed in the same bucket, tied at 0 and reported a spurious GS0266
            // where C# §12.6.4.5 prefers the better conversion TARGET. Payload
            // converts implicitly to object and object does not convert back, so
            // Payload wins; genuinely unrelated targets still tie and stay
            // ambiguous.
            if ka == ClrOverloadResolution
                .ImplicitConversionKind
                .UserDefinedImplicit &&
                paramA != nil &&
                paramB != nil &&
                !object.ReferenceEquals(paramA, paramB) {
                return CompareReferenceTargets(paramA, paramB)
            }
            return 0
        }

        /// ADR-0186 §3: for a `T!` argument, a non-null `T` parameter
        /// beats a `T?` parameter over the same underlying type.
        ///
        /// Scoped as narrowly as the rule is: it fires only when the argument is
        /// platform-typed and the two candidate parameters are exactly `U`
        /// and `U?` over one underlying. Any other pair — including
        /// `U` against an unrelated `V`, and every pair at all while
        /// `--nullability=platform-types` is off, since nothing constructs a
        /// platform type then — is left to the ordinary ranking below.
        /// @param source The argument's static type.
        /// @param targetA The first candidate's parameter type.
        /// @param targetB The second candidate's parameter type.
        /// @returns Negative when A wins, positive when B wins, 0 when the rule does not apply.
        private func ComparePlatformArgumentTargets(
            source TypeSymbol?,
            targetA TypeSymbol?,
            targetB TypeSymbol?
        ) int32 {
            if !(source is PlatformTypeSymbol) || targetA == nil || targetB == nil {
                return 0
            }
            if !(targetA is NullableTypeSymbol) &&
                targetB is NullableTypeSymbol nilableB &&
                TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(targetA, nilableB.UnderlyingType) {
                return -1
            }
            if !(targetB is NullableTypeSymbol) &&
                targetA is NullableTypeSymbol nilableA &&
                TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(targetB, nilableA.UnderlyingType) {
                return 1
            }
            return 0
        }

        /// Issue #2146: implements the C# §7.5.3.4 "better conversion target" rule
        /// for reference-type targets. Returns a negative value when
        /// [`targetA`](paramref) is the better (more-derived) target, positive
        /// when [`targetB`](paramref) is, and 0 when the two targets are
        /// unrelated (neither implicitly converts to the other) — preserving genuine
        /// ambiguity. Convertibility is probed one-directionally via
        /// (cref:Conversion.Classify) rather than hand-rolled type checks so
        /// user classes, interfaces, and imported/BCL reference types are all
        /// handled uniformly.
        private func CompareReferenceTargets(targetA TypeSymbol, targetB TypeSymbol) int32 {
            // Finite insertion coverage is not a nominal target-type relation.
            let aToB = if targetA != targetB && NativeProtocolOperations.GetProtocol(targetB) != nil {
                Conversion.None
            } else {
                Conversion.Classify(targetA, targetB)
            }
            let bToA = if targetA != targetB && NativeProtocolOperations.GetProtocol(targetA) != nil {
                Conversion.None
            } else {
                Conversion.Classify(targetB, targetA)
            }
            let aToBImplicit = aToB.IsImplicit && !aToB.IsIdentity
            let bToAImplicit = bToA.IsImplicit && !bToA.IsIdentity
            if aToBImplicit && !bToAImplicit {
                // A converts to B but not vice versa => A is more derived => A better.
                return -1
            }
            if bToAImplicit && !aToBImplicit {
                return 1
            }
            return 0
        }

        private func IsNumericPrimitive(type TypeSymbol) bool -> type
            ?.ClrType
            ?.FullName is string fullName &&
            NumericWideningLattice.IsNumericPrimitive(fullName)

        /// Issue #1154: returns `true` when [`argumentNames`](paramref)
        /// carries any non-null positional name. When named arguments are present the
        /// positional index→parameter mapping used by the convertibility filter is
        /// unreliable, so the filter is skipped entirely for that call.
        private func HasNamedArguments(argumentNames ImmutableArray[string]) bool {
            if argumentNames.IsDefault {
                return false
            }
            for var i = 0; i < argumentNames.Length; i++ {
                if argumentNames[i] != nil {
                    return true
                }
            }
            return false
        }

        /// True when a single trailing argument already IS the variadic carrier
        /// (`f(existingSlice)`), so the call binds in NORMAL form and the
        /// per-element tail check must not run.
        /// @remarks This was a `==` test on the two (cref:TypeSymbol)s. Neither
        /// (cref:TypeSymbol) nor (cref:Symbol) declares an
        /// `operator ==`, so that is REFERENCE identity — it only ever
        /// succeeded when the argument's type symbol was literally the same
        /// instance as the parameter's. The `[]string` a carrier is declared
        /// with and the `string[]` read back from CLR metadata denote the same
        /// runtime type but are built on different paths, so
        /// `f(Environment.GetCommandLineArgs())` failed the pass-through test, fell
        /// into the element loop, failed `string[] -> string`, and the candidate was
        /// dropped as non-convertible. When EVERY candidate is dropped the caller
        /// keeps the unfiltered set and ranks it, so two variadic siblings tie and
        /// the call is reported ambiguous (GS0266) instead of binding.
        /// Classify the conversion instead: an identity or implicit conversion to
        /// the carrier is exactly what "the argument already is the carrier" means,
        /// and it is the same test the final argument coercion applies.
        /// @param argumentType The single trailing argument's type.
        /// @param carrierType The candidate's variadic carrier parameter type.
        /// @returns `true` when the argument binds as the carrier itself.
        private func IsVariadicCarrierPassThrough(argumentType TypeSymbol, carrierType TypeSymbol) bool {
            if object.ReferenceEquals(argumentType, carrierType) {
                return true
            }
            let conversion = Conversion.Classify(argumentType, carrierType)
            return conversion.Exists && (conversion.IsIdentity || conversion.IsImplicit)
        }

        private func HasSameAsyncLambdaResultShape(argumentType TypeSymbol?, parameterType TypeSymbol) bool {
            if argumentType is not FunctionTypeSymbol argumentFunction ||
                !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(parameterType, out var targetFunction) ||
                !AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(
                argumentFunction.ReturnType,
                out var argumentResult
            ) ||
                !AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(targetFunction!!.ReturnType, out var targetResult) {
                return false
            }
            return TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(argumentResult, targetResult)
        }

        private func TryBoundLambdaBodyNeverCompletes(argument BoundExpression?) bool -> argument != nil &&
            LambdaBinder.TryGetFunctionLiteral(argument, out var literal) && ControlFlowGraph.AllPathsReturn(
            Lowerer.Lower(literal!!.Body)
        )

        private func IsObviouslyNonCompleting(block BlockExpressionSyntax) bool -> IsObviouslyNonCompleting(
            block.Statements.LastOrDefault()
        )

        private func IsObviouslyNonCompleting(statement StatementSyntax?) bool -> switch statement {
            case _ is ThrowStatementSyntax: true
            case block is BlockStatementSyntax: IsObviouslyNonCompleting(block.Statements.LastOrDefault())
            case conditional is IfStatementSyntax when conditional.ElseClause != nil: IsObviouslyNonCompleting(
                conditional.ThenStatement
            ) &&
                IsObviouslyNonCompleting(conditional.ElseClause!!.ElseStatement)
            case loop is ForInfiniteStatementSyntax: !ContainsPotentialLoopExit(loop.Body, loopLabel: nil)
            case loop is WhileStatementSyntax when IsConstantTrue(loop.Condition): !ContainsPotentialLoopExit(
                loop.Body,
                loopLabel: nil
            )
            case loop is DoWhileStatementSyntax when IsConstantTrue(loop.Condition): !ContainsPotentialLoopExit(
                loop.Body,
                loopLabel: nil
            )
            case LabeledStatementSyntax{
                Statement: ForInfiniteStatementSyntax loop
            } labeledLoop: !ContainsPotentialLoopExit(loop.Body, labeledLoop.LabelIdentifier.ValueText)
            case LabeledStatementSyntax{Statement: WhileStatementSyntax loop} labeledLoop when IsConstantTrue(
                loop.Condition
            ): !ContainsPotentialLoopExit(loop.Body, labeledLoop.LabelIdentifier.ValueText)
            case LabeledStatementSyntax{Statement: DoWhileStatementSyntax loop} labeledLoop when IsConstantTrue(
                loop.Condition
            ): !ContainsPotentialLoopExit(loop.Body, labeledLoop.LabelIdentifier.ValueText)
            default: false
        }

        private func ContainsPotentialLoopExit(body StatementSyntax, loopLabel string?) bool {
            let localGotoLabels = CollectGotoLabels(body)
            let stack = Stack[(Node SyntaxNode, NestedLoopDepth int32)]()
            stack.Push((body, 0))
            while stack.Count > 0 {
                let (node, nestedLoopDepth) = stack.Pop()
                if node is BreakStatementSyntax breakStatement &&
                    (
                    (breakStatement.LabelIdentifier == nil && nestedLoopDepth == 0) ||
                        (
                        breakStatement.LabelIdentifier != nil && string.Equals(
                            breakStatement.LabelIdentifier.ValueText,
                            loopLabel,
                            StringComparison.Ordinal
                        )
                    )
                ) {
                    return true
                }
                if node is GotoStatementSyntax gotoStatement && !localGotoLabels.Contains(
                    gotoStatement.LabelIdentifier.ValueText
                ) {
                    return true
                }
                if !object.ReferenceEquals(node, body) &&
                    (node is LambdaExpressionSyntax or FunctionLiteralExpressionSyntax or FunctionDeclarationSyntax) {
                    continue
                }
                let childLoopDepth = nestedLoopDepth +
                    (
                    if IsLoopSyntax(node) && !object.ReferenceEquals(node, body) {
                        1
                    } else {
                        0
                    }
                )
                for child in node.GetChildren() {
                    stack.Push((child, childLoopDepth))
                }
            }
            return false
        }

        private func CollectGotoLabels(body StatementSyntax) HashSet[string] {
            let labels = HashSet[string](StringComparer.Ordinal)
            let stack = Stack[SyntaxNode]()
            stack.Push(body)
            while stack.Count > 0 {
                let node = stack.Pop()
                if !object.ReferenceEquals(node, body) &&
                    (node is LambdaExpressionSyntax or FunctionLiteralExpressionSyntax or FunctionDeclarationSyntax) {
                    continue
                }
                if node is LabeledStatementSyntax labeled && !IsLoopSyntax(labeled.Statement) {
                    labels.Add(labeled.LabelIdentifier.ValueText)
                }
                for child in node.GetChildren() {
                    stack.Push(child)
                }
            }
            return labels
        }

        private func IsConstantTrue(condition ExpressionSyntax) bool {
            var condition = condition
            while condition is ParenthesizedExpressionSyntax parenthesized {
                condition = parenthesized.Expression
            }
            return condition is LiteralExpressionSyntax && condition.Value is true
        }

        private func IsLoopSyntax(node SyntaxNode) bool -> (
            node.Kind is SyntaxKind.WhileLetStatement or
                SyntaxKind.WhileStatement or
                SyntaxKind.DoWhileStatement or
                SyntaxKind.ForInfiniteStatement or
                SyntaxKind.ForEllipsisStatement or
                SyntaxKind.ForConditionStatement or
                SyntaxKind.ForClauseStatement or
                SyntaxKind.ForRangeStatement or
                SyntaxKind.ForTupleRangeStatement or
                SyntaxKind.AwaitForRangeStatement
        )

        private func IsNonGenericTaskReturnType(type TypeSymbol) bool {
            let clr Type? = type?.ClrType
            return clr != nil && (clr.IsSameAs(typeof(Task)) || clr.IsSameAs(typeof(ValueTask)))
        }

        /// Issue #1552: the Kotlin-model null-safety gate used by overload
        /// applicability. Returns `true` when a nullable REFERENCE
        /// argument [`argType`](paramref) (`S?`) must NOT be accepted by
        /// the (non-nullable, non-`object`) reference parameter
        /// [`paramType`](paramref). Passing a nullable reference where a
        /// non-nullable reference is required is an error in G# (the user must write
        /// `!!` or rely on smart-cast narrowing); this mirrors that rule during
        /// overload resolution so the ambiguity/leak paths cannot silently drop the
        /// `?`. The gate deliberately fires ONLY for reference-like nullable
        /// underlyings, so value-type nullables and nullable type-parameter
        /// underlyings are unaffected.
        private func IsNullableReferenceGateRejected(argType TypeSymbol, paramType TypeSymbol) bool {
            if argType is not NullableTypeSymbol argNullable {
                return false
            }
            // Only a REFERENCE-like nullable underlying is subject to the gate.
            if !IsReferenceLikeType(argNullable.UnderlyingType) {
                return false
            }
            // A null-tolerant parameter (`object`/`object?` or any nullable target)
            // accepts null, so the gate does not fire.
            if IsNullTolerantParameter(paramType) {
                return false
            }
            // Only reference parameters are gated; a nullable-reference argument to
            // a value-type parameter is already non-convertible via Conversion.
            if !IsReferenceLikeType(paramType) {
                return false
            }
            // Review finding (#3988, Copilot on PR #3999): the gate must only claim
            // that NULLABILITY is the reason the candidate failed. Everything above
            // is a SHAPE test — both sides are reference-like — and shape alone does
            // not establish that dropping the `?` would make the call work. Where it
            // would not, GS0154 names a parameter the argument could never satisfy
            // and prescribes a remedy (`!!`, or narrowing) that cannot possibly
            // help, which is worse than the generic no-applicable-overload answer it
            // displaces. So require that the argument's NON-NULLABLE form actually
            // reaches the parameter; if it does not, decline and let the ordinary
            // diagnostic stand.
            //
            // Measured: `func f(ch chan[string])` / `func f(xs []string)` called
            // with a `chan[T]?` reported `GS0154: Parameter 'ch' requires a value of
            // type 'chan[string]' but was given a value of type 'chan[T]?'` — true
            // as far as it goes, but `!!` makes neither overload applicable. The
            // defect is OLDER than the predicate unification that exposed it here: a
            // `string?` against the same unrelated overload set misattributed
            // identically on the parent commit, through the `ClrType` fallback that
            // has answered for `string` since #1552. Fixing it here repairs both.
            let underlying = argNullable.UnderlyingType
            let underlyingConversion = Conversion.Classify(underlying, paramType)
            return underlyingConversion.Exists && (underlyingConversion.IsImplicit || underlyingConversion.IsIdentity)
        }

        /// Issue #1552: a parameter is null-tolerant when it accepts a null
        /// reference: the top type `object`/`object?` or any nullable
        /// target (`T?`).
        private func IsNullTolerantParameter(paramType TypeSymbol) bool {
            if paramType is NullableTypeSymbol {
                return true
            }
            if paramType == TypeSymbol.Object {
                return true
            }
            return paramType?.ClrType?.IsSameAs(typeof(object)) == true
        }

        /// Issue #1552: the reference-like notion used by the null-safety gate.
        /// Issue #3988: this WAS a hand-copied mirror of
        /// (cref:Conversion.IsReferenceLikeTarget) — its own doc comment
        /// said so — and it had drifted. It listed only interfaces, user
        /// `class`es, `string` and the `ClrType` fallback, while
        /// the original had grown arms for every structural shape that IS a
        /// reference type while a type-parameter element leaves its
        /// `ClrType` null: slices, fixed and rectangular arrays, named
        /// delegates, structural function types, reference-constrained type
        /// parameters and (since #3985) channels. A copy whose comment claims to
        /// mirror another is the #3705 shape, so the copy is gone: this now
        /// DELEGATES, and the two answers cannot disagree again.
        /// @remarks The dropped `TypeSymbol.String` arm was already redundant —
        /// `string`'s `ClrType` is `System.String`, a class, so the
        /// delegate's own `ClrType` fallback answers it identically.
        /// @param type The candidate type.
        /// @returns `true` when [`type`](paramref) is reference-like.
        private func IsReferenceLikeType(type TypeSymbol?) bool -> type != nil && Conversion.IsReferenceLikeTarget(type)

        /// Review finding (#3988, Copilot on PR #3999): true when some supplied
        /// argument is a nullable REFERENCE that reaches no candidate's
        /// corresponding parameter in EITHER form — neither as `S?` nor as the
        /// bare `S`. Such a call is not a null-safety failure (dropping the
        /// annotation would not help) and it is not an ambiguity (nothing is
        /// applicable to choose between), so it belongs on the
        /// no-applicable-overload path rather than on GS0266's.
        /// @remarks Deliberately conservative in three ways, so that only the shape the
        /// review raised is diverted. It requires an argument that actually is a
        /// nullable reference; it requires EVERY candidate to reject BOTH forms, so
        /// a set containing even one overload the bare value could reach keeps its
        /// existing diagnostic; and it skips the same candidates
        /// (cref:TryFindNullSafetyArgumentMismatch) skips, so the two agree
        /// about what they are looking at.
        /// @param candidates The arity-applicable candidates.
        /// @param argumentCount The supplied argument count.
        /// @param boundArguments The bound arguments.
        /// @returns `true` when no overload can accept the argument in either form.
        private func HasUnsatisfiableNullableReferenceArgument(
            candidates List[FunctionSymbol]?,
            argumentCount int32,
            boundArguments ImmutableArray[BoundExpression].Builder
        ) bool {
            if candidates == nil || candidates.Count == 0 {
                return false
            }
            let count = Math.Min(argumentCount, boundArguments.Count)
            for var i = 0; i < count; i++ {
                if boundArguments[i]?.Type is not NullableTypeSymbol argNullable ||
                    !IsReferenceLikeType(argNullable.UnderlyingType) {
                    continue
                }
                var sawCandidate = false
                var everyCandidateRejectsBothForms = true
                for candidate in candidates {
                    if candidate.IsGeneric {
                        continue
                    }
                    let parameterOffset = if candidate.ExplicitReceiverParameter == nil {
                        0
                    } else {
                        1
                    }
                    let paramIndex = i + parameterOffset
                    if paramIndex < 0 || paramIndex >= candidate.Parameters.Length {
                        continue
                    }
                    let parameter = candidate.Parameters[paramIndex]
                    if parameter.RefKind != RefKind.None || parameter.IsVariadic {
                        continue
                    }
                    sawCandidate = true
                    if IsConvertibleForNullSafetyAttribution(argNullable, parameter.Type) ||
                        IsConvertibleForNullSafetyAttribution(argNullable.UnderlyingType, parameter.Type) {
                        everyCandidateRejectsBothForms = false
                        break
                    }
                }
                if sawCandidate && everyCandidateRejectsBothForms {
                    return true
                }
            }
            return false
        }

        /// Whether [`from`](paramref) reaches [`to`](paramref) by an
        /// identity or implicit conversion — the question "would this argument be
        /// applicable here?", asked without the structural-projection allowance so
        /// it matches what the convertibility pass already decided.
        /// @param from The source type.
        /// @param to The parameter type.
        /// @returns `true` when the conversion exists and is implicit or identity.
        private func IsConvertibleForNullSafetyAttribution(from TypeSymbol?, to TypeSymbol?) bool {
            if from == nil || to == nil {
                return false
            }
            let conversion = Conversion.Classify(from, to)
            return conversion.Exists && (conversion.IsImplicit || conversion.IsIdentity)
        }

        /// Issue #1552: when every arity-applicable candidate was filtered out by
        /// the convertibility pass, locate the first supplied argument whose
        /// nullable-reference type is rejected by the null-safety gate against at
        /// least one candidate's parameter at that position. Returns the mismatch so
        /// the caller can emit the same GS0154 the single-candidate path produces
        /// (pointing at the argument), or `null` when the empty set
        /// is not attributable to the null-safety gate.
        private func TryFindNullSafetyArgumentMismatch(
            candidates List[FunctionSymbol],
            argumentCount int32,
            boundArguments ImmutableArray[BoundExpression].Builder
        ) NullSafetyArgumentMismatch? {
            let count = Math.Min(argumentCount, boundArguments.Count)
            for var i = 0; i < count; i++ {
                let argType = boundArguments[i]?.Type
                if argType is not NullableTypeSymbol argNullable || !IsReferenceLikeType(argNullable.UnderlyingType) {
                    continue
                }
                for candidate in candidates {
                    if candidate.IsGeneric {
                        continue
                    }
                    let parameterOffset = if candidate.ExplicitReceiverParameter == nil {
                        0
                    } else {
                        1
                    }
                    let paramIndex = i + parameterOffset
                    if paramIndex < 0 || paramIndex >= candidate.Parameters.Length {
                        continue
                    }
                    let parameter = candidate.Parameters[paramIndex]
                    if parameter.RefKind != RefKind.None || parameter.IsVariadic {
                        continue
                    }
                    if IsNullableReferenceGateRejected(argType, parameter.Type) {
                        return NullSafetyArgumentMismatch(i, argType, parameter.Type, parameter.Name)
                    }
                }
            }
            return nil
        }

        /// ADR-0063: returns true when the supplied argument count + names could
        /// reach the parameter list of the candidate.
        ///
        /// Issue #1628: maps a source-order argument index to the parameter slot
        /// (0-based, excluding [`parameterOffset`](paramref)) it actually
        /// binds to on [`candidate`](paramref). A named argument binds to
        /// whichever parameter shares its name — not necessarily its source
        /// position — while an unnamed argument binds positionally. Mirrors the
        /// name→slot resolution (cref:IsApplicableUserCallable) already
        /// validates and `TryReorderUserCallArguments` already performs, so
        /// Phase-2 exact-match scoring ranks the candidate against the parameter
        /// it will really receive the argument on. Returns -1 if the name (already
        /// validated applicable) is not found, which should not happen in practice.
        private func MapArgumentIndexToParameterSlot(
            candidate FunctionSymbol,
            argumentNames ImmutableArray[string],
            argumentIndex int32,
            parameterOffset int32,
            paramLen int32
        ) int32 {
            let name string? = if argumentNames.IsDefault || argumentIndex >= argumentNames.Length {
                default(string?)
            } else {
                argumentNames[argumentIndex]
            }
            if name == nil {
                return argumentIndex
            }
            for var p = 0; p < paramLen; p++ {
                if candidate.Parameters[p + parameterOffset].Name == name {
                    return p
                }
            }
            return -1
        }

        private func IsApplicableUserCallable(
            candidate FunctionSymbol,
            argumentCount int32,
            argumentNames ImmutableArray[string]
        ) bool {
            let parameterOffset = if candidate.ExplicitReceiverParameter == nil {
                0
            } else {
                1
            }
            let paramLen = candidate.Parameters.Length - parameterOffset
            let isVariadic = paramLen > 0 && candidate.Parameters[candidate.Parameters.Length - 1].IsVariadic
            let fixedParamCount = if isVariadic {
                paramLen - 1
            } else {
                paramLen
            }
            // Compute required (non-optional) leading-parameter count.
            var requiredParamCount = paramLen
            for var i = paramLen - 1; i >= 0; i-- {
                if candidate.Parameters[i + parameterOffset].HasExplicitDefaultValue {
                    requiredParamCount = i
                } else {
                    break
                }
            }
            if isVariadic {
                if argumentCount < fixedParamCount {
                    return false
                }
            } else if argumentCount < requiredParamCount || argumentCount > paramLen {
                return false
            }
            // Named-argument names must each correspond to a parameter.
            if !argumentNames.IsDefault {
                for var i = 0; i < argumentNames.Length; i++ {
                    let n string? = argumentNames[i]
                    if n == nil {
                        continue
                    }
                    var found = false
                    for var p = 0; p < paramLen; p++ {
                        if candidate.Parameters[p + parameterOffset].Name == n {
                            found = true
                            break
                        }
                    }
                    if !found {
                        return false
                    }
                }
            }
            return true
        }
    }
}
