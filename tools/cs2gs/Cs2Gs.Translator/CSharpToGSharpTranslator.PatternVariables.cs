// <copyright file="CSharpToGSharpTranslator.PatternVariables.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    /// <summary>
    /// ADR-0166 / issue #3409: native G# pattern variables. When every
    /// designation in a C# <c>is</c> pattern is expressible as a G# designation
    /// (<c>x is T t</c>, <c>x is { P: T t } u</c>, <c>x is [.. rest]</c>) and G#
    /// scopes each pattern variable to every region C# reads it in, the
    /// translator emits the pattern verbatim — no <c>if let</c>, no negated-guard
    /// hoist, no <c>__spillN</c> temporary, no <c>(x as T)!!</c> substitution.
    /// </summary>
    private sealed partial class DeclarationVisitor
    {
        /// <summary>
        /// The ADR-0166 native path for a binding or <c>var</c> <c>is</c> pattern. Returns
        /// <see langword="null"/> when the enclosing condition does not qualify,
        /// in which case the caller continues with the legacy lowering.
        /// </summary>
        private GExpression TryTranslateNativePatternVariables(IsPatternExpressionSyntax isPattern)
        {
            if (!PatternUsesNativeVariableSyntax(isPattern.Pattern)
                || !this.ConditionUsesNativePatternVariables(GetConditionRoot(isPattern)))
            {
                return null;
            }

            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            var binders = new List<ILocalSymbol>();

            // C# allows designations under a top-level `not` (`x is not T t`)
            // and assigns them when the whole test is FALSE; G# rejects bindings
            // under `not` (GS0390) but scopes them identically through `!`, so
            // the shape lowers to `!(x is T t)`.
            PatternSyntax pattern = StripTopLevelNegation(isPattern.Pattern, out bool negated);
            GPattern native = this.BuildNativePattern(pattern, binders);
            foreach (ILocalSymbol binder in binders)
            {
                this.state.PatternBindings[binder] = new IdentifierExpression(SanitizeIdentifier(binder.Name));
                this.state.NativePatternVariables.Add(binder);
            }

            GExpression test = new PatternTestExpression(receiver, native);
            return negated
                ? new UnaryExpression("!", new ParenthesizedExpression(test))
                : test;
        }

        /// <summary>
        /// True when <paramref name="condition"/> contains at least one binding
        /// <c>is</c> pattern and every binding <c>is</c> pattern in it qualifies
        /// for the ADR-0166 native path. Conditions are all-or-nothing: the
        /// legacy <c>if let</c> / guard-hoist lowerings rewrite the whole
        /// condition and would not scope a native pattern variable into the
        /// bodies they synthesize.
        /// </summary>
        private bool ConditionUsesNativePatternVariables(ExpressionSyntax condition)
        {
            if (condition == null)
            {
                return false;
            }

            if (this.state.NativePatternConditionCache.TryGetValue(condition, out bool cached))
            {
                return cached;
            }

            bool any = false;
            bool all = true;
            foreach (IsPatternExpressionSyntax isPattern in condition
                .DescendantNodesAndSelf(node => node is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
                .OfType<IsPatternExpressionSyntax>())
            {
                if (!PatternUsesNativeVariableSyntax(isPattern.Pattern))
                {
                    continue;
                }

                any = true;
                if (!this.IsPatternQualifiesForNativeVariables(isPattern))
                {
                    all = false;
                    break;
                }
            }

            bool result = any && all;
            this.state.NativePatternConditionCache[condition] = result;
            return result;
        }

        private static bool PatternUsesNativeVariableSyntax(PatternSyntax pattern)
            => PatternIntroducesBinding(pattern)
            || pattern.DescendantNodesAndSelf()
                .OfType<VarPatternSyntax>()
                .Any(varPattern => varPattern.Designation is SingleVariableDesignationSyntax or DiscardDesignationSyntax);

        /// <summary>
        /// The outermost boolean context an <c>is</c> pattern participates in:
        /// the chain of parentheses, <c>!</c>, <c>&amp;&amp;</c>, and <c>||</c>
        /// above it. The dispatchers ask about this same node, so the native
        /// decision is consistent between the statement/expression lowering and
        /// the pattern itself.
        /// </summary>
        private static ExpressionSyntax GetConditionRoot(ExpressionSyntax node)
        {
            ExpressionSyntax root = node;
            while (true)
            {
                switch (root.Parent)
                {
                    case ParenthesizedExpressionSyntax parenthesized:
                        root = parenthesized;
                        continue;
                    case PrefixUnaryExpressionSyntax prefix when prefix.IsKind(SyntaxKind.LogicalNotExpression):
                        root = prefix;
                        continue;
                    case BinaryExpressionSyntax binary
                        when binary.IsKind(SyntaxKind.LogicalAndExpression) || binary.IsKind(SyntaxKind.LogicalOrExpression):
                        root = binary;
                        continue;
                    default:
                        return root;
                }
            }
        }

        private bool IsPatternQualifiesForNativeVariables(IsPatternExpressionSyntax isPattern)
        {
            if (!IsNativelyExpressiblePattern(isPattern.Pattern, topLevel: true))
            {
                return false;
            }

            List<SyntaxNode> regions = ComputeNativePatternVariableRegions(isPattern);
            SyntaxNode scope = this.state.CurrentBodyScope
                ?? isPattern.Ancestors().OfType<MemberDeclarationSyntax>().FirstOrDefault()
                ?? isPattern.SyntaxTree.GetRoot();

            foreach (SingleVariableDesignationSyntax designation in
                isPattern.Pattern.DescendantNodesAndSelf().OfType<SingleVariableDesignationSyntax>())
            {
                if (this.context.GetDeclaredSymbol(designation) is not ILocalSymbol local
                    || local.Type == null
                    || local.Type.TypeKind == TypeKind.Error
                    || local.Type.IsRefLikeType
                    || CSharpTypeMapper.IsSystemIndexOrRange(local.Type))
                {
                    return false;
                }

                // G# pattern variables are `let`-immutable.
                if (this.IsSymbolReassigned(local, scope))
                {
                    return false;
                }

                foreach (IdentifierNameSyntax identifier in scope.DescendantNodes().OfType<IdentifierNameSyntax>())
                {
                    if (identifier.Identifier.Text != local.Name
                        || !SymbolEqualityComparer.Default.Equals(this.context.GetSymbolInfo(identifier).Symbol, local))
                    {
                        continue;
                    }

                    if (!regions.Any(region => region.Span.Contains(identifier.Span)))
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        /// <summary>
        /// The syntax regions in which G# scopes the pattern variables of
        /// <paramref name="isPattern"/> — the mirror of the compiler's
        /// <c>PatternVariables</c> classifier and <c>BindIfStatement</c> leak rule:
        /// the right operand of an enclosing <c>&amp;&amp;</c> (of <c>||</c> under
        /// negation), the branch a condition selects, the loop body, the guarded
        /// switch arm, and the statements after an <c>if</c> whose other branch
        /// always exits.
        /// </summary>
        private static List<SyntaxNode> ComputeNativePatternVariableRegions(IsPatternExpressionSyntax isPattern)
        {
            // `x is not T t` assigns `t` when the whole test is FALSE.
            StripTopLevelNegation(isPattern.Pattern, out bool negated);
            return ComputePatternFlowRegions(isPattern, whenTrue: !negated);
        }

        private static List<SyntaxNode> ComputePatternFlowRegions(
            IsPatternExpressionSyntax isPattern,
            bool whenTrue,
            bool includeWhenClauseRegion = true) =>
            ComputeBooleanFlowRegions(isPattern, whenTrue, includeWhenClauseRegion);

        private static List<SyntaxNode> ComputeBooleanFlowRegions(
            ExpressionSyntax condition,
            bool whenTrue,
            bool includeWhenClauseRegion = true)
        {
            var regions = new List<SyntaxNode>();
            SyntaxNode node = condition;

            while (true)
            {
                SyntaxNode parent = node.Parent;
                switch (parent)
                {
                    case ParenthesizedExpressionSyntax:
                        node = parent;
                        continue;

                    case PrefixUnaryExpressionSyntax prefix when prefix.IsKind(SyntaxKind.LogicalNotExpression):
                        whenTrue = !whenTrue;
                        node = parent;
                        continue;

                    case BinaryExpressionSyntax binary when binary.IsKind(SyntaxKind.LogicalAndExpression):
                        if (!whenTrue)
                        {
                            return regions;
                        }

                        if (binary.Left == node)
                        {
                            regions.Add(binary.Right);
                        }

                        node = parent;
                        continue;

                    case BinaryExpressionSyntax binary when binary.IsKind(SyntaxKind.LogicalOrExpression):
                        if (whenTrue)
                        {
                            return regions;
                        }

                        if (binary.Left == node)
                        {
                            regions.Add(binary.Right);
                        }

                        node = parent;
                        continue;

                    case ConditionalExpressionSyntax conditional when conditional.Condition == node:
                        regions.Add(whenTrue ? conditional.WhenTrue : conditional.WhenFalse);
                        return regions;

                    case IfStatementSyntax ifStatement when ifStatement.Condition == node:
                        {
                            if (whenTrue)
                            {
                                regions.Add(ifStatement.Statement);
                            }
                            else if (ifStatement.Else != null)
                            {
                                regions.Add(ifStatement.Else.Statement);
                            }

                            bool leaks = whenTrue
                                ? ifStatement.Else != null && StatementAlwaysExits(ifStatement.Else.Statement)
                                : StatementAlwaysExits(ifStatement.Statement);
                            if (leaks)
                            {
                                AddFollowingStatements(ifStatement, regions);
                            }

                            return regions;
                        }

                    case WhileStatementSyntax whileStatement when whileStatement.Condition == node:
                        if (whenTrue)
                        {
                            regions.Add(whileStatement.Statement);
                        }

                        return regions;

                    case ForStatementSyntax forStatement when forStatement.Condition == node:
                        if (whenTrue)
                        {
                            regions.Add(forStatement.Statement);
                        }

                        return regions;

                    case WhenClauseSyntax whenClause:
                        if (whenTrue && includeWhenClauseRegion)
                        {
                            if (whenClause.Parent is CasePatternSwitchLabelSyntax { Parent: SwitchSectionSyntax section })
                            {
                                regions.AddRange(section.Statements);
                            }
                            else if (whenClause.Parent is SwitchExpressionArmSyntax arm)
                            {
                                regions.Add(arm.Expression);
                            }
                        }

                        return regions;

                    default:
                        return regions;
                }
            }
        }

        private static bool TryGetPatternNonNullPolarity(
            PatternSyntax pattern,
            out bool whenTrue)
        {
            switch (pattern)
            {
                case ParenthesizedPatternSyntax parenthesized:
                    return TryGetPatternNonNullPolarity(parenthesized.Pattern, out whenTrue);

                case UnaryPatternSyntax unary when unary.OperatorToken.IsKind(SyntaxKind.NotKeyword):
                    if (TryGetPatternNonNullPolarity(unary.Pattern, out whenTrue))
                    {
                        whenTrue = !whenTrue;
                        return true;
                    }

                    break;

                case ConstantPatternSyntax constant when IsNullLiteral(constant.Expression):
                    whenTrue = false;
                    return true;

                case BinaryPatternSyntax binary when binary.OperatorToken.IsKind(SyntaxKind.AndKeyword):
                    {
                        bool leftKnown = TryGetPatternNonNullPolarity(binary.Left, out bool leftWhenTrue);
                        bool rightKnown = TryGetPatternNonNullPolarity(binary.Right, out bool rightWhenTrue);
                        if ((leftKnown && leftWhenTrue) || (rightKnown && rightWhenTrue))
                        {
                            whenTrue = true;
                            return true;
                        }

                        if (leftKnown && rightKnown && !leftWhenTrue && !rightWhenTrue)
                        {
                            whenTrue = false;
                            return true;
                        }

                        break;
                    }

                case BinaryPatternSyntax binary when binary.OperatorToken.IsKind(SyntaxKind.OrKeyword):
                    {
                        bool leftKnown = TryGetPatternNonNullPolarity(binary.Left, out bool leftWhenTrue);
                        bool rightKnown = TryGetPatternNonNullPolarity(binary.Right, out bool rightWhenTrue);
                        if ((leftKnown && !leftWhenTrue) || (rightKnown && !rightWhenTrue))
                        {
                            whenTrue = false;
                            return true;
                        }

                        if (leftKnown && rightKnown && leftWhenTrue && rightWhenTrue)
                        {
                            whenTrue = true;
                            return true;
                        }

                        break;
                    }

                case VarPatternSyntax:
                case DiscardPatternSyntax:
                    break;

                case ConstantPatternSyntax:
                case RelationalPatternSyntax:
                case TypePatternSyntax:
                case DeclarationPatternSyntax:
                case RecursivePatternSyntax:
                case ListPatternSyntax:
                    whenTrue = true;
                    return true;
            }

            whenTrue = false;
            return false;
        }

        // Peels parentheses and top-level `not` layers off a pattern, reporting
        // whether an odd number of negations remained: designations under such a
        // `not` are assigned when the enclosing test evaluates to false.
        private static PatternSyntax StripTopLevelNegation(PatternSyntax pattern, out bool negated)
        {
            negated = false;
            while (true)
            {
                if (pattern is ParenthesizedPatternSyntax parenthesized)
                {
                    pattern = parenthesized.Pattern;
                    continue;
                }

                if (pattern is UnaryPatternSyntax unary && unary.OperatorToken.IsKind(SyntaxKind.NotKeyword))
                {
                    negated = !negated;
                    pattern = unary.Pattern;
                    continue;
                }

                return pattern;
            }
        }

        // The statements after `ifStatement` in its enclosing statement list.
        // Only a direct child of a block (or switch section) leaks in G#; an
        // `else if` never does, because the outer condition's other path
        // reaches the following statements without the match.
        private static void AddFollowingStatements(IfStatementSyntax ifStatement, List<SyntaxNode> regions)
        {
            SyntaxList<StatementSyntax> statements;
            switch (ifStatement.Parent)
            {
                case BlockSyntax block:
                    statements = block.Statements;
                    break;
                case SwitchSectionSyntax section:
                    statements = section.Statements;
                    break;
                default:
                    return;
            }

            bool after = false;
            foreach (StatementSyntax statement in statements)
            {
                if (after)
                {
                    regions.Add(statement);
                }
                else if (statement == ifStatement)
                {
                    after = true;
                }
            }
        }

        /// <summary>
        /// Structural mirror of <see cref="BuildNativePattern"/>: true when the
        /// pattern maps onto G# pattern grammar with designations and no
        /// translator-side substitution (scalar <c>var</c> designations do;
        /// positional clauses, whole-list designations, and tuple designations do not).
        /// </summary>
        private bool IsNativelyExpressiblePattern(PatternSyntax pattern, bool topLevel)
        {
            switch (pattern)
            {
                case ConstantPatternSyntax:
                case RelationalPatternSyntax:
                case DiscardPatternSyntax:
                case TypePatternSyntax:
                    return true;

                case DeclarationPatternSyntax declaration:
                    return declaration.Designation is SingleVariableDesignationSyntax or DiscardDesignationSyntax;

                case VarPatternSyntax varPattern:
                    return varPattern.Designation is SingleVariableDesignationSyntax or DiscardDesignationSyntax;

                case RecursivePatternSyntax recursive:
                    if (recursive.PositionalPatternClause != null
                        || recursive.Designation is ParenthesizedVariableDesignationSyntax)
                    {
                        return false;
                    }

                    if (recursive.PropertyPatternClause != null)
                    {
                        var directRoots = new HashSet<string>(System.StringComparer.Ordinal);
                        var extendedRoots = new HashSet<string>(System.StringComparer.Ordinal);
                        var extendedTrees = new Dictionary<string, ExtendedPropertyFieldTree>(System.StringComparer.Ordinal);
                        foreach (SubpatternSyntax sub in recursive.PropertyPatternClause.Subpatterns)
                        {
                            if (!this.IsNativelyExpressiblePattern(sub.Pattern, topLevel: false))
                            {
                                return false;
                            }

                            if (sub.NameColon != null)
                            {
                                directRoots.Add(SanitizeIdentifier(this.GetSubpatternMemberName(sub)));
                                continue;
                            }

                            if (sub.ExpressionColon == null)
                            {
                                return false;
                            }

                            List<string> names = SplitMemberPath(sub.ExpressionColon.Expression);
                            string rootName = SanitizeIdentifier(names[0]);
                            extendedRoots.Add(rootName);
                            if (!extendedTrees.TryGetValue(rootName, out ExtendedPropertyFieldTree tree))
                            {
                                tree = new ExtendedPropertyFieldTree();
                                extendedTrees[rootName] = tree;
                            }

                            tree.Insert(names, 1, sub.Pattern);
                            if (tree.HasCollision)
                            {
                                return false;
                            }
                        }

                        if (directRoots.Overlaps(extendedRoots))
                        {
                            return false;
                        }
                    }

                    return true;

                case UnaryPatternSyntax unary when unary.OperatorToken.IsKind(SyntaxKind.NotKeyword):
                    // A designation under `not` is only assignable when the whole
                    // test is negated at the top (`x is not T t`), which
                    // TryTranslateNativePatternVariables lowers to `!(x is T t)`.
                    return topLevel
                        ? IsNativelyExpressiblePattern(unary.Pattern, topLevel: true)
                        : !PatternIntroducesBinding(unary.Pattern) && IsNativelyExpressiblePattern(unary.Pattern, topLevel: false);

                case ParenthesizedPatternSyntax parenthesized:
                    return IsNativelyExpressiblePattern(parenthesized.Pattern, topLevel);

                case BinaryPatternSyntax binary
                    when binary.OperatorToken.IsKind(SyntaxKind.AndKeyword) || binary.OperatorToken.IsKind(SyntaxKind.OrKeyword):
                    if (binary.OperatorToken.IsKind(SyntaxKind.OrKeyword) && PatternIntroducesBinding(binary))
                    {
                        return false;
                    }

                    return IsNativelyExpressiblePattern(binary.Left, topLevel: false)
                        && IsNativelyExpressiblePattern(binary.Right, topLevel: false);

                case ListPatternSyntax list:
                    if (list.Designation != null)
                    {
                        return false;
                    }

                    foreach (PatternSyntax element in list.Patterns)
                    {
                        if (element is SlicePatternSyntax slice)
                        {
                            if (slice.Pattern is null
                                or VarPatternSyntax { Designation: SingleVariableDesignationSyntax or DiscardDesignationSyntax }
                                or DeclarationPatternSyntax { Designation: SingleVariableDesignationSyntax or DiscardDesignationSyntax })
                            {
                                continue;
                            }

                            return false;
                        }

                        if (!IsNativelyExpressiblePattern(element, topLevel: false))
                        {
                            return false;
                        }
                    }

                    return true;

                default:
                    return false;
            }
        }

        /// <summary>
        /// Builds the G# pattern for a natively expressible C# pattern (see
        /// <see cref="IsNativelyExpressiblePattern"/>), collecting the C# locals
        /// its designations declare so the caller can register them as
        /// identity substitutions.
        /// </summary>
        private GPattern BuildNativePattern(PatternSyntax pattern, List<ILocalSymbol> binders)
        {
            switch (pattern)
            {
                case ConstantPatternSyntax constant when this.IsTypeReferencePattern(constant.Expression):
                    return new TypePattern("_", this.MapTypeReferenceExpression(constant.Expression), designationAfterType: true);

                case ConstantPatternSyntax constant:
                    return new ConstantPattern(this.TranslateExpression(constant.Expression));

                case RelationalPatternSyntax relational:
                    return new RelationalPattern(relational.OperatorToken.Text, this.TranslateExpression(relational.Expression));

                case DiscardPatternSyntax:
                    return new DiscardPattern();

                case TypePatternSyntax typePattern:
                    return new TypePattern("_", this.MapTypeSyntax(typePattern.Type), designationAfterType: true);

                case DeclarationPatternSyntax declaration:
                    return new TypePattern(
                        this.NativeDesignator(declaration.Designation, binders),
                        this.MapTypeSyntax(declaration.Type),
                        designationAfterType: true);

                case VarPatternSyntax varPattern:
                    return new VarPattern(this.NativeDesignator(varPattern.Designation, binders));

                case RecursivePatternSyntax recursive:
                    {
                        List<PropertyPatternField> fields = this.BuildNativePropertyFields(recursive, binders);

                        string designator = this.NativeDesignator(recursive.Designation, binders);
                        if (recursive.Type != null)
                        {
                            // `T { }` carries the type test's own non-nil check, and
                            // an empty suffix would read as the statement body in a
                            // G# `if` header, so it is dropped.
                            return new TypePattern(
                                designator,
                                this.MapTypeSyntax(recursive.Type),
                                fields.Count == 0 ? null : new PropertyPattern(fields),
                                designationAfterType: true);
                        }

                        return new PropertyPattern(fields, designator == "_" ? null : designator);
                    }

                case UnaryPatternSyntax unary when unary.OperatorToken.IsKind(SyntaxKind.NotKeyword):
                    return new NotPattern(this.BuildNativePattern(unary.Pattern, binders));

                case ParenthesizedPatternSyntax parenthesized:
                    return new ParenthesizedPattern(this.BuildNativePattern(parenthesized.Pattern, binders));

                case BinaryPatternSyntax binary:
                    return new BinaryPattern(
                        binary.OperatorToken.IsKind(SyntaxKind.AndKeyword),
                        this.BuildNativePattern(binary.Left, binders),
                        this.BuildNativePattern(binary.Right, binders));

                case ListPatternSyntax list:
                    {
                        var elements = new List<GPattern>(list.Patterns.Count);
                        foreach (PatternSyntax element in list.Patterns)
                        {
                            if (element is SlicePatternSyntax slice)
                            {
                                VariableDesignationSyntax sliceDesignation = slice.Pattern switch
                                {
                                    VarPatternSyntax varPattern => varPattern.Designation,
                                    DeclarationPatternSyntax declarationPattern => declarationPattern.Designation,
                                    _ => null,
                                };
                                string sliceDesignator = this.NativeDesignator(sliceDesignation, binders);
                                elements.Add(new SlicePattern(sliceDesignator == "_" ? null : sliceDesignator));
                                continue;
                            }

                            elements.Add(this.BuildNativePattern(element, binders));
                        }

                        return new ListPattern(elements);
                    }

                default:
                    this.context.ReportUnsupported(
                        pattern,
                        $"pattern '{pattern.Kind()}' has no canonical G# form yet (ADR-0115 §B).");
                    return new DiscardPattern();
            }
        }

        private List<PropertyPatternField> BuildNativePropertyFields(
            RecursivePatternSyntax recursive,
            List<ILocalSymbol> binders)
        {
            var fields = new List<PropertyPatternField>();
            if (recursive.PropertyPatternClause == null)
            {
                return fields;
            }

            var extendedTrees = new Dictionary<string, ExtendedPropertyFieldTree>(System.StringComparer.Ordinal);
            var extendedIndexes = new Dictionary<string, int>(System.StringComparer.Ordinal);
            foreach (SubpatternSyntax sub in recursive.PropertyPatternClause.Subpatterns)
            {
                if (sub.NameColon != null)
                {
                    fields.Add(new PropertyPatternField(
                        SanitizeIdentifier(this.GetSubpatternMemberName(sub)),
                        this.BuildNativePattern(sub.Pattern, binders)));
                    continue;
                }

                List<string> names = SplitMemberPath(sub.ExpressionColon.Expression);
                string rootName = SanitizeIdentifier(names[0]);
                if (!extendedTrees.TryGetValue(rootName, out ExtendedPropertyFieldTree tree))
                {
                    tree = new ExtendedPropertyFieldTree();
                    extendedTrees[rootName] = tree;
                    extendedIndexes[rootName] = fields.Count;
                    fields.Add(null);
                }

                tree.Insert(names, 1, sub.Pattern);
            }

            foreach (var pair in extendedTrees)
            {
                fields[extendedIndexes[pair.Key]] = new PropertyPatternField(
                    pair.Key,
                    new PropertyPattern(pair.Value.ConvertNativeChildren(this, binders)));
            }

            return fields;
        }

        // Records the local a designation declares and returns its sanitized G#
        // name; a discard or missing designation is `_`.
        private string NativeDesignator(VariableDesignationSyntax designation, List<ILocalSymbol> binders)
        {
            if (designation is SingleVariableDesignationSyntax single
                && this.context.GetDeclaredSymbol(single) is ILocalSymbol local)
            {
                binders.Add(local);
                return this.state.NativePatternVariableAliases.TryGetValue(local, out string alias)
                    ? alias
                    : SanitizeIdentifier(single.Identifier.Text);
            }

            return "_";
        }
    }
}
