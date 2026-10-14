// <copyright file="PatternVariables.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Collections.Immutable

/// ADR-0166: the flow facts of pattern variables introduced by boolean
/// `is` expressions. A pattern variable is definitely assigned exactly
/// when its pattern matched, so the binder scopes it to the regions where the
/// enclosing condition is known to be true (or false, through negation).
/// This helper computes those "when true" / "when false" sets structurally
/// over a bound condition, mirroring C#'s definite-assignment rules for
/// `&&`, `||`, `!`, and pattern matches, and mirroring
/// the smart-cast classifiers (`ClassifyTypeTestNarrowing`) that already
/// walk the same shapes.
internal shared class PatternVariables {
    /// The empty result: no pattern variable is assigned on either branch.
    let None(WhenTrue ImmutableArray[LocalVariableSymbol], WhenFalse ImmutableArray[LocalVariableSymbol]) = (
        ImmutableArray[LocalVariableSymbol].Empty,
        ImmutableArray[LocalVariableSymbol].Empty
    )

    /// Collects the source-visible variables a pattern assigns when it matches:
    /// type-pattern designations, slice captures, and their conjunctive,
    /// recursive, and top-level-negated descendants.
    /// @param pattern The bound pattern.
    /// @returns The variables in source order.
    func CollectBindings(pattern BoundPattern?) ImmutableArray[LocalVariableSymbol] {
        if pattern == nil {
            return ImmutableArray[LocalVariableSymbol].Empty
        }
        let builder = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
        Collect(pattern, builder)
        return builder.ToImmutable()
    }

    /// Classifies a boolean condition into the pattern variables that are
    /// definitely assigned when it evaluates to `true` and to
    /// `false`.
    /// @param condition The bound condition.
    /// @returns The when-true and when-false variable sets.
    func Classify(condition BoundExpression?)(
        WhenTrue ImmutableArray[LocalVariableSymbol],
        WhenFalse ImmutableArray[LocalVariableSymbol]
    ) {
        switch condition {
            case isExpression is BoundIsExpression {
                return ClassifyPattern(isExpression.Pattern)
            }
            case unary is BoundUnaryExpression when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
                {
                    let (whenTrue, whenFalse) = Classify(unary.Operand)
                    return (whenFalse, whenTrue)
                }
            }
            case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                {
                    // `A && B` is true only when both were true, so both sides'
                    // when-true variables are assigned; it is false when either
                    // side was false, so only variables assigned on BOTH false
                    // paths survive.
                    let (leftTrue, leftFalse) = Classify(binary.Left)
                    let (rightTrue, rightFalse) = Classify(binary.Right)
                    return (Union(leftTrue, rightTrue), Intersect(leftFalse, rightFalse))
                }
            }
            case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
                {
                    let (leftTrue, leftFalse) = Classify(binary.Left)
                    let (rightTrue, rightFalse) = Classify(binary.Right)
                    return (Intersect(leftTrue, rightTrue), Union(leftFalse, rightFalse))
                }
            }
            case conversion is BoundConversionExpression when conversion.Type == TypeSymbol.Bool {
                return Classify(conversion.Expression)
            }
            default {
                return None
            }
        }
    }

    /// Runs [`bind`](paramref) with [`variables`](paramref) declared
    /// in a fresh child scope of the binder's current scope — the region in
    /// which those pattern variables are definitely assigned. Duplicate names
    /// are reported by the construct that merged them (see
    /// `ExpressionBinder.ReportDuplicatePatternVariables`), so a
    /// redeclaration is silently skipped here.
    /// @typeparam T The bound result type.
    /// @param binderCtx The shared binder context whose current scope is extended.
    /// @param variables The pattern variables in scope for the region.
    /// @param bind The binding action.
    /// @returns The bound result.
    func BindInScope[T](binderCtx BinderContext, variables ImmutableArray[LocalVariableSymbol], bind() -> T) T {
        if variables.IsDefaultOrEmpty {
            return bind()
        }
        let saved = binderCtx.RootScope
        let region = BoundScope(saved)
        binderCtx.RootScope = region
        try {
            for variable in variables {
                region.TryDeclareVariable(variable)
            }
            return bind()
        } finally {
            binderCtx.RootScope = saved
            // Anything else the region declared — an inline `out var` in the
            // right operand of `&&`, for instance — belongs to the enclosing
            // scope exactly as it would without the pattern-variable region
            // (C# scopes expression variables to the enclosing statement), so
            // hoist it out; only the pattern variables stay region-scoped.
            let patternSet = HashSet[LocalVariableSymbol](variables)
            for declared in region.GetDeclaredVariables() {
                if declared is LocalVariableSymbol local && patternSet.Contains(local) {
                    continue
                }
                if !saved.TryDeclareVariable(declared) && declared.DeclaringSyntax is SyntaxNode declaring {
                    binderCtx.Diagnostics.ReportSymbolAlreadyDeclared(declaring.Location, declared.Name)
                }
            }
        }
    }

    private func ClassifyPattern(pattern BoundPattern)(
        WhenTrue ImmutableArray[LocalVariableSymbol],
        WhenFalse ImmutableArray[LocalVariableSymbol]
    ) {
        switch pattern {
            case notPattern is BoundNotPattern {
                {
                    let (whenTrue, whenFalse) = ClassifyPattern(notPattern.Pattern)
                    return (whenFalse, whenTrue)
                }
            }
            case binary is BoundBinaryPattern when binary.IsConjunction {
                {
                    let (leftTrue, leftFalse) = ClassifyPattern(binary.Left)
                    let (rightTrue, rightFalse) = ClassifyPattern(binary.Right)
                    return (Union(leftTrue, rightTrue), Intersect(leftFalse, rightFalse))
                }
            }
            case binary is BoundBinaryPattern {
                {
                    let (leftTrue, leftFalse) = ClassifyPattern(binary.Left)
                    let (rightTrue, rightFalse) = ClassifyPattern(binary.Right)
                    return (Intersect(leftTrue, rightTrue), Union(leftFalse, rightFalse))
                }
            }
            default {
                return (CollectBindings(pattern), ImmutableArray[LocalVariableSymbol].Empty)
            }
        }
    }

    private func Collect(pattern BoundPattern, into ImmutableArray[LocalVariableSymbol].Builder) {
        switch pattern {
            case BoundDiscardPattern{Variable: not nil} varPattern {
                into.Add(varPattern.Variable!!)
            }
            case typePattern is BoundTypePattern {
                if typePattern.HasBinding {
                    into.Add(typePattern.Variable)
                }
                if typePattern.PropertyPattern != nil {
                    Collect(typePattern.PropertyPattern, into)
                }
            }
            case propertyPattern is BoundPropertyPattern {
                for field in propertyPattern.Fields {
                    Collect(field.Pattern, into)
                }
            }
            case listPattern is BoundListPattern {
                for element in listPattern.Elements {
                    Collect(element, into)
                }
            }
            case slicePattern is BoundSlicePattern {
                if slicePattern.Variable != nil &&
                    (slicePattern.Syntax is SlicePatternSyntax and {CaptureIdentifier: not nil}) {
                    into.Add(slicePattern.Variable)
                }
                if slicePattern.Pattern != nil {
                    Collect(slicePattern.Pattern, into)
                }
            }
            case binaryPattern is BoundBinaryPattern when binaryPattern.IsConjunction {
                Collect(binaryPattern.Left, into)
                Collect(binaryPattern.Right, into)
            }
            case notPattern is BoundNotPattern {
                Collect(notPattern.Pattern, into)
            }
            default { }
        }
    }

    private func Union(a ImmutableArray[LocalVariableSymbol], b ImmutableArray[LocalVariableSymbol]) ImmutableArray[
        LocalVariableSymbol
    ] {
        if a.IsDefaultOrEmpty {
            return if b.IsDefault {
                ImmutableArray[LocalVariableSymbol].Empty
            } else {
                b
            }
        }
        if b.IsDefaultOrEmpty {
            return a
        }
        return a.AddRange(b)
    }

    private func Intersect(a ImmutableArray[LocalVariableSymbol], b ImmutableArray[LocalVariableSymbol]) ImmutableArray[
        LocalVariableSymbol
    ] {
        if a.IsDefaultOrEmpty || b.IsDefaultOrEmpty {
            return ImmutableArray[LocalVariableSymbol].Empty
        }
        let set = HashSet[LocalVariableSymbol](b)
        let builder = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
        for variable in a {
            if set.Contains(variable) {
                builder.Add(variable)
            }
        }
        return builder.ToImmutable()
    }
}
