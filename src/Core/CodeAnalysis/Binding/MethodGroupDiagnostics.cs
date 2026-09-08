// <copyright file="MethodGroupDiagnostics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Reports method groups that escaped without a delegate target.</summary>
internal static class MethodGroupDiagnostics
{
    public static bool RequiresTarget(BoundExpression expression) =>
        expression is BoundMethodGroupExpression { FunctionType: null }
            or BoundClrMethodGroupExpression { ResolvedMethod: null };

    public static bool HasDelegateTarget(BoundExpression expression)
    {
        if (expression is BoundClrMethodGroupExpression clrGroup)
        {
            return clrGroup.ResolvedMethod != null;
        }

        return expression is BoundMethodGroupExpression userGroup
            && userGroup.HasTargetDelegateType;
    }

    public static BoundErrorExpression ReportRequiresTarget(
        DiagnosticBag diagnostics,
        BoundExpression expression,
        TextLocation fallbackLocation)
    {
        var (kind, name) = Describe(expression);
        diagnostics.ReportMethodGroupRequiresTarget(
            GetNameLocation(expression.Syntax, fallbackLocation),
            kind,
            name);
        return new BoundErrorExpression(null);
    }

    public static void ReportUnresolved(BoundNode root, DiagnosticBag diagnostics)
        => new Walker(diagnostics).Visit(root);

    private static (string Kind, string Name) Describe(BoundExpression expression)
    {
        if (expression is BoundClrMethodGroupExpression clrGroup)
        {
            var kind = clrGroup.Receiver == null
                ? "imported static method group"
                : clrGroup.Candidates.Any(candidate => candidate.IsStatic)
                    ? "imported extension method group"
                    : "imported instance method group";
            return (kind, clrGroup.MethodName);
        }

        var userGroup = (BoundMethodGroupExpression)expression;
        var userKind = userGroup.Candidates.Any(candidate => candidate.IsExtension)
            ? "user extension method group"
            : userGroup.Receiver != null
                ? "user instance method group"
                : userGroup.StaticOwnerType != null
                    || userGroup.Candidates.Any(candidate => candidate.IsStatic)
                    ? "user static method group"
                    : "user method group";
        var userName = userGroup.Function?.Name
            ?? userGroup.Candidates.FirstOrDefault()?.Name
            ?? "<method group>";
        return (userKind, userName);
    }

    private static TextLocation GetNameLocation(SyntaxNode? syntax, TextLocation fallbackLocation)
    {
        while (syntax is ParenthesizedExpressionSyntax parenthesized)
        {
            syntax = parenthesized.Expression;
        }

        while (syntax is AccessorExpressionSyntax accessor)
        {
            syntax = accessor.RightPart;
        }

        return syntax switch
        {
            NameExpressionSyntax name => name.IdentifierToken.Location,
            GenericNameExpressionSyntax generic => generic.Identifier.Location,
            _ => fallbackLocation,
        };
    }

    private sealed class Walker : BoundTreeWalker
    {
        private readonly DiagnosticBag diagnostics;
        private int callArgumentDepth;

        public Walker(DiagnosticBag diagnostics)
        {
            this.diagnostics = diagnostics;
        }

        protected override void VisitCallExpression(BoundCallExpression node)
            => VisitCallArguments(node.Arguments);

        protected override void VisitImportedCallExpression(BoundImportedCallExpression node)
            => VisitCallArguments(node.Arguments);

        protected override void VisitImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
        {
            VisitExpression(node.Receiver);
            VisitCallArguments(node.Arguments);
        }

        protected override void VisitConstrainedStaticCallExpression(BoundConstrainedStaticCallExpression node)
            => VisitCallArguments(node.Arguments);

        protected override void VisitConversionExpression(BoundConversionExpression node)
        {
            if (node.Expression is BoundMethodGroupExpression userGroup)
            {
                VisitExpression(userGroup.Receiver);
            }
            else if (node.Expression is BoundClrMethodGroupExpression clrGroup)
            {
                VisitExpression(clrGroup.Receiver);
            }
            else
            {
                base.VisitConversionExpression(node);
            }
        }

        protected override void VisitConstructorCallExpression(BoundConstructorCallExpression node)
            => VisitCallArguments(node.Arguments);

        protected override void VisitConstructorChainingExpression(BoundConstructorChainingExpression node)
            => VisitCallArguments(node.Arguments);

        protected override void VisitUserInstanceCallExpression(BoundUserInstanceCallExpression node)
        {
            VisitExpression(node.Receiver);
            VisitCallArguments(node.Arguments);
        }

        protected override void VisitBaseInterfaceCallExpression(BoundBaseInterfaceCallExpression node)
        {
            VisitExpression(node.Receiver);
            VisitCallArguments(node.Arguments);
        }

        protected override void VisitBaseClassCallExpression(BoundBaseClassCallExpression node)
        {
            VisitExpression(node.Receiver);
            VisitCallArguments(node.Arguments);
        }

        protected override void VisitIndirectCallExpression(BoundIndirectCallExpression node)
        {
            VisitExpression(node.Target);
            VisitCallArguments(node.Arguments);
        }

        protected override void VisitClrConstructorCallExpression(BoundClrConstructorCallExpression node)
            => VisitCallArguments(node.Arguments);

        protected override void VisitClrStaticCallExpression(BoundClrStaticCallExpression node)
            => VisitCallArguments(node.Arguments);

        protected override void VisitClrIndexExpression(BoundClrIndexExpression node)
        {
            VisitExpression(node.Target);
            VisitCallArguments(node.Arguments);
        }

        protected override void VisitClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
        {
            VisitExpression(node.TargetExpression);
            VisitCallArguments(node.Arguments);
            VisitExpression(node.Value);
        }

        protected override void VisitClrMethodGroupExpression(BoundClrMethodGroupExpression node)
        {
            if (this.callArgumentDepth == 0 && node.ResolvedMethod == null)
            {
                ReportRequiresTarget(this.diagnostics, node, node.Syntax?.Location ?? default);
            }

            base.VisitClrMethodGroupExpression(node);
        }

        protected override void VisitMethodGroupExpression(BoundMethodGroupExpression node)
        {
            if (this.callArgumentDepth == 0 && !HasDelegateTarget(node))
            {
                ReportRequiresTarget(this.diagnostics, node, node.Syntax?.Location ?? default);
            }

            base.VisitMethodGroupExpression(node);
        }

        private void VisitCallArguments(ImmutableArray<BoundExpression> arguments)
        {
            foreach (var argument in arguments)
            {
                this.callArgumentDepth++;
                try
                {
                    VisitExpression(argument);
                }
                finally
                {
                    this.callArgumentDepth--;
                }
            }
        }
    }
}
