// <copyright file="ProtectedReceiverDiagnostics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #4453: enforces the C# CS1540 receiver rule for <c>protected</c>
/// source instance members (fields, properties, methods and events) over a
/// bound body. A derived class may reach such a member only through a
/// receiver of its own type or a subtype; a base- or sibling-typed receiver
/// is reported as GS0379.
/// <para>
/// The binder has many member-access paths (reads, writes, compound
/// assignment, calls, method groups, event subscriptions, object
/// initializers, …), and each already runs the class-level
/// <see cref="AccessibilityChecker.IsAccessible"/> check. Rather than thread
/// the receiver through every one of them, this walker visits every node
/// that references an instance member through a receiver, so a new binder
/// path cannot skip the rule. The decision itself is
/// <see cref="AccessibilityChecker.ViolatesProtectedReceiverRule"/>, which
/// reports nothing the class-level check already rejected.
/// </para>
/// </summary>
internal static class ProtectedReceiverDiagnostics
{
    /// <summary>Reports every protected-receiver violation in <paramref name="root"/>.</summary>
    /// <param name="root">The bound (pre-lowering) body or expression.</param>
    /// <param name="function">The function whose body <paramref name="root"/> is, or the accessibility context an initializer is bound in.</param>
    /// <param name="diagnostics">The bag to report into.</param>
    public static void Report(BoundNode? root, FunctionSymbol? function, DiagnosticBag diagnostics)
    {
        if (root != null && function != null)
        {
            new Walker(function, diagnostics).Visit(root);
        }
    }

    /// <summary>
    /// The class that declares a member: the level of
    /// <paramref name="start"/>'s hierarchy that <paramref name="declares"/>
    /// accepts, i.e. whose own member list holds it.
    /// When none does, <paramref name="start"/> itself, so the rule still
    /// applies to a receiver typed as the class the member was found on.
    /// </summary>
    private static StructSymbol FindDeclaringClass(StructSymbol start, Func<StructSymbol, bool> declares)
    {
        foreach (var level in start.GetHierarchy())
        {
            if (declares(level))
            {
                return level;
            }
        }

        return start;
    }

    /// <summary>The location of the accessed member's name within <paramref name="syntax"/>.</summary>
    private static TextLocation? GetMemberNameLocation(SyntaxNode? syntax)
    {
        var current = syntax;
        while (current != null)
        {
            switch (current)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    current = parenthesized.Expression;
                    continue;
                case AccessorExpressionSyntax accessor:
                    current = accessor.RightPart;
                    continue;
                case EventSubscriptionExpressionSyntax subscription:
                    current = subscription.LeftHandSide;
                    continue;
                case CallExpressionSyntax call:
                    return call.Identifier.Location;
                case NameExpressionSyntax name:
                    return name.IdentifierToken.Location;
                case GenericNameExpressionSyntax generic:
                    return generic.Identifier.Location;
                case MemberFieldAssignmentExpressionSyntax memberAssignment:
                    return memberAssignment.FieldIdentifier.Location;
                case FieldAssignmentExpressionSyntax fieldAssignment:
                    return fieldAssignment.FieldIdentifier.Location;
                default:
                    return current.Location;
            }
        }

