﻿// <copyright file="Binder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System;
    using System.Collections.Generic;
    using System.Collections.Immutable;
    using System.Linq;
    using System.Text;
    using GSharp.Core.CodeAnalysis.Lowering;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.CodeAnalysis.Text;

    /// <summary>
    /// Binder.
    /// </summary>
    public sealed class Binder
    {
        private readonly FunctionSymbol function;

        private Stack<(BoundLabel BreakLabel, BoundLabel ContinueLabel)> loopStack = new Stack<(BoundLabel BreakLabel, BoundLabel ContinueLabel)>();
        private int labelCounter;
        private BoundScope scope;

        /// <summary>
        /// Initializes a new instance of the <see cref="Binder"/> class.
        /// </summary>
        /// <param name="parent">The parent scope.</param>
        /// <param name="function">The function to bind.</param>
        public Binder(BoundScope parent, FunctionSymbol function)
        {
            scope = new BoundScope(parent);
            this.function = function;

            if (function != null)
            {
                foreach (var p in function.Parameters)
                {
                    scope.TryDeclareVariable(p);
                }
            }
        }

        /// <summary>
        /// Gets the diagnostics bag.
        /// </summary>
        public DiagnosticBag Diagnostics { get; } = new DiagnosticBag();

        /// <summary>
        /// Binds a set of syntax trees to the previous global scope, resulting in a new chained global scope.
        /// </summary>
        /// <param name="previous">The previous global scope.</param>
        /// <param name="syntaxTrees">The new syntax trees.</param>
        /// <returns>The new chained bound global scope.</returns>
        public static BoundGlobalScope BindGlobalScope(BoundGlobalScope previous, ImmutableArray<SyntaxTree> syntaxTrees)
        {
            var parentScope = CreateParentScope(previous);
            var binder = new Binder(parentScope, function: null);

            var importDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                     .OfType<ImportSyntax>();
            foreach (var import in importDeclarations)
            {
                binder.BindImport(import);
            }

            var functionDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                                  .OfType<FunctionDeclarationSyntax>();
            foreach (var function in functionDeclarations)
            {
                binder.BindFunctionDeclaration(function);
            }

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            var globalStatements = syntaxTrees.SelectMany(st => st.Root.Members)
                                              .OfType<GlobalStatementSyntax>();
            foreach (var globalStatement in globalStatements)
            {
                var statement = binder.BindStatement(globalStatement.Statement);
                statements.Add(statement);
            }

            var imports = binder.scope.GetDeclaredImports();
            var functions = binder.scope.GetDeclaredFunctions();
            var variables = binder.scope.GetDeclaredVariables();
            var diagnostics = binder.Diagnostics.ToImmutableArray();

            if (previous != null)
            {
                diagnostics = diagnostics.InsertRange(0, previous.Diagnostics);
            }

            var packageSymbol = new PackageSymbol(name: "Default", declaration: null);
            return new BoundGlobalScope(previous, packageSymbol, diagnostics, imports, functions, variables, statements.ToImmutable());
        }

        /// <summary>
        /// Produces a bound program from the specified global scope.
        /// </summary>
        /// <param name="globalScope">The global scope.</param>
        /// <returns>A bound program.</returns>
        public static BoundProgram BindProgram(BoundGlobalScope globalScope)
        {
            var parentScope = CreateParentScope(globalScope);

            var functionBodies = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
            var diagnostics = ImmutableArray.CreateBuilder<Diagnostic>();

            var scope = globalScope;

            while (scope != null)
            {
                foreach (var function in scope.Functions)
                {
                    var binder = new Binder(parentScope, function);
                    var body = binder.BindStatement(function.Declaration.Body);
                    var loweredBody = Lowerer.Lower(body);

                    if (function.Type != TypeSymbol.Void && !ControlFlowGraph.AllPathsReturn(loweredBody))
                    {
                        binder.Diagnostics.ReportAllPathsMustReturn(function.Declaration.Identifier.Location);
                    }

                    functionBodies.Add(function, loweredBody);

                    diagnostics.AddRange(binder.Diagnostics);
                }

                scope = scope.Previous;
            }

            var statement = Lowerer.Lower(new BoundBlockStatement(globalScope.Statements));

            return new BoundProgram(globalScope.Package.Name, diagnostics.ToImmutable(), functionBodies.ToImmutable(), statement);
        }

        private static BoundScope CreateParentScope(BoundGlobalScope previous)
        {
            var stack = new Stack<BoundGlobalScope>();
            while (previous != null)
            {
                stack.Push(previous);
                previous = previous.Previous;
            }

            var parent = CreateRootScope();

            while (stack.Count > 0)
            {
                previous = stack.Pop();
                var scope = new BoundScope(parent);

                foreach (var i in previous.Imports)
                {
                    scope.TryImport(i);
                }

                foreach (var f in previous.Functions)
                {
                    scope.TryDeclareFunction(f);
                }

                foreach (var v in previous.Variables)
                {
                    scope.TryDeclareVariable(v);
                }

                parent = scope;
            }

            return parent;
        }

        private static BoundScope CreateRootScope()
        {
            var result = new BoundScope(null);

            foreach (var f in BuiltinFunctions.GetAll())
            {
                result.TryDeclareFunction(f);
            }

            return result;
        }

        private void BindImport(ImportSyntax import)
        {
            var sb = new StringBuilder();
            foreach (var i in import.IdentifiersWithDots)
            {
                sb.Append(i.Text);
            }

            var importName = sb.ToString();
            var importSymbol = new ImportSymbol(importName, import);
            scope.TryImport(importSymbol);
        }

        private void BindFunctionDeclaration(FunctionDeclarationSyntax syntax)
        {
            var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();

            var seenParameterNames = new HashSet<string>();

            foreach (var parameterSyntax in syntax.Parameters)
            {
                var parameterName = parameterSyntax.Identifier.Text;
                var parameterType = BindTypeClause(parameterSyntax.Type);
                if (!seenParameterNames.Add(parameterName))
                {
                    Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                }
                else
                {
                    var parameter = new ParameterSymbol(parameterName, parameterType);
                    parameters.Add(parameter);
                }
            }

            var type = BindTypeClause(syntax.Type) ?? TypeSymbol.Void;

            var function = new FunctionSymbol(syntax.Identifier.Text, parameters.ToImmutable(), type, syntax);
            if (function.Declaration.Identifier.Text != null && !scope.TryDeclareFunction(function))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, function.Name);
            }
        }

        private BoundStatement BindErrorStatement()
        {
            return new BoundExpressionStatement(new BoundErrorExpression());
        }

        private BoundStatement BindStatement(StatementSyntax syntax)
        {
            switch (syntax.Kind)
            {
                case SyntaxKind.CommentToken:
                    // comments don't need to be bound
                    return null;
                case SyntaxKind.BlockStatement:
                    return BindBlockStatement((BlockStatementSyntax)syntax);
                case SyntaxKind.VariableDeclaration:
                    return BindVariableDeclaration((VariableDeclarationSyntax)syntax);
                case SyntaxKind.IfStatement:
                    return BindIfStatement((IfStatementSyntax)syntax);
                case SyntaxKind.ForInfiniteStatement:
                    return BindForInfiniteStatement((ForInfiniteStatementSyntax)syntax);
                case SyntaxKind.ForEllipsisStatement:
                    return BindForEllipsisStatement((ForEllipsisStatementSyntax)syntax);
                case SyntaxKind.BreakStatement:
                    return BindBreakStatement((BreakStatementSyntax)syntax);
                case SyntaxKind.ContinueStatement:
                    return BindContinueStatement((ContinueStatementSyntax)syntax);
                case SyntaxKind.ReturnStatement:
                    return BindReturnStatement((ReturnStatementSyntax)syntax);
                case SyntaxKind.ExpressionStatement:
                    return BindExpressionStatement((ExpressionStatementSyntax)syntax);
                default:
                    throw new Exception($"Unexpected syntax {syntax.Kind}");
            }
        }

        private BoundStatement BindBlockStatement(BlockStatementSyntax syntax)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            scope = new BoundScope(scope);

            foreach (var statementSyntax in syntax.Statements)
            {
                var statement = BindStatement(statementSyntax);
                statements.Add(statement);
            }

            scope = scope.Parent;

            return new BoundBlockStatement(statements.ToImmutable());
        }

        private BoundStatement BindVariableDeclaration(VariableDeclarationSyntax syntax)
        {
            var isReadOnly = syntax.Keyword?.Kind == SyntaxKind.ConstKeyword;
            var type = BindTypeClause(syntax.TypeClause);
            var initializer = BindExpression(syntax.Initializer);
            var variableType = type ?? initializer.Type;
            var variable = BindVariableDeclaration(syntax.Identifier, isReadOnly, variableType);
            var convertedInitializer = BindConversion(syntax.Initializer.Location, initializer, variableType);

            return new BoundVariableDeclaration(variable, convertedInitializer);
        }

        private TypeSymbol BindTypeClause(TypeClauseSyntax syntax)
        {
            if (syntax == null)
            {
                return null;
            }

            var type = LookupType(syntax.Identifier.Text);
            if (type == null)
            {
                Diagnostics.ReportUndefinedType(syntax.Identifier.Location, syntax.Identifier.Text);
            }

            return type;
        }

        private BoundStatement BindIfStatement(IfStatementSyntax syntax)
        {
            var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);
            var thenStatement = BindStatement(syntax.ThenStatement);
            var elseStatement = syntax.ElseClause == null ? null : BindStatement(syntax.ElseClause.ElseStatement);
            return new BoundIfStatement(condition, thenStatement, elseStatement);
        }

        private BoundStatement BindForInfiniteStatement(ForInfiniteStatementSyntax syntax)
        {
            scope = new BoundScope(scope);

            var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

            scope = scope.Parent;

            return new BoundForInfiniteStatement(body, breakLabel, continueLabel);
        }

        private BoundStatement BindForEllipsisStatement(ForEllipsisStatementSyntax syntax)
        {
            var lowerBound = BindExpression(syntax.LowerBound, TypeSymbol.Int);
            var upperBound = BindExpression(syntax.UpperBound, TypeSymbol.Int);

            scope = new BoundScope(scope);

            var variable = BindVariableDeclaration(syntax.Identifier, isReadOnly: false, type: TypeSymbol.Int);
            var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

            scope = scope.Parent;

            return new BoundForEllipsisStatement(variable, lowerBound, upperBound, body, breakLabel, continueLabel);
        }

        private BoundStatement BindLoopBody(StatementSyntax body, out BoundLabel breakLabel, out BoundLabel continueLabel)
        {
            labelCounter++;
            breakLabel = new BoundLabel($"break{labelCounter}");
            continueLabel = new BoundLabel($"continue{labelCounter}");

            loopStack.Push((breakLabel, continueLabel));
            var boundBody = BindStatement(body);
            loopStack.Pop();

            return boundBody;
        }

        private BoundStatement BindBreakStatement(BreakStatementSyntax syntax)
        {
            if (loopStack.Count == 0)
            {
                Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text);
                return BindErrorStatement();
            }

            var breakLabel = loopStack.Peek().BreakLabel;
            return new BoundGotoStatement(breakLabel);
        }

        private BoundStatement BindContinueStatement(ContinueStatementSyntax syntax)
        {
            if (loopStack.Count == 0)
            {
                Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text);
                return BindErrorStatement();
            }

            var continueLabel = loopStack.Peek().ContinueLabel;
            return new BoundGotoStatement(continueLabel);
        }

        private BoundStatement BindReturnStatement(ReturnStatementSyntax syntax)
        {
            var expression = syntax.Expression == null ? null : BindExpression(syntax.Expression);

            if (function == null)
            {
                Diagnostics.ReportInvalidReturn(syntax.ReturnKeyword.Location);
            }
            else
            {
                if (function.Type == TypeSymbol.Void)
                {
                    if (expression != null)
                    {
                        Diagnostics.ReportInvalidReturnExpression(syntax.Expression.Location, function.Name);
                    }
                }
                else
                {
                    if (expression == null)
                    {
                        Diagnostics.ReportMissingReturnExpression(syntax.ReturnKeyword.Location, function.Type);
                    }
                    else
                    {
                        expression = BindConversion(syntax.Expression.Location, expression, function.Type);
                    }
                }
            }

            return new BoundReturnStatement(expression);
        }

        private BoundStatement BindExpressionStatement(ExpressionStatementSyntax syntax)
        {
            var expression = BindExpression(syntax.Expression, canBeVoid: true);
            return new BoundExpressionStatement(expression);
        }

        private BoundExpression BindExpression(ExpressionSyntax syntax, TypeSymbol targetType)
        {
            return BindConversion(syntax, targetType);
        }

        private BoundExpression BindExpression(ExpressionSyntax syntax, bool canBeVoid = false)
        {
            var result = BindExpressionpublic(syntax);
            if (!canBeVoid && result.Type == TypeSymbol.Void)
            {
                Diagnostics.ReportExpressionMustHaveValue(syntax.Location);
                return new BoundErrorExpression();
            }

            return result;
        }

        private BoundExpression BindExpressionpublic(ExpressionSyntax syntax)
        {
            switch (syntax.Kind)
            {
                case SyntaxKind.ParenthesizedExpression:
                    return BindParenthesizedExpression((ParenthesizedExpressionSyntax)syntax);
                case SyntaxKind.LiteralExpression:
                    return BindLiteralExpression((LiteralExpressionSyntax)syntax);
                case SyntaxKind.NameExpression:
                    return BindNameExpression((NameExpressionSyntax)syntax);
                case SyntaxKind.AssignmentExpression:
                    return BindAssignmentExpression((AssignmentExpressionSyntax)syntax);
                case SyntaxKind.UnaryExpression:
                    return BindUnaryExpression((UnaryExpressionSyntax)syntax);
                case SyntaxKind.BinaryExpression:
                    return BindBinaryExpression((BinaryExpressionSyntax)syntax);
                case SyntaxKind.CallExpression:
                    return BindCallExpression((CallExpressionSyntax)syntax);
                case SyntaxKind.AccessorExpression:
                    return BindAccessorExpression((AccessorExpressionSyntax)syntax);
                default:
                    throw new Exception($"Unexpected syntax {syntax.Kind}");
            }
        }

        private BoundExpression BindParenthesizedExpression(ParenthesizedExpressionSyntax syntax)
        {
            return BindExpression(syntax.Expression);
        }

        private BoundExpression BindLiteralExpression(LiteralExpressionSyntax syntax)
        {
            var value = syntax.Value ?? 0;
            return new BoundLiteralExpression(value);
        }

        private BoundExpression BindNameExpression(NameExpressionSyntax syntax)
        {
            var name = syntax.IdentifierToken.Text;
            if (syntax.IdentifierToken.IsMissing)
            {
                // This means the token was inserted by the parser. We already
                // reported error so we can just return an error expression.
                return new BoundErrorExpression();
            }

            var variable = BindVariableReference(name, syntax.IdentifierToken.Location);
            if (variable == null)
            {
                return new BoundErrorExpression();
            }

            return new BoundVariableExpression(variable);
        }

        private BoundExpression BindAssignmentExpression(AssignmentExpressionSyntax syntax)
        {
            var name = syntax.IdentifierToken.Text;
            var boundExpression = BindExpression(syntax.Expression);

            var variable = BindVariableReference(name, syntax.IdentifierToken.Location);
            if (variable == null)
            {
                return boundExpression;
            }

            if (variable.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }

            var convertedExpression = BindConversion(syntax.Expression.Location, boundExpression, variable.Type);

            return new BoundAssignmentExpression(variable, convertedExpression);
        }

        private BoundExpression BindUnaryExpression(UnaryExpressionSyntax syntax)
        {
            var boundOperand = BindExpression(syntax.Operand);

            if (boundOperand.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression();
            }

            var boundOperator = BoundUnaryOperator.Bind(syntax.OperatorToken.Kind, boundOperand.Type);

            if (boundOperator == null)
            {
                Diagnostics.ReportUndefinedUnaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, boundOperand.Type);
                return new BoundErrorExpression();
            }

            return new BoundUnaryExpression(boundOperator, boundOperand);
        }

        private BoundExpression BindBinaryExpression(BinaryExpressionSyntax syntax)
        {
            var boundLeft = BindExpression(syntax.Left);
            var boundRight = BindExpression(syntax.Right);

            if (boundLeft.Type == TypeSymbol.Error || boundRight.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression();
            }

            var boundOperator = BoundBinaryOperator.Bind(syntax.OperatorToken.Kind, boundLeft.Type, boundRight.Type);

            if (boundOperator == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, boundLeft.Type, boundRight.Type);
                return new BoundErrorExpression();
            }

            return new BoundBinaryExpression(boundLeft, boundOperator, boundRight);
        }

        private BoundExpression BindCallExpression(CallExpressionSyntax syntax)
        {
            if (syntax.Arguments.Count == 1 && LookupType(syntax.Identifier.Text) is TypeSymbol type)
            {
                return BindConversion(syntax.Arguments[0], type, allowExplicit: true);
            }

            var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();

            foreach (var argument in syntax.Arguments)
            {
                var boundArgument = BindExpression(argument);
                boundArguments.Add(boundArgument);
            }

            var symbol = scope.TryLookupSymbol(syntax.Identifier.Text);
            if (symbol == null)
            {
                Diagnostics.ReportUndefinedFunction(syntax.Identifier.Location, syntax.Identifier.Text);
                return new BoundErrorExpression();
            }

            var function = symbol as FunctionSymbol;
            if (function == null)
            {
                Diagnostics.ReportNotAFunction(syntax.Identifier.Location, syntax.Identifier.Text);
                return new BoundErrorExpression();
            }

            if (syntax.Arguments.Count != function.Parameters.Length)
            {
                TextSpan span;
                if (syntax.Arguments.Count > function.Parameters.Length)
                {
                    SyntaxNode firstExceedingNode;
                    if (function.Parameters.Length > 0)
                    {
                        firstExceedingNode = syntax.Arguments.GetSeparator(function.Parameters.Length - 1);
                    }
                    else
                    {
                        firstExceedingNode = syntax.Arguments[0];
                    }

                    var lastExceedingArgument = syntax.Arguments[syntax.Arguments.Count - 1];
                    span = TextSpan.FromBounds(firstExceedingNode.Span.Start, lastExceedingArgument.Span.End);
                }
                else
                {
                    span = syntax.CloseParenthesisToken.Span;
                }

                Diagnostics.ReportWrongArgumentCount(new TextLocation(syntax.Location.Text, span), function.Name, function.Parameters.Length, syntax.Arguments.Count);
                return new BoundErrorExpression();
            }

            bool hasErrors = false;
            for (var i = 0; i < syntax.Arguments.Count; i++)
            {
                var argument = boundArguments[i];
                var parameter = function.Parameters[i];

                if (argument.Type != parameter.Type)
                {
                    if (argument.Type != TypeSymbol.Error)
                    {
                        Diagnostics.ReportWrongArgumentType(syntax.Arguments[i].Location, parameter.Name, parameter.Type, argument.Type);
                    }

                    hasErrors = true;
                }
            }

            if (hasErrors)
            {
                return new BoundErrorExpression();
            }

            return new BoundCallExpression(function, boundArguments.ToImmutable());
        }

        private BoundExpression BindAccessorExpression(AccessorExpressionSyntax syntax)
        {
            // Hack: for now this is only supported for imported types on the left
            var leftPart = (NameExpressionSyntax)syntax.LeftPart;
            var foundClass = scope.TryLookupImportedClass(leftPart.IdentifierToken.Text, syntax.LeftPart, out var importedClass);
            if (!foundClass)
            {
                Diagnostics.ReportUnableToFindType(leftPart.Location, leftPart.IdentifierToken.Text);
                return new BoundErrorExpression();
            }

            var rightPart = syntax.RightPart;
            switch (rightPart)
            {
                case NameExpressionSyntax ne:
                    var foundMember = importedClass.TryLookupMember(ne.IdentifierToken.Text, ne, out var member);
                    if (!foundMember)
                    {
                        Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                        return new BoundErrorExpression();
                    }

                    break;
                case CallExpressionSyntax ce:
                    var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
                    foreach (var argument in ce.Arguments)
                    {
                        var boundArgument = BindExpression(argument);
                        boundArguments.Add(boundArgument);
                    }

                    var arguments = boundArguments.ToImmutable();
                    var foundFunction = importedClass.TryLookupFunction(ce.Identifier.Text, ce, arguments, out var function);
                    if (!foundFunction)
                    {
                        Diagnostics.ReportUnableToFindFunction(ce.Location, ce.Identifier.Text);
                        return new BoundErrorExpression();
                    }

                    return new BoundImportedCallExpression(function, arguments);
                default:
                    return new BoundErrorExpression();
            }

            return new BoundErrorExpression();
        }

        private BoundExpression BindConversion(ExpressionSyntax syntax, TypeSymbol type, bool allowExplicit = false)
        {
            var expression = BindExpression(syntax);
            return BindConversion(syntax.Location, expression, type, allowExplicit);
        }

        private BoundExpression BindConversion(TextLocation diagnosticLocation, BoundExpression expression, TypeSymbol type, bool allowExplicit = false)
        {
            var conversion = Conversion.Classify(expression.Type, type);

            if (!conversion.Exists)
            {
                if (expression.Type != TypeSymbol.Error && type != TypeSymbol.Error)
                {
                    Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, type);
                }

                return new BoundErrorExpression();
            }

            if (!allowExplicit && conversion.IsExplicit)
            {
                Diagnostics.ReportCannotConvertImplicitly(diagnosticLocation, expression.Type, type);
            }

            if (conversion.IsIdentity)
            {
                return expression;
            }

            return new BoundConversionExpression(type, expression);
        }

        private VariableSymbol BindVariableDeclaration(SyntaxToken identifier, bool isReadOnly, TypeSymbol type)
        {
            var name = identifier.Text ?? "?";
            var declare = !identifier.IsMissing;
            var variable = function == null
                                ? (VariableSymbol)new GlobalVariableSymbol(name, isReadOnly, type)
                                : new LocalVariableSymbol(name, isReadOnly, type);

            if (declare && !scope.TryDeclareVariable(variable))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, name);
            }

            return variable;
        }

        private VariableSymbol BindVariableReference(string name, TextLocation location)
        {
            switch (scope.TryLookupSymbol(name))
            {
                case VariableSymbol variable:
                    return variable;

                case null:
                    Diagnostics.ReportUndefinedVariable(location, name);
                    return null;

                default:
                    Diagnostics.ReportNotAVariable(location, name);
                    return null;
            }
        }

        private TypeSymbol LookupType(string name)
        {
            switch (name)
            {
                case "bool":
                    return TypeSymbol.Bool;
                case "int":
                    return TypeSymbol.Int;
                case "string":
                    return TypeSymbol.String;
                default:
                    return null;
            }
        }
    }
}
