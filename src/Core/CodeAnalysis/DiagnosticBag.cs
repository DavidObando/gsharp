// <copyright file="DiagnosticBag.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis
{
    using System;
    using System.Collections;
    using System.Collections.Generic;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.CodeAnalysis.Text;

    /// <summary>
    /// Represents a collection of code analysis diagnostics information.
    /// </summary>
    public sealed class DiagnosticBag : IEnumerable<Diagnostic>
    {
        private readonly List<Diagnostic> diagnostics = new List<Diagnostic>();

        /// <inheritdoc/>
        public IEnumerator<Diagnostic> GetEnumerator() => diagnostics.GetEnumerator();

        /// <inheritdoc/>
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        /// <summary>
        /// Adds the diagnotics contained by the specified diagnostics bag into
        /// this instance.
        /// </summary>
        /// <param name="diagnostics">The diagnostics bag to copy from.</param>
        public void AddRange(DiagnosticBag diagnostics)
        {
            this.diagnostics.AddRange(diagnostics.diagnostics);
        }

        /// <summary>
        /// Reports a bad character during lexing.
        /// </summary>
        /// <param name="position">Position in the stream.</param>
        /// <param name="character">The unexpected bad character.</param>
        public void ReportBadCharacter(int position, char character)
        {
            var span = new TextSpan(position, 1);
            var message = $"Bad character input: '{character}'.";
            Report(span, message);
        }

        /// <summary>
        /// Reports an unterminated string literal.
        /// </summary>
        /// <param name="span">Span where unterminated string was found.</param>
        public void ReportUnterminatedString(TextSpan span)
        {
            var message = "Unterminated string literal.";
            Report(span, message);
        }

        /// <summary>
        /// Reports a number literal as invalid.
        /// </summary>
        /// <param name="span">Span where literal was found.</param>
        /// <param name="text">Text found in the source document.</param>
        /// <param name="type">Expected type.</param>
        public void ReportInvalidNumber(TextSpan span, string text, TypeSymbol type)
        {
            var message = $"The number {text} isn't valid {type}.";
            Report(span, message);
        }

        /// <summary>
        /// Reports an unexpected token while parsing.
        /// </summary>
        /// <param name="span">The text span where the token was found.</param>
        /// <param name="actualKind">The kind of syntax encountered.</param>
        /// <param name="expectedKind">The kind of syntax expected.</param>
        public void ReportUnexpectedToken(TextSpan span, SyntaxKind actualKind, SyntaxKind expectedKind)
        {
            var message = $"Unexpected token <{actualKind}>, expected <{expectedKind}>.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that not all code paths return a value.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        public void ReportAllPathsMustReturn(TextSpan span)
        {
            var message = "Not all code paths return a value.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that a parameter with the given name already exists.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="parameterName">The name of the parameter.</param>
        public void ReportParameterAlreadyDeclared(TextSpan span, string parameterName)
        {
            var message = $"A parameter with the name '{parameterName}' already exists.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that a symbol is already declared.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="name">The name of the symbol.</param>
        public void ReportSymbolAlreadyDeclared(TextSpan span, string name)
        {
            var message = $"'{name}' is already declared.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that a type doesn't exist.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="name">The type name.</param>
        public void ReportUndefinedType(TextSpan span, string name)
        {
            var message = $"Type '{name}' doesn't exist.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that the keyworkd can only be used inside of loops.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="text">The keyword.</param>
        public void ReportInvalidBreakOrContinue(TextSpan span, string text)
        {
            var message = $"The keyword '{text}' can only be used inside of loops.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that the return keyword can only be used inside of functions.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        public void ReportInvalidReturn(TextSpan span)
        {
            var message = "The 'return' keyword can only be used inside of functions.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that the return value cannot be followed for an expression in functions without a return type.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="functionName">The name of the function.</param>
        public void ReportInvalidReturnExpression(TextSpan span, string functionName)
        {
            var message = $"Since the function '{functionName}' does not return a value the 'return' keyword cannot be followed by an expression.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that an expression of a given type was expected.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="returnType">The expected type.</param>
        public void ReportMissingReturnExpression(TextSpan span, TypeSymbol returnType)
        {
            var message = $"An expression of type '{returnType}' expected.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that an expression must have a value.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        public void ReportExpressionMustHaveValue(TextSpan span)
        {
            var message = "Expression must have a value.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that a variable doesn't exist.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="name">The name of the variable.</param>
        public void ReportUndefinedName(TextSpan span, string name)
        {
            var message = $"Variable '{name}' doesn't exist.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that the specified variable is read-only and cannot be assigned.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="name">The name of the variable.</param>
        public void ReportCannotAssign(TextSpan span, string name)
        {
            var message = $"Variable '{name}' is read-only and cannot be assigned to.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that the specified unary operator is not defined for the specified type.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="operatorText">The operator text.</param>
        /// <param name="operandType">The operand type.</param>
        public void ReportUndefinedUnaryOperator(TextSpan span, string operatorText, TypeSymbol operandType)
        {
            var message = $"Unary operator '{operatorText}' is not defined for type '{operandType}'.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that the specified unary operator is not defined for the specified types.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="operatorText">The operator text.</param>
        /// <param name="leftType">The left operand type.</param>
        /// <param name="rightType">The right operand type.</param>
        public void ReportUndefinedBinaryOperator(TextSpan span, string operatorText, TypeSymbol leftType, TypeSymbol rightType)
        {
            var message = $"Binary operator '{operatorText}' is not defined for types '{leftType}' and '{rightType}'.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that the function doesn't exist.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="name">The function name.</param>
        public void ReportUndefinedFunction(TextSpan span, string name)
        {
            var message = $"Function '{name}' doesn't exist.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that the function requires a different amount of arguments.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="name">The function name.</param>
        /// <param name="expectedCount">The expected argument count.</param>
        /// <param name="actualCount">The actual argument count.</param>
        public void ReportWrongArgumentCount(TextSpan span, string name, int expectedCount, int actualCount)
        {
            var message = $"Function '{name}' requires {expectedCount} arguments but was given {actualCount}.";
            Report(span, message);
        }

        /// <summary>
        /// Reports that the parameter requires a value of a different type.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="name">The parameter name.</param>
        /// <param name="expectedType">The expected type.</param>
        /// <param name="actualType">The actual type.</param>
        public void ReportWrongArgumentType(TextSpan span, string name, TypeSymbol expectedType, TypeSymbol actualType)
        {
            var message = $"Parameter '{name}' requires a value of type '{expectedType}' but was given a value of type '{actualType}'.";
            Report(span, message);
        }

        /// <summary>
        /// Rerpots that there's no conversion from one type to the other.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="fromType">From type.</param>
        /// <param name="toType">To type.</param>
        public void ReportCannotConvert(TextSpan span, TypeSymbol fromType, TypeSymbol toType)
        {
            var message = $"Cannot convert type '{fromType}' to '{toType}'.";
            Report(span, message);
        }

        /// <summary>
        /// Rerpots that there's no implicit conversion from one type to the other.
        /// </summary>
        /// <param name="span">The text span where the error was found.</param>
        /// <param name="fromType">From type.</param>
        /// <param name="toType">To type.</param>
        public void ReportCannotConvertImplicitly(TextSpan span, TypeSymbol fromType, TypeSymbol toType)
        {
            var message = $"Cannot convert type '{fromType}' to '{toType}'. An explicit conversion exists (are you missing a cast?)";
            Report(span, message);
        }

        private void Report(TextSpan span, string message)
        {
            var diagnostic = new Diagnostic(span, message);
            diagnostics.Add(diagnostic);
        }
    }
}
