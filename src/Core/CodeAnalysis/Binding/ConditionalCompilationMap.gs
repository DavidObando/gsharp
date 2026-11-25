package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable

/// Owns syntax-derived symbol environments and inclusion for one compilation.
internal class ConditionalCompilationMap {
    private let symbols ImmutableHashSet[string]
    private let trees Dictionary[SyntaxTree, TreeMap] = Dictionary[SyntaxTree, TreeMap]()

    internal init(symbols ImmutableHashSet[string]?) {
        this.symbols = (symbols ?? ImmutableHashSet[string].Empty).WithComparer(StringComparer.Ordinal)
    }

    private class Region {
        internal init(span TextSpan, symbols ImmutableHashSet[string], active bool) {
            Span = span
            Symbols = symbols
            Active = active
        }
        internal prop Span TextSpan {
            get;
        }
        internal prop Symbols ImmutableHashSet[string] {
            get;
        }
        internal prop Active bool {
            get;
        }
    }

    private class TreeMap {
        internal let Regions List[Region] = List[Region]()
        internal let Diagnostics DiagnosticBag = DiagnosticBag()
    }

    internal func IsActive(node SyntaxNode) bool -> FindRegion(node).Active

    internal func Filter[T SyntaxNode](nodes ImmutableArray[T]) ImmutableArray[T] {
        var result ImmutableArray[T].Builder? = nil
        for var i = 0; i < nodes.Length; i++ {
            if !IsActive(nodes[i]) {
                if result == nil {
                    result = ImmutableArray.CreateBuilder[T]()
                    result.AddRange(nodes, i)
                }
            } else {
                result?.Add(nodes[i])
            }
        }
        return result?.ToImmutable() ?? nodes
    }

    internal func SymbolsAt(node SyntaxNode?) ImmutableHashSet[string] ->
    if node == nil {
        symbols
    } else {
        FindRegion(node).Symbols
    }

    internal func Validate(tree SyntaxTree, diagnostics DiagnosticBag) {
        diagnostics.AddRange(GetTree(tree).Diagnostics)
    }

    private func FindRegion(node SyntaxNode) Region {
        let treeMap = GetTree(node.SyntaxTree)
        var result = treeMap.Regions[0]
        let span = node.Span
        for region in treeMap.Regions {
            if region.Span.Start <= span.Start &&
                region.Span.End >= span.End &&
                region.Span.Length <= result.Span.Length {
                result = region
            }
        }
        return result
    }

    private func GetTree(tree SyntaxTree) TreeMap {
        lock trees {
            if trees.TryGetValue(tree, out var cached) {
                return cached
            }
            let treeMap = TreeMap()
            let pending = Stack[(Node SyntaxNode, Symbols ImmutableHashSet[string], Active bool)]()
            pending.Push((tree.Root, symbols, true))
            while pending.Count > 0 {
                let (node, inherited, ancestorActive) = pending.Pop()
                let annotations = if node is CompilationUnitSyntax unit {
                    unit.FileAttributes
                } else {
                    DiagnosticSuppressionMap.GetAnnotations(node)
                }
                var active = ancestorActive
                var effective = inherited
                var count = 0
                let definitions = Dictionary[string, bool](StringComparer.Ordinal)
                for annotation in annotations {
                    if node is CompilationUnitSyntax &&
                        annotation.Target?.KindIdentifier.ValueText == "file" &&
                        !IsIntrinsic(annotation) {
                        treeMap.Diagnostics.ReportScopedSymbolInvalid(
                            annotation.Location,
                            "the file target accepts only DefineSymbol, UndefineSymbol and If"
                        )
                    }
                    if IsIf(annotation) {
                        count++
                        if count > 1 {
                            treeMap.Diagnostics.ReportConditionalInclusionInvalid(
                                annotation.Location,
                                "only one @If is allowed per owner"
                            )
                        }
                        if !IsAllowedOwner(node, annotation, inclusion: true) {
                            treeMap.Diagnostics.ReportConditionalInclusionInvalid(
                                annotation.Location,
                                "this target cannot be conditionally included"
                            )
                        }
                        if annotation.Arguments.Count != 1 || annotation.HasTypeArgumentList {
                            treeMap.Diagnostics.ReportConditionalInclusionInvalid(
                                annotation.Location,
                                "exactly one predicate is required"
                            )
                            active = false
                        } else {
                            // Validate both operands, including below an inactive ancestor.
                            let included = EvaluatePredicate(annotation.Arguments[0], inherited, treeMap.Diagnostics)
                            active = active && included
                        }
                    }
                }
                for annotation in annotations {
                    if !IsDefinition(annotation) || !active {
                        continue
                    }
                    if !IsAllowedOwner(node, annotation, inclusion: false) {
                        treeMap.Diagnostics.ReportScopedSymbolInvalid(
                            annotation.Location,
                            "this target cannot define or undefine symbols"
                        )
                        continue
                    }
                    if annotation.Arguments.Count == 0 || annotation.HasTypeArgumentList {
                        treeMap.Diagnostics.ReportScopedSymbolInvalid(
                            annotation.Location,
                            "one or more literal symbol names are required"
                        )
                    }
                    let defined = HasName(annotation, "DefineSymbol")
                    for argument in annotation.Arguments {
                        if !TryName(argument, out var name) {
                            treeMap.Diagnostics.ReportScopedSymbolInvalid(
                                argument.Location,
                                "a literal valid symbol name is required"
                            )
                            continue
                        }
                        if definitions.TryGetValue(name, out var previous) && previous != defined {
                            treeMap.Diagnostics.ReportScopedSymbolInvalid(
                                argument.Location,
                                "the same owner cannot define and undefine '" + name + "'"
                            )
                        }
                        definitions[name] = defined
                        effective = if defined {
                            effective.Add(name)
                        } else {
                            effective.Remove(name)
                        }
                    }
                }
                if node is CompilationUnitSyntax || !annotations.IsDefaultOrEmpty {
                    treeMap.Regions.Add(Region(node.Span, effective, active))
                }
                for var i = node.ChildCount - 1; i >= 0; i-- {
                    let child = node.GetChild(i)
                    if child is not(AnnotationSyntax or SyntaxToken) {
                        pending.Push((child, effective, active))
                    }
                }
            }
            trees[tree] = treeMap
            return treeMap
        }
    }

