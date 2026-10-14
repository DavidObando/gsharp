// <copyright file="RewriterClonePreservationAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading

/// Flags a `BoundTreeRewriter` override that reconstructs its node while
/// reading fewer of the node's members than the base rewriter reads.
/// @remarks Bound nodes are discriminated unions over their constructors: a member that
/// one construction form omits (`InterfaceType` for an interface static
/// field access, `TargetExpression` for a narrowed index target,
/// `NarrowedType` for a smart-cast field read) is <em>silently</em> lost
/// when a rewriter rebuilds the node through a constructor that does not take
/// it. The result is not a failure at the rewrite site but a mis-parented
/// member reference much later, in the emitter.
///
/// `BoundTreeRewriter`'s own implementations branch on the discriminator
/// and reconstruct through the matching constructor. An override that
/// reconstructs the same node type therefore has to read at least the members
/// the base reads — if it does not, it is dropping one. That is the exact shape
/// of issues #1644 and #3333, which between them cost three miscompiles no test
/// caught, because a non-generic interface happens to resolve correctly either
/// way.
///
/// The check is deliberately a subset test rather than a constructor-matching
/// test: it needs no model of which constructor carries which member, it names
/// the dropped member, and it stays quiet for an override that only delegates
/// to `base` or returns the node unchanged. Reads reached through a helper
/// that takes the node are followed one level, so extracting a recurring union
/// invariant into a helper (as `Lowering/BoundNodeForm.cs` does) does not
/// trip it.
@GSharpDiagnosticAnalyzer
class RewriterClonePreservationAnalyzer : GSharpDiagnosticAnalyzer {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _supportedDiagnostics ImmutableArray[DiagnosticDescriptor] = ImmutableArray.Create(
        DiagnosticDescriptors.RewriterCloneDropsMember
    )

