package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Compilation
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
        internal init(node SyntaxNode, symbols ImmutableHashSet[string], active bool, order int32) {
            Span = node.Span
            Symbols = symbols
            Active = active
            OpenAtEnd = PrefixBindingContext.IsOpen(node)
            Order = order
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
        internal prop OpenAtEnd bool {
            get;
        }
        internal prop Order int32 {
            get;
        }
        internal prop Parent Region? {
            get;
            set;
        }
    }

    private class TreeMap {
        internal let Regions List[Region] = List[Region]()
        internal let Diagnostics DiagnosticBag = DiagnosticBag()
        internal var Root Region?

        internal func IndexRegions() {
            Root = Regions[0]
            Regions.Sort(
                (left Region, right Region) -> {
                    let start = left.Span.Start.CompareTo(right.Span.Start)
                    if start != 0 {
                        return start
                    }
                    let length = right.Span.Length.CompareTo(left.Span.Length)
                    return if length != 0 {
                        length
                    } else {
                        left.Order.CompareTo(right.Order)
                    }
                }
            )
            let parents = Stack[Region]()
            for region in Regions {
                while parents.Count > 0 && parents.Peek().Span.End < region.Span.End {
                    parents.Pop()
                }
                region.Parent = if parents.Count > 0 {
                    parents.Peek()
                } else {
                    nil
                }
                parents.Push(region)
            }
        }
    }

    internal func IsActive(node SyntaxNode) bool -> FindRegion(node).Active

    internal func IsActiveAt(tree SyntaxTree, position int32) bool -> FindRegion(tree, TextSpan(position, 0)).Active

    internal func SymbolsAt(tree SyntaxTree, position int32) ImmutableHashSet[string] ->
    FindRegion(tree, TextSpan(position, 0)).Symbols

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

    private func FindRegion(node SyntaxNode) Region -> FindRegion(node.SyntaxTree, node.Span)

    private func FindRegion(tree SyntaxTree, span TextSpan) Region {
        let treeMap = GetTree(tree)
        let root = treeMap.Root!!
        if treeMap.Regions.Count == 1 {
            CompilationMeasurements.Count("conditional.regions.probed")
            return root
        }
        var probes = 0
        var low = 0
        var high = treeMap.Regions.Count - 1
        var index = -1
        while low <= high {
            let middle = low + (high - low) / 2
            probes++
            if treeMap.Regions[middle].Span.Start <= span.Start {
                index = middle
                low = middle + 1
            } else {
                high = middle - 1
            }
        }
        var result = root
        var candidate = if index < 0 {
            nil
        } else {
            treeMap.Regions[index]
        }
        while candidate != nil {
            let region = candidate
            probes++
            if region.Span.Start <= span.Start &&
                (
                if span.Length == 0 {
                    region.Span.End > span.Start || (region.OpenAtEnd && region.Span.End == span.Start)
                } else {
                    region.Span.End >= span.End
                }
            ) &&
                region.Span.Length <= root.Span.Length {
                result = region
                break
            }
            candidate = region.Parent
        }
        CompilationMeasurements.Count("conditional.regions.probed", probes)
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
                var hasConditionalAnnotation = false
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
                        hasConditionalAnnotation = true
                        count++
                        if count > 1 {
                            treeMap.Diagnostics.ReportConditionalInclusionInvalid(
                                annotation.Location,
                                "only one @If is allowed per owner"
                            )
                        }
                        let allowed = IsAllowedOwner(node, annotation, inclusion: true)
                        if !allowed {
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
                            if allowed {
                                active = false
                            }
                        } else {
                            // Validate both operands, including below an inactive ancestor.
                            let included = EvaluatePredicate(annotation.Arguments[0], inherited, treeMap.Diagnostics)
                            if allowed {
                                active = active && included
                            }
                        }
                    }
                }
                for annotation in annotations {
                    if active &&
                        (
                        node is TupleDeconstructionStatementSyntax or
                            NamedDeconstructionStatementSyntax or
                            MultiAssignmentStatementSyntax or
                            PropertyAccessorSyntax or
                            EventAccessorSyntax
                    ) &&
                        !IsIntrinsic(annotation) {
                        treeMap.Diagnostics.ReportAnnotationsNotAllowedOnStatement(annotation.Location)
                    }
                    if !IsDefinition(annotation) {
                        continue
                    }
                    hasConditionalAnnotation = true
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
                        if active {
                            effective = if defined {
                                effective.Add(name)
                            } else {
                                effective.Remove(name)
                            }
                        }
                    }
                }
                if node is CompilationUnitSyntax || hasConditionalAnnotation {
                    treeMap.Regions.Add(Region(node, effective, active, treeMap.Regions.Count))
                }
                for var i = node.ChildCount - 1; i >= 0; i-- {
                    let child = node.GetChild(i)
                    if child is not(AnnotationSyntax or SyntaxToken) {
                        pending.Push((child, effective, active))
                    }
                }
            }
            treeMap.IndexRegions()
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
            if node is GlobalStatementSyntax globalStatement {
                return globalStatement.Statement is BlockStatementSyntax
            }
            if node is ImportSyntax or PackageSyntax {
                return false
            }
            if node is MultiAssignmentStatementSyntax multi {
                for target in multi.Targets {
                    if target is not MultiAssignmentDeclarationExpressionSyntax {
                        return false
                    }
                }
                return true
            }
            return node is MemberSyntax or
                FieldDeclarationSyntax or
                PropertyDeclarationSyntax or
                EventDeclarationSyntax or
                VariableDeclarationSyntax or
                TupleDeconstructionStatementSyntax or
                NamedDeconstructionStatementSyntax or
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
