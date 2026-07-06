// <copyright file="ExpressionBinder.SwitchExpr.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{
    private BoundExpression BindSwitchExpression(SwitchExpressionSyntax syntax)
        => BindSwitchExpression(syntax, targetType: null);

    private BoundExpression BindSwitchExpression(SwitchExpressionSyntax syntax, TypeSymbol targetType)
    {
        // Issue #1238: when this switch-expression is an eagerly-bound call
        // argument with no target type yet, defer a no-common-type unification
        // failure (instead of reporting GS0179) so the argument can be re-bound
        // against the resolved parameter type. The flag is read-and-cleared up
        // front so nested sub-expressions bind with normal semantics.
        var deferOnFailure = targetType == null && binderCtx.DeferTargetlessConditional;
        binderCtx.DeferTargetlessConditional = false;

        var discriminant = BindExpression(syntax.Expression);
        var switchType = discriminant.Type;

        if (switchType == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        if (syntax.Arms.Length == 0)
        {
            if (ExhaustivenessAnalyzer.IsExhaustiveDiscriminant(switchType))
            {
                ExhaustivenessAnalyzer.AnalyzeSwitchExpression(
                    syntax.SwitchKeyword.Location,
                    switchType,
                    ImmutableArray<BoundSwitchExpressionArm>.Empty,
                    scope.GetDeclaredStructs(),
                    Diagnostics);
            }
            else
            {
                Diagnostics.ReportSwitchExpressionMissingDefault(syntax.SwitchKeyword.Location);
            }

            return new BoundErrorExpression(null);
        }

        var hasDefault = false;
        var boundArmBuilders = ImmutableArray.CreateBuilder<(SwitchExpressionArmSyntax Syntax, BoundPattern Pattern, BoundExpression Guard, BoundExpression Result)>();

        foreach (var armSyntax in syntax.Arms)
        {
            BoundPattern pattern = null;
            if (armSyntax.IsDefault)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(armSyntax.Keyword.Location);
                }

                hasDefault = true;
                var result = BindExpression(armSyntax.Result);
                boundArmBuilders.Add((armSyntax, pattern, null, result));
                continue;
            }

            scope = new BoundScope(scope);
            pattern = patterns.BindPattern(armSyntax.Value, switchType);

            // Issue #991: a guarded arm (`when <bool>`) can always fail at
            // runtime, so it never contributes to exhaustiveness — in
            // particular a guarded discard `case _ when …` does NOT act as a
            // default/total arm.
            var hasGuard = armSyntax.Guard != null;
            if (pattern is BoundDiscardPattern && !hasGuard)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(armSyntax.Value.Location);
                }

                hasDefault = true;
            }

            var frame = StatementBinder.TryClassifyPatternNarrowing(discriminant, pattern);
            BoundExpression guard = null;
            if (hasGuard)
            {
                guard = BindGuardExpression(armSyntax.Guard, frame);
            }

            var armResult = BindExpressionWithNarrowing(armSyntax.Result, frame);
            scope = scope.Parent;
            boundArmBuilders.Add((armSyntax, pattern, guard, armResult));
        }

        if (!hasDefault && !ExhaustivenessAnalyzer.IsExhaustiveDiscriminant(switchType))
        {
            Diagnostics.ReportSwitchExpressionMissingDefault(syntax.SwitchKeyword.Location);
        }

        var resultType = ComputeSwitchExpressionResultType(boundArmBuilders, targetType);
        var diagMark = Diagnostics.Count;
        var anyArmFailed = false;
        var arms = ImmutableArray.CreateBuilder<BoundSwitchExpressionArm>(boundArmBuilders.Count);
        foreach (var arm in boundArmBuilders)
        {
            var result = arm.Result;

            // Issue #1443: a bare `default` arm result (`case 0: default`) is
            // an untyped placeholder `BoundDefaultExpression(Error)` until a
            // target type is known — its concrete type is supplied by the
            // switch's result type, exactly like `default` in a return/arrow
            // body. Re-bind it against `resultType` (which already honors any
            // outer target type and the other arms) so it materialises as
            // `default(resultType)`. Without this it would fall into the
            // conversion-failure branch below and be silently replaced by a
            // BoundErrorExpression that crashes emission (GS9998).
            if (result is BoundDefaultExpression bareDefault
                && bareDefault.Type == TypeSymbol.Error
                && resultType != TypeSymbol.Error
                && resultType != TypeSymbol.Void)
            {
                result = BindExpression(arm.Syntax.Result, resultType);
                arms.Add(new BoundSwitchExpressionArm(null, arm.Pattern, arm.Guard, result));
                continue;
            }

            var conversion = Conversion.Classify(result.Type, resultType);
            if (!conversion.Exists || conversion.IsExplicit)
            {
                if (result.Type != TypeSymbol.Error && resultType != TypeSymbol.Error)
                {
                    Diagnostics.ReportSwitchExpressionArmTypeMismatch(arm.Syntax.Result.Location, result.Type, resultType);
                    anyArmFailed = true;
                }

                result = new BoundErrorExpression(null);
            }
            else if (!conversion.IsIdentity)
            {
                // Issue #1151: route the materialised conversion through
                // BindConversion so value-type `nil → T?` arms are lowered to a
                // BoundDefaultExpression (the verifiable Nullable<T> default),
                // matching the if-expression path. The Conversion.Classify check
                // above still governs the GS0179 arm-mismatch diagnostic.
                result = conversions.BindConversion(arm.Syntax.Result.Location, result, resultType);
            }

            arms.Add(new BoundSwitchExpressionArm(null, arm.Pattern, arm.Guard, result));
        }

        var boundArms = arms.ToImmutable();

        // Issue #1238: a deferred argument switch-expression whose arms could not
        // unify without a target — suppress the GS0179 diagnostics and return a
        // syntax-carrying placeholder so the caller can re-bind against the
        // resolved parameter type.
        if (anyArmFailed && deferOnFailure)
        {
            Diagnostics.TruncateTo(diagMark);
            return new BoundErrorExpression(syntax);
        }

        ExhaustivenessAnalyzer.AnalyzeSwitchExpression(
            syntax.SwitchKeyword.Location,
            switchType,
            boundArms,
            scope.GetDeclaredStructs(),
            Diagnostics);

        return new BoundSwitchExpression(null, discriminant, boundArms, resultType);
    }

    /// <summary>
    /// Issue #1112: computes the switch-expression result type. When a target
    /// type is available (C#-style target-typing from an enclosing typed local,
    /// function return type, or argument context) and every arm is implicitly
    /// convertible to it, the target type is used. Otherwise the best common
    /// type (least-upper-bound) across the arm types is computed by walking the
    /// base-class chain and implemented interfaces, falling back to
    /// <c>object</c>. When no common type exists the first arm's type is kept so
    /// the existing GS0179 arm-mismatch diagnostic fires for the offending arms.
    /// </summary>
    private static TypeSymbol ComputeSwitchExpressionResultType(
        IReadOnlyList<(SwitchExpressionArmSyntax Syntax, BoundPattern Pattern, BoundExpression Guard, BoundExpression Result)> arms,
        TypeSymbol targetType)
    {
        var armTypes = new List<TypeSymbol>(arms.Count);
        foreach (var arm in arms)
        {
            armTypes.Add(arm.Result.Type);
        }

        // Target-typing: honor an explicit target when every arm converts to it.
        if (targetType != null
            && targetType != TypeSymbol.Error
            && targetType != TypeSymbol.Void
            && AllArmsImplicitlyConvertTo(armTypes, targetType))
        {
            return targetType;
        }

        var common = ComputeBestCommonType(armTypes);
        return common ?? armTypes[0];
    }

    private static bool AllArmsImplicitlyConvertTo(IReadOnlyList<TypeSymbol> armTypes, TypeSymbol candidate)
    {
        foreach (var armType in armTypes)
        {
            if (armType == TypeSymbol.Error
                || armType == TypeSymbol.Never
                || armType == TypeSymbol.Null)
            {
                // The bottom (`never`) and null-sentinel types convert to any
                // reference/nullable target; an error arm is already diagnosed.
                continue;
            }

            var conversion = Conversion.Classify(armType, candidate);
            if (!conversion.IsImplicit)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Computes the best common type (least-upper-bound) across the supplied
    /// arm types. Candidates are enumerated from the most-derived "anchor" arm
    /// type — itself, then its base-class chain, then its implemented
    /// interfaces, then <c>object</c> — and the first candidate to which every
    /// arm is implicitly convertible is returned. Returns <see langword="null"/>
    /// when no common type can be found.
    /// </summary>
    private static TypeSymbol ComputeBestCommonType(IReadOnlyList<TypeSymbol> armTypes)
    {
        // Any error arm short-circuits to Error so callers suppress further
        // diagnostics.
        foreach (var t in armTypes)
        {
            if (t == TypeSymbol.Error)
            {
                return TypeSymbol.Error;
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
        var significant = new List<TypeSymbol>(armTypes.Count);
        var hasNullArm = false;
        var hasNullableArm = false;
        foreach (var t in armTypes)
        {
            if (t == TypeSymbol.Null)
            {
                hasNullArm = true;
            }
            else if (t != TypeSymbol.Never)
            {
                if (t is NullableTypeSymbol nullableArm)
                {
                    hasNullableArm = true;
                    significant.Add(nullableArm.UnderlyingType);
                }
                else
                {
                    significant.Add(t);
                }
            }
        }

        if (significant.Count == 0)
        {
            return null;
        }

        // Fast path: all arms already share the same type.
        var first = significant[0];
        var allSame = true;
        for (var i = 1; i < significant.Count; i++)
        {
            if (!ReferenceEquals(significant[i], first))
            {
                allSame = false;
                break;
            }
        }

        TypeSymbol common;
        if (allSame)
        {
            common = first;
        }
        else
        {
            common = null;
            foreach (var candidate in EnumerateSupertypeCandidates(first))
            {
                if (AllArmsImplicitlyConvertTo(significant, candidate))
                {
                    common = candidate;
                    break;
                }
            }
        }

        // Issue #1151: when a `nil` arm was present and the common type of the
        // remaining arms is a non-nullable value type `T`, unify to `T?`.
        if (common != null && hasNullArm)
        {
            common = LiftForNilArm(common);
        }

        // Issue #2202: when at least one arm was itself a nullable `T?`, the
        // unified result must stay nullable too, mirroring the two-arm
        // `UnionArmNullability` conditional-expression behavior.
        if (common != null && hasNullableArm && common is not NullableTypeSymbol)
        {
            common = NullableTypeSymbol.Get(common);
        }

        return common;
    }

    /// <summary>
    /// Enumerates the candidate supertypes of <paramref name="type"/> ordered
    /// most-specific first: the type itself, its base-class chain, then its
    /// directly implemented interfaces. Mirroring C# best-common-type, this
    /// deliberately does NOT invent <c>object</c> as a candidate — when arms
    /// share no common base/interface the result is left unresolved so the
    /// arm-mismatch diagnostic (GS0179) fires (an explicit target type can
    /// still unify to a wider type, including <c>object</c>).
    /// </summary>
    private static IEnumerable<TypeSymbol> EnumerateSupertypeCandidates(TypeSymbol type)
    {
        yield return type;

        if (type is StructSymbol structSymbol)
        {
            for (var baseClass = structSymbol.BaseClass; baseClass != null; baseClass = baseClass.BaseClass)
            {
                yield return baseClass;
            }

            // Issue #1274: a user class's transitive base chain may end in an
            // imported/BCL base class (e.g. `MyStream : System.IO.Stream`),
            // recorded as `ImportedBaseType` rather than in the `BaseClass`
            // chain. Surface that imported base as a candidate so two sibling
            // subclasses of the same imported base unify to it. Walk the
            // user-base chain to find the first class carrying an imported base.
            for (var c = structSymbol; c != null; c = c.BaseClass)
            {
                if (c.ImportedBaseType != null)
                {
                    yield return c.ImportedBaseType;
                    break;
                }
            }

            foreach (var iface in structSymbol.Interfaces)
            {
                yield return iface;
            }
        }
    }
}
