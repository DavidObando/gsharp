// <copyright file="ExhaustivenessAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Performs conservative exhaustiveness checks for enum and sealed-interface switch discriminants.
/// </summary>
public static class ExhaustivenessAnalyzer
{
    /// <summary>
    /// Determines whether the specified discriminant type participates in exhaustiveness checking.
    /// </summary>
    /// <param name="type">The switch discriminant type.</param>
    /// <returns>True for enum types, sealed interfaces, and sealed-hierarchy classes; otherwise false.</returns>
    public static bool IsExhaustiveDiscriminant(TypeSymbol type)
        => type is EnumSymbol
        || type?.ClrType.IsEnumSafe() == true
        || type is InterfaceSymbol { IsSealed: true }
        || type is StructSymbol { IsSealedHierarchy: true };

    /// <summary>
    /// Reports a diagnostic when a switch expression over a closed discriminant misses variants.
    /// </summary>
    /// <param name="location">The switch location.</param>
    /// <param name="discriminantType">The switch discriminant type.</param>
    /// <param name="arms">The bound switch-expression arms.</param>
    /// <param name="structs">All user-defined aggregate types in scope.</param>
    /// <param name="diagnostics">The diagnostic sink.</param>
    public static void AnalyzeSwitchExpression(
        TextLocation location,
        TypeSymbol discriminantType,
        ImmutableArray<BoundSwitchExpressionArm> arms,
        ImmutableArray<StructSymbol> structs,
        DiagnosticBag diagnostics)
    {
        if (TryGetMissingVariants(discriminantType, arms.Where(a => a.Guard == null).Select(a => a.Pattern), structs, out var discriminantDescription, out var missingNames))
        {
            diagnostics.ReportSwitchExpressionNotExhaustive(location, discriminantDescription, missingNames);
        }
    }

    /// <summary>
    /// Reports a diagnostic when a switch statement over a closed discriminant misses variants.
    /// </summary>
    /// <param name="location">The switch location.</param>
    /// <param name="discriminantType">The switch discriminant type.</param>
    /// <param name="arms">The bound switch-statement arms.</param>
    /// <param name="structs">All user-defined aggregate types in scope.</param>
    /// <param name="diagnostics">The diagnostic sink.</param>
    public static void AnalyzeSwitchStatement(
        TextLocation location,
        TypeSymbol discriminantType,
        ImmutableArray<BoundPatternSwitchArm> arms,
        ImmutableArray<StructSymbol> structs,
        DiagnosticBag diagnostics)
    {
        if (TryGetMissingVariants(discriminantType, arms.Where(a => a.Guard == null).Select(a => a.Pattern), structs, out var discriminantDescription, out var missingNames))
        {
            diagnostics.ReportSwitchStatementNotExhaustive(location, discriminantDescription, missingNames);
        }
    }

