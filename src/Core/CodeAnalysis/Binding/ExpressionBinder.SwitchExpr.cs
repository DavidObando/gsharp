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
        var boundArmBuilders = ImmutableArray.CreateBuilder<(SwitchExpressionArmSyntax Syntax, BoundPattern Pattern, BoundExpression Result)>();

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
                boundArmBuilders.Add((armSyntax, pattern, result));
                continue;
            }

            scope = new BoundScope(scope);
            pattern = patterns.BindPattern(armSyntax.Value, switchType);
            if (pattern is BoundDiscardPattern)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(armSyntax.Value.Location);
                }

                hasDefault = true;
            }

            var frame = StatementBinder.TryClassifyPatternNarrowing(discriminant, pattern);
            var armResult = BindExpressionWithNarrowing(armSyntax.Result, frame);
            scope = scope.Parent;
            boundArmBuilders.Add((armSyntax, pattern, armResult));
        }

        if (!hasDefault && !ExhaustivenessAnalyzer.IsExhaustiveDiscriminant(switchType))
        {
            Diagnostics.ReportSwitchExpressionMissingDefault(syntax.SwitchKeyword.Location);
        }

        var resultType = boundArmBuilders[0].Result.Type;
        var arms = ImmutableArray.CreateBuilder<BoundSwitchExpressionArm>(boundArmBuilders.Count);
        foreach (var arm in boundArmBuilders)
        {
            var result = arm.Result;
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

            arms.Add(new BoundSwitchExpressionArm(null, arm.Pattern, result));
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
}
