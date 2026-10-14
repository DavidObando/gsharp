// <copyright file="ExhaustivenessAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// Performs conservative exhaustiveness checks for enum and sealed-interface switch discriminants.
shared class ExhaustivenessAnalyzer {
    /// Determines whether the specified discriminant type participates in exhaustiveness checking.
    /// @param type The switch discriminant type.
    /// @returns True for enum types, sealed interfaces, and sealed-hierarchy classes; otherwise false.
    func IsExhaustiveDiscriminant(type TypeSymbol) bool -> type is EnumSymbol ||
        (type.ClrType is {} clrType && clrType.IsEnumSafe()) ||
        type is InterfaceSymbol &&
        type.IsSealed == true ||
        type is StructSymbol &&
        type.IsSealedHierarchy == true

    /// Reports a diagnostic when a switch expression over a closed discriminant misses variants.
    /// @param location The switch location.
    /// @param discriminantType The switch discriminant type.
    /// @param arms The bound switch-expression arms.
    /// @param structs All user-defined aggregate types in scope.
    /// @param diagnostics The diagnostic sink.
    func AnalyzeSwitchExpression(
        location TextLocation,
        discriminantType TypeSymbol,
        arms ImmutableArray[BoundSwitchExpressionArm],
        structs ImmutableArray[StructSymbol],
        diagnostics DiagnosticBag
    ) {
        if TryGetMissingVariants(
            discriminantType,
            arms.Where((a BoundSwitchExpressionArm) -> a.Guard == nil).Select(
                (a BoundSwitchExpressionArm) -> a.Pattern
            ),
            structs,
            out var discriminantDescription,
            out var missingNames
        ) &&
            discriminantDescription != nil {
            diagnostics.ReportSwitchExpressionNotExhaustive(location, discriminantDescription, missingNames)
        }
    }

    /// Reports a diagnostic when a switch statement over a closed discriminant misses variants.
    /// @param location The switch location.
    /// @param discriminantType The switch discriminant type.
    /// @param arms The bound switch-statement arms.
    /// @param structs All user-defined aggregate types in scope.
    /// @param diagnostics The diagnostic sink.
    /// @returns Whether the switch covers every value of a closed discriminant type.
    func AnalyzeSwitchStatement(
        location TextLocation,
        discriminantType TypeSymbol,
        arms ImmutableArray[BoundPatternSwitchArm],
        structs ImmutableArray[StructSymbol],
        diagnostics DiagnosticBag
    ) bool {
        if !IsExhaustiveDiscriminant(discriminantType) {
            return false
        }
        if TryGetMissingVariants(
            discriminantType,
            arms.Where((a BoundPatternSwitchArm) -> a.Guard == nil).Select((a BoundPatternSwitchArm) -> a.Pattern),
            structs,
            out var discriminantDescription,
            out var missingNames
        ) &&
            discriminantDescription != nil {
            diagnostics.ReportSwitchStatementNotExhaustive(location, discriminantDescription, missingNames)
            return false
        }
        return true
    }

    private func TryGetMissingVariants(
        discriminantType TypeSymbol,
        patterns IEnumerable[BoundPattern?],
        structs ImmutableArray[StructSymbol],
        out discriminantDescription string?,
        out missingNames ImmutableArray[string]
    ) bool {
        discriminantDescription = nil
        missingNames = ImmutableArray[string].Empty
        if discriminantType == TypeSymbol.Error {
            return false
        }
        let patternArray = patterns.ToArray()
        if patternArray.Any((pattern BoundPattern?) -> pattern == nil) {
            return false
        }
        let nonNullPatterns = patternArray.OfType[BoundPattern]().ToArray()
        // Issue #1643: an `or` disjunction (`Red or Green`) covers whatever its
        // leaves cover, including a nested discard, so flatten before checking
        // for a wildcard arm. `and` conjunctions narrow and are NOT flattened.
        if nonNullPatterns.Any(
            (pattern BoundPattern) -> FlattenDisjunction(pattern).Any(
                (leaf BoundPattern) -> leaf is BoundDiscardPattern
            )
        ) {
            return false
        }
        if TryGetEnumVariants(discriminantType, out var enumVariants) {
            discriminantDescription = "enum '${discriminantType.Name}'"
            let coveredValues = HashSet[object]()
            for pattern in nonNullPatterns {
                for leaf in FlattenDisjunction(pattern) {
                    if leaf is BoundConstantPattern constant && constant.Value is BoundLiteralExpression literal {
                        if literal.Value is {} value {
                            coveredValues.Add(value)
                        }
                    }
                }
            }
            let missing = ImmutableArray.CreateBuilder[string]()
            for member in enumVariants {
                if !coveredValues.Contains(member.Value) {
                    missing.Add(member.Name)
                }
            }
            missingNames = missing.ToImmutable()
            return missingNames.Length > 0
        }
        if discriminantType is InterfaceSymbol{IsSealed: true} sealedInterface {
            discriminantDescription = "sealed interface '${sealedInterface.Name}'"
            let implementors = structs.Where(
                (s StructSymbol) -> string.Equals(
                    s.PackageName ?? string.Empty,
                    sealedInterface.PackageName ?? string.Empty,
                    StringComparison.Ordinal
                ) &&
                    s
                    .Interfaces
                    .Any((i InterfaceSymbol) -> SameInterface(i, sealedInterface))
            )
                .ToImmutableArray()
            let coveredTypes = HashSet[StructSymbol]()
            for pattern in nonNullPatterns {
                for leaf in FlattenDisjunction(pattern) {
                    if leaf is BoundTypePattern typePattern &&
                        typePattern.TargetType is StructSymbol structSymbol &&
                        structSymbol
                        .Interfaces
                        .Any((i InterfaceSymbol) -> SameInterface(i, sealedInterface)) {
                        coveredTypes.Add(structSymbol)
                    }
                }
            }
            missingNames = implementors
                .Where((implementor StructSymbol) -> !coveredTypes.Contains(implementor))
                .Select((implementor StructSymbol) -> implementor.Name)
                .ToImmutableArray()
            return missingNames.Length > 0
        }
        if discriminantType is StructSymbol{IsSealedHierarchy: true} sealedBaseClass {
            // ADR-0078: sealed class hierarchies form a closed set. Subclasses
            // must live in the same package; the switch arms must cover every
            // direct or indirect subclass.
            discriminantDescription = "sealed class '${sealedBaseClass.Name}'"
            let subclasses = structs.Where(
                (s StructSymbol) -> s.IsClass && string.Equals(
                    s.PackageName ?? string.Empty,
                    sealedBaseClass.PackageName ?? string.Empty,
                    StringComparison.Ordinal
                ) &&
                    IsSubclassOf(s, sealedBaseClass)
            )
                .ToImmutableArray()
            let coveredSubclasses = HashSet[StructSymbol]()
            for pattern in nonNullPatterns {
                for leaf in FlattenDisjunction(pattern) {
                    if leaf is BoundTypePattern typePattern &&
                        typePattern.TargetType is StructSymbol structSymbol &&
                        IsSubclassOf(structSymbol, sealedBaseClass) {
                        coveredSubclasses.Add(structSymbol)
                    }
                }
            }
            missingNames = subclasses
                .Where((s StructSymbol) -> !coveredSubclasses.Contains(s))
                .Select((s StructSymbol) -> s.Name)
                .ToImmutableArray()
            return missingNames.Length > 0
        }
        return false
    }

    private func TryGetEnumVariants(type TypeSymbol, out variants ImmutableArray[(Name string, Value object)]) bool {
        if type is EnumSymbol enumSymbol {
            variants = enumSymbol
                .Members
                .Select((member EnumMemberSymbol) -> (member.Name, object(member.Value)))
                .ToImmutableArray()
            return true
        }
        if type?.ClrType is not Type clrType || !clrType.IsEnumSafe() {
            variants = ImmutableArray[(Name string, Value object)].Empty
            return false
        }
        variants = GetClrEnumVariants(clrType).ToImmutableArray()
        return true
    }

    private func GetClrEnumVariants(type Type) sequence[(Name string, Value object)] {
        for field in ClrTypeUtilities.SafeGetFields(type, BindingFlags.Public | BindingFlags.Static) {
            if !field.IsLiteral {
                continue
            }
            let value object? = field.GetRawConstantValue()
            if value != nil {
                yield(field.Name, value)
            }
        }
    }

    /// Issue #1643: recursively flattens an `or` disjunction ((cref:BoundBinaryPattern)
    /// with (cref:BoundBinaryPattern.IsConjunction) false) into its leaf patterns, so
    /// each disjunct is matched individually against the covered-variant set. Any nesting
    /// (`A or B or C`, `(A or B) or C`) is handled. An `and` conjunction narrows
    /// rather than covers, so it is never flattened and is returned as a single opaque leaf.
    private func FlattenDisjunction(pattern BoundPattern) sequence[BoundPattern] {
        if pattern is BoundBinaryPattern{IsConjunction: false} disjunction {
            for leaf in FlattenDisjunction(disjunction.Left) {
                yield leaf
            }
            for leaf in FlattenDisjunction(disjunction.Right) {
                yield leaf
            }
        } else {
            yield pattern
        }
    }

    private func IsSubclassOf(candidate StructSymbol, baseClass StructSymbol) bool {
        let chain = candidate.GetHierarchy()
        for var level = 1; level < chain.Count; level++ {
            let current = chain[level]
            if current == baseClass ||
                current.Definition == baseClass ||
                current == baseClass.Definition ||
                current.Definition == baseClass.Definition {
                return true
            }
        }
        return false
    }

    private func SameInterface(left InterfaceSymbol, right InterfaceSymbol) bool -> left == right ||
        left.Definition == right ||
        left == right.Definition ||
        left.Definition == right.Definition
}
