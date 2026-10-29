// <copyright file="ExpressionBinder.SwitchExpr.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Text
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis

internal partial class ExpressionBinder {
    private func BindSwitchExpression(syntax SwitchExpressionSyntax) BoundExpression -> BindSwitchExpression(
        syntax,
        targetType: nil
    )

    /// @param canBeVoid Issue #4966 §2 (ADR-0202): the switch is in a position
    /// whose value is discarded (an expression statement, a void arrow body, a
    /// lambda body). When an arm is then void, the whole switch is the void
    /// switch — the switch statement's meaning: arm values are discarded, and
    /// with no default arm an unmatched value does nothing (GS0176 is a
    /// value-position rule).
    private func BindSwitchExpression(
        syntax SwitchExpressionSyntax,
        targetType TypeSymbol?,
        canBeVoid bool = false
    ) BoundExpression {
        // Issue #1238: when this switch-expression is an eagerly-bound call
        // argument with no target type yet, defer a no-common-type unification
        // failure (instead of reporting GS0179) so the argument can be re-bound
        // against the resolved parameter type. The flag is read-and-cleared up
        // front so nested sub-expressions bind with normal semantics.
        let deferOnFailure = targetType == nil && binderCtx.DeferTargetlessConditional
        this.binderCtx.DeferTargetlessConditional = false
        let discriminant = BindExpression(syntax.Expression)
        if NativeProtocolOperations.GetProtocol(discriminant.Type) != nil {
            Diagnostics.ReportNativeProtocol(
                syntax.Location,
                "native protocol switch patterns require an explicit is/as intermediate view"
            )
            return BoundErrorExpression(syntax)
        }
        let switchType = discriminant.Type
        if switchType == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        if syntax.Arms.Length == 0 {
            if ExhaustivenessAnalyzer.IsExhaustiveDiscriminant(switchType) {
                ExhaustivenessAnalyzer.AnalyzeSwitchExpression(
                    syntax.SwitchKeyword.Location,
                    switchType,
                    ImmutableArray[BoundSwitchExpressionArm].Empty,
                    $scope.GetDeclaredStructs(),
                    Diagnostics
                )
            } else {
                Diagnostics.ReportSwitchExpressionMissingDefault(syntax.SwitchKeyword.Location)
            }
            return BoundErrorExpression(nil)
        }
        var hasDefault = false
        let boundArmBuilders = ImmutableArray
            .CreateBuilder[
            (Syntax SwitchExpressionArmSyntax, Pattern BoundPattern?, Guard BoundExpression?, Result BoundExpression)
        ]()
        for armSyntax in syntax.Arms {
            var pattern BoundPattern? = nil
            if armSyntax.IsDefault {
                if hasDefault {
                    Diagnostics.ReportDuplicateSwitchDefault(armSyntax.Keyword.Location)
                }
                hasDefault = true
                let result = if targetType == nil {
                    BindExpression(armSyntax.Result, canBeVoid)
                } else {
                    BindExpression(armSyntax.Result, targetType)
                }
                boundArmBuilders.Add((armSyntax, pattern, default(BoundExpression), result))
                continue
            }
            $scope = BoundScope($scope)
            let patternSyntax = Invariant.Required(
                armSyntax.Value,
                "a non-default switch arm has a pattern value",
                expression: "armSyntax.Value"
            )
            pattern = patterns.BindPattern(patternSyntax, switchType)
            // Issue #991: a guarded arm (`when <bool>`) can always fail at
            // runtime, so it never contributes to exhaustiveness — in
            // particular a guarded discard `case _ when …` does NOT act as a
            // default/total arm.
            let hasGuard = armSyntax.Guard != nil
            if pattern is BoundDiscardPattern && !hasGuard {
                if hasDefault {
                    Diagnostics.ReportDuplicateSwitchDefault(patternSyntax.Location)
                }
                hasDefault = true
            }
            let frame = StatementBinder.TryClassifyPatternNarrowing(discriminant, pattern)
            var guard_ BoundExpression? = nil
            if hasGuard {
                guard_ = BindGuardExpression(
                    Invariant.Required(
                        armSyntax.Guard,
                        "a guarded switch arm has a guard expression",
                        expression: "armSyntax.Guard"
                    ),
                    frame
                )
            }
            // ADR-0166: the arm result sees the guard's when-true pattern variables.
            let (guardWhenTrue, _) = PatternVariables.Classify(guard_)
            let armResult = BindWithPatternVariables(
                guardWhenTrue,
                () -> {
                    return BindExpressionWithNarrowing(armSyntax.Result, frame, targetType, canBeVoid)
                }
            )
            $scope = $scope.Pop()
            boundArmBuilders.Add((armSyntax, pattern, guard_, armResult))
        }
        let armResults = List[BoundExpression](boundArmBuilders.Count)
        for arm in boundArmBuilders {
            armResults.Add(arm.Result)
        }
        if IsVoidInDiscardedPosition(canBeVoid, armResults) {
            let voidArms = ImmutableArray.CreateBuilder[BoundSwitchExpressionArm](boundArmBuilders.Count)
            for arm in boundArmBuilders {
                voidArms.Add(BoundSwitchExpressionArm(nil, arm.Pattern, arm.Guard, DiscardValue(arm.Result)))
            }
            return BoundSwitchExpression(nil, discriminant, voidArms.MoveToImmutable(), TypeSymbol.Void)
        }
        if !hasDefault && !ExhaustivenessAnalyzer.IsExhaustiveDiscriminant(switchType) {
            Diagnostics.ReportSwitchExpressionMissingDefault(syntax.SwitchKeyword.Location)
        }
        let resultType = ComputeSwitchExpressionResultType(boundArmBuilders, targetType)
        let diagMark = Diagnostics.Count
        var anyArmFailed = false
        let arms = ImmutableArray.CreateBuilder[BoundSwitchExpressionArm](boundArmBuilders.Count)
        for arm in boundArmBuilders {
            var result = arm.Result
            // Issue #1443: a bare `default` arm result (`case 0: default`) is
            // an untyped placeholder `BoundDefaultExpression(Error)` until a
            // target type is known — its concrete type is supplied by the
            // switch's result type, exactly like `default` in a return/arrow
            // body. Re-bind it against `resultType` (which already honors any
            // outer target type and the other arms) so it materialises as
            // `default(resultType)`. Without this it would fall into the
            // conversion-failure branch below and be silently replaced by a
            // BoundErrorExpression that crashes emission (GS9998).
            if result is BoundDefaultExpression bareDefault &&
                bareDefault.Type == TypeSymbol.Error &&
                resultType != TypeSymbol.Error &&
                resultType != TypeSymbol
                .Void {
                result = BindExpression(arm.Syntax.Result, resultType)
                arms.Add(BoundSwitchExpressionArm(nil, arm.Pattern, arm.Guard, result))
                continue
            }
            let conversion = Conversion.Classify(result.Type, resultType)
            if !conversion.Exists || conversion.IsExplicit {
                if result.Type != TypeSymbol.Error && resultType != TypeSymbol.Error {
                    Diagnostics.ReportSwitchExpressionArmTypeMismatch(
                        arm.Syntax.Result.Location,
                        result.Type,
                        resultType
                    )
                    anyArmFailed = true
                }
                result = BoundErrorExpression(nil)
            } else if !conversion.IsIdentity {
                // Issue #1151: route the materialised conversion through
                // BindConversion so value-type `nil → T?` arms are lowered to a
                // BoundDefaultExpression (the verifiable Nullable<T> default),
                // matching the if-expression path. The Conversion.Classify check
                // above still governs the GS0179 arm-mismatch diagnostic.
                result = conversions.BindConversion(arm.Syntax.Result.Location, result, resultType)
            }
            arms.Add(BoundSwitchExpressionArm(nil, arm.Pattern, arm.Guard, result))
        }
        let boundArms = arms.ToImmutable()
        // Issue #1238: a deferred argument switch-expression whose arms could not
        // unify without a target — suppress the GS0179 diagnostics and return a
        // syntax-carrying placeholder so the caller can re-bind against the
        // resolved parameter type.
        if anyArmFailed && deferOnFailure {
            Diagnostics.TruncateTo(diagMark)
            return BoundErrorExpression(syntax)
        }
        ExhaustivenessAnalyzer.AnalyzeSwitchExpression(
            syntax.SwitchKeyword.Location,
            switchType,
            boundArms,
            $scope.GetDeclaredStructs(),
            Diagnostics
        )
        return BoundSwitchExpression(nil, discriminant, boundArms, resultType)
    }