    override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> _supportedDiagnostics

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Initialize(context AnalysisContext) {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None)
        context.EnableConcurrentExecution()
        context.RegisterSyntaxNodeAction(AnalyzeMethod, SyntaxKind.FunctionDeclaration)
    }

    shared {
        private const RewriterBaseTypeName string = "BoundTreeRewriter"

        private func AnalyzeMethod(context SyntaxNodeAnalysisContext) {
            let declaration = cast[FunctionDeclarationSyntax](context.Node)
            if !declaration.IsOverride || declaration.Parameters.Count != 1 {
                return
            }
            if context.SemanticModel.GetDeclaredSymbol(
                declaration,
                context.CancellationToken
            ) is not FunctionSymbol method ||
                method
                .Parameters
                .Length != 1 ||
                RewriterBase(method.ContainingType?.BaseType) == nil {
                return
            }
            // Compare against the declaration on BoundTreeRewriter itself, not an
            // intermediate override: the base is the reference implementation.
            let root FunctionSymbol? = RootOverride(method)
            if root == nil || root.ContainingType?.Name != RewriterBaseTypeName {
                return
            }
            let baseDeclaration FunctionDeclarationSyntax? = SourceDeclaration(root, context.CancellationToken)
            if baseDeclaration == nil || baseDeclaration.Parameters.Count != 1 {
                // The base is in metadata, not source: nothing to compare against.
                return
            }
            let nodeType = method.Parameters[0].Type
            if !Rebuilds(declaration, nodeType.Name) {
                return
            }
            // The base's own reads are collected syntactically -- it reads members
            // off the node directly, so no symbol resolution is needed there.
            let baseReads = CollectReads(
                baseDeclaration,
                baseDeclaration.Parameters[0].Identifier!!.Text,
                model: nil,
                context.CancellationToken
            )
            // `var rewritten = (BoundX)base.RewriteX(node);` makes `rewritten` the
            // node's stand-in for the rest of the method, so reads off it count.
            let parameterName = declaration.Parameters[0].Identifier!!.Text
            let overrideReads = HashSet[string](StringComparer.Ordinal)
            for name in Aliases(declaration, parameterName) {
                for read in CollectReads(declaration, name, context.SemanticModel, context.CancellationToken) {
                    overrideReads.Add(read)
                }
            }
            // Only a member some construction form omits can be dropped silently.
            // A member every constructor requires cannot be: an override that does
            // not pass it is replacing the node with a different shape, which is a
            // visible design choice rather than a clone losing information.
            let formDependent = FormDependentMembers(nodeType)
            let dropped = baseReads
                .Where((name string) -> !overrideReads.Contains(name) && formDependent.Contains(name))
                .OrderBy((name string) -> name, StringComparer.Ordinal)
                .ToList()
            if dropped.Count == 0 {
                return
            }
            context.ReportDiagnostic(
                Diagnostic.Create(
                    DiagnosticDescriptors.RewriterCloneDropsMember,
                    declaration.Identifier.Location,
                    (method.ContainingType?.Name ?? "<unknown>") + "." + method.Name,
                    nodeType.Name,
                    string.Join(", node.", dropped),
                    root.Name
                )
            )
        }

        /// The members of [`nodeType`](paramref) that depend on which
        /// construction form was used: a member some constructor or factory takes
        /// and another omits, or one whose parameter is optional. Those are exactly
        /// the members a rebuild can drop without the compiler noticing.
        private func FormDependentMembers(nodeType TypeSymbol) HashSet[string] {
            let forms = nodeType
                .GetMembers()
                .Concat(nodeType.GetConstructors())
                .OfType[FunctionSymbol]()
                .Where(
                (candidate FunctionSymbol) -> candidate.Name == ".ctor" ||
                    (
                    candidate.IsStatic && candidate.Name != ".ctor" && SymbolEqualityComparer.Default.Equals(
                        candidate.Type,
                        nodeType
                    )
                )
            )
                .ToList()
            let dependent = HashSet[string](StringComparer.Ordinal)
            if forms.Count == 0 {
                return dependent
            }
            for member in nodeType.GetMembers().OfType[PropertySymbol]() {
                var omitted = false
                var taken = false
                var optional = false
                for form in forms {
                    let parameter ParameterSymbol? = form.Parameters.FirstOrDefault(
                        (candidate ParameterSymbol) -> string.Equals(
                            candidate.Name,
                            member.Name,
                            StringComparison.OrdinalIgnoreCase
                        )
                    )
                    if parameter == nil {
                        omitted = true
                    } else {
                        taken = true
                        optional |= parameter.HasExplicitDefaultValue
                    }
                }
                if taken && (omitted || optional) {
                    dependent.Add(member.Name)
                }
            }
            return dependent
        }

        /// The node parameter plus every local that stands in for it — a local
        /// initialized from `base.RewriteX(node)`, which is the idiomatic way
        /// to rewrite the children first and then inspect the result.
        private func Aliases(declaration FunctionDeclarationSyntax, parameterName string) IEnumerable[string] {
            let names = HashSet[string](StringComparer.Ordinal){parameterName}
            for declarator in declaration.DescendantNodes().OfType[VariableDeclarationSyntax]() {
                let initializer ExpressionSyntax? = declarator.Initializer
                if initializer == nil {
                    continue
                }
                for invocation in initializer.DescendantNodesAndSelf().OfType[CallExpressionSyntax]() {
                    if invocation.Parent is BaseClassCallExpressionSyntax && invocation.Arguments.Any(
                        (argument ExpressionSyntax) -> argument is NameExpressionSyntax identifier &&
                            identifier
                            .GetLastToken().Text == parameterName
                    ) {
                        names.Add(declarator.Identifier.Text)
                        break
                    }
                }
            }
            // `rewritten is BoundX narrowed` re-binds the same node under a new
            // name; two passes reach the pattern variables of pattern variables,
            // which is as deep as the rewriters go.
            for var pass = 0; pass < 2; pass++ {
                for pattern in declaration.DescendantNodes().OfType[IsExpressionSyntax]() {
                    if pattern.Expression is not NameExpressionSyntax source || !names.Contains(
                        source.GetLastToken().Text
                    ) {
                        continue
                    }
                    for designation in pattern
                        .Pattern
                        .DescendantNodesAndSelf()
                        .OfType[PatternSyntax]()
                        .Where((pattern PatternSyntax) -> pattern.BindingIdentifier != nil) {
                        names.Add(designation.BindingIdentifier!!.Text)
                    }
                }
            }
            return names
        }

        private func RewriterBase(type TypeSymbol?) TypeSymbol? {
            for var current TypeSymbol? = type; current != nil; current = current!!.BaseType {
                if current.Name == RewriterBaseTypeName {
                    return current
                }
            }
            return nil
        }

        private func RootOverride(method FunctionSymbol) FunctionSymbol? {
            var current = method.OverriddenMethod
            while current?.OverriddenMethod != nil {
                current = current!!.OverriddenMethod
            }
            return current
        }

        private func SourceDeclaration(
            method FunctionSymbol,
            cancellationToken CancellationToken
        ) FunctionDeclarationSyntax? {
            for reference in method.DeclaringSyntaxNodes {
                if reference is FunctionDeclarationSyntax declaration {
                    return declaration
                }
            }
            return nil
        }

        /// Whether the method constructs a value of the node's own type, either
        /// with `new` or through a static factory declared on that type.
        private func Rebuilds(declaration FunctionDeclarationSyntax, nodeTypeName string) bool {
            for node in declaration.DescendantNodes() {
                switch node {
                    case creation is CallExpressionSyntax when creation.Identifier.Text == nodeTypeName {
                        return true
                    }
                    case CallExpressionSyntax{
                        Parent: AccessorExpressionSyntax{IsNullConditional: false} access
                    } when access.LeftPart is NameExpressionSyntax owner &&
                        owner
                        .GetLastToken().Text == nodeTypeName {
                        return true
                    }
                }
            }
            return false
        }

        private func TypeNameOf(type TypeClauseSyntax) string? -> if type.NameIdentifier != nil {
            type.NameIdentifier!!.Text
        } else {
            nil
        }

        /// Every member name read off [`parameterName`](paramref). When
        /// [`model`](paramref) is supplied, a call that passes the parameter
        /// on to a helper is followed one level, so reads inside the helper count.
        private func CollectReads(
            declaration FunctionDeclarationSyntax,
            parameterName string,
            model SemanticModel?,
            cancellationToken CancellationToken
        ) HashSet[string] {
            let reads = HashSet[string](StringComparer.Ordinal)
            for node in declaration.DescendantNodes() {
                switch node {
                    case access is AccessorExpressionSyntax{
                        IsNullConditional: false
                    } when access.LeftPart is NameExpressionSyntax target &&
                        target
                        .GetLastToken().Text == parameterName {
                        reads.Add(access.RightPart.GetLastToken().Text)
                    }
                    case pattern is IsExpressionSyntax when pattern.Expression is NameExpressionSyntax target &&
                        target
                        .GetLastToken().Text == parameterName {
                        AddPatternMembers(pattern.Pattern, reads)
                    }
                    case switchStatement is SwitchStatementSyntax when switchStatement.Expression is NameExpressionSyntax target &&
                        target
                        .GetLastToken().Text == parameterName {
                        for label in switchStatement.Cases.Where(
                            (switchCase SwitchCaseSyntax) -> !switchCase.IsDefault &&
                                (switchCase.Guard != nil || switchCase.Value is not ConstantPatternSyntax)
                        ) {
                            AddPatternMembers(label.Value!!, reads)
                        }
                    }
                    case invocation is CallExpressionSyntax when model != nil {
                        FollowHelper(invocation, parameterName, model!!, reads, cancellationToken)
                    }
                }
            }
            return reads
        }

        private func AddPatternMembers(pattern PatternSyntax, reads HashSet[string]) {
            for subpattern in pattern.DescendantNodesAndSelf().OfType[PropertyPatternFieldSyntax]() {
                if subpattern.Identifier is SyntaxToken name {
                    reads.Add(name.Text)
                }
            }
        }

        /// Unions in the members a helper reads off the parameter it was handed.
        /// Only one level deep, and only through the model for the tree being
        /// analyzed -- the helper's body is then read syntactically.
        private func FollowHelper(
            invocation CallExpressionSyntax,
            parameterName string,
            model SemanticModel,
            reads HashSet[string],
            cancellationToken CancellationToken
        ) {
            // `base.RewriteX(node)` is not a helper: delegating on one path does not
            // excuse dropping a member on the path that rebuilds.
            if invocation.Parent is BaseClassCallExpressionSyntax {
                return
            }
            let arguments = invocation.Arguments
            var index = -1
            for var i = 0; i < arguments.Count; i++ {
                if arguments[i] is NameExpressionSyntax argument && argument.GetLastToken().Text == parameterName {
                    index = i
                    break
                }
            }
            if index < 0 || model.GetSymbolInfo(invocation, cancellationToken)
                .Symbol is not FunctionSymbol target ||
                index >= target
                .Parameters
                .Length {
                return
            }
            let helper FunctionDeclarationSyntax? = SourceDeclaration(target, cancellationToken)
            if helper == nil || helper.Parameters.Count <= index {
                return
            }
            for read in CollectReads(
                helper,
                helper.Parameters[index].Identifier!!.Text,
                model: nil,
                cancellationToken
            ) {
                reads.Add(read)
            }
        }
    }
}
