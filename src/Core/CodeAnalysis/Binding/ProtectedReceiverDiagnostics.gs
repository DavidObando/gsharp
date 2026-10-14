// <copyright file="ProtectedReceiverDiagnostics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic

/// Issue #4453: enforces the C# CS1540 receiver rule for `protected`
/// source instance members (fields, properties, methods and events) over a
/// bound body. A derived class may reach such a member only through a
/// receiver of its own type or a subtype; a base- or sibling-typed receiver
/// is reported as GS0379.
///
/// The binder has many member-access paths (reads, writes, compound
/// assignment, calls, method groups, event subscriptions, object
/// initializers, …), and each already runs the class-level
/// (cref:AccessibilityChecker.IsAccessible) check. Rather than thread
/// the receiver through every one of them, this walker visits every node
/// that references an instance member through a receiver, so a new binder
/// path cannot skip the rule. The decision itself is
/// (cref:AccessibilityChecker.ViolatesProtectedReceiverRule), which
/// reports nothing the class-level check already rejected.
internal shared class ProtectedReceiverDiagnostics {
    private class Walker : BoundTreeWalker {
        private let diagnostics DiagnosticBag
        private let reported HashSet[(Location TextLocation, Member string)] = HashSet[
            (Location TextLocation, Member string)
        ]()
        private var function FunctionSymbol?

        // The nearest enclosing node that carries syntax. A compound
        // assignment's implicit read (`s.f += 1`) and a null-conditional
        // access's inner member (`s?.P`) are unanchored; they report at the
        // source expression they belong to, once.
        private var anchor SyntaxNode?

        init(function FunctionSymbol?, diagnostics DiagnosticBag) {
            this.function = function
            this.diagnostics = diagnostics
        }

        override func VisitStatement(node BoundStatement?) {
            let outer = anchor
            anchor = node?.Syntax ?? anchor
            try {
                base.VisitStatement(node)
            } finally {
                anchor = outer
            }
        }

        override func VisitExpression(node BoundExpression?) {
            let outerAnchor = anchor
            let outerFunction = function
            anchor = node?.Syntax ?? anchor
            try {
                // The base walker treats a function literal as opaque. Its
                // body is still code of the enclosing class, and the binder
                // checked it under the literal's own function symbol, so do
                // the same.
                if node is BoundFunctionLiteralExpression literal {
                    function = literal.Function
                    VisitStatement(literal.Body)
                } else {
                    base.VisitExpression(node)
                }
            } finally {
                anchor = outerAnchor
                function = outerFunction
            }
        }

        protected override func VisitFieldAccessExpression(node BoundFieldAccessExpression) {
            if node.Receiver != nil && !node.Field.IsStatic && node.StructType != nil {
                let declaring = ProtectedReceiverDiagnostics.FindDeclaringClass(
                    node.StructType,
                    (level StructSymbol) -> level.Fields.Contains(node.Field)
                )
                Check(node, node.Receiver!!.Type, node.Field.Name, node.Field.Accessibility, declaring)
            }
            base.VisitFieldAccessExpression(node)
        }

        protected override func VisitFieldAssignmentExpression(node BoundFieldAssignmentExpression) {
            let receiverType TypeSymbol? = node.ReceiverExpression?.Type ?? node.Receiver?.Type
            if receiverType != nil && !node.Field.IsStatic && node.StructType != nil {
                let declaring = ProtectedReceiverDiagnostics.FindDeclaringClass(
                    node.StructType,
                    (level StructSymbol) -> level.Fields.Contains(node.Field)
                )
                Check(node, receiverType, node.Field.Name, node.Field.Accessibility, declaring)
            }
            base.VisitFieldAssignmentExpression(node)
        }

        protected override func VisitStructLiteralExpression(node BoundStructLiteralExpression) {
            // A composite literal `Source{ f: 1 }` writes each named member
            // through the new instance, whose static type is the literal's
            // type (C# reports CS1540 for `new Source { f = 1 }` in a
            // derived class). The initializers carry no syntax of their own,
            // so each reports at its member name in the literal.
            for init in node.Initializers {
                if init.Field is {IsStatic: false} field {
                    let declaring = init.FieldDeclaringType ?? ProtectedReceiverDiagnostics.FindDeclaringClass(
                        node.StructType,
                        (level StructSymbol) -> level.Fields.Contains(field)
                    )
                    CheckLiteralMember(node, field.Name, field.Accessibility, declaring)
                } else if init.Property is {IsStatic: false} property {
                    let declaring = ProtectedReceiverDiagnostics.FindDeclaringClass(
                        node.StructType,
                        (level StructSymbol) -> level.Properties.Contains(property)
                    )
                    CheckLiteralMember(node, property.Name, property.SetterAccessibility, declaring)
                }
            }
            base.VisitStructLiteralExpression(node)
        }

        protected override func VisitPropertyPattern(node BoundPropertyPattern) {
            // `s is { f: 1 }` reads each named member through the pattern's
            // input, whose static type is the pattern's type.
            for member in node.Fields {
                var name string
                var accessibility Accessibility
                var declares(StructSymbol) -> bool
                if member.Field is {IsStatic: false} field {
                    name, accessibility = field.Name, field.Accessibility
                    declares = (level StructSymbol) -> level.Fields.Contains(field)
                } else if member.Property is {IsStatic: false} property {
                    name, accessibility = property.Name, property.GetterAccessibility
                    declares = (level StructSymbol) -> level.Properties.Contains(property)
                } else {
                    continue
                }
                let declaring StructSymbol? = member.DeclaringType as StructSymbol ??
                    (
                    if node.Type as StructSymbol is {} owner {
                        ProtectedReceiverDiagnostics.FindDeclaringClass(owner, declares)
                    } else {
                        default(StructSymbol?)
                    }
                )
                // The pattern binder resolves members without the class-level
                // check every other access path makes, so this is the one
                // place a pattern's private or protected member read is
                // checked at all (GS0472 / GS0379), before the receiver rule.
                if declaring == nil ||
                    (
                    AccessibilityChecker.IsAccessible(accessibility, declaring, function) &&
                        !AccessibilityChecker.ViolatesProtectedReceiverRule(
                        accessibility,
                        declaring,
                        node.Type,
                        function
                    )
                ) {
                    continue
                }
                let location = if member.Syntax is PropertyPatternFieldSyntax fieldSyntax {
                    fieldSyntax.Identifier.Location
                } else {
                    ProtectedReceiverDiagnostics.GetMemberNameLocation(member.Syntax ?? node.Syntax ?? anchor)
                }
                Report(location, name, declaring, accessibility)
            }
            base.VisitPropertyPattern(node)
        }

        protected override func VisitPropertyAccessExpression(node BoundPropertyAccessExpression) {
            if node.Receiver != nil && !node.Property.IsStatic && node.StructType != nil {
                let declaring = ProtectedReceiverDiagnostics.FindDeclaringClass(
                    node.StructType,
                    (level StructSymbol) -> level.Properties.Contains(node.Property)
                )
                Check(node, node.Receiver!!.Type, node.Property.Name, node.Property.GetterAccessibility, declaring)
            }
            base.VisitPropertyAccessExpression(node)
        }

        protected override func VisitPropertyAssignmentExpression(node BoundPropertyAssignmentExpression) {
            if node.Receiver != nil && !node.Property.IsStatic && node.StructType != nil {
                let declaring = ProtectedReceiverDiagnostics.FindDeclaringClass(
                    node.StructType,
                    (level StructSymbol) -> level.Properties.Contains(node.Property)
                )
                Check(node, node.Receiver!!.Type, node.Property.Name, node.Property.SetterAccessibility, declaring)
            }
            base.VisitPropertyAssignmentExpression(node)
        }

        protected override func VisitUserInstanceCallExpression(node BoundUserInstanceCallExpression) {
            if !node.Method.IsStatic && node.Method.ReceiverType is StructSymbol declaring {
                // A source indexer binds as a call to its get/set accessor.
                // Name the indexer, so `r[i] += 1` reports once, as `Item`.
                var name = node.Method.Name
                for property in declaring.Properties {
                    if object.ReferenceEquals(property.GetterSymbol, node.Method) || object.ReferenceEquals(
                        property.SetterSymbol,
                        node.Method
                    ) {
                        name = property.Name
                        break
                    }
                }
                Check(node, node.Receiver.Type, name, node.Method.Accessibility, declaring)
            }
            base.VisitUserInstanceCallExpression(node)
        }

        protected override func VisitMethodGroupExpression(node BoundMethodGroupExpression) {
            let method FunctionSymbol? = node.Function ??
                (
                if node.Candidates.Length == 1 {
                    node.Candidates[0]
                } else {
                    default(FunctionSymbol?)
                }
            )
            if node.Receiver != nil &&
                method != nil &&
                !method.IsStatic &&
                method.ReceiverType is StructSymbol declaring {
                Check(node, node.Receiver.Type, method.Name, method.Accessibility, declaring)
            }
            base.VisitMethodGroupExpression(node)
        }

        protected override func VisitEventSubscriptionExpression(node BoundEventSubscriptionExpression) {
            if node.Receiver != nil && !node.Event.IsStatic && node.StructType is StructSymbol owner {
                let declaring = ProtectedReceiverDiagnostics.FindDeclaringClass(
                    owner,
                    (level StructSymbol) -> level.Events.Contains(node.Event)
                )
                Check(node, node.Receiver!!.Type, node.Event.Name, node.Event.Accessibility, declaring)
            }
            base.VisitEventSubscriptionExpression(node)
        }

        private func CheckLiteralMember(
            node BoundStructLiteralExpression,
            memberName string,
            accessibility Accessibility,
            declaringType StructSymbol
        ) {
            if !AccessibilityChecker.ViolatesProtectedReceiverRule(
                accessibility,
                declaringType,
                node.StructType,
                function
            ) {
                return
            }
            var location TextLocation? = nil
            if node.Syntax is StructLiteralExpressionSyntax literalSyntax {
                for element in literalSyntax.Elements {
                    if element is FieldInitializerSyntax initializer && string.Equals(
                        initializer.FieldIdentifier.ValueText,
                        memberName,
                        StringComparison.Ordinal
                    ) {
                        location = initializer.FieldIdentifier.Location
                        break
                    }
                }
            }
            Report(
                location ?? ProtectedReceiverDiagnostics.GetMemberNameLocation(node.Syntax ?? anchor),
                memberName,
                declaringType,
                accessibility
            )
        }

        private func Report(
            location TextLocation?,
            memberName string,
            declaringType StructSymbol,
            accessibility Accessibility
        ) {
            if location is not{} reportedLocation || !reported.Add((reportedLocation, memberName)) {
                return
            }
            diagnostics.ReportMemberInaccessible(reportedLocation, memberName, declaringType.Name, accessibility)
        }

        private func Check(
            node BoundNode,
            receiverType TypeSymbol,
            memberName string,
            accessibility Accessibility,
            declaringType StructSymbol
        ) {
            if !AccessibilityChecker.ViolatesProtectedReceiverRule(
                accessibility,
                declaringType,
                receiverType,
                function
            ) {
                return
            }
            Report(
                ProtectedReceiverDiagnostics.GetMemberNameLocation(node.Syntax ?? anchor),
                memberName,
                declaringType,
                accessibility
            )
        }
    }

    /// Reports every protected-receiver violation in [`root`](paramref).
    /// @param root The bound (pre-lowering) body or expression.
    /// @param function The function whose body [`root`](paramref) is, the accessibility context an
    /// initializer is bound in, or `null` for code outside any function.
    /// @param diagnostics The bag to report into.
    func Report(root BoundNode?, function FunctionSymbol?, diagnostics DiagnosticBag) {
        if root != nil {
            ProtectedReceiverDiagnostics.Walker(function, diagnostics).Visit(root)
        }
    }

    /// The class that declares a member: the level of
    /// [`start`](paramref)'s hierarchy that [`declares`](paramref)
    /// accepts, i.e. whose own member list holds it.
    /// When none does, [`start`](paramref) itself, so the rule still
    /// applies to a receiver typed as the class the member was found on.
    private func FindDeclaringClass(start StructSymbol, declares(StructSymbol) -> bool) StructSymbol {
        for level in start.GetHierarchy() {
            if declares(level) {
                return level
            }
        }
        return start
    }

    /// The location of the accessed member's name within [`syntax`](paramref).
    private func GetMemberNameLocation(syntax SyntaxNode?) TextLocation? {
        var current SyntaxNode? = syntax
        while current != nil {
            switch current {
                case parenthesized is ParenthesizedExpressionSyntax {
                    current = parenthesized.Expression
                    continue
                }
                case accessor is AccessorExpressionSyntax {
                    current = accessor.RightPart
                    continue
                }
                case subscription is EventSubscriptionExpressionSyntax {
                    current = subscription.LeftHandSide
                    continue
                }
                case call is CallExpressionSyntax {
                    return call.Identifier.Location
                }
                case name is NameExpressionSyntax {
                    return name.IdentifierToken.Location
                }
                case generic is GenericNameExpressionSyntax {
                    return generic.Identifier.Location
                }
                case memberAssignment is MemberFieldAssignmentExpressionSyntax {
                    return memberAssignment.FieldIdentifier.Location
                }
                case fieldAssignment is FieldAssignmentExpressionSyntax {
                    return fieldAssignment.FieldIdentifier.Location
                }
                default {
                    return current!!.Location
                }
            }
        }
        return nil
    }
}