        return null;
    }

    private sealed class Walker : BoundTreeWalker
    {
        private readonly DiagnosticBag diagnostics;
        private readonly HashSet<(TextLocation Location, string Member)> reported = new();
        private FunctionSymbol function;

        // The nearest enclosing node that carries syntax. A compound
        // assignment's implicit read (`s.f += 1`) and a null-conditional
        // access's inner member (`s?.P`) are unanchored; they report at the
        // source expression they belong to, once.
        private SyntaxNode? anchor;

        public Walker(FunctionSymbol function, DiagnosticBag diagnostics)
        {
            this.function = function;
            this.diagnostics = diagnostics;
        }

        public override void VisitStatement(BoundStatement? node)
        {
            var outer = anchor;
            anchor = node?.Syntax ?? anchor;
            try
            {
                base.VisitStatement(node);
            }
            finally
            {
                anchor = outer;
            }
        }

        public override void VisitExpression(BoundExpression? node)
        {
            var outerAnchor = anchor;
            var outerFunction = function;
            anchor = node?.Syntax ?? anchor;
            try
            {
                // The base walker treats a function literal as opaque. Its
                // body is still code of the enclosing class, and the binder
                // checked it under the literal's own function symbol, so do
                // the same.
                if (node is BoundFunctionLiteralExpression literal)
                {
                    function = literal.Function;
                    VisitStatement(literal.Body);
                }
                else
                {
                    base.VisitExpression(node);
                }
            }
            finally
            {
                anchor = outerAnchor;
                function = outerFunction;
            }
        }

        protected override void VisitFieldAccessExpression(BoundFieldAccessExpression node)
        {
            if (node.Receiver != null && !node.Field.IsStatic && node.StructType != null)
            {
                var declaring = FindDeclaringClass(node.StructType, level => level.Fields.Contains(node.Field));
                Check(node, node.Receiver.Type, node.Field.Name, node.Field.Accessibility, declaring);
            }

            base.VisitFieldAccessExpression(node);
        }

        protected override void VisitFieldAssignmentExpression(BoundFieldAssignmentExpression node)
        {
            var receiverType = node.ReceiverExpression?.Type ?? node.Receiver?.Type;
            if (receiverType != null && !node.Field.IsStatic && node.StructType != null)
            {
                var declaring = FindDeclaringClass(node.StructType, level => level.Fields.Contains(node.Field));
                Check(node, receiverType, node.Field.Name, node.Field.Accessibility, declaring);
            }

            base.VisitFieldAssignmentExpression(node);
        }

        protected override void VisitStructLiteralExpression(BoundStructLiteralExpression node)
        {
            // A composite literal `Source{ f: 1 }` writes each named member
            // through the new instance, whose static type is the literal's
            // type (C# reports CS1540 for `new Source { f = 1 }` in a
            // derived class). The initializers carry no syntax of their own,
            // so each reports at its member name in the literal.
            foreach (var init in node.Initializers)
            {
                if (init.Field is { IsStatic: false } field)
                {
                    var declaring = init.FieldDeclaringType
                        ?? FindDeclaringClass(node.StructType, level => level.Fields.Contains(field));
                    CheckLiteralMember(node, field.Name, field.Accessibility, declaring);
                }
                else if (init.Property is { IsStatic: false } property)
                {
                    var declaring = FindDeclaringClass(node.StructType, level => level.Properties.Contains(property));
                    CheckLiteralMember(node, property.Name, property.SetterAccessibility, declaring);
                }
            }

            base.VisitStructLiteralExpression(node);
        }

        protected override void VisitPropertyPattern(BoundPropertyPattern node)
        {
            // `s is { f: 1 }` reads each named member through the pattern's
            // input, whose static type is the pattern's type.
            foreach (var member in node.Fields)
            {
                string name;
                Accessibility accessibility;
                Func<StructSymbol, bool> declares;
                if (member.Field is { IsStatic: false } field)
                {
                    (name, accessibility) = (field.Name, field.Accessibility);
                    declares = level => level.Fields.Contains(field);
                }
                else if (member.Property is { IsStatic: false } property)
                {
                    (name, accessibility) = (property.Name, property.GetterAccessibility);
                    declares = level => level.Properties.Contains(property);
                }
                else
                {
                    continue;
                }

                var declaring = member.DeclaringType as StructSymbol
                    ?? (node.Type as StructSymbol is { } owner ? FindDeclaringClass(owner, declares) : null);

                // The pattern binder resolves members without the class-level
                // check every other access path makes, so this is the one
                // place a pattern's private or protected member read is
                // checked at all (GS0472 / GS0379), before the receiver rule.
                if (declaring == null
                    || (AccessibilityChecker.IsAccessible(accessibility, declaring, function)
                        && !AccessibilityChecker.ViolatesProtectedReceiverRule(accessibility, declaring, node.Type, function)))
                {
                    continue;
                }

                var location = member.Syntax is PropertyPatternFieldSyntax fieldSyntax
                    ? fieldSyntax.Identifier.Location
                    : GetMemberNameLocation(member.Syntax ?? node.Syntax ?? anchor);
                Report(location, name, declaring, accessibility);
            }

            base.VisitPropertyPattern(node);
        }

        protected override void VisitPropertyAccessExpression(BoundPropertyAccessExpression node)
        {
            if (node.Receiver != null && !node.Property.IsStatic && node.StructType != null)
            {
                var declaring = FindDeclaringClass(node.StructType, level => level.Properties.Contains(node.Property));
                Check(node, node.Receiver.Type, node.Property.Name, node.Property.GetterAccessibility, declaring);
            }

            base.VisitPropertyAccessExpression(node);
        }

        protected override void VisitPropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
        {
            if (node.Receiver != null && !node.Property.IsStatic && node.StructType != null)
            {
                var declaring = FindDeclaringClass(node.StructType, level => level.Properties.Contains(node.Property));
                Check(node, node.Receiver.Type, node.Property.Name, node.Property.SetterAccessibility, declaring);
            }

            base.VisitPropertyAssignmentExpression(node);
        }

        protected override void VisitUserInstanceCallExpression(BoundUserInstanceCallExpression node)
        {
            if (!node.Method.IsStatic && node.Method.ReceiverType is StructSymbol declaring)
            {
                Check(node, node.Receiver.Type, node.Method.Name, node.Method.Accessibility, declaring);
            }

            base.VisitUserInstanceCallExpression(node);
        }

        protected override void VisitMethodGroupExpression(BoundMethodGroupExpression node)
        {
            var method = node.Function ?? (node.Candidates.Length == 1 ? node.Candidates[0] : null);
            if (node.Receiver != null
                && method != null
                && !method.IsStatic
                && method.ReceiverType is StructSymbol declaring)
            {
                Check(node, node.Receiver.Type, method.Name, method.Accessibility, declaring);
            }

            base.VisitMethodGroupExpression(node);
        }

        protected override void VisitEventSubscriptionExpression(BoundEventSubscriptionExpression node)
        {
            if (node.Receiver != null && !node.Event.IsStatic && node.StructType is StructSymbol owner)
            {
                var declaring = FindDeclaringClass(owner, level => level.Events.Contains(node.Event));
                Check(node, node.Receiver.Type, node.Event.Name, node.Event.Accessibility, declaring);
            }

            base.VisitEventSubscriptionExpression(node);
        }

        private void CheckLiteralMember(
            BoundStructLiteralExpression node,
            string memberName,
            Accessibility accessibility,
            StructSymbol declaringType)
        {
            if (!AccessibilityChecker.ViolatesProtectedReceiverRule(accessibility, declaringType, node.StructType, function))
            {
                return;
            }

            TextLocation? location = null;
            if (node.Syntax is StructLiteralExpressionSyntax literalSyntax)
            {
                foreach (var element in literalSyntax.Elements)
                {
                    if (element is FieldInitializerSyntax initializer
                        && string.Equals(initializer.FieldIdentifier.ValueText, memberName, StringComparison.Ordinal))
                    {
                        location = initializer.FieldIdentifier.Location;
                        break;
                    }
                }
            }

            Report(location ?? GetMemberNameLocation(node.Syntax ?? anchor), memberName, declaringType, accessibility);
        }

        private void Report(TextLocation? location, string memberName, StructSymbol declaringType, Accessibility accessibility)
        {
            if (location is not { } reportedLocation || !reported.Add((reportedLocation, memberName)))
            {
                return;
            }

            diagnostics.ReportMemberInaccessible(reportedLocation, memberName, declaringType.Name, accessibility);
        }

        private void Check(
            BoundNode node,
            TypeSymbol receiverType,
            string memberName,
            Accessibility accessibility,
            StructSymbol declaringType)
        {
            if (!AccessibilityChecker.ViolatesProtectedReceiverRule(accessibility, declaringType, receiverType, function))
            {
                return;
            }

            Report(GetMemberNameLocation(node.Syntax ?? anchor), memberName, declaringType, accessibility);
        }
    }
}
