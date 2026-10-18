// <copyright file="BoundSemantics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Linq
import System.Reflection

/// Issue #4989: the language server's one read of what the binder decided.
/// Hover, completion, signature help, navigation and semantic tokens ask this
/// accessor for the symbol a token refers to and for the type an expression
/// has, so they all report the bound tree rather than a type or member they
/// recompute from syntax.
/// @remarks The answers come from the compilation's ADR-0169
/// (cref:GSharp.Core.CodeAnalysis.SemanticModel), which indexes the bound
/// program by syntax. Each query returns `null` when the binder left no
/// answer (unbound or erroneous code, a token from a stale tree); callers then
/// fall back to their syntactic lookup.
///
/// A member-access chain such as `a.B.C()` parses right-nested and the
/// binder anchors only the outermost accessor, to the bound node of the final
/// member. The other segments are reached through that node's receiver chain:
/// segment `k` of `n` segments is `n - 1 - k` receivers down. A receiver read
/// carries the variable's flow type, so after `guard let s = store` the
/// receiver `s` is the declared `IStore`, never the type of a value assigned
/// on one branch.
shared class BoundSemantics {
    /// Gets the symbol the binder declared at, or resolved, [`token`](paramref).
    /// Imported CLR members are not reported here; see (cref:GetImportedMember).
    /// @param compilation The compilation the token's tree belongs to.
    /// @param token An identifier token.
    /// @returns The symbol, or null when the binder has no answer for the token.
    func GetSymbol(compilation Compilation?, token SyntaxToken?) Symbol? {
        let model = GetModel(compilation, token)
        if model == nil || token == nil {
            return nil
        }
        if model.GetDeclaredSymbol(token) is {} declared && declared.Name == token.Text {
            return declared
        }
        let node = FindReferencedNode(model, token)
        return if node == nil {
            default(Symbol?)
        } else {
            ReferencedSourceSymbol(node, token.Text)
        }
    }

    /// Gets the CLR member the binder bound [`token`](paramref) to when the
    /// token names an imported method or property.
    /// @param compilation The compilation the token's tree belongs to.
    /// @param token An identifier token naming a member or a call.
    /// @returns The bound member, or null when the token does not name an imported member.
    func GetImportedMember(compilation Compilation?, token SyntaxToken?) MemberInfo? {
        let model = GetModel(compilation, token)
        if model == nil || token == nil {
            return nil
        }
        let member MemberInfo? = switch FindReferencedNode(model, token) {
            case instanceCall is BoundImportedInstanceCallExpression: instanceCall.Method
            case staticCall is BoundImportedCallExpression: staticCall.Function?.Method
            case property is BoundClrPropertyAccessExpression: property.Member
            default: default(MemberInfo?)
        }
        return if member != nil && member.Name == token.Text {
            member
        } else {
            default(MemberInfo?)
        }
    }

    /// Gets the type the binder gave [`expression`](paramref), including any
    /// flow narrowing in effect where it is read.
    /// @param compilation The compilation the expression's tree belongs to.
    /// @param expression An expression, typically the receiver of a member access.
    /// @returns The bound type, or null when the binder has no answer for the expression.
    func GetExpressionType(compilation Compilation?, expression ExpressionSyntax?) TypeSymbol? {
        let anchor SyntaxToken? = switch expression {
            case name is NameExpressionSyntax: name.IdentifierToken
            case call is CallExpressionSyntax: call.Identifier
            default: default(SyntaxToken?)
        }
        if expression == nil || compilation == nil {
            return nil
        }
        let model = GetModel(compilation, expression.SyntaxTree)
        if model == nil {
            return nil
        }
        let node = FindBoundExpression(model, expression)
        if node == nil {
            return nil
        }
        // A name or call segment must be the one the binder bound: a mismatch
        // means the chain walk landed on another segment.
        if anchor != nil && ReferencedSymbol(node) is {} referenced && referenced.Name != anchor.Text {
            return nil
        }
        return node.Type
    }

    /// Gets the semantic model of [`token`](paramref)'s tree when that tree
    /// belongs to [`compilation`](paramref).
    private func GetModel(compilation Compilation?, token SyntaxToken?) GSharp.Core.CodeAnalysis.SemanticModel? {
        if compilation == nil || token == nil || token.Kind != SyntaxKind.IdentifierToken || token.IsMissing {
            return nil
        }
        return GetModel(compilation, token.SyntaxTree)
    }

    private func GetModel(compilation Compilation, tree SyntaxTree?) GSharp.Core.CodeAnalysis.SemanticModel? {
        if tree == nil {
            return nil
        }
        // Only the compilation's own tree instance is answered. A token from a
        // stale parse of the file keeps the callers' syntactic fallbacks until the
        // document is refreshed; mapping it here would cost a text comparison
        // and a token search per query.
        if !compilation.SyntaxTrees.Contains(tree) {
            return nil
        }
        try {
            // The model indexes the bound program lazily; binding it here keeps a
            // compilation that cannot be bound on the caller's fallback path
            // instead of throwing from the first query.
            let _ = compilation.BoundProgram
            return compilation.GetSemanticModel(tree)
        } catch (InvalidOperationException) {
            return nil
        }
    }

    /// Gets the expression whose identifier is [`token`](paramref): a name,
    /// or a call's callee name.
    private func ExpressionNamedBy(token SyntaxToken) ExpressionSyntax? {
        return switch token.Parent {
            case name is NameExpressionSyntax when object.ReferenceEquals(name.IdentifierToken, token): name
            case call is CallExpressionSyntax when object.ReferenceEquals(call.Identifier, token): call
            default: default(ExpressionSyntax?)
        }
    }

    private func FindReferencedNode(model GSharp.Core.CodeAnalysis.SemanticModel, token SyntaxToken) BoundExpression? {
        let expression = ExpressionNamedBy(token)
        return if expression == nil {
            default(BoundExpression?)
        } else {
            FindBoundExpression(model, expression)
        }
    }

    /// Finds the bound node for [`expression`](paramref). An expression that
    /// is a segment of a member-access chain is reached from the chain's
    /// anchored outermost accessor through the receiver chain.
    private func FindBoundExpression(
        model GSharp.Core.CodeAnalysis.SemanticModel,
        expression ExpressionSyntax
    ) BoundExpression? {
        var root ExpressionSyntax = expression
        while root.Parent is AccessorExpressionSyntax accessor &&
            (object.ReferenceEquals(accessor.LeftPart, root) || object.ReferenceEquals(accessor.RightPart, root)) {
            root = accessor
        }
        if object.ReferenceEquals(root, expression) {
            return Unwrap(model.GetBoundNode(expression) as BoundExpression)
        }
        let segments = List[ExpressionSyntax]()
        var current ExpressionSyntax = root
        while current is AccessorExpressionSyntax link {
            segments.Add(link.LeftPart)
            current = link.RightPart
        }
        segments.Add(current)
        var index = -1
        for var i = 0; i < segments.Count; i++ {
            if object.ReferenceEquals(segments[i], expression) {
                index = i
                break
            }
        }
        if index < 0 {
            return nil
        }
        var node BoundExpression? = Unwrap(model.GetBoundNode(root) as BoundExpression)
        for var depth = segments.Count - 1; depth > index && node != nil; depth-- {
            node = Unwrap(ReceiverOf(node))
        }
        return node
    }

    /// Gets the receiver of a bound member access or call, or null when it has
    /// none (a static member, or a node that is not a member access).
    private func ReceiverOf(node BoundExpression) BoundExpression? -> switch node {
        case userCall is BoundUserInstanceCallExpression: userCall.Receiver
        case importedCall is BoundImportedInstanceCallExpression: importedCall.Receiver
        case property is BoundPropertyReferenceOperationExpression: property.Instance
        case field is BoundFieldAccessExpression: field.Receiver
        case call is BoundCallExpression when call.Function.IsExtension && call.Arguments.Length > 0: call.Arguments[0]
        case call is BoundImportedCallExpression when call
            .Arguments
            .Length > 0 &&
            IsExtensionMethod(call.Function?.Method): call.Arguments[0]
        default: default(BoundExpression?)
    }

    private func IsExtensionMethod(method MethodInfo?) bool {
        if method == nil || !method.IsStatic {
            return false
        }
        try {
            return method.GetCustomAttributesData().Any(
                (attribute CustomAttributeData) -> attribute.AttributeType.FullName ==
                "System.Runtime.CompilerServices.ExtensionAttribute"
            )
        } catch (Exception) {
            // Metadata that cannot be read is treated as a plain static call.
            return false
        }
    }

    /// Removes the conversions and nil-unwraps the binder adds around a read
    /// without user syntax of their own (they carry no syntax or the
    /// enclosing accessor's), so the node reached is the read itself.
    private func Unwrap(node BoundExpression?) BoundExpression? {
        var current = node
        while current != nil {
            if current is BoundConversionExpression conversion &&
                IsSynthesizedWrapper(conversion, conversion.Expression) {
                current = conversion.Expression
            } else if current is BoundUnaryExpression unary &&
                unary
                .Op
                .Kind == BoundUnaryOperatorKind.NullAssertion &&
                IsSynthesizedWrapper(unary, unary.Operand) {
                current = unary.Operand
            } else {
                break
            }
        }
        return current
    }

    private func IsSynthesizedWrapper(wrapper BoundExpression, inner BoundExpression) bool -> wrapper.Syntax == nil ||
        wrapper.Syntax is AccessorExpressionSyntax ||
        object.ReferenceEquals(wrapper.Syntax, inner.Syntax)

    /// Gets the symbol a bound read or call refers to, whatever its origin.
    private func ReferencedSymbol(node BoundExpression) Symbol? -> switch node {
        case variable is BoundVariableExpression: variable.Variable
        case call is BoundCallOperationExpression: call.CalledFunction
        case property is BoundPropertyReferenceOperationExpression: property.ReferencedProperty
        case field is BoundFieldAccessExpression: field.Field
        default: default(Symbol?)
    }

    /// Gets the same-compilation symbol a bound read or call refers to, when
    /// its name is [`name`](paramref). Imported members are left to
    /// (cref:GetImportedMember).
    private func ReferencedSourceSymbol(node BoundExpression, name string) Symbol? {
        let symbol Symbol? = switch node {
            // A bare member name inside a method reads through an implicit
            // `this`/type receiver; the reference is to the member itself.
            case BoundVariableExpression{Variable: ImplicitFieldVariableSymbol implicitField}: implicitField.Field
            case BoundVariableExpression{
                Variable: ImplicitPropertyVariableSymbol implicitProperty
            }: implicitProperty.Property
            case BoundVariableExpression{Variable: ImplicitStaticFieldVariableSymbol staticField}: staticField.Field
            case BoundVariableExpression{
                Variable: ImplicitStaticPropertyVariableSymbol staticProperty
            }: staticProperty.Property
            case variable is BoundVariableExpression: variable.Variable
            case call is BoundCallExpression: call.Function
            case userCall is BoundUserInstanceCallExpression: userCall.Method
            case property is BoundPropertyAccessExpression: property.Property
            case field is BoundFieldAccessExpression: field.Field
            default: default(Symbol?)
        }
        return if symbol != nil && symbol.Name == name {
            symbol
        } else {
            default(Symbol?)
        }
    }
}
