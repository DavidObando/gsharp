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

        // Issue #1112: compute the result type using a best-common-type
        // (least-upper-bound) procedure across ALL arm types rather than
        // forcing every arm to match the first arm's type. When no common
        // type exists but a declared target type is supplied (a `let x T = …`
        // initializer or a `return` in a function with a declared return
        // type), fall back to target-typing the arms.
        var armTypes = boundArmBuilders.Select(a => a.Result.Type);
        var resultType = ComputeSwitchResultType(armTypes);

        if ((resultType == null || IsObjectOrValueType(resultType))
            && targetType != null
            && targetType != TypeSymbol.Error
            && AllArmsConvertTo(boundArmBuilders, targetType))
        {
            resultType = targetType;
        }

        if (resultType == null)
        {
            // No best-common-type and no usable target type: anchor on the
            // first arm's type so the per-arm loop below reports the GS0179
            // mismatch diagnostic against it (preserving prior behavior).
            resultType = boundArmBuilders[0].Result.Type;
        }

        var arms = ImmutableArray.CreateBuilder<BoundSwitchExpressionArm>(boundArmBuilders.Count);
        foreach (var arm in boundArmBuilders)
        {
            var result = arm.Result;

            // Issue #1018 precedent: a throw-expression arm has the bottom
            // (`never`) type — it yields no value to convert, so leave it
            // unwrapped (mirroring ConvertConditionalBranch).
            if (result.Type == TypeSymbol.Never)
            {
                arms.Add(new BoundSwitchExpressionArm(null, arm.Pattern, arm.Guard, result));
                continue;
            }

            var conversion = Conversion.Classify(result.Type, resultType);
            if (!conversion.Exists || conversion.IsExplicit)
            {
                if (result.Type != TypeSymbol.Error && resultType != TypeSymbol.Error)
                {
                    Diagnostics.ReportSwitchExpressionArmTypeMismatch(arm.Syntax.Result.Location, result.Type, resultType);
                }

                result = new BoundErrorExpression(null);
            }
            else if (!conversion.IsIdentity)
            {
                result = new BoundConversionExpression(null, resultType, result);
            }

            arms.Add(new BoundSwitchExpressionArm(null, arm.Pattern, arm.Guard, result));
        }

        var boundArms = arms.ToImmutable();
        ExhaustivenessAnalyzer.AnalyzeSwitchExpression(
            syntax.SwitchKeyword.Location,
            switchType,
            boundArms,
            scope.GetDeclaredStructs(),
            Diagnostics);

        return new BoundSwitchExpression(null, discriminant, boundArms, resultType);
    }

    /// <summary>
    /// Issue #1112: computes the best-common-type (least-upper-bound) across a
    /// set of switch-expression arm result types, using the following ordered
    /// rules (mirroring the ternary <c>ComputeConditionalCommonType</c>
    /// procedure but generalized to N arms):
    /// <list type="number">
    ///   <item><description><c>never</c> arms (throw-expressions) do not constrain the result; <c>nil</c> arms only require a reference/nullable result, which the per-arm conversion verifies.</description></item>
    ///   <item><description>Identity — all constraining arms already share one type.</description></item>
    ///   <item><description>Pairwise dominance — an arm type to which every other arm implicitly converts (preserves numeric widening and the "one arm IS the common base" case), with the numeric tie-break when several mutually convert.</description></item>
    ///   <item><description>Shared supertype — the most-derived class or interface to which EVERY arm implicitly converts. <c>object</c>/<c>System.ValueType</c> are never valid results, so unrelated arms (e.g. <c>string</c> + <c>int32</c>) have no common type.</description></item>
    /// </list>
    /// Returns <see langword="null"/> when no common type exists.
    /// </summary>
    private static TypeSymbol ComputeSwitchResultType(IEnumerable<TypeSymbol> armTypesEnumerable)
    {
        var armTypes = armTypesEnumerable.ToList();
        if (armTypes.Count == 0)
        {
            return null;
        }

        if (armTypes.Any(t => t == TypeSymbol.Error))
        {
            return TypeSymbol.Error;
        }

        // never/nil sentinels do not constrain the common type (mirroring
        // ComputeConditionalCommonType). A nil arm only needs the chosen
        // result to be reference/nullable-compatible, which the per-arm
        // conversion pass verifies separately.
        var hasNull = armTypes.Any(t => t == TypeSymbol.Null);
        var constraining = armTypes.Where(t => t != TypeSymbol.Never && t != TypeSymbol.Null).ToList();

        if (constraining.Count == 0)
        {
            // Every arm is a throw (never) or nil. Prefer nil when present so
            // the result stays reference-compatible; otherwise the bottom type.
            return hasNull ? TypeSymbol.Null : TypeSymbol.Never;
        }

        // Rule 1: identity — all constraining arms already share one type.
        var first = constraining[0];
        if (constraining.All(t => ReferenceEquals(t, first)))
        {
            return first;
        }

        // Rule 2: pairwise dominance — an arm type to which every other arm
        // implicitly converts. Preserves numeric widening (ADR-0037) and the
        // case where one arm literally IS the shared base type.
        TypeSymbol dominator = null;
        foreach (var candidate in constraining)
        {
            if (!AllConvertTo(constraining, candidate))
            {
                continue;
            }

            if (dominator == null)
            {
                dominator = candidate;
            }
            else
            {
                // Several mutually-convertible dominators (e.g. numeric
                // primitives): prefer the wider via the numeric tie-break.
                var widened = TryNumericTieBreak(dominator, candidate);
                dominator = widened ?? dominator;
            }
        }

        if (dominator != null)
        {
            return dominator;
        }

        // Rule 3: shared supertype LUB — the most-derived class or interface
        // (excluding object/ValueType) to which every arm implicitly converts.
        // The candidate pool is the ordered supertype set (most-derived first)
        // of the first user-type arm; AllConvertTo enforces the intersection
        // against all other arms.
        foreach (var arm in constraining)
        {
            if (arm is not StructSymbol && arm is not InterfaceSymbol)
            {
                continue;
            }

            foreach (var candidate in EnumerateSupertypes(arm))
            {
                if (IsObjectOrValueType(candidate))
                {
                    continue;
                }

                if (AllConvertTo(constraining, candidate))
                {
                    return candidate;
                }
            }

            break;
        }

        return null;
    }

    /// <summary>
    /// Returns <see langword="true"/> when every type in <paramref name="types"/>
    /// implicitly converts (including identity) to <paramref name="target"/>.
    /// </summary>
    private static bool AllConvertTo(IEnumerable<TypeSymbol> types, TypeSymbol target)
    {
        foreach (var t in types)
        {
            if (ReferenceEquals(t, target))
            {
                continue;
            }

            // never/nil are implicitly convertible to any reference/nullable
            // target; Conversion.Classify already encodes the never rule, and
            // a nil sentinel widens to any reference/nullable type.
            if (t == TypeSymbol.Never)
            {
                continue;
            }

            if (!Conversion.Classify(t, target).IsImplicit)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Returns <see langword="true"/> when every switch arm implicitly
    /// converts to <paramref name="target"/> (used for target-typing fallback).
    /// </summary>
    private static bool AllArmsConvertTo(
        IEnumerable<(SwitchExpressionArmSyntax Syntax, BoundPattern Pattern, BoundExpression Guard, BoundExpression Result)> arms,
        TypeSymbol target)
        => AllConvertTo(arms.Select(a => a.Result.Type), target);

    /// <summary>
    /// Enumerates the supertype set of a user type — itself, its transitive
    /// base classes, its imported CLR base class, and its transitive (and
    /// inherited) interfaces — ordered most-derived first so the first match
    /// found by the LUB search is the most specific shared supertype. Only
    /// user-declared <see cref="StructSymbol"/> classes and
    /// <see cref="InterfaceSymbol"/> interfaces contribute a non-trivial set;
    /// primitive/imported types contribute only themselves, which keeps
    /// unrelated value-type arms (e.g. <c>string</c> + <c>int32</c>) without a
    /// common type.
    /// </summary>
    private static IEnumerable<TypeSymbol> EnumerateSupertypes(TypeSymbol type)
    {
        var seen = new HashSet<TypeSymbol>();
        var ordered = new List<TypeSymbol>();

        void Add(TypeSymbol t)
        {
            if (t != null && seen.Add(t))
            {
                ordered.Add(t);
            }
        }

        if (type is StructSymbol s && s.IsClass)
        {
            // Self + user base-class chain (most-derived first).
            for (var c = s; c != null; c = c.BaseClass)
            {
                Add(c);
            }

            // Imported CLR base class (e.g. a G# class extending a CLR type).
            Add(s.ImportedBaseType);

            // Transitive user interfaces and imported CLR interfaces from the
            // whole class chain.
            for (var c = s; c != null; c = c.BaseClass)
            {
                foreach (var iface in c.Interfaces)
                {
                    foreach (var baseIface in iface.SelfAndAllBaseInterfaces())
                    {
                        Add(baseIface);
                    }
                }

                foreach (var clrIface in c.ImplementedClrInterfaces)
                {
                    Add(clrIface);
                }
            }
        }
        else if (type is InterfaceSymbol i)
        {
            foreach (var baseIface in i.SelfAndAllBaseInterfaces())
            {
                Add(baseIface);
            }
        }
        else
        {
            Add(type);
        }

        return ordered;
    }

    /// <summary>
    /// Issue #1112: <c>object</c> and <c>System.ValueType</c> are never valid
    /// best-common-type results — when the only shared supertype is one of
    /// these, the arms are treated as having no common type.
    /// </summary>
    private static bool IsObjectOrValueType(TypeSymbol type)
    {
        if (type == null)
        {
            return true;
        }

        if (ReferenceEquals(type, TypeSymbol.Object))
        {
            return true;
        }

        var clr = type.ClrType;
        if (clr == null)
        {
            return false;
        }

        return clr.IsSameAs(typeof(object)) || clr.IsSameAs(typeof(System.ValueType));
    }
}