    shared {
        internal func HasName(annotation AnnotationSyntax, name string) bool ->
        annotation.NameSegments.Length == 1 &&
            (annotation.GetNameText() == name || annotation.GetNameText() == name + "Attribute")

        internal func IsIf(annotation AnnotationSyntax) bool -> HasName(annotation, "If")

        internal func IsDefinition(annotation AnnotationSyntax) bool ->
        HasName(annotation, "DefineSymbol") || HasName(annotation, "UndefineSymbol")

        internal func IsIntrinsic(annotation AnnotationSyntax) bool -> IsIf(annotation) || IsDefinition(annotation)

        private func IsAllowedOwner(node SyntaxNode, annotation AnnotationSyntax, inclusion bool) bool {
            if node is CompilationUnitSyntax {
                return annotation.Target?.KindIdentifier.ValueText == "file"
            }
            if annotation.Target != nil {
                return false
            }
            if node is ParameterSyntax or TypeParameterSyntax {
                return false
            }
            if node is EnumMemberSyntax {
                return inclusion
            }
            if node is PropertyAccessorSyntax or EventAccessorSyntax {
                return !inclusion
            }
            return node is MemberSyntax or
                FieldDeclarationSyntax or
                PropertyDeclarationSyntax or
                EventDeclarationSyntax or
                VariableDeclarationSyntax or
                BlockStatementSyntax
        }

        internal func TryName(expression ExpressionSyntax, out name string) bool {
            name = string.Empty
            if expression is LiteralExpressionSyntax{
                LiteralToken: {Kind: SyntaxKind.StringToken},
                Value: string value
            } &&
                ConditionalSymbols.IsValidName(value) {
                name = value
                return true
            }
            return false
        }

        internal func TryQuery(query DefinedExpressionSyntax, out name string) bool {
            name = string.Empty
            return query.Identifier.Text == "defined" &&
                query.Arguments.Count == 1 &&
                TryName(query.Arguments[0], out name)
        }

        private func EvaluatePredicate(
            expression ExpressionSyntax,
            symbols ImmutableHashSet[string],
            diagnostics DiagnosticBag
        ) bool {
            switch expression {
                case query is DefinedExpressionSyntax {
                    if TryQuery(query, out var name) {
                        return symbols.Contains(name)
                    }
                    diagnostics.ReportConditionalInclusionInvalid(
                        query.Location,
                        "@defined requires one literal valid symbol name"
                    )
                    return false
                }
                case literal is LiteralExpressionSyntax when literal.Value is bool {
                    return cast[bool](literal.Value)
                }
                case parens is ParenthesizedExpressionSyntax {
                    return EvaluatePredicate(parens.Expression, symbols, diagnostics)
                }
                case unary is UnaryExpressionSyntax when unary.OperatorToken.Kind == SyntaxKind.BangToken {
                    return !EvaluatePredicate(unary.Operand, symbols, diagnostics)
                }
                case binary is BinaryExpressionSyntax when binary
                    .OperatorToken
                    .Kind is SyntaxKind.AmpersandAmpersandToken or
                    SyntaxKind.PipePipeToken {
                    let left = EvaluatePredicate(binary.Left, symbols, diagnostics)
                    let right = EvaluatePredicate(binary.Right, symbols, diagnostics)
                    return if binary.OperatorToken.Kind == SyntaxKind.AmpersandAmpersandToken {
                        left && right
                    } else {
                        left || right
                    }
                }
                default {
                    diagnostics.ReportConditionalInclusionInvalid(
                        expression.Location,
                        "use @defined, booleans, !, &&, || and parentheses only"
                    )
                    return false
                }
            }
        }
    }
}
