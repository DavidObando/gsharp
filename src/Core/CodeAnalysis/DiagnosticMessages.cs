// <copyright file="DiagnosticMessages.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Represents a collection of code analysis diagnostics information.
/// </summary>

public sealed partial class DiagnosticBag : IEnumerable<Diagnostic>
{


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
    /// Issue #526: reports that the outer type exists but does not contain a nested
    /// type of the requested name.
    /// </summary>
    /// <param name="location">The text location of the nested-type segment.</param>
    /// <param name="outerTypeName">The outer (containing) type's source-visible name.</param>
    /// <param name="nestedName">The nested-type segment that could not be resolved.</param>
    public void ReportUndefinedNestedType(TextLocation location, string outerTypeName, string nestedName)
    {
        var message = $"Type '{outerTypeName}' does not contain a nested type named '{nestedName}'.";
        Report(location, "GS0268", message);
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
        // Issue #660 / #721: when the user writes 'null' (C# spelling) and no
        // symbol named `null` exists in scope, surface the GS0273 "did you
        // mean 'nil'?" diagnostic instead of the generic GS0125. The binder
        // also synthesises a `nil` literal so that target-type contexts (such
        // as `let x string? = null` or `Foo(null)` with a nullable parameter)
        // continue to typecheck without cascading errors.
        if (name == "null")
        {
            ReportUseNilInsteadOfNull(location);
            return;
        }

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
    /// Issue #946: reports that an <c>init</c>-only property was assigned
    /// outside of object initialization. An <c>init</c>-only property may only
    /// be assigned in the declaring type's constructor(s), in an object/
    /// aggregate initializer at the creation site, or within an <c>init</c>
    /// accessor of the same instance.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the property.</param>
    public void ReportInitOnlyPropertyAssignment(TextLocation location, string name)
    {
        var message = $"Init-only property '{name}' can only be assigned during object initialization (in a constructor, an object initializer, or an 'init' accessor).";
        Report(location, "GS0372", message);
    }

    /// <summary>
    /// Issue #946: reports that a property declared both a <c>set</c> and an
    /// <c>init</c> accessor, which is not allowed (mirrors C#'s rule).
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the property.</param>
    public void ReportPropertyHasBothSetAndInit(TextLocation location, string name)
    {
        var message = $"Property '{name}' cannot declare both a 'set' and an 'init' accessor.";
        Report(location, "GS0373", message);
    }

    /// <summary>
    /// Issue #946: reports that an <c>init</c>-only accessor was declared on a
    /// static property. The <c>init</c> accessor is instance-only.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the property.</param>
    public void ReportInitAccessorOnStaticProperty(TextLocation location, string name)
    {
        var message = $"Static property '{name}' cannot declare an 'init' accessor; 'init' is only valid on instance properties.";
        Report(location, "GS0374", message);
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
        var message = $"The 'async' modifier in a type clause is only valid before 'sequence[T]', '(T) -> R', or 'func(...)'; found '<{actualKind}>'.";
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

    /// <summary>Reports a type used as a type-parameter constraint that is neither an interface nor a class (issue #1052 generalised the former sealed-interface restriction; issue #1056 additionally permits base-class constraints, so this now fires only for value types such as a struct or enum).</summary>
    /// <param name="location">The text location of the constraint reference.</param>
    /// <param name="typeName">The offending type name.</param>
    public void ReportConstraintNotInterface(TextLocation location, string typeName)
    {
        Report(location, "GS0153", $"Type '{typeName}' cannot be used as a type-parameter constraint because it is neither an interface nor a class.");
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
}
