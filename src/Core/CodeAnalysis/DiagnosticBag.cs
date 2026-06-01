// <copyright file="DiagnosticBag.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis;

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
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="character">The unexpected bad character.</param>
    public void ReportBadCharacter(TextLocation location, char character)
    {
        var message = $"Bad character input: '{character}'.";
        Report(location, "GS0001", message);
    }

    /// <summary>
    /// Reports an unterminated comment.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportUnterminatedComment(TextLocation location)
    {
        var message = "Unterminated comment.";
        Report(location, "GS0002", message);
    }

    /// <summary>
    /// Reports an unterminated string literal.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportUnterminatedString(TextLocation location)
    {
        var message = "Unterminated string literal.";
        Report(location, "GS0003", message);
    }

    /// <summary>
    /// Reports a number literal as invalid.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">Text found in the source document.</param>
    /// <param name="type">Expected type.</param>
    public void ReportInvalidNumber(TextLocation location, string text, TypeSymbol type)
    {
        var message = $"The number {text} isn't valid {type}.";
        Report(location, "GS0004", message);
    }

    /// <summary>
    /// Reports an unexpected token while parsing.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="actualKind">The kind of syntax encountered.</param>
    /// <param name="expectedKind">The kind of syntax expected.</param>
    public void ReportUnexpectedToken(TextLocation location, SyntaxKind actualKind, SyntaxKind expectedKind)
    {
        var message = $"Unexpected token <{actualKind}>, expected <{expectedKind}>.";
        Report(location, "GS0005", message);
    }

    /// <summary>
    /// Reports that not all code paths return a value.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportAllPathsMustReturn(TextLocation location)
    {
        var message = "Not all code paths return a value.";
        Report(location, "GS0100", message);
    }

    /// <summary>
    /// Reports that a parameter with the given name already exists.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="parameterName">The name of the parameter.</param>
    public void ReportParameterAlreadyDeclared(TextLocation location, string parameterName)
    {
        var message = $"A parameter with the name '{parameterName}' already exists.";
        Report(location, "GS0101", message);
    }

    /// <summary>
    /// Reports that a symbol is already declared.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the symbol.</param>
    public void ReportSymbolAlreadyDeclared(TextLocation location, string name)
    {
        var message = $"'{name}' is already declared.";
        Report(location, "GS0102", message);
    }

    /// <summary>
    /// Reports that a same-package receiver declaration targets a non-aggregate type.
    /// </summary>
    /// <param name="location">The text location where the receiver type was found.</param>
    /// <param name="receiverTypeName">The receiver type name.</param>
    public void ReportMethodReceiverMustBeStructOrClass(TextLocation location, string receiverTypeName)
    {
        var message = $"Method receiver type '{receiverTypeName}' must be a struct or class declared in the same package.";
        Report(location, "GS0103", message);
    }

    /// <summary>
    /// Reports that a <c>data struct</c> was declared with no fields (ADR-0029).
    /// </summary>
    /// <param name="location">The text location of the struct identifier.</param>
    /// <param name="name">The struct name.</param>
    public void ReportEmptyDataStruct(TextLocation location, string name)
    {
        var message = $"'data struct {name}' requires at least one field; use 'struct' instead.";
        Report(location, "GS0104", message);
    }

    /// <summary>Reports that an inline struct does not declare exactly one field.</summary>
    /// <param name="location">The text location of the struct identifier.</param>
    /// <param name="name">The struct name.</param>
    /// <param name="actualCount">The actual field count.</param>
    public void ReportInlineStructRequiresExactlyOneField(TextLocation location, string name, int actualCount)
    {
        var message = $"'inline struct {name}' requires exactly one field, but has {actualCount}.";
        Report(location, "GS0105", message);
    }

    /// <summary>Reports that the <c>inline</c> modifier was combined with <c>data</c> or <c>record</c>.</summary>
    /// <param name="location">The text location of the conflicting modifier.</param>
    public void ReportInlineCannotBeCombinedWithData(TextLocation location)
    {
        Report(location, "GS0106", "'inline' cannot be combined with 'data' or 'record'.");
    }

    /// <summary>Reports that inline and open modifiers were combined.</summary>
    /// <param name="location">The text location of the conflicting modifier.</param>
    public void ReportInlineCannotBeCombinedWithOpen(TextLocation location)
    {
        Report(location, "GS0107", "'inline struct' cannot be combined with 'open'.");
    }

    /// <summary>Reports that a synthesized inline-struct member was hand-written.</summary>
    /// <param name="location">The text location of the member name.</param>
    /// <param name="typeName">The inline struct type name.</param>
    /// <param name="memberName">The synthesized member name.</param>
    public void ReportInlineStructSynthesizedMemberConflict(TextLocation location, string typeName, string memberName)
    {
        var message = $"Inline struct '{typeName}' synthesizes member '{memberName}'; it cannot be declared explicitly.";
        Report(location, "GS0108", message);
    }

    /// <summary>
    /// Reports that the <c>record</c> alias cannot be combined with the <c>data</c> contextual keyword.
    /// </summary>
    /// <param name="location">The text location of the <c>data</c> keyword.</param>
    public void ReportRecordCannotBeCombinedWithDataKeyword(TextLocation location)
    {
        Report(location, "GS0109", "'record' is an alias for 'data struct' and cannot be combined with 'data'.");
    }

    /// <summary>
    /// Reports that an enum declaration contains no members.
    /// </summary>
    /// <param name="location">The text location of the enum identifier.</param>
    /// <param name="enumName">The enum name.</param>
    public void ReportEmptyEnumDeclaration(TextLocation location, string enumName)
    {
        var message = $"Enum '{enumName}' must declare at least one member.";
        Report(location, "GS0110", message);
    }

    /// <summary>
    /// Reports that an enum declares the same member more than once.
    /// </summary>
    /// <param name="location">The text location of the duplicate member.</param>
    /// <param name="memberName">The duplicate member name.</param>
    /// <param name="enumName">The enum name.</param>
    public void ReportDuplicateEnumMember(TextLocation location, string memberName, string enumName)
    {
        var message = $"Enum '{enumName}' already declares a member named '{memberName}'.";
        Report(location, "GS0111", message);
    }

    /// <summary>
    /// Reports that an enum member access references an unknown member.
    /// </summary>
    /// <param name="location">The text location of the unknown member.</param>
    /// <param name="memberName">The unknown member name.</param>
    /// <param name="enumName">The enum name.</param>
    public void ReportUndefinedEnumMember(TextLocation location, string memberName, string enumName)
    {
        var message = $"Enum '{enumName}' does not define a member named '{memberName}'.";
        Report(location, "GS0112", message);
    }

    /// <summary>
    /// Reports that a type doesn't exist.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The type name.</param>
    public void ReportUndefinedType(TextLocation location, string name)
    {
        var message = $"Type '{name}' doesn't exist.";
        Report(location, "GS0113", message);
    }

    /// <summary>
    /// Reports that the array length is not a valid non-negative integer literal.
    /// </summary>
    /// <param name="location">The text location.</param>
    /// <param name="text">The length token text.</param>
    public void ReportInvalidArrayLength(TextLocation location, string text)
    {
        var message = $"Array length '{text}' must be a non-negative integer literal.";
        Report(location, "GS0114", message);
    }

    /// <summary>
    /// Reports that the number of array initialisers does not match the declared length.
    /// </summary>
    /// <param name="location">The text location.</param>
    /// <param name="expected">The declared length.</param>
    /// <param name="actual">The provided initialiser count.</param>
    public void ReportArrayLiteralLengthMismatch(TextLocation location, int expected, int actual)
    {
        var message = $"Array literal expects {expected} initialisers but got {actual}.";
        Report(location, "GS0115", message);
    }

    /// <summary>
    /// Reports that indexing was attempted on a non-array expression.
    /// </summary>
    /// <param name="location">The text location.</param>
    /// <param name="type">The actual type.</param>
    public void ReportTypeNotIndexable(TextLocation location, TypeSymbol type)
    {
        var message = $"Type '{type.Name}' is not indexable.";
        Report(location, "GS0116", message);
    }

    /// <summary>
    /// Reports that a built-in intrinsic was applied to an unsupported argument type.
    /// </summary>
    /// <param name="location">The text location of the offending argument.</param>
    /// <param name="name">The intrinsic name.</param>
    /// <param name="type">The actual argument type.</param>
    public void ReportIntrinsicArgumentType(TextLocation location, string name, TypeSymbol type)
    {
        var message = $"Built-in '{name}' cannot be applied to a value of type '{type.Name}'.";
        Report(location, "GS0117", message);
    }

    /// <summary>
    /// Reports that a 'try' statement has neither catch nor finally clauses.
    /// </summary>
    /// <param name="location">The text location of the 'try' keyword.</param>
    public void ReportTryWithoutCatchOrFinally(TextLocation location)
    {
        Report(location, "GS0118", "A 'try' statement requires at least one catch or finally clause.");
    }

    /// <summary>
    /// Reports that a type used in a 'using' declaration does not implement IDisposable.
    /// </summary>
    /// <param name="location">The text location of the using keyword.</param>
    /// <param name="type">The non-disposable type.</param>
    public void ReportTypeNotDisposable(TextLocation location, TypeSymbol type)
    {
        Report(location, "GS0119", $"Type '{type.Name}' cannot be used in a 'using' statement because it does not provide a public Dispose() method.");
    }

    /// <summary>
    /// Reports that the keyworkd can only be used inside of loops.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The keyword.</param>
    public void ReportInvalidBreakOrContinue(TextLocation location, string text)
    {
        var message = $"The keyword '{text}' can only be used inside of loops.";
        Report(location, "GS0120", message);
    }

    /// <summary>
    /// Reports that the return keyword can only be used inside of functions.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportInvalidReturn(TextLocation location)
    {
        var message = "The 'return' keyword can only be used inside of functions.";
        Report(location, "GS0121", message);
    }

    /// <summary>
    /// Reports that the return value cannot be followed for an expression in functions without a return type.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="functionName">The name of the function.</param>
    public void ReportInvalidReturnExpression(TextLocation location, string functionName)
    {
        var message = $"Since the function '{functionName}' does not return a value the 'return' keyword cannot be followed by an expression.";
        Report(location, "GS0122", message);
    }

    /// <summary>
    /// Reports that an expression of a given type was expected.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="returnType">The expected type.</param>
    public void ReportMissingReturnExpression(TextLocation location, TypeSymbol returnType)
    {
        var message = $"An expression of type '{returnType}' is expected.";
        Report(location, "GS0123", message);
    }

    /// <summary>
    /// Reports that an expression must have a value.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportExpressionMustHaveValue(TextLocation location)
    {
        var message = "Expression must have a value.";
        Report(location, "GS0124", message);
    }

    /// <summary>
    /// Reports that a variable doesn't exist.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the variable.</param>
    public void ReportUndefinedVariable(TextLocation location, string name)
    {
        var message = $"Variable '{name}' doesn't exist.";
        Report(location, "GS0125", message);
    }

    /// <summary>
    /// Reports that a name doesn't belong to a variable.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the variable.</param>
    public void ReportNotAVariable(TextLocation location, string name)
    {
        var message = $"'{name}' is not a variable.";
        Report(location, "GS0126", message);
    }

    /// <summary>
    /// Reports that the specified variable is read-only and cannot be assigned.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the variable.</param>
    public void ReportCannotAssign(TextLocation location, string name)
    {
        var message = $"Variable '{name}' is read-only and cannot be assigned to.";
        Report(location, "GS0127", message);
    }

    /// <summary>
    /// Reports that the specified unary operator is not defined for the specified type.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="operatorText">The operator text.</param>
    /// <param name="operandType">The operand type.</param>
    public void ReportUndefinedUnaryOperator(TextLocation location, string operatorText, TypeSymbol operandType)
    {
        var message = $"Unary operator '{operatorText}' is not defined for type '{operandType}'.";
        Report(location, "GS0128", message);
    }

    /// <summary>
    /// Reports that the specified unary operator is not defined for the specified types.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="operatorText">The operator text.</param>
    /// <param name="leftType">The left operand type.</param>
    /// <param name="rightType">The right operand type.</param>
    public void ReportUndefinedBinaryOperator(TextLocation location, string operatorText, TypeSymbol leftType, TypeSymbol rightType)
    {
        var message = $"Binary operator '{operatorText}' is not defined for types '{leftType}' and '{rightType}'.";
        Report(location, "GS0129", message);
    }

    /// <summary>
    /// Reports that the function doesn't exist.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The function name.</param>
    public void ReportUndefinedFunction(TextLocation location, string name)
    {
        var message = $"Function '{name}' doesn't exist.";
        Report(location, "GS0130", message);
    }

    /// <summary>
    /// Reports that the name doesn't belong to a function.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The function name.</param>
    public void ReportNotAFunction(TextLocation location, string name)
    {
        var message = $"'{name}' is not a function.";
        Report(location, "GS0131", message);
    }

    /// <summary>
    /// Reports that <c>await</c> appears outside an <c>async</c> function (Phase 5.1 / ADR-0023).
    /// </summary>
    /// <param name="location">The text location where the <c>await</c> keyword appears.</param>
    public void ReportAwaitOutsideAsyncFunction(TextLocation location)
    {
        var message = "'await' can only be used inside an 'async func'.";
        Report(location, "GS0132", message);
    }

    /// <summary>
    /// Reports that the operand of an <c>await</c> expression is not a Task (Phase 5.1 / ADR-0023).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    /// <param name="actualType">The actual type of the operand.</param>
    public void ReportTypeIsNotAwaitable(TextLocation location, TypeSymbol actualType)
    {
        var message = $"Expression of type '{actualType}' cannot be awaited; expected a 'Task' or 'Task[T]'.";
        Report(location, "GS0133", message);
    }

    /// <summary>
    /// Reports that the operand of an <c>await for v := range stream</c> statement is not an <c>IAsyncEnumerable[T]</c> (Phase 5.8 / ADR-0023).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    /// <param name="actualType">The actual type of the operand.</param>
    public void ReportTypeIsNotAsyncEnumerable(TextLocation location, TypeSymbol actualType)
    {
        var message = $"Expression of type '{actualType}' cannot be iterated with 'await for'; expected an 'IAsyncEnumerable[T]'.";
        Report(location, "GS0134", message);
    }

    /// <summary>
    /// Reports that the <c>async</c> modifier was used in a type-clause position
    /// without being followed by <c>sequence</c> or <c>func</c> (ADR-0042 / ADR-0043).
    /// </summary>
    /// <param name="location">The text location of the <c>async</c> modifier.</param>
    /// <param name="actualKind">The kind of the token actually following <c>async</c>.</param>
    public void ReportAsyncModifierInTypeClauseRequiresSequenceOrFunc(TextLocation location, SyntaxKind actualKind)
    {
        var message = $"The 'async' modifier in a type clause is only valid before 'sequence[T]' or 'func(...)'; found '<{actualKind}>'.";
        Report(location, "GS0135", message);
    }

    /// <summary>
    /// Reports that a <c>yield</c> statement was used outside an iterator function (ADR-0040).
    /// </summary>
    /// <param name="location">The text location of the yield keyword.</param>
    public void ReportYieldOutsideIteratorFunction(TextLocation location)
    {
        var message = "'yield' statement is not allowed outside an iterator function (a function returning IEnumerable[T] or sequence[T]).";
        Report(location, "GS0136", message);
    }

    /// <summary>
    /// Reports that the operand of a <c>go</c> statement is not a call expression (Phase 5.3 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    public void ReportGoOperandIsNotACall(TextLocation location)
    {
        var message = "'go' must be followed by a function or method call.";
        Report(location, "GS0137", message);
    }

    /// <summary>
    /// Reports that the operand of a <c>defer</c> statement is not a call expression (Phase 7.1 / ADR-0030).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    public void ReportDeferOperandIsNotACall(TextLocation location)
    {
        var message = "'defer' must be followed by a function or method call.";
        Report(location, "GS0138", message);
    }

    /// <summary>
    /// Reports that the operand of a channel-receive expression (<c>&lt;-ch</c>) is not a channel (Phase 5.5 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    /// <param name="actualType">The actual type of the operand.</param>
    public void ReportReceiveOperandIsNotChannel(TextLocation location, TypeSymbol actualType)
    {
        var message = $"The receive operator '<-' requires a channel operand; got '{actualType}'.";
        Report(location, "GS0139", message);
    }

    /// <summary>
    /// Reports that the left-hand side of a channel-send statement is not a channel (Phase 5.5 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the left-hand side.</param>
    /// <param name="actualType">The actual type of the left-hand side.</param>
    public void ReportSendTargetIsNotChannel(TextLocation location, TypeSymbol actualType)
    {
        var message = $"The send operator '<-' requires a channel on the left; got '{actualType}'.";
        Report(location, "GS0140", message);
    }

    /// <summary>
    /// Reports that the operand of <c>close(ch)</c> is not a channel (Phase 5.4 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    /// <param name="actualType">The actual type of the operand.</param>
    public void ReportCloseOperandIsNotChannel(TextLocation location, TypeSymbol actualType)
    {
        var message = $"'close' requires a channel operand; got '{actualType}'.";
        Report(location, "GS0141", message);
    }

    /// <summary>
    /// Reports a <c>select</c> with no arms (Phase 5.6 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the <c>select</c> keyword.</param>
    public void ReportSelectWithNoCases(TextLocation location)
    {
        var message = "'select' with no cases is unreachable.";
        Report(location, "GS0142", message);
    }

    /// <summary>
    /// Reports a <c>select</c> with more than one <c>default</c> arm (Phase 5.6 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the duplicate <c>default</c> keyword.</param>
    public void ReportSelectDuplicateDefault(TextLocation location)
    {
        var message = "'select' may have at most one 'default' arm.";
        Report(location, "GS0143", message);
    }

    /// <summary>
    /// Reports that the function requires a different amount of arguments.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The function name.</param>
    /// <param name="expectedCount">The expected argument count.</param>
    /// <param name="actualCount">The actual argument count.</param>
    public void ReportWrongArgumentCount(TextLocation location, string name, int expectedCount, int actualCount)
    {
        var message = $"Function '{name}' requires {expectedCount} arguments but was given {actualCount}.";
        Report(location, "GS0144", message);
    }

    /// <summary>Reports a variadic parameter (<c>...T</c>) that is not the last parameter (Phase 4.8).</summary>
    /// <param name="location">The text location of the offending parameter.</param>
    /// <param name="name">The parameter name.</param>
    public void ReportVariadicParameterMustBeLast(TextLocation location, string name)
    {
        var message = $"Variadic parameter '{name}' must be the last parameter.";
        Report(location, "GS0145", message);
    }

    /// <summary>Reports a variadic parameter used in a context that does not yet support it (Phase 4.8 — MVP: top-level functions only).</summary>
    /// <param name="location">The text location of the offending parameter.</param>
    /// <param name="name">The parameter name.</param>
    public void ReportVariadicParameterNotSupportedHere(TextLocation location, string name)
    {
        var message = $"Variadic parameter '{name}' is only supported on top-level function declarations.";
        Report(location, "GS0146", message);
    }

    /// <summary>Reports a call to a variadic function with too few fixed arguments (Phase 4.8).</summary>
    /// <param name="location">The text location of the call.</param>
    /// <param name="name">The callee name.</param>
    /// <param name="minimumCount">The minimum required argument count (fixed parameters).</param>
    /// <param name="actualCount">The actual argument count provided.</param>
    public void ReportTooFewArgumentsForVariadic(TextLocation location, string name, int minimumCount, int actualCount)
    {
        var message = $"Function '{name}' requires at least {minimumCount} arguments but was given {actualCount}.";
        Report(location, "GS0147", message);
    }

    /// <summary>Reports a generic call whose explicit type-argument list has the wrong arity (Phase 4.1 / ADR-0020).</summary>
    /// <param name="location">The text location of the type-argument list.</param>
    /// <param name="name">The callee name.</param>
    /// <param name="expectedCount">The expected number of type arguments.</param>
    /// <param name="actualCount">The actual number of type arguments.</param>
    public void ReportWrongTypeArgumentCount(TextLocation location, string name, int expectedCount, int actualCount)
    {
        Report(location, "GS0148", $"Generic function '{name}' requires {expectedCount} type arguments but was given {actualCount}.");
    }

    /// <summary>Reports a type-clause type-argument list applied to a non-generic type (Phase 4.3c / ADR-0020).</summary>
    /// <param name="location">The text location of the offending identifier.</param>
    /// <param name="name">The type name.</param>
    public void ReportTypeNotGeneric(TextLocation location, string name)
    {
        Report(location, "GS0149", $"Type '{name}' is not generic.");
    }

    /// <summary>Reports an interface type-parameter used in a position incompatible with its declared variance (Phase 4.3c / ADR-0021).</summary>
    /// <param name="location">The text location of the offending use.</param>
    /// <param name="typeParameterName">The type-parameter name.</param>
    /// <param name="declaredVariance">The declared variance (in/out).</param>
    /// <param name="usedPosition">The position the type-parameter was used in (input/output).</param>
    public void ReportTypeParameterVariancePositionViolation(TextLocation location, string typeParameterName, string declaredVariance, string usedPosition)
    {
        Report(location, "GS0150", $"Type parameter '{typeParameterName}' declared '{declaredVariance}' cannot appear in {usedPosition} position.");
    }

    /// <summary>Reports a generic call whose type arguments could not be inferred from the value arguments (Phase 4.1 / ADR-0020).</summary>
    /// <param name="location">The text location of the call.</param>
    /// <param name="name">The callee name.</param>
    /// <param name="typeParameterName">The unresolved type-parameter name.</param>
    public void ReportTypeArgumentInferenceFailed(TextLocation location, string name, string typeParameterName)
    {
        Report(location, "GS0151", $"Cannot infer type argument '{typeParameterName}' for generic function '{name}'; supply it explicitly via '[{typeParameterName}]'.");
    }

    /// <summary>Reports a generic call whose type argument does not satisfy the declared constraint (Phase 4.2 / ADR-0020).</summary>
    /// <param name="location">The text location of the offending type argument or call.</param>
    /// <param name="typeParameterName">The type-parameter name (e.g. <c>T</c>).</param>
    /// <param name="typeArgument">The supplied type argument.</param>
    /// <param name="constraintDescription">A human-readable description of the constraint (e.g. <c>comparable</c>).</param>
    public void ReportTypeArgumentDoesNotSatisfyConstraint(TextLocation location, string typeParameterName, TypeSymbol typeArgument, string constraintDescription)
    {
        Report(location, "GS0152", $"Type argument '{typeArgument}' for type parameter '{typeParameterName}' does not satisfy the '{constraintDescription}' constraint.");
    }

    /// <summary>Reports an interface used as a type-parameter constraint that is not <c>sealed</c> (Phase 4.2b / ADR-0020).</summary>
    /// <param name="location">The text location of the interface reference.</param>
    /// <param name="interfaceName">The interface name.</param>
    public void ReportInterfaceConstraintNotSealed(TextLocation location, string interfaceName)
    {
        Report(location, "GS0153", $"Interface '{interfaceName}' cannot be used as a type-parameter constraint because it is not declared 'sealed'.");
    }

    /// <summary>
    /// Reports that the parameter requires a value of a different type.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The parameter name.</param>
    /// <param name="expectedType">The expected type.</param>
    /// <param name="actualType">The actual type.</param>
    public void ReportWrongArgumentType(TextLocation location, string name, TypeSymbol expectedType, TypeSymbol actualType)
    {
        var message = $"Parameter '{name}' requires a value of type '{expectedType}' but was given a value of type '{actualType}'.";
        Report(location, "GS0154", message);
    }

    /// <summary>
    /// Rerpots that there's no conversion from one type to the other.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="fromType">From type.</param>
    /// <param name="toType">To type.</param>
    public void ReportCannotConvert(TextLocation location, TypeSymbol fromType, TypeSymbol toType)
    {
        var message = $"Cannot convert type '{fromType}' to '{toType}'.";
        Report(location, "GS0155", message);
    }

    /// <summary>
    /// Reports that there's no implicit conversion from one type to the other.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="fromType">From type.</param>
    /// <param name="toType">To type.</param>
    public void ReportCannotConvertImplicitly(TextLocation location, TypeSymbol fromType, TypeSymbol toType)
    {
        var message = $"Cannot convert type '{fromType}' to '{toType}'. An explicit conversion exists (are you missing a cast?)";
        Report(location, "GS0156", message);
    }

    /// <summary>
    /// Issue #337: reports that a CLR member method group cannot be converted to
    /// the expected target type (it is not a compatible delegate type, or no
    /// overload matches the delegate signature).
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="methodName">The method-group name.</param>
    /// <param name="toType">The expected target type.</param>
    public void ReportCannotConvertMethodGroup(TextLocation location, string methodName, TypeSymbol toType)
    {
        var message = $"Cannot convert method group '{methodName}' to '{toType}'. No overload matches the target delegate signature.";
        Report(location, "GS0218", message);
    }

    /// <summary>
    /// Reports that we couldn't find the specified type.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The text associated to the type.</param>
    public void ReportUnableToFindType(TextLocation location, string text)
    {
        var message = $"Cannot find type {text}. Are you missing an import?";
        Report(location, "GS0157", message);
    }

    /// <summary>
    /// Reports that we couldn't find the specified member.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The text associated to the member.</param>
    public void ReportUnableToFindMember(TextLocation location, string text)
    {
        var message = $"Cannot find member {text}.";
        Report(location, "GS0158", message);
    }

    /// <summary>
    /// Reports that we couldn't find the specified function.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The text associated to the function.</param>
    public void ReportUnableToFindFunction(TextLocation location, string text)
    {
        var message = $"Cannot find function {text}.";
        Report(location, "GS0159", message);
    }

    /// <summary>
    /// Reports that an overloaded call (constructor, static method, or
    /// instance method) is ambiguous between two or more applicable
    /// candidates under the binder's "better function member" rules.
    /// </summary>
    /// <param name="location">The text location of the call expression.</param>
    /// <param name="name">The function or constructor name.</param>
    /// <param name="candidateCount">The number of tied applicable candidates.</param>
    public void ReportAmbiguousOverload(TextLocation location, string name, int candidateCount)
    {
        var message = $"Call to '{name}' is ambiguous between {candidateCount} applicable overloads.";
        Report(location, "GS0160", message);
    }

    /// <summary>Reports that copy/with syntax was applied to a non-data-struct value.</summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="type">The actual receiver type.</param>
    public void ReportCopyOrWithNotDataStruct(TextLocation location, TypeSymbol type)
    {
        var message = $"copy/with requires a data struct receiver, but got '{type}'.";
        Report(location, "GS0161", message);
    }

    /// <summary>Reports that named arguments were used outside the scoped data-struct copy syntax.</summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportNamedArgumentOnlyValidForCopy(TextLocation location)
    {
        var message = "Named arguments are only supported for data-struct .copy(...).";
        Report(location, "GS0162", message);
    }

    /// <summary>Reports that a deconstruction target has the wrong number of elements.</summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="expected">The expected number of elements.</param>
    /// <param name="actual">The actual number of elements.</param>
    public void ReportDeconstructionFieldCountMismatch(TextLocation location, int expected, int actual)
    {
        var message = $"Deconstruction requires {expected} fields but was given {actual}.";
        Report(location, "GS0163", message);
    }

    /// <summary>Reports that positional deconstruction needs a tuple or data struct.</summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="type">The actual initializer type.</param>
    public void ReportDeconstructionRequiresTupleOrDataStruct(TextLocation location, TypeSymbol type)
    {
        var message = $"Deconstruction requires a tuple or data struct initializer, but got '{type}'.";
        Report(location, "GS0164", message);
    }

    /// <summary>
    /// Reports that top-level statements appear in more than one source file in
    /// the same compilation, which is not allowed.
    /// </summary>
    /// <param name="location">A location in one of the offending files.</param>
    public void ReportMultipleTopLevelFiles(TextLocation location)
    {
        var message = "Only one source file in a compilation may contain top-level statements.";
        Report(location, "GS0165", message);
    }

    /// <summary>
    /// Reports that the compilation contains both top-level statements and an
    /// explicit Main function, which is ambiguous.
    /// </summary>
    /// <param name="location">The location of the explicit Main function declaration.</param>
    public void ReportTopLevelStatementsConflictWithMain(TextLocation location)
    {
        var message = "Top-level statements cannot be used together with an explicit Main function.";
        Report(location, "GS0166", message);
    }

    /// <summary>
    /// Reports that a multi-target assignment or short variable declaration has
    /// a different number of targets and values.
    /// </summary>
    /// <param name="location">The text location of the statement.</param>
    /// <param name="targetCount">The number of left-hand targets.</param>
    /// <param name="valueCount">The number of right-hand values.</param>
    public void ReportMultiAssignmentMismatch(TextLocation location, int targetCount, int valueCount)
    {
        var message = $"Multi-assignment has {targetCount} target(s) but {valueCount} value(s).";
        Report(location, "GS0167", message);
    }

    /// <summary>
    /// Reports a use of the reserved <c>fallthrough</c> keyword (ADR-0013: GSharp
    /// does not support Go-style implicit case fallthrough).
    /// </summary>
    /// <param name="location">The text location where <c>fallthrough</c> was found.</param>
    public void ReportFallthroughNotSupported(TextLocation location)
    {
        var message = "'fallthrough' is not supported (ADR-0013). GSharp 'switch' cases do not fall through.";
        Report(location, "GS0168", message);
    }

    /// <summary>
    /// Reports a duplicate <c>default</c> arm in a switch statement.
    /// </summary>
    /// <param name="location">The text location of the offending default arm.</param>
    public void ReportDuplicateSwitchDefault(TextLocation location)
    {
        var message = "A 'switch' statement can only have one 'default' arm.";
        Report(location, "GS0169", message);
    }

    /// <summary>
    /// Reports a non-constant value used in a switch case.
    /// </summary>
    /// <param name="location">The text location of the offending case value.</param>
    public void ReportSwitchCaseValueNotConstant(TextLocation location)
    {
        var message = "Switch case value must be a constant expression.";
        Report(location, "GS0170", message);
    }

    /// <summary>
    /// Reports a switch case value whose type doesn't match the discriminant.
    /// </summary>
    /// <param name="location">The text location of the offending case value.</param>
    /// <param name="caseType">The case value type.</param>
    /// <param name="switchType">The switched-on discriminant type.</param>
    public void ReportSwitchCaseTypeMismatch(TextLocation location, TypeSymbol caseType, TypeSymbol switchType)
    {
        var message = $"Switch case value of type '{caseType}' is incompatible with switch expression of type '{switchType}'.";
        Report(location, "GS0171", message);
    }

    /// <summary>Reports that a property pattern was used on a non-aggregate type.</summary>
    /// <param name="location">The text location.</param>
    /// <param name="type">The discriminant type.</param>
    public void ReportPropertyPatternRequiresStructOrClass(TextLocation location, TypeSymbol type)
    {
        Report(location, "GS0172", $"Property pattern requires a struct or class value, not '{type}'.");
    }

    /// <summary>Reports that a property pattern references an unknown field.</summary>
    /// <param name="location">The text location.</param>
    /// <param name="fieldName">The field name.</param>
    /// <param name="type">The containing type.</param>
    public void ReportUndefinedFieldOnType(TextLocation location, string fieldName, TypeSymbol type)
    {
        Report(location, "GS0173", $"Type '{type}' does not define a field named '{fieldName}'.");
    }

    /// <summary>Reports that a relational pattern operator is not defined for a type.</summary>
    /// <param name="location">The text location.</param>
    /// <param name="op">The operator kind.</param>
    /// <param name="type">The operand type.</param>
    public void ReportRelationalPatternOperatorUndefined(TextLocation location, SyntaxKind op, TypeSymbol type)
    {
        Report(location, "GS0174", $"Relational pattern operator '{SyntaxFacts.GetText(op)}' is not defined for type '{type}'.");
    }

    /// <summary>Reports that a list pattern was used on a non-array/slice type.</summary>
    /// <param name="location">The text location.</param>
    /// <param name="type">The discriminant type.</param>
    public void ReportListPatternRequiresArrayOrSlice(TextLocation location, TypeSymbol type)
    {
        Report(location, "GS0175", $"List pattern requires an array or slice value, not '{type}'.");
    }

    /// <summary>
    /// Reports a switch expression without a default arm.
    /// </summary>
    /// <param name="location">The text location of the switch expression.</param>
    public void ReportSwitchExpressionMissingDefault(TextLocation location)
    {
        var message = "Switch expression must have a 'default' arm.";
        Report(location, "GS0176", message);
    }

    /// <summary>
    /// Reports a non-exhaustive switch expression over a closed discriminant.
    /// </summary>
    /// <param name="location">The text location of the switch expression.</param>
    /// <param name="discriminantTypeName">The discriminant type description.</param>
    /// <param name="missingNames">The missing variant names.</param>
    public void ReportSwitchExpressionNotExhaustive(TextLocation location, string discriminantTypeName, IEnumerable<string> missingNames)
    {
        var message = $"Switch expression on {discriminantTypeName} is not exhaustive: missing {FormatMissingNames(missingNames)}.";
        Report(location, "GS0177", message);
    }

    /// <summary>
    /// Reports a non-exhaustive switch statement over a closed discriminant.
    /// </summary>
    /// <param name="location">The text location of the switch statement.</param>
    /// <param name="discriminantTypeName">The discriminant type description.</param>
    /// <param name="missingNames">The missing variant names.</param>
    public void ReportSwitchStatementNotExhaustive(TextLocation location, string discriminantTypeName, IEnumerable<string> missingNames)
    {
        var message = $"Switch statement on {discriminantTypeName} is not exhaustive: missing {FormatMissingNames(missingNames)}.";
        Report(location, "GS0178", message);
    }

    /// <summary>
    /// Reports a switch-expression arm whose result type does not match the unified result type.
    /// </summary>
    /// <param name="location">The text location of the offending arm.</param>
    /// <param name="armType">The arm result type.</param>
    /// <param name="expectedType">The expected result type.</param>
    public void ReportSwitchExpressionArmTypeMismatch(TextLocation location, TypeSymbol armType, TypeSymbol expectedType)
    {
        var message = $"All switch-expression arms must produce the same type; expected '{expectedType}' but arm produces '{armType}'.";
        Report(location, "GS0179", message);
    }

    /// <summary>
    /// Reports an accessibility modifier (<c>public</c>/<c>internal</c>/<c>private</c>) appearing on a construct that does not accept one.
    /// </summary>
    /// <param name="location">The text location of the modifier token.</param>
    /// <param name="modifier">The modifier text.</param>
    public void ReportAccessibilityModifierNotAllowedHere(TextLocation location, string modifier)
    {
        var message = $"Accessibility modifier '{modifier}' is not allowed here. It is only valid on top-level 'func', 'type', 'var', 'let' and 'const' declarations.";
        Report(location, "GS0180", message);
    }

    /// <summary>Reports an attempt to subclass a sealed (non-<c>open</c>) class. Phase 3.B.3 sub-step 3 / ADR-0017.</summary>
    /// <param name="location">The text location of the base-type identifier.</param>
    /// <param name="baseTypeName">The base type name.</param>
    public void ReportBaseClassNotOpen(TextLocation location, string baseTypeName)
    {
        Report(location, "GS0181", $"Class '{baseTypeName}' is not open; declare 'open class {baseTypeName}' to allow subclassing.");
    }

    /// <summary>Reports base-constructor arguments (<c>: Base(args)</c>) on a class that declares no base class (issue #306).</summary>
    /// <param name="location">The text location of the base-constructor argument list.</param>
    public void ReportBaseConstructorArgumentsWithoutBase(TextLocation location)
    {
        Report(location, "GS0213", "A base-constructor argument list requires an explicit base class.");
    }

    /// <summary>Reports that no accessible base constructor matches the supplied base-constructor arguments (issue #306).</summary>
    /// <param name="location">The text location of the base-constructor argument list.</param>
    /// <param name="baseTypeName">The base type name.</param>
    /// <param name="argumentCount">The number of supplied arguments.</param>
    public void ReportNoMatchingBaseConstructor(TextLocation location, string baseTypeName, int argumentCount)
    {
        Report(location, "GS0214", $"Class '{baseTypeName}' has no accessible constructor that takes {argumentCount} argument(s).");
    }

    /// <summary>Reports a class that declares both a Kotlin-style primary constructor and an explicit <c>init(...)</c> constructor (issue #306).</summary>
    /// <param name="location">The text location of the offending <c>init</c> declaration.</param>
    /// <param name="className">The class name.</param>
    public void ReportPrimaryAndExplicitConstructors(TextLocation location, string className)
    {
        Report(location, "GS0215", $"Class '{className}' cannot declare both a primary constructor and an explicit 'init' constructor.");
    }

    /// <summary>Reports a class that declares more than one explicit <c>init(...)</c> constructor, which is not yet supported (issue #306).</summary>
    /// <param name="location">The text location of the offending <c>init</c> declaration.</param>
    /// <param name="className">The class name.</param>
    public void ReportMultipleConstructorsUnsupported(TextLocation location, string className)
    {
        Report(location, "GS0216", $"Class '{className}' declares multiple 'init' constructors; only a single explicit constructor is supported.");
    }

    /// <summary>Reports construction of a generic class that declares an explicit <c>init(...)</c> constructor, which is not yet supported (issue #306).</summary>
    /// <param name="location">The text location of the construction call.</param>
    /// <param name="className">The class name.</param>
    public void ReportGenericExplicitConstructorUnsupported(TextLocation location, string className)
    {
        Report(location, "GS0217", $"Generic class '{className}' with an explicit 'init' constructor cannot be constructed; generic explicit constructors are not supported.");
    }

    /// <summary>Reports a method that overrides a base method without using <c>override</c>. ADR-0017.</summary>
    /// <param name="location">The text location of the offending declaration.</param>
    /// <param name="baseTypeName">The base type name.</param>
    /// <param name="methodName">The method name.</param>
    public void ReportMissingOverride(TextLocation location, string baseTypeName, string methodName)
    {
        Report(location, "GS0182", $"Method '{baseTypeName}.{methodName}' is overridable; add 'override' to redefine it.");
    }

    /// <summary>Reports an <c>override</c> method that does not match any open base method. ADR-0017.</summary>
    /// <param name="location">The text location of the offending declaration.</param>
    /// <param name="methodName">The method name.</param>
    public void ReportNoBaseMethodToOverride(TextLocation location, string methodName)
    {
        Report(location, "GS0183", $"Method '{methodName}' is marked 'override' but no matching open base method was found.");
    }

    /// <summary>Reports an <c>override</c> targeting a method that is not <c>open</c> (sealed override). ADR-0017.</summary>
    /// <param name="location">The text location of the offending declaration.</param>
    /// <param name="methodName">The method name.</param>
    public void ReportOverrideOfSealedMethod(TextLocation location, string methodName)
    {
        Report(location, "GS0184", $"Method '{methodName}' cannot override the base method because the base method is not open.");
    }

    /// <summary>Reports a signature mismatch between an <c>override</c> method and its base method.</summary>
    /// <param name="location">The text location of the offending declaration.</param>
    /// <param name="methodName">The method name.</param>
    public void ReportOverrideSignatureMismatch(TextLocation location, string methodName)
    {
        Report(location, "GS0185", $"Override of method '{methodName}' must match the base method's parameter types and return type.");
    }

    /// <summary>Reports an interface method declared with a body (ADR-0018: Phase 3 interfaces are signature-only).</summary>
    /// <param name="location">The text location of the offending method identifier.</param>
    /// <param name="methodName">The method name.</param>
    public void ReportInterfaceMethodHasBody(TextLocation location, string methodName)
    {
        Report(location, "GS0186", $"Interface method '{methodName}' may not have a body in this version of GSharp; see ADR-0018.");
    }

    /// <summary>Reports a class that fails to implement an interface method.</summary>
    /// <param name="location">The text location of the class identifier.</param>
    /// <param name="className">The implementing class.</param>
    /// <param name="interfaceName">The interface name.</param>
    /// <param name="methodName">The missing method.</param>
    public void ReportInterfaceMethodNotImplemented(TextLocation location, string className, string interfaceName, string methodName)
    {
        Report(location, "GS0187", $"Class '{className}' does not implement interface method '{interfaceName}.{methodName}'.");
    }

    /// <summary>Phase 3.B.5: reports a class that implements a sealed interface declared in a different package.</summary>
    /// <param name="location">The text location of the implementing class identifier.</param>
    /// <param name="className">The implementing class.</param>
    /// <param name="interfaceName">The sealed interface name.</param>
    /// <param name="interfacePackage">The package owning the sealed interface.</param>
    public void ReportSealedInterfaceImplementorOutsidePackage(TextLocation location, string className, string interfaceName, string interfacePackage)
    {
        Report(location, "GS0188", $"Class '{className}' cannot implement sealed interface '{interfaceName}' from a different package ('{interfacePackage}').");
    }

    /// <summary>ADR-0051: reports an auto-property declared inside a <c>data struct</c>, which is not allowed.</summary>
    /// <param name="location">The text location of the property identifier.</param>
    /// <param name="propertyName">The property name.</param>
    public void ReportAutoPropertyInDataStruct(TextLocation location, string propertyName)
    {
        Report(location, "GS0189", $"Property '{propertyName}' cannot be an auto-property in a data struct; use a computed property with an explicit body instead.");
    }

    /// <summary>ADR-0051: reports an <c>open</c> member declared on a class that is not itself <c>open</c>.</summary>
    /// <param name="location">The text location of the <c>open</c> modifier.</param>
    /// <param name="memberName">The member name.</param>
    public void ReportOpenMemberInNonOpenClass(TextLocation location, string memberName)
    {
        Report(location, "GS0190", $"Member '{memberName}' is marked 'open' but the enclosing class is not open.");
    }

    /// <summary>GS9001: Cannot take address of a non-lvalue expression.</summary>
    /// <param name="location">The text location of the <c>&amp;</c> operator.</param>
    /// <param name="expressionText">A textual representation of the offending expression.</param>
    public void ReportCannotTakeAddressOfNonLvalue(TextLocation location, string expressionText)
    {
        Report(location, "GS9001", $"Cannot take address of '{expressionText}': expression is not an lvalue.");
    }

    /// <summary>GS9002: Argument must be passed by reference.</summary>
    /// <param name="location">The text location of the argument.</param>
    /// <param name="argumentIndex">The 1-based argument position.</param>
    /// <param name="methodName">The target method name.</param>
    public void ReportArgumentMustBePassedByRef(TextLocation location, int argumentIndex, string methodName)
    {
        Report(location, "GS9002", $"Argument {argumentIndex} to '{methodName}' must be passed by reference (`&`).");
    }

    /// <summary>GS9003: Variable must be definitely assigned before being passed by ref.</summary>
    /// <param name="location">The text location of the argument.</param>
    /// <param name="variableName">The variable name.</param>
    public void ReportVariableNotDefinitelyAssignedForRef(TextLocation location, string variableName)
    {
        Report(location, "GS9003", $"Variable '{variableName}' must be definitely assigned before being passed by `ref`.");
    }

    /// <summary>GS9004: By-ref value cannot escape its declaring scope.</summary>
    /// <param name="location">The text location of the escape attempt.</param>
    /// <param name="reason">Description of the escape (capture in lambda, return, store in field).</param>
    public void ReportByRefCannotEscape(TextLocation location, string reason)
    {
        Report(location, "GS9004", $"By-ref value cannot escape: {reason}.");
    }

    /// <summary>GS9005: Cannot take address of a constant.</summary>
    /// <param name="location">The text location of the <c>&amp;</c> operator.</param>
    /// <param name="constantName">The constant name.</param>
    public void ReportCannotTakeAddressOfConstant(TextLocation location, string constantName)
    {
        Report(location, "GS9005", $"Cannot take address of constant '{constantName}'.");
    }

    /// <summary>GS9006: Pointer type cannot be used as a field type.</summary>
    /// <param name="location">The text location of the field declaration.</param>
    /// <param name="typeName">The pointer type name.</param>
    public void ReportPointerTypeCannotBeFieldType(TextLocation location, string typeName)
    {
        Report(location, "GS9006", $"Pointer type '{typeName}' cannot be used as a field type.");
    }

    /// <summary>
    /// Reports that an <c>async func(...)</c> type clause has an explicit
    /// <c>Task[…]</c> (or other Task-shaped) return type. The <c>async</c>
    /// modifier already implies a Task wrap, so the explicit wrap is
    /// disallowed (ADR-0043).
    /// </summary>
    /// <param name="location">The text location of the offending return-type clause.</param>
    /// <param name="returnTypeName">The name of the explicit return type.</param>
    public void ReportAsyncFunctionTypeClauseHasExplicitTaskReturn(TextLocation location, string returnTypeName)
    {
        var message = $"The return type of an 'async func(...)' type clause is implicitly wrapped in 'Task'; do not write '{returnTypeName}' explicitly.";
        Report(location, "GS0189", message);
    }

    /// <summary>
    /// Reports that a <c>nameof(...)</c> argument is not a valid name
    /// reference (it must denote an identifier, member access, or type).
    /// </summary>
    /// <param name="location">The text location of the argument.</param>
    public void ReportNameOfRequiresNameReference(TextLocation location)
    {
        Report(location, "GS0190", "The argument to 'nameof' must be a name reference: an identifier, member access, or type.");
    }

    /// <summary>
    /// Reports a character literal that is missing a closing quote or
    /// whose body crosses a line terminator (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportUnterminatedCharLiteral(TextLocation location)
    {
        Report(location, "GS0191", "Unterminated character literal.");
    }

    /// <summary>
    /// Reports an empty character literal <c>''</c> (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportEmptyCharLiteral(TextLocation location)
    {
        Report(location, "GS0192", "Empty character literal; a character literal must contain exactly one code unit or escape.");
    }

    /// <summary>
    /// Reports a character literal containing more than one code unit
    /// (e.g. <c>'ab'</c>) per ADR-0046.
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportMultiCharCharLiteral(TextLocation location)
    {
        Report(location, "GS0193", "Character literal contains more than one code unit; use a string literal instead.");
    }

    /// <summary>
    /// Reports an unknown escape sequence inside a character literal
    /// (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    /// <param name="escapeChar">The unrecognised escape character.</param>
    public void ReportInvalidCharEscape(TextLocation location, char escapeChar)
    {
        Report(location, "GS0194", $"Unrecognised escape sequence '\\{escapeChar}' in character literal.");
    }

    /// <summary>
    /// Reports a malformed Unicode escape (<c>\\u</c>, <c>\\U</c>, or
    /// <c>\\x</c>) inside a character literal: too few hex digits, or in
    /// the case of <c>\\U</c>, a value outside the basic multilingual
    /// plane (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportInvalidUnicodeEscape(TextLocation location)
    {
        Report(location, "GS0195", "Malformed Unicode escape in character literal.");
    }

    /// <summary>
    /// Reports an annotation lead-in (<c>@</c>) that is not followed by an
    /// identifier or a use-site target qualifier (ADR-0047 §1).
    /// </summary>
    /// <param name="location">The source location of the offending token.</param>
    public void ReportAnnotationExpected(TextLocation location)
    {
        Report(location, "GS0196", "Annotation name expected after '@'.");
    }

    /// <summary>
    /// Reports an annotation use-site target qualifier whose kind is not one
    /// of the canonical kinds defined in ADR-0047 §2 (<c>field</c>,
    /// <c>param</c>, <c>return</c>, <c>type</c>, <c>method</c>,
    /// <c>property</c>, <c>event</c>, <c>module</c>, <c>assembly</c>,
    /// <c>genericparam</c>).
    /// </summary>
    /// <param name="location">The source location of the offending kind identifier.</param>
    /// <param name="kind">The unrecognized kind text.</param>
    public void ReportAnnotationTargetInvalid(TextLocation location, string kind)
    {
        Report(location, "GS0197", $"Annotation target '{kind}' is not a recognized use-site kind. Expected one of: field, param, return, type, method, property, event, module, assembly, genericparam.");
    }

    /// <summary>
    /// Reports an annotation whose name cannot be resolved to any type
    /// reachable from the declaring scope (ADR-0047 §3).
    /// </summary>
    /// <param name="location">The source location of the offending annotation name.</param>
    /// <param name="name">The unresolved annotation name as written in source.</param>
    public void ReportAttributeTypeNotFound(TextLocation location, string name)
    {
        Report(location, "GS0198", $"Attribute type '{name}' could not be found. Looked up both '{name}' and '{name}Attribute'.");
    }

    /// <summary>
    /// Reports an annotation whose name resolves to both <c>Foo</c> and
    /// <c>FooAttribute</c> in the declaring scope (ADR-0047 §3). The user
    /// must qualify the name to disambiguate.
    /// </summary>
    /// <param name="location">The source location of the offending annotation name.</param>
    /// <param name="name">The ambiguous annotation name as written in source.</param>
    public void ReportAmbiguousAttributeName(TextLocation location, string name)
    {
        Report(location, "GS0199", $"Attribute name '{name}' is ambiguous between '{name}' and '{name}Attribute'. Qualify the name to disambiguate.");
    }

    /// <summary>
    /// Reports an annotation whose resolved type does not derive from
    /// <c>System.Attribute</c> (ADR-0047 §3).
    /// </summary>
    /// <param name="location">The source location of the offending annotation.</param>
    /// <param name="typeName">The type name that fails the attribute check.</param>
    public void ReportNotAnAttributeType(TextLocation location, string typeName)
    {
        Report(location, "GS0200", $"Type '{typeName}' is not an attribute class (it does not derive from System.Attribute).");
    }

    /// <summary>
    /// Reports a use-site target qualifier that is valid in isolation but
    /// not permitted at the current declaration position (ADR-0047 §4).
    /// </summary>
    /// <param name="location">The source location of the offending target.</param>
    /// <param name="kind">The disallowed target kind text.</param>
    /// <param name="position">A human-readable description of the declaration position.</param>
    public void ReportAttributeTargetInvalidForPosition(TextLocation location, string kind, string position)
    {
        Report(location, "GS0201", $"Attribute target '{kind}' is not valid on {position}.");
    }

    /// <summary>
    /// Reports an attribute argument whose value cannot be reduced to a
    /// compile-time constant of the recognised attribute-argument value
    /// space (ADR-0047 §3 / ECMA-335 II.23.3).
    /// </summary>
    /// <param name="location">The source location of the offending argument.</param>
    public void ReportAttributeArgumentNotConstant(TextLocation location)
    {
        Report(location, "GS0202", "Attribute arguments must be compile-time constants (primitive, string, typeof, enum, or 1-D array thereof).");
    }

    /// <summary>
    /// Reports a class declaration tagged with the <c>@Attribute</c>
    /// declaration sugar (ADR-0047 §5) that already declares an explicit
    /// base class other than <c>System.Attribute</c>. The implicit
    /// <c>System.Attribute</c> base imposed by the sugar conflicts with
    /// the user-supplied base.
    /// </summary>
    /// <param name="location">The location of the offending base-class identifier.</param>
    /// <param name="baseName">The user-supplied base-class name.</param>
    public void ReportAttributeClassExplicitBase(TextLocation location, string baseName)
    {
        Report(location, "GS0203", $"Class is tagged @Attribute and cannot also declare an explicit base class '{baseName}'. The @Attribute sugar implies ': System.Attribute'.");
    }

    /// <summary>
    /// Reports a reference to a symbol marked with
    /// <see cref="System.ObsoleteAttribute"/>. The diagnostic is a
    /// warning by default; if the attribute's <c>error</c> flag is set
    /// it is reported as an error (ADR-0047 §6).
    /// </summary>
    /// <param name="location">The source location of the use site.</param>
    /// <param name="name">The display name of the obsolete symbol.</param>
    /// <param name="message">The optional user message; may be <c>null</c>.</param>
    /// <param name="isError">When <c>true</c>, the diagnostic is reported as an error.</param>
    public void ReportObsoleteUse(TextLocation location, string name, string message, bool isError)
    {
        var text = string.IsNullOrEmpty(message)
            ? $"'{name}' is obsolete."
            : $"'{name}' is obsolete: '{message}'.";
        Report(location, "GS0204", text, isError ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// Reports a user-written annotation that names an attribute the
    /// compiler reserves for its own synthesis (ADR-0047 §6: the
    /// <c>Extension</c>, <c>AsyncStateMachine</c>, <c>CompilerGenerated</c>,
    /// <c>Nullable</c>, <c>NullableContext</c> family).
    /// </summary>
    /// <param name="location">The source location of the annotation.</param>
    /// <param name="name">The attribute name as written in source.</param>
    public void ReportAttributeReservedForCompiler(TextLocation location, string name)
    {
        Report(location, "GS0205", $"Attribute '{name}' is reserved for compiler synthesis and cannot be written in source.");
    }

    /// <summary>
    /// Reports GS0206 when an annotation lead-in (<c>@Name</c>) precedes a
    /// statement that does not accept annotations (only local
    /// <c>var</c>/<c>let</c>/<c>const</c> declarations do — see ADR-0047 §2
    /// and issue #187).
    /// </summary>
    /// <param name="location">The source location of the leading <c>@</c>.</param>
    public void ReportAnnotationsNotAllowedOnStatement(TextLocation location)
    {
        Report(location, "GS0206", "Annotations are only allowed on variable declarations (var/let/const), not on this statement.");
    }

    /// <summary>
    /// Reports GS0207 when <c>@EnumeratorCancellation</c> is applied to a
    /// parameter whose type is not <see cref="System.Threading.CancellationToken"/>
    /// (ADR-0047 §6 / ADR-0040: <c>EnumeratorCancellationAttribute</c> marks
    /// the cancellation-token parameter that the async-sequence rewriter
    /// threads through; non-token parameters cannot be threaded).
    /// </summary>
    /// <param name="location">The source location of the parameter declaration.</param>
    /// <param name="parameterName">The parameter's declared name.</param>
    /// <param name="actualTypeName">The parameter's declared type (display string).</param>
    public void ReportEnumeratorCancellationWrongType(TextLocation location, string parameterName, string actualTypeName)
    {
        Report(location, "GS0207", $"Parameter '{parameterName}' is annotated '@EnumeratorCancellation' but has type '{actualTypeName}'; only 'System.Threading.CancellationToken' parameters can carry this annotation.");
    }

    /// <summary>
    /// Reports GS0208 when <c>@EnumeratorCancellation</c> is applied to a
    /// parameter on a function whose return type is not an
    /// <c>async sequence</c> (i.e. <see cref="System.Collections.Generic.IAsyncEnumerable{T}"/>).
    /// The runtime only threads the per-enumerator cancellation token through
    /// <c>IAsyncEnumerable.GetAsyncEnumerator(CancellationToken)</c>, so the
    /// attribute is meaningless elsewhere (ADR-0040).
    /// </summary>
    /// <param name="location">The source location of the parameter declaration.</param>
    /// <param name="parameterName">The parameter's declared name.</param>
    public void ReportEnumeratorCancellationNotAsyncSequence(TextLocation location, string parameterName)
    {
        Report(location, "GS0208", $"Parameter '{parameterName}' is annotated '@EnumeratorCancellation' but its enclosing function is not an async sequence (does not return 'IAsyncEnumerable[T]').");
    }

    /// <summary>
    /// Reports GS0209 when an attribute is applied to a declaration whose CLR
    /// target is excluded by the attribute's <c>[AttributeUsage(ValidOn)]</c>.
    /// </summary>
    /// <param name="location">The annotation name location.</param>
    /// <param name="attributeName">The source-form attribute name.</param>
    /// <param name="position">A human description of the use-site declaration.</param>
    /// <param name="validOn">The flag set declared on the attribute class.</param>
    public void ReportAttributeUsageInvalidTarget(TextLocation location, string attributeName, string position, System.AttributeTargets validOn)
    {
        Report(location, "GS0209", $"Attribute '{attributeName}' is not valid on {position}; its [AttributeUsage] permits only: {validOn}.");
    }

    /// <summary>
    /// Reports GS0210 when an attribute is applied more than once to the
    /// same target and its <c>[AttributeUsage(AllowMultiple = false)]</c>
    /// (the C# default) forbids duplicates.
    /// </summary>
    /// <param name="location">The location of the duplicate annotation.</param>
    /// <param name="attributeName">The source-form attribute name.</param>
    public void ReportAttributeUsageDuplicate(TextLocation location, string attributeName)
    {
        Report(location, "GS0210", $"Duplicate attribute '{attributeName}'; this attribute type does not allow multiple applications (AllowMultiple = false).");
    }

    /// <summary>
    /// Reports GS0211 when <c>[DllImport]</c> is applied in source. ADR-0047 §6
    /// recognises <see cref="System.Runtime.InteropServices.DllImportAttribute"/>
    /// but only on declarations whose body marker is <c>extern</c>; emit of the
    /// underlying P/Invoke metadata is post-v1.0, so v1.0 rejects every use.
    /// </summary>
    /// <param name="location">The source location of the annotation.</param>
    /// <param name="name">The attribute name as written in source.</param>
    public void ReportDllImportNotSupported(TextLocation location, string name)
    {
        Report(location, "GS0211", $"Attribute '{name}' is recognised but not supported in v1.0; P/Invoke (extern function bodies) is a post-v1.0 feature.");
    }

    /// <summary>
    /// Reports GS0212 when <c>[Conditional("SYMBOL")]</c> is applied to a
    /// function whose return type is not <c>void</c>. The CLR rule
    /// (matching C# <c>CS0578</c>) is that conditional-method calls may be
    /// elided at the call site, which is incompatible with a non-void result
    /// flowing into the surrounding expression. ADR-0047 §6 / issue #176.
    /// </summary>
    /// <param name="location">The source location of the function declaration.</param>
    /// <param name="functionName">The function's declared name.</param>
    public void ReportConditionalMethodMustReturnVoid(TextLocation location, string functionName)
    {
        Report(location, "GS0212", $"Function '{functionName}' is marked '@Conditional' but does not return 'void'; conditional methods must return 'void' because calls may be elided at the call site.");
    }

    /// <summary>GS9007: A type may contain at most one 'shared' block.</summary>
    /// <param name="location">The text location of the duplicate shared keyword.</param>
    public void ReportDuplicateSharedBlock(TextLocation location)
    {
        Report(location, "GS9007", "A type may contain at most one 'shared' block.");
    }

    /// <summary>
    /// ADR-0055: reports an interpolation hole whose alignment clause
    /// (<c>${expr,alignment}</c>) is not a constant integer.
    /// </summary>
    /// <param name="location">The text location of the offending hole.</param>
    /// <param name="text">The offending alignment text.</param>
    public void ReportInvalidInterpolationAlignment(TextLocation location, string text)
    {
        Report(location, "GS0214", $"Invalid interpolation alignment '{text}' (must be a constant integer).");
    }

    private static string FormatMissingNames(IEnumerable<string> missingNames)
    {
        var displayed = new List<string>();
        var count = 0;
        foreach (var name in missingNames)
        {
            if (count < 3)
            {
                displayed.Add($"'{name}'");
            }

            count++;
        }

        if (count > 3)
        {
            displayed.Add("…");
        }

        return string.Join(", ", displayed);
    }

    private void Report(TextLocation location, string id, string message, DiagnosticSeverity severity = DiagnosticSeverity.Error)
    {
        var diagnostic = new Diagnostic(location, id, severity, message);
        diagnostics.Add(diagnostic);
    }
}