    private static bool TryGetMissingVariants(
        TypeSymbol discriminantType,
        IEnumerable<BoundPattern> patterns,
        ImmutableArray<StructSymbol> structs,
        out string discriminantDescription,
        out ImmutableArray<string> missingNames)
    {
        discriminantDescription = null;
        missingNames = ImmutableArray<string>.Empty;

        if (discriminantType == TypeSymbol.Error)
        {
            return false;
        }

        var patternArray = patterns.ToArray();
        if (patternArray.Any(pattern => pattern == null))
        {
            return false;
        }

        // Issue #1643: an `or` disjunction (`Red or Green`) covers whatever its
        // leaves cover, including a nested discard, so flatten before checking
        // for a wildcard arm. `and` conjunctions narrow and are NOT flattened.
        if (patternArray.Any(pattern => FlattenDisjunction(pattern).Any(leaf => leaf is BoundDiscardPattern)))
        {
            return false;
        }

        if (TryGetEnumVariants(discriminantType, out var enumVariants))
        {
            discriminantDescription = $"enum '{discriminantType.Name}'";
            var coveredValues = new HashSet<object>();
            foreach (var pattern in patternArray)
            {
                foreach (var leaf in FlattenDisjunction(pattern))
                {
                    if (leaf is BoundConstantPattern constant
                        && constant.Value is BoundLiteralExpression literal)
                    {
                        coveredValues.Add(literal.Value);
                    }
                }
            }

            missingNames = enumVariants
                .Where(member => !coveredValues.Contains(member.Value))
                .Select(member => member.Name)
                .ToImmutableArray();
            return missingNames.Length > 0;
        }

        if (discriminantType is InterfaceSymbol { IsSealed: true } sealedInterface)
        {
            discriminantDescription = $"sealed interface '{sealedInterface.Name}'";
            var implementors = structs
                .Where(s => string.Equals(s.PackageName ?? string.Empty, sealedInterface.PackageName ?? string.Empty, System.StringComparison.Ordinal)
                    && s.Interfaces.Any(i => SameInterface(i, sealedInterface)))
                .ToImmutableArray();

            var coveredTypes = new HashSet<StructSymbol>();
            foreach (var pattern in patternArray)
            {
                foreach (var leaf in FlattenDisjunction(pattern))
                {
                    if (leaf is BoundTypePattern typePattern
                        && typePattern.TargetType is StructSymbol structSymbol
                        && structSymbol.Interfaces.Any(i => SameInterface(i, sealedInterface)))
                    {
                        coveredTypes.Add(structSymbol);
                    }
                }
            }

            missingNames = implementors
                .Where(implementor => !coveredTypes.Contains(implementor))
                .Select(implementor => implementor.Name)
                .ToImmutableArray();
            return missingNames.Length > 0;
        }

        if (discriminantType is StructSymbol { IsSealedHierarchy: true } sealedBaseClass)
        {
            // ADR-0078: sealed class hierarchies form a closed set. Subclasses
            // must live in the same package; the switch arms must cover every
            // direct or indirect subclass.
            discriminantDescription = $"sealed class '{sealedBaseClass.Name}'";
            var subclasses = structs
                .Where(s => s.IsClass
                    && string.Equals(s.PackageName ?? string.Empty, sealedBaseClass.PackageName ?? string.Empty, System.StringComparison.Ordinal)
                    && IsSubclassOf(s, sealedBaseClass))
                .ToImmutableArray();

            var coveredSubclasses = new HashSet<StructSymbol>();
            foreach (var pattern in patternArray)
            {
                foreach (var leaf in FlattenDisjunction(pattern))
                {
                    if (leaf is BoundTypePattern typePattern
                        && typePattern.TargetType is StructSymbol structSymbol
                        && IsSubclassOf(structSymbol, sealedBaseClass))
                    {
                        coveredSubclasses.Add(structSymbol);
                    }
                }
            }

            missingNames = subclasses
                .Where(s => !coveredSubclasses.Contains(s))
                .Select(s => s.Name)
                .ToImmutableArray();
            return missingNames.Length > 0;
        }

        return false;
    }

    private static bool TryGetEnumVariants(
        TypeSymbol type,
        out ImmutableArray<(string Name, object Value)> variants)
    {
        if (type is EnumSymbol enumSymbol)
        {
            variants = enumSymbol.Members
                .Select(member => (member.Name, (object)member.Value))
                .ToImmutableArray();
            return true;
        }

        if (type?.ClrType.IsEnumSafe() != true)
        {
            variants = ImmutableArray<(string Name, object Value)>.Empty;
            return false;
        }

        variants = ClrTypeUtilities.SafeGetFields(type.ClrType, BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.IsLiteral)
            .Select(field => (field.Name, field.GetRawConstantValue()))
            .ToImmutableArray();
        return true;
    }

    /// <summary>
    /// Issue #1643: recursively flattens an `or` disjunction (<see cref="BoundBinaryPattern"/>
    /// with <see cref="BoundBinaryPattern.IsConjunction"/> false) into its leaf patterns, so
    /// each disjunct is matched individually against the covered-variant set. Any nesting
    /// (<c>A or B or C</c>, <c>(A or B) or C</c>) is handled. An `and` conjunction narrows
    /// rather than covers, so it is never flattened and is returned as a single opaque leaf.
    /// </summary>
    private static IEnumerable<BoundPattern> FlattenDisjunction(BoundPattern pattern)
    {
        if (pattern is BoundBinaryPattern { IsConjunction: false } disjunction)
        {
            foreach (var leaf in FlattenDisjunction(disjunction.Left))
            {
                yield return leaf;
            }

            foreach (var leaf in FlattenDisjunction(disjunction.Right))
            {
                yield return leaf;
            }
        }
        else
        {
            yield return pattern;
        }
    }

    private static bool IsSubclassOf(StructSymbol candidate, StructSymbol baseClass)
    {
        for (var current = candidate.BaseClass; current != null; current = current.BaseClass)
        {
            if (current == baseClass || current.Definition == baseClass || current == baseClass.Definition || current.Definition == baseClass.Definition)
            {
                return true;
            }
        }

        return false;
    }

    private static bool SameInterface(InterfaceSymbol left, InterfaceSymbol right)
        => left == right || left.Definition == right || left == right.Definition || left.Definition == right.Definition;
}
