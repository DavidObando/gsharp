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
    /// Adds a sequence of already-constructed diagnostics into this instance.
    /// Used to surface inner diagnostics (e.g. an interpolation hole's syntax
    /// errors) whose locations have already been mapped to the outer file.
    /// </summary>
    /// <param name="diagnostics">The diagnostics to copy in.</param>
    public void AddRange(IEnumerable<Diagnostic> diagnostics)
    {
        this.diagnostics.AddRange(diagnostics);
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
    /// Issue #367: reports that a by-ref-like (<c>ref struct</c>) value is used in
    /// a position that would let it escape the stack. By-ref-like types such as
    /// <c>Span[T]</c>, <c>ReadOnlySpan[T]</c>, and
    /// <c>DefaultInterpolatedStringHandler</c> may be declared as locals and
    /// passed around, but the CLR forbids boxing them, storing them in fields of a
    /// non-ref-struct, capturing them in closures, hoisting them into
    /// async/iterator state machines, and using them as generic type arguments.
    /// </summary>
    /// <param name="location">The text location of the illegal use.</param>
    /// <param name="type">The by-ref-like type.</param>
    /// <param name="reason">A description of why the value would escape.</param>
    public void ReportByRefLikeEscape(TextLocation location, TypeSymbol type, string reason)
    {
        Report(location, "GS0219", $"By-ref-like type '{type}' is a `ref struct` and cannot {reason}.");
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
        Report(location, "GS0220", $"Invalid interpolation alignment '{text}' (must be a constant integer).");
    }

    /// <summary>
    /// Issue #368: reports an interpolated string passed to an
    /// <c>[InterpolatedStringHandler]</c> parameter whose
    /// <c>[InterpolatedStringHandlerArgument]</c> forwarding could not be
    /// satisfied (an unknown referenced argument, a missing receiver, or no
    /// matching handler constructor).
    /// </summary>
    /// <param name="location">The text location of the interpolated argument.</param>
    /// <param name="reason">A human-readable description of the failure.</param>
    public void ReportInterpolatedStringHandlerArgument(TextLocation location, string reason)
    {
        Report(location, "GS0221", $"Cannot use the interpolated-string-handler argument: {reason}.");
    }

    /// <summary>
    /// ADR-0055: reports an interpolation hole (<c>${ … }</c>) that is never
    /// closed by a matching <c>}</c> before the end of the source.
    /// </summary>
    /// <param name="location">The text location of the unterminated hole.</param>
    public void ReportUnterminatedInterpolationHole(TextLocation location)
    {
        Report(location, "GS0222", "Unterminated interpolation hole; expected a closing '}'.");
    }

    /// <summary>
    /// ADR-0055: reports an empty interpolation hole (<c>${}</c>), which has no
    /// expression to evaluate.
    /// </summary>
    /// <param name="location">The text location of the empty hole.</param>
    public void ReportEmptyInterpolationHole(TextLocation location)
    {
        Report(location, "GS0223", "Empty interpolation hole; expected an expression between '${' and '}'.");
    }

    /// <summary>
    /// ADR-0055: reports an interpolation hole whose format clause is present
    /// but empty (<c>${expr:}</c>).
    /// </summary>
    /// <param name="location">The text location of the offending hole.</param>
    public void ReportEmptyInterpolationFormat(TextLocation location)
    {
        Report(location, "GS0224", "Empty format specifier; expected a format string after ':'.");
    }

    /// <summary>
    /// ADR-0055: reports a raw newline in the literal portion of an
    /// interpolated string. Newlines are only permitted inside <c>${ … }</c>
    /// holes, not in the literal text segments.
    /// </summary>
    /// <param name="location">The text location of the newline.</param>
    public void ReportNewlineInInterpolatedStringLiteral(TextLocation location)
    {
        Report(location, "GS0225", "Newline in the literal portion of an interpolated string; only '${ … }' holes may span lines.");
    }

    /// <summary>
    /// ADR-0056 §2: reports an attempt to assign through a read-only span
    /// element. A <c>ReadOnlySpan[T]</c> indexer is <c>ref readonly T</c>, so
    /// <c>span[i] = v</c> is not permitted (only <c>Span[T]</c> writes are).
    /// </summary>
    /// <param name="location">The text location of the offending assignment.</param>
    /// <param name="type">The read-only span type being written through.</param>
    public void ReportCannotAssignReadOnlySpanElement(TextLocation location, TypeSymbol type)
    {
        var message = $"Cannot assign through a read-only span element ('{type.Name}' is read-only).";
        Report(location, "GS0226", message);
    }

    /// <summary>
    /// ADR-0057 §P4: reports a documentation comment block that does not precede
    /// any documentable declaration (a "floating" doc comment).
    /// </summary>
    /// <param name="location">The text location of the floating documentation comment.</param>
    public void ReportFloatingDocumentationComment(TextLocation location)
    {
        Report(location, "GS0227", "Documentation comment is not attached to a declaration.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0057 §P4: reports a public API member that lacks documentation (opt-in via /warnondoc or similar mechanism).
    /// </summary>
    /// <param name="location">The text location of the undocumented declaration.</param>
    /// <param name="symbolName">The undocumented public symbol name.</param>
    public void ReportMissingDocumentation(TextLocation location, string symbolName)
    {
        Report(location, "GS0228", $"Missing documentation comment on public member '{symbolName}'.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0057 §P4: reports a @param or @typeparam tag whose name does not match
    /// any parameter in the documented member's signature.
    /// </summary>
    /// <param name="location">The text location of the documented declaration.</param>
    /// <param name="paramName">The unmatched parameter or type-parameter name.</param>
    /// <param name="symbolName">The documented symbol name.</param>
    public void ReportDocParamMismatch(TextLocation location, string paramName, string symbolName)
    {
        Report(location, "GS0229", $"Documentation @param '{paramName}' does not match any parameter of '{symbolName}'.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0057 §P4: reserved for unsupported Markdown constructs that cannot be
    /// represented in the documentation model.
    /// </summary>
    /// <param name="location">The text location of the unsupported Markdown construct.</param>
    /// <param name="detail">Details about the unsupported Markdown construct.</param>
    public void ReportUnsupportedDocumentationMarkdown(TextLocation location, string detail)
    {
        Report(location, "GS0230", $"Unsupported documentation Markdown: {detail}. Use ```xmldoc for complex XML-doc constructs.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// Reports GS0231 when a documentation comment contains an unknown block tag
    /// (e.g. <c>@return</c> instead of <c>@returns</c>).
    /// </summary>
    /// <param name="location">The location of the documentation comment.</param>
    /// <param name="tagName">The unrecognised tag text.</param>
    public void ReportUnknownDocumentationTag(TextLocation location, string tagName)
    {
        Report(location, "GS0231", $"Unknown documentation tag '{tagName}'. Valid tags are: @param, @typeparam, @returns, @remarks, @value, @exception, @seealso.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// Issue #410 / ADR-0029: reports that a synthesized data-struct member
    /// (<c>Equals</c>, <c>GetHashCode</c>, <c>ToString</c>, <c>op_Equality</c>,
    /// <c>op_Inequality</c>, or <c>Deconstruct</c>) was hand-written. The ADR
    /// forbids user-written versions so the contract of <c>data struct</c> is
    /// learnable and predictable.
    /// </summary>
    /// <param name="location">The text location of the member name.</param>
    /// <param name="typeName">The data struct type name.</param>
    /// <param name="memberName">The synthesized member name.</param>
    public void ReportDataStructSynthesizedMemberConflict(TextLocation location, string typeName, string memberName)
    {
        var message = $"Data struct '{typeName}' synthesizes member '{memberName}'; it cannot be declared explicitly.";
        Report(location, "GS0232", message);
    }

    /// <summary>
    /// ADR-0059 / issue #255: reports that a delegate declaration
    /// (<c>type Name = delegate …</c>) was not followed by a <c>func(...)</c>
    /// signature. Named delegates must take the shape
    /// <c>type Name = delegate func(params) ret</c>.
    /// </summary>
    /// <param name="location">The text location of the offending token.</param>
    public void ReportDelegateDeclarationRequiresFunc(TextLocation location)
    {
        Report(location, "GS0233", "Named delegate declaration requires 'func(...)' after 'delegate' (e.g. 'type Name = delegate func(sender Object, e EventArgs)').");
    }

    /// <summary>
    /// ADR-0059 / issue #255: reports a generic delegate declaration (e.g.
    /// <c>type Predicate[T any] = delegate func(value T) bool</c>) — generic
    /// delegate emit is not yet supported in v1 and is tracked as ADR-0059
    /// follow-up work.
    /// </summary>
    /// <param name="location">The text location of the delegate identifier.</param>
    /// <param name="typeName">The delegate type name.</param>
    public void ReportGenericDelegateNotSupported(TextLocation location, string typeName)
    {
        Report(location, "GS0234", $"Generic delegate declaration '{typeName}' is not yet supported; declare a non-generic named delegate type (ADR-0059 follow-up).");
    }

    /// <summary>
    /// ADR-0060: reports that an argument's ref-kind modifier (or its absence) does not match
    /// the parameter's declared ref-kind at a call site. Replaces the lower-level GS9002 for
    /// keyword-form call sites with a more targeted message naming both observed and expected.
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="argumentIndex">The 1-based argument index.</param>
    /// <param name="parameterName">The parameter name on the callee.</param>
    /// <param name="expected">The expected ref-kind ("none", "ref", "out", "in").</param>
    /// <param name="observed">The observed ref-kind ("none", "ref", "out", "in").</param>
    public void ReportRefKindMismatch(TextLocation location, int argumentIndex, string parameterName, string expected, string observed)
    {
        Report(location, "GS0235", $"Argument {argumentIndex} (parameter '{parameterName}') passes with ref-kind '{observed}' but the parameter is declared '{expected}'.");
    }

    /// <summary>
    /// ADR-0060: reports that an inline-declaration / discard form (<c>out var</c>, <c>out let</c>,
    /// or <c>out _</c>) was used outside an <c>out</c> argument position (e.g. with <c>ref</c>
    /// or <c>in</c>, or as a named-argument value, or in a non-argument expression position).
    /// </summary>
    /// <param name="location">The location of the offending construct.</param>
    public void ReportOutDeclarationOutsideOutArgument(TextLocation location)
    {
        Report(location, "GS0236", "An inline 'out var', 'out let', or 'out _' declaration is only allowed as an argument at an 'out' parameter position.");
    }

    /// <summary>
    /// ADR-0060 §5: reports an assignment to an <c>in</c> parameter inside the function body.
    /// </summary>
    /// <param name="location">The assignment location.</param>
    /// <param name="parameterName">The parameter name.</param>
    public void ReportCannotAssignToInParameter(TextLocation location, string parameterName)
    {
        Report(location, "GS0237", $"'in' parameter '{parameterName}' is read-only; remove the 'in' modifier on the declaration if mutation is intended.");
    }

    /// <summary>
    /// ADR-0060 §5: reports a return-path on which an <c>out</c> parameter has not been
    /// definitely assigned. The diagnostic locates the offending <c>return</c>.
    /// </summary>
    /// <param name="location">The location of the return statement (or the end-of-body for fall-through).</param>
    /// <param name="parameterName">The out parameter name.</param>
    public void ReportOutParameterNotAssigned(TextLocation location, string parameterName)
    {
        Report(location, "GS0238", $"Out parameter '{parameterName}' must be definitely assigned on every path before the function returns.");
    }

    /// <summary>
    /// ADR-0060 §8: user-facing twin of GS9003. Reports that a variable was passed by <c>ref</c>
    /// before being definitely assigned.
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="variableName">The variable name.</param>
    public void ReportVariableNotAssignedBeforeRef(TextLocation location, string variableName)
    {
        Report(location, "GS0239", $"Variable '{variableName}' is not definitely assigned before being passed by 'ref'.");
    }

    /// <summary>
    /// ADR-0060 §8: reports that an override or interface-implementation method's parameter
    /// ref-kind does not match the base/interface declaration.
    /// </summary>
    /// <param name="location">The location of the overriding declaration.</param>
    /// <param name="memberName">The member name.</param>
    /// <param name="parameterName">The parameter name.</param>
    /// <param name="expected">The expected ref-kind ("none", "ref", "out", "in").</param>
    /// <param name="actual">The actual ref-kind ("none", "ref", "out", "in").</param>
    public void ReportOverrideRefKindMismatch(TextLocation location, string memberName, string parameterName, string expected, string actual)
    {
        Report(location, "GS0240", $"Override of '{memberName}' must match the base parameter ref-kind on '{parameterName}': base is '{expected}', this declaration is '{actual}'.");
    }

    /// <summary>
    /// ADR-0060 §8: reports a variadic parameter (`...T`) declared with a ref-kind modifier.
    /// The combination is forbidden — the CLR cannot express an array of by-ref values.
    /// </summary>
    /// <param name="location">The parameter location.</param>
    /// <param name="parameterName">The parameter name.</param>
    public void ReportRefKindOnVariadicParameter(TextLocation location, string parameterName)
    {
        Report(location, "GS0241", $"'ref'/'out'/'in' is not a legal modifier on a variadic parameter '{parameterName}'.");
    }

    /// <summary>
    /// ADR-0060 + ADR-0029: rejects a ref-kind modifier on a primary-constructor parameter.
    /// Primary-constructor parameters materialize fields, and the CLR cannot encode a
    /// managed-pointer (<c>T&amp;</c>) as a field type. The user must drop the modifier or
    /// move the constructor body to a standalone <c>init(...)</c> that does not synthesize
    /// a backing field.
    /// </summary>
    /// <param name="location">The ref-kind modifier location.</param>
    /// <param name="parameterName">The parameter name.</param>
    public void ReportRefKindOnPrimaryCtorParameter(TextLocation location, string parameterName)
    {
        Report(location, "GS0241", $"'ref'/'out'/'in' is not a legal modifier on the primary-constructor parameter '{parameterName}'; primary-ctor parameters materialize fields, and the CLR cannot store a managed pointer in a field. Move the constructor to an 'init(...)' body if a by-reference parameter is required.");
    }

    /// <summary>
    /// ADR-0060 §8: warns that a call passes a value at an <c>in</c> parameter position
    /// without the matching <c>in</c> modifier. The compiler does NOT silently spill the
    /// value; the user should write <c>in lvalue</c> or remove the <c>in</c> from the signature.
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="argumentIndex">The 1-based argument index.</param>
    /// <param name="parameterName">The parameter name on the callee.</param>
    public void ReportInArgumentMissingInModifier(TextLocation location, int argumentIndex, string parameterName)
    {
        Report(location, "GS0242", $"Argument {argumentIndex} (parameter '{parameterName}') is an 'in' parameter but the call does not use the 'in' modifier; pass 'in <lvalue>' or change the parameter to by-value.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0060 §2: rejects a managed-pointer type (`*T`) used as a parameter type. The CLR
    /// cannot encode a `*T` parameter without going through `ELEMENT_TYPE_BYREF` plus the
    /// matching attributes; use the keyword form (`ref name T` / `out name T` / `in name T`)
    /// to declare an explicit by-reference parameter.
    /// </summary>
    /// <param name="location">The parameter or type-clause location.</param>
    /// <param name="parameterName">The parameter name.</param>
    /// <param name="pointeeName">The pointee type name (e.g. "int32").</param>
    public void ReportPointerTypeCannotBeParameterType(TextLocation location, string parameterName, string pointeeName)
    {
        Report(location, "GS0243", $"Managed-pointer type '*{pointeeName}' is not a legal parameter type; use 'ref {parameterName} {pointeeName}', 'out {parameterName} {pointeeName}', or 'in {parameterName} {pointeeName}' instead.");
    }

    /// <summary>
    /// ADR-0060 §10: reports a ref-kind parameter on an <c>async</c>, <c>sequence</c>, or
    /// <c>async sequence</c> function. The state-machine rewriter cannot hoist a managed
    /// pointer into a field, so the parameter is rejected. (Same GS0226 family as the
    /// existing async/iterator restrictions.)
    /// </summary>
    /// <param name="location">The parameter location.</param>
    /// <param name="parameterName">The parameter name.</param>
    /// <param name="functionKind">"async", "sequence", or "async sequence".</param>
    public void ReportRefKindOnAsyncOrIterator(TextLocation location, string parameterName, string functionKind)
    {
        Report(location, "GS0226", $"Ref-kind parameter '{parameterName}' cannot appear on a {functionKind} function.");
    }

    /// <summary>
    /// Issue #343: reports a positional call argument written after a named call
    /// argument. Named arguments must come last; positional → named ordering is
    /// fixed by the parser to support unambiguous matching against the parameter
    /// list.
    /// </summary>
    /// <param name="location">The location of the offending positional argument.</param>
    public void ReportPositionalArgumentAfterNamedArgument(TextLocation location)
    {
        Report(location, "GS0244", "Positional argument cannot follow a named argument.");
    }

    /// <summary>
    /// Issue #343: reports a duplicate named argument at a call site (e.g.
    /// <c>F(x: 1, x: 2)</c>). Each named argument's name must be unique.
    /// </summary>
    /// <param name="location">The location of the duplicate named argument.</param>
    /// <param name="name">The duplicated parameter name.</param>
    public void ReportDuplicateNamedArgument(TextLocation location, string name)
    {
        Report(location, "GS0245", $"Named argument '{name}' specified more than once.");
    }

    /// <summary>
    /// Issue #343: reports a named call argument whose name does not match any
    /// parameter of the resolved callee.
    /// </summary>
    /// <param name="location">The location of the offending named argument.</param>
    /// <param name="callee">The callee name (for diagnostic context).</param>
    /// <param name="name">The argument name that did not match any parameter.</param>
    public void ReportNamedArgumentParameterNotFound(TextLocation location, string callee, string name)
    {
        Report(location, "GS0246", $"Named argument '{name}' does not match any parameter of '{callee}'.");
    }

    /// <summary>
    /// Issue #343: reports a named call argument whose target parameter is
    /// already supplied by a positional argument earlier in the same call.
    /// </summary>
    /// <param name="location">The location of the offending named argument.</param>
    /// <param name="name">The parameter name that was double-bound.</param>
    public void ReportNamedArgumentAlsoSpecifiedPositionally(TextLocation location, string name)
    {
        Report(location, "GS0247", $"Named argument '{name}' specifies a value for parameter '{name}' which was already given a positional value.");
    }

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): a function declaration carries a <c>ref</c> return modifier
    /// without an explicit return type clause (e.g. <c>func foo() ref { ... }</c>).
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> modifier.</param>
    public void ReportRefReturnRequiresReturnType(TextLocation location)
    {
        Report(location, "GS0248", "A 'ref' return modifier requires an explicit return type clause (e.g. 'ref int32').");
    }

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): a <c>ref</c> return modifier was placed on an
    /// <c>async</c> or sequence/async-sequence function; the state-machine rewriter cannot
    /// hoist a managed pointer into a state-machine field (ELEMENT_TYPE_BYREF is illegal
    /// in field signatures — ADR-0058 §2).
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> modifier.</param>
    /// <param name="kind">"async", "sequence", or "async sequence".</param>
    public void ReportRefReturnOnAsyncOrIterator(TextLocation location, string kind)
    {
        Report(location, "GS0249", $"'ref' return is not legal on an {kind} function; the state-machine rewriter cannot hoist a managed pointer.");
    }

    /// <summary>
    /// Issue #490: a <c>ref</c>-returning function declares its return type as <c>*T</c>
    /// (a managed pointer). The two are redundant — write <c>ref T</c> instead of <c>ref *T</c>.
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> modifier.</param>
    public void ReportRefReturnOfByRefType(TextLocation location)
    {
        Report(location, "GS0250", "'ref' return modifier is redundant when the declared return type is already a managed pointer ('*T'); write 'ref T' instead.");
    }

    /// <summary>
    /// Issue #490: a <c>return ref expr</c> statement appears inside a function whose
    /// declaration does not carry the <c>ref</c> return modifier.
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> keyword on the return statement.</param>
    /// <param name="functionName">The enclosing function name.</param>
    public void ReportRefReturnInNonRefReturningFunction(TextLocation location, string functionName)
    {
        Report(location, "GS0251", $"'return ref' is not allowed in '{functionName}' because its declaration does not specify a 'ref' return type.");
    }

    /// <summary>
    /// Issue #490: a plain <c>return expr</c> statement appears inside a <c>ref</c>-returning function.
    /// The body must use <c>return ref &lt;lvalue&gt;</c>.
    /// </summary>
    /// <param name="location">The location of the <c>return</c> keyword.</param>
    /// <param name="functionName">The enclosing function name.</param>
    public void ReportRefReturnRequiredOnRefReturningFunction(TextLocation location, string functionName)
    {
        Report(location, "GS0252", $"Function '{functionName}' returns by reference; use 'return ref <lvalue>' instead of a plain 'return'.");
    }

    /// <summary>
    /// Issue #490: the operand of <c>return ref</c> is not an lvalue (literal, arithmetic
    /// expression, call result, etc.). Only variables, fields, array elements, dereferences,
    /// and conditional expressions whose branches are themselves lvalues can be returned by ref.
    /// </summary>
    /// <param name="location">The location of the offending expression.</param>
    public void ReportRefReturnRequiresLvalue(TextLocation location)
    {
        Report(location, "GS0253", "The operand of 'return ref' must be an lvalue (variable, field, array element, or '*p').");
    }

    /// <summary>
    /// Issue #490 (ADR-0058 ref-safe-to-escape): the operand of <c>return ref</c> refers to
    /// storage that dies at function exit (a local variable, a <c>scoped</c> parameter, or a
    /// field/element rooted in one of those). Returning that pointer would expose dangling
    /// memory to the caller.
    /// </summary>
    /// <param name="location">The location of the offending expression.</param>
    public void ReportRefReturnEscapesLocalScope(TextLocation location)
    {
        Report(location, "GS0254", "Cannot return a managed pointer to function-local storage; the reference would dangle once the function returns.");
    }

    /// <summary>
    /// Issue #490 (ADR-0060 §9 extension): the overriding / interface-implementing method
    /// disagrees with the base/interface declaration on whether the return is by reference.
    /// </summary>
    /// <param name="location">The location of the overriding declaration.</param>
    /// <param name="memberName">The member name.</param>
    /// <param name="expected">The expected return ref-kind text (e.g. "ref" or "by value").</param>
    /// <param name="actual">The actual return ref-kind text on the derived/implementing declaration.</param>
    public void ReportOverrideReturnRefKindMismatch(TextLocation location, string memberName, string expected, string actual)
    {
        Report(location, "GS0255", $"Override of '{memberName}' must match the base return ref-kind: base returns {expected}, this declaration returns {actual}.");
    }

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): reports a ref-aliasing local declaration whose
    /// initializer is not an lvalue. <c>let ref</c> / <c>var ref</c> binds the local as
    /// an alias for an existing storage slot — the RHS must therefore be a variable, a
    /// field/property access, an indexer access, or a dereference of a managed pointer.
    /// </summary>
    /// <param name="location">The <c>ref</c> modifier location.</param>
    /// <param name="exprText">The source text of the offending RHS expression.</param>
    public void ReportRefLocalRhsMustBeLvalue(TextLocation location, string exprText)
    {
        Report(location, "GS0256", $"The right-hand side of a ref-aliasing local must be an lvalue (a variable, field/property, indexer access, or '*p' dereference); '{exprText}' is not assignable.");
    }

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): reports a ref-aliasing local whose initializer's
    /// ref-safe-to-escape scope is narrower than the local's declaring scope. The aliased
    /// storage would not outlive the local; reading or writing through the alias is therefore
    /// unsafe. Reported, for example, when binding a ref local to a value whose pointee lives
    /// in a <c>scoped</c> ref struct or to a temporary that the local would outlive.
    /// </summary>
    /// <param name="location">The <c>ref</c> modifier location.</param>
    /// <param name="variableName">The local name.</param>
    public void ReportRefLocalRhsHasNarrowerEscapeScope(TextLocation location, string variableName)
    {
        Report(location, "GS0257", $"Cannot bind ref-aliasing local '{variableName}' to a value whose ref-safe-to-escape scope is narrower than the local's scope; the alias would outlive its referent.");
    }

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): reports the <c>ref</c> aliasing modifier on a
    /// declaration that cannot legally store a managed pointer — a top-level binding
    /// (emitted as a static field), a local in an <c>async</c> function or iterator
    /// (hoisted into a state-machine field), or a <c>const</c> declaration.
    /// </summary>
    /// <param name="location">The <c>ref</c> modifier location.</param>
    /// <param name="variableName">The local name.</param>
    /// <param name="context">Description of the disallowed context (e.g. "a top-level variable").</param>
    public void ReportRefLocalCannotBeDeclaredHere(TextLocation location, string variableName, string context)
    {
        Report(location, "GS0258", $"Ref-aliasing local '{variableName}' cannot be declared as {context}; managed pointers cannot be stored across this boundary.");
    /// ADR-0061: reports a conditional ref-argument expression that surfaces outside of
    /// a ref-kind modifier payload (<c>ref</c>/<c>out</c>/<c>in</c>) or an <c>&amp;</c> operand.
    /// </summary>
    /// <param name="location">The text location of the conditional expression.</param>
    public void ReportConditionalRefArgumentOutsideRefContext(TextLocation location)
    {
        Report(location, "GS0259", "Conditional lvalue expression (`cond ? a : b`) is only legal as the payload of a 'ref'/'out'/'in' argument modifier or as the operand of '&'.");
    }

    /// <summary>
    /// ADR-0061: reports that the two branches of a conditional ref-argument produce
    /// values of different (non-identical) types.
    /// </summary>
    /// <param name="location">The text location of the conditional expression.</param>
    /// <param name="trueType">The type of the true-branch lvalue.</param>
    /// <param name="falseType">The type of the false-branch lvalue.</param>
    public void ReportConditionalRefArgumentBranchTypeMismatch(TextLocation location, string trueType, string falseType)
    {
        Report(location, "GS0260", $"Both branches of a conditional ref-argument must produce lvalues of the same type, but the true branch is '{trueType}' and the false branch is '{falseType}'.");
    }

    /// <summary>
    /// ADR-0061: reports an inline-declaration (<c>out var</c>/<c>out let</c>/<c>out _</c>)
    /// appearing inside a branch of a conditional ref-argument. A new local declared on
    /// only one branch is semantically incoherent.
    /// </summary>
    /// <param name="location">The text location of the offending inline declaration.</param>
    public void ReportInlineDeclarationInConditionalRefBranch(TextLocation location)
    {
        Report(location, "GS0261", "An 'out var'/'out let'/'out _' inline declaration cannot appear inside a branch of a conditional ref-argument (the new local would only conditionally exist). Declare the local before the call instead.");
    }

    /// <summary>
    /// ADR-0061: reports an inner ref-kind modifier on a conditional ref-argument branch
    /// that does not match the outer modifier.
    /// </summary>
    /// <param name="location">The text location of the offending inner modifier.</param>
    /// <param name="outerModifier">The outer modifier text (<c>ref</c>/<c>out</c>/<c>in</c>).</param>
    /// <param name="innerModifier">The inner modifier text observed.</param>
    public void ReportConditionalRefArgumentInnerModifierMismatch(TextLocation location, string outerModifier, string innerModifier)
    {
        Report(location, "GS0262", $"Inner ref-kind modifier '{innerModifier}' on a conditional ref-argument branch must match the outer modifier '{outerModifier}'.");
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
