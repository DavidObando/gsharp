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
/// member. The other segments are reached through that node's receiver chain.
/// Each index adds a target step, not a member step. Index arguments are
/// independent expressions and never form part of that chain. A receiver read
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
        let node = Unwrap(FindReferencedNode(model, token))
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
        let member MemberInfo? = switch Unwrap(FindReferencedNode(model, token)) {
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
        if anchor != nil &&
            Unwrap(node) is {} read &&
            ReferencedSymbol(read) is {} referenced &&
            referenced.Name != anchor.Text {
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
        // A delegate callee's token names its variable, while its call names Invoke.
        if model.GetBoundNode(token) is BoundExpression named {
            return named
        }
        let expression = ExpressionNamedBy(token)
        return if expression == nil {
            default(BoundExpression?)
        } else {
            FindBoundExpression(model, expression)
        }
    }

    /// Keeps the original query as provenance while normalizing receiver steps.
    /// Prefers reachable outer flow context and retains inner anchors when an
    /// outer write target or index cannot supply the queried expression.
    private func FindBoundExpression(
        model GSharp.Core.CodeAnalysis.SemanticModel,
        expression ExpressionSyntax
    ) BoundExpression? {
        var root ExpressionSyntax = expression
        let anchors = Stack[(Syntax ExpressionSyntax, Node BoundExpression)]()
        while true {
            if GetBoundAnchor(model, root) is {} anchored {
                anchors.Push((root, anchored))
            }
            if root.Parent is AccessorExpressionSyntax accessor &&
                (object.ReferenceEquals(accessor.LeftPart, root) || object.ReferenceEquals(accessor.RightPart, root)) {
                root = accessor
            } else if root.Parent is IndexExpressionSyntax index && object.ReferenceEquals(index.Target, root) {
                root = index
            } else {
                break
            }
        }
        while anchors.Count > 0 {
            let (syntax, node) = anchors.Pop()
            if FindFromAnchor(syntax, node, expression) is {} found {
                return PeelConversions(found, expression)
            }
        }
        return nil
    }

    private func FindFromAnchor(
        root ExpressionSyntax,
        anchored BoundExpression,
        expression ExpressionSyntax
    ) BoundExpression? {
        if object.ReferenceEquals(root, expression) {
            return anchored
        }
        let segments = List[ExpressionSyntax]()
        AddReceiverSegments(root, segments)
        let terminal = TerminalSegment(expression)
        var index = -1
        for var i = 0; i < segments.Count; i++ {
            if object.ReferenceEquals(segments[i], terminal) {
                index = i
                break
            }
        }
        if index < 0 {
            return nil
        }
        let lastSyntax = if index == segments.Count - 1 {
            expression
        } else {
            segments[segments.Count - 1]
        }
        var node BoundExpression? = PeelConversions(anchored, lastSyntax)
        // A `?.` hop binds its access over a synthetic capture of the receiver;
        // the walk maps each capture back to the receiver it stands for.
        let captures = Dictionary[VariableSymbol, BoundExpression]()
        for var depth = segments.Count - 1; depth > index && node != nil; depth-- {
            var member = PeelConversions(node, segments[depth])
            while member is BoundNullConditionalAccessExpression hop {
                captures[hop.Capture] = hop.Receiver
                member = PeelConversions(hop.WhenNotNull, segments[depth])
            }
            member = Unwrap(member)
            let receiverSyntax = if depth - 1 == index {
                expression
            } else {
                segments[depth - 1]
            }
            node = if member == nil {
                default(BoundExpression?)
            } else if segments[depth] is IndexExpressionSyntax {
                PeelConversions(IndexTargetOf(member), receiverSyntax)
            } else {
                PeelConversions(ReceiverOf(member), receiverSyntax)
            }
            if node is BoundVariableExpression read && captures.TryGetValue(read.Variable, out var captured) {
                node = PeelConversions(captured, receiverSyntax)
            }
        }
        return node
    }

    private func GetBoundAnchor(
        model GSharp.Core.CodeAnalysis.SemanticModel,
        expression ExpressionSyntax
    ) BoundExpression? {
        if model.GetBoundNode(expression) is BoundExpression anchored && OwnsIndexAnchor(expression, anchored) {
            return anchored
        }
        // Generated index plans can retain the written argument as their anchor.
        // An ordinary argument requires capture provenance, unlike a range that
        // can directly anchor a CLR index read.
        if TerminalSegment(expression) is IndexExpressionSyntax index && index.Indices.Count == 1 {
            let argumentAnchor = model.GetBoundNode(index.Index) as BoundExpression
            if Unwrap(argumentAnchor) is {} read &&
                IndexTargetOf(read, capturedOnly: index.Index is not RangeExpressionSyntax) != nil &&
                OwnsIndexAnchor(expression, read) {
                return argumentAnchor
            }
        }
        return nil
    }

    private func OwnsIndexAnchor(expression ExpressionSyntax, anchored BoundExpression) bool {
        // Every recognized capture plan anchored on an argument belongs to its
        // enclosing index, regardless of whether the plan returns a ref or value.
        if Unwrap(anchored) is {} read &&
            IndexTargetOf(read, capturedOnly: true) != nil &&
            read.Syntax is ExpressionSyntax argument &&
            argument.Parent is IndexExpressionSyntax owner &&
            owner
            .Indices
            .Any((item ExpressionSyntax) -> object.ReferenceEquals(item, argument)) {
            return object.ReferenceEquals(TerminalSegment(expression), owner)
        }
        return true
    }

    private func TerminalSegment(expression ExpressionSyntax) ExpressionSyntax {
        var current = expression
        while current is AccessorExpressionSyntax accessor {
            current = accessor.RightPart
        }
        return current
    }

    // An implicit ref read adds no syntax step. Its operand must itself be a
    // recognized index or guarded capture plan, never an arbitrary block.
    private func IndexTargetOf(node BoundExpression, capturedOnly bool = false) BoundExpression? -> switch node {
        case index is BoundIndexExpression when !capturedOnly: index.Target
        case index is BoundClrIndexExpression when !capturedOnly: index.Target
        case dereference is BoundDereferenceExpression when dereference
            .Operand
            .Type is ByRefTypeSymbol &&
            IsSynthesizedWrapper(dereference, dereference.Operand): IndexTargetOf(dereference.Operand, capturedOnly)
        case block is BoundBlockExpression: CapturedIndexTarget(block)
        default: if capturedOnly {
            default(BoundExpression?)
        } else {
            ReceiverOf(node)
        }
    }

    private func CapturedIndexTarget(block BoundBlockExpression) BoundExpression? {
        // DeclareRangeTemp emits the source capture first for index/slice
        // blocks. Its reserved role and absent declaration exclude authored
        // blocks and other generated capture plans.
        const sourceCapturePrefix = "$$slice_src"
        if !block
            .Statements
            .IsDefaultOrEmpty &&
            block.Statements[0] is BoundVariableDeclaration{
            Variable: LocalVariableSymbol{DeclaringSyntax: nil, IsReadOnly: true} capture,
            Initializer: {} target
        } &&
            capture
            .Name
            .StartsWith(sourceCapturePrefix, StringComparison.Ordinal) && int32.TryParse(
            capture.Name.Substring(sourceCapturePrefix.Length),
            out _
        ) {
            return target
        }
        return nil
    }

    private func AddReceiverSegments(expression ExpressionSyntax, segments List[ExpressionSyntax]) {
        switch expression {
            case accessor is AccessorExpressionSyntax {
                AddReceiverSegments(accessor.LeftPart, segments)
                AddReceiverSegments(accessor.RightPart, segments)
            }
            case index is IndexExpressionSyntax {
                AddReceiverSegments(index.Target, segments)
                segments.Add(index)
            }
            default {
                segments.Add(expression)
            }
        }
    }

    /// Gets a bound member's receiver, or null when it has none.
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

    /// Removes the implicit conversions the binder adds around a read without
    /// user syntax of their own. A narrowed value-type read keeps its
    /// synthesized `!!`: that node's type is the read's flow type (`S`,
    /// where the read below it is still `S?`).
    private func PeelConversions(node BoundExpression?, expression ExpressionSyntax) BoundExpression? {
        let receiverSyntax = AssignmentTargetSyntaxFacts.UnwrapParentheses(expression)
        var current = node
        while current is BoundConversionExpression conversion &&
            IsSynthesizedWrapper(conversion, conversion.Expression, receiverSyntax) {
            current = conversion.Expression
        }
        return current
    }

    /// Removes the conversions and nil-unwraps the binder adds around a read
    /// without user syntax of their own, so the node reached is the read itself.
    private func Unwrap(node BoundExpression?) BoundExpression? {
        var current = node
        while current != nil {
            if current is BoundConversionExpression conversion &&
                IsSynthesizedWrapper(conversion, conversion.Expression) {
                current = conversion.Expression
            } else if current is BoundNullConditionalAccessExpression hop {
                // The member a `?.` hop reads is its non-nil access.
                current = hop.WhenNotNull
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

    // For type queries, a conversion anchored on the whole accessor is implicit
    // only when its operand is the queried receiver, not a conversion argument.
    private func IsSynthesizedWrapper(
        wrapper BoundExpression,
        inner BoundExpression,
        expression ExpressionSyntax? = nil
    ) bool -> wrapper.Syntax == nil ||
        (
        wrapper.Syntax is AccessorExpressionSyntax &&
            (expression == nil || object.ReferenceEquals(inner.Syntax, expression))
    ) ||
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
            // A read through a constructed generic interface keeps the
            // declaration's property and records the substituted type beside
            // it; show the property at that type. References still match it
            // by its declaration.
            case BoundPropertyAccessExpression{
                SubstitutedType: {} substitutedType
            } property when !object.ReferenceEquals(substitutedType, property.Property.Type): property
                .Property
                .WithSignature(substitutedType, property.Property.Parameters)
            case property is BoundPropertyAccessExpression: property.Property
            case field is BoundFieldAccessExpression: field.Field
            default: default(Symbol?)
        }
        // A field-like event's read binds its synthesized backing field; the
        // reference is to the event, which the callers' event lookup finds.
        if symbol is FieldSymbol{IsEventBackingField: true} {
            return nil
        }
        return if symbol != nil && symbol.Name == name {
            symbol
        } else {
            default(Symbol?)
        }
    }
}