    shared {
        /// Issue #1112: computes the switch-expression result type. When a target
        /// type is available (C#-style target-typing from an enclosing typed local,
        /// function return type, or argument context) and every arm is implicitly
        /// convertible to it, the target type is used. Otherwise the best common
        /// type (least-upper-bound) across the arm types is computed by walking the
        /// base-class chain and implemented interfaces, falling back to
        /// `object`. When no common type exists the first arm's type is kept so
        /// the existing GS0179 arm-mismatch diagnostic fires for the offending arms.
        private func ComputeSwitchExpressionResultType(
            arms IReadOnlyList[
                (
                    Syntax SwitchExpressionArmSyntax,
                    Pattern BoundPattern?,
                    Guard BoundExpression?,
                    Result BoundExpression
                )
            ],
            targetType TypeSymbol?
        ) TypeSymbol {
            let armTypes = List[TypeSymbol](arms.Count)
            for arm in arms {
                armTypes.Add(arm.Result.Type)
            }
            // Target-typing: honor an explicit target when every arm converts to it.
            if targetType != nil &&
                targetType != TypeSymbol.Error &&
                targetType != TypeSymbol.Void &&
                AllArmsImplicitlyConvertTo(armTypes, targetType) {
                return targetType
            }
            let common TypeSymbol? = ComputeBestCommonType(armTypes)
            return common ?? armTypes[0]
        }

        private func AllArmsImplicitlyConvertTo(armTypes IReadOnlyList[TypeSymbol], candidate TypeSymbol) bool {
            for armType in armTypes {
                if armType == TypeSymbol.Error || armType == TypeSymbol.Never || armType == TypeSymbol.Null {
                    // The bottom (`never`) and null-sentinel types convert to any
                    // reference/nullable target; an error arm is already diagnosed.
                    continue
                }
                let conversion = Conversion.Classify(armType, candidate)
                if !conversion.IsImplicit {
                    return false
                }
            }
            return true
        }

        /// Computes the best common type (least-upper-bound) across the supplied
        /// arm types. Candidates are enumerated from the most-derived "anchor" arm
        /// type — itself, then its base-class chain, then its implemented
        /// interfaces, then `object` — and the first candidate to which every
        /// arm is implicitly convertible is returned. Returns `null`
        /// when no common type can be found.
        private func ComputeBestCommonType(armTypes IReadOnlyList[TypeSymbol]) TypeSymbol? {
            // Any error arm short-circuits to Error so callers suppress further
            // diagnostics.
            for t in armTypes {
                if t == TypeSymbol.Error {
                    return TypeSymbol.Error
                }
            }
            // Drop the trivial bottom / null-sentinel types — they convert to any
            // reference target and never constrain the common type. Issue #1151:
            // remember whether a `nil` arm was present so a value-type common type
            // can be lifted to its nullable form below. Issue #2202: a `T?` arm is
            // unwrapped to its underlying `T` before candidate enumeration below —
            // e.g. a `Component?` / `Book?` arm pair must unify via `Component`'s /
            // `Book`'s shared `IBookCommon` interface exactly as the non-nullable
            // pair would — and the nullable annotation is re-applied to whatever
            // common type is found afterward.
            let significant = List[TypeSymbol](armTypes.Count)
            var hasNullArm = false
            var hasNullableArm = false
            var hasPlatformArm = false
            for t in armTypes {
                if t == TypeSymbol.Null {
                    hasNullArm = true
                } else if t != TypeSymbol.Never {
                    if t is NullableTypeSymbol nullableArm {
                        hasNullableArm = true
                        significant.Add(nullableArm.UnderlyingType)
                    } else if t is PlatformTypeSymbol platformArm {
                        // ADR-0186 §3: lub(`T!`, `T`) is `T!`. The arm's wrapper
                        // is stripped here for the same reason the `T?` arm's is
                        // — the common-type search runs over underlyings — and
                        // re-applied below, where `T?` deliberately wins over
                        // `T!` because an explicit statement beats the absence of
                        // one.
                        hasPlatformArm = true
                        significant.Add(platformArm.UnderlyingType)
                    } else {
                        significant.Add(t)
                    }
                }
            }
            if significant.Count == 0 {
                return nil
            }
            // Fast path: all arms already share the same type.
            let first = significant[0]
            var allSame = true
            for var i = 1; i < significant.Count; i++ {
                if !object.ReferenceEquals(significant[i], first) {
                    allSame = false
                    break
                }
            }
            var common TypeSymbol?
            if allSame {
                common = first
            } else {
                common = nil
                for candidate in EnumerateSupertypeCandidates(first) {
                    if AllArmsImplicitlyConvertTo(significant, candidate) {
                        common = candidate
                        break
                    }
                }
            }
            // Issue #1151: when a `nil` arm was present and the common type of the
            // remaining arms is a non-nullable value type `T`, unify to `T?`.
            // A `T!` arm already admits `nil`, so the join stays `T!` (restored below) unless an arm is `T?`.
            if common != nil && hasNullArm && (!hasPlatformArm || hasNullableArm) {
                common = LiftForNilArm(common)
            }
            // Issue #2202: when at least one arm was itself a nullable `T?`, the
            // unified result must stay nullable too, mirroring the two-arm
            // `UnionArmNullability` conditional-expression behavior.
            if common != nil && hasNullableArm && !(common is NullableTypeSymbol) {
                common = NullableTypeSymbol.Get(common)
            }
            // ADR-0186 §3, the same unification rule the two-arm conditional
            // applies in `UnionArmNullability`, and in the same order: an
            // explicit `T?` arm wins outright (handled just above), and a `T!`
            // arm only reaches this point when no arm was explicitly nullable.
            // It must NOT be symmetric absorption — a plain `T` arm asserts
            // non-nullness for itself alone and says nothing about the platform
            // arm, so the union stays `T!` rather than silently promoting an
            // unknown to a guarantee that §4 would then never check.
            if common != nil &&
                hasPlatformArm &&
                !((common is NullableTypeSymbol || common is PlatformTypeSymbol)) &&
                common != TypeSymbol.Error &&
                common != TypeSymbol.Never {
                common = PlatformTypeSymbol.Get(common)
            }
            return common
        }

        /// Enumerates the candidate supertypes of [`type`](paramref) ordered
        /// most-specific first: the type itself, its base-class chain, then its
        /// directly implemented interfaces. Mirroring C# best-common-type, this
        /// deliberately does NOT invent `object` as a candidate — when arms
        /// share no common base/interface the result is left unresolved so the
        /// arm-mismatch diagnostic (GS0179) fires (an explicit target type can
        /// still unify to a wider type, including `object`).
        private func EnumerateSupertypeCandidates(type TypeSymbol) sequence[TypeSymbol] {
            yield type
            if type is StructSymbol structSymbol {
                let baseClassChain = structSymbol.GetHierarchy()
                for var level = 1; level < baseClassChain.Count; level++ {
                    yield baseClassChain[level]
                }
                // Issue #1274: a user class's transitive base chain may end in an
                // imported/BCL base class (e.g. `MyStream : System.IO.Stream`),
                // recorded as `ImportedBaseType` rather than in the `BaseClass`
                // chain. Surface that imported base as a candidate so two sibling
                // subclasses of the same imported base unify to it. Walk the
                // user-base chain to find the first class carrying an imported base.
                for c in baseClassChain {
                    if c.ImportedBaseType != nil {
                        yield c.ImportedBaseType!!
                        break
                    }
                }
                for iface in structSymbol.Interfaces {
                    yield iface
                }
            }
        }
    }
}
