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
        Report(location, message);
    }

    /// <summary>
    /// Reports an unterminated comment.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportUnterminatedComment(TextLocation location)
    {
        var message = "Unterminated comment.";
        Report(location, message);
    }

    /// <summary>
    /// Reports an unterminated string literal.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportUnterminatedString(TextLocation location)
    {
        var message = "Unterminated string literal.";
        Report(location, message);
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
        Report(location, message);
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
        Report(location, message);
    }

    /// <summary>
    /// Reports that not all code paths return a value.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportAllPathsMustReturn(TextLocation location)
    {
        var message = "Not all code paths return a value.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that a parameter with the given name already exists.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="parameterName">The name of the parameter.</param>
    public void ReportParameterAlreadyDeclared(TextLocation location, string parameterName)
    {
        var message = $"A parameter with the name '{parameterName}' already exists.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that a symbol is already declared.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the symbol.</param>
    public void ReportSymbolAlreadyDeclared(TextLocation location, string name)
    {
        var message = $"'{name}' is already declared.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that a <c>data struct</c> was declared with no fields (ADR-0029).
    /// </summary>
    /// <param name="location">The text location of the struct identifier.</param>
    /// <param name="name">The struct name.</param>
    public void ReportEmptyDataStruct(TextLocation location, string name)
    {
        var message = $"'data struct {name}' requires at least one field; use 'struct' instead.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that a type doesn't exist.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The type name.</param>
    public void ReportUndefinedType(TextLocation location, string name)
    {
        var message = $"Type '{name}' doesn't exist.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that the array length is not a valid non-negative integer literal.
    /// </summary>
    /// <param name="location">The text location.</param>
    /// <param name="text">The length token text.</param>
    public void ReportInvalidArrayLength(TextLocation location, string text)
    {
        var message = $"Array length '{text}' must be a non-negative integer literal.";
        Report(location, message);
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
        Report(location, message);
    }

    /// <summary>
    /// Reports that indexing was attempted on a non-array expression.
    /// </summary>
    /// <param name="location">The text location.</param>
    /// <param name="type">The actual type.</param>
    public void ReportTypeNotIndexable(TextLocation location, TypeSymbol type)
    {
        var message = $"Type '{type.Name}' is not indexable.";
        Report(location, message);
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
        Report(location, message);
    }

    /// <summary>
    /// Reports that a 'try' statement has neither catch nor finally clauses.
    /// </summary>
    /// <param name="location">The text location of the 'try' keyword.</param>
    public void ReportTryWithoutCatchOrFinally(TextLocation location)
    {
        Report(location, "A 'try' statement requires at least one catch or finally clause.");
    }

    /// <summary>
    /// Reports that a type used in a 'using' declaration does not implement IDisposable.
    /// </summary>
    /// <param name="location">The text location of the using keyword.</param>
    /// <param name="type">The non-disposable type.</param>
    public void ReportTypeNotDisposable(TextLocation location, TypeSymbol type)
    {
        Report(location, $"Type '{type.Name}' cannot be used in a 'using' statement because it does not provide a public Dispose() method.");
    }

    /// <summary>
    /// Reports that the keyworkd can only be used inside of loops.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The keyword.</param>
    public void ReportInvalidBreakOrContinue(TextLocation location, string text)
    {
        var message = $"The keyword '{text}' can only be used inside of loops.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that the return keyword can only be used inside of functions.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportInvalidReturn(TextLocation location)
    {
        var message = "The 'return' keyword can only be used inside of functions.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that the return value cannot be followed for an expression in functions without a return type.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="functionName">The name of the function.</param>
    public void ReportInvalidReturnExpression(TextLocation location, string functionName)
    {
        var message = $"Since the function '{functionName}' does not return a value the 'return' keyword cannot be followed by an expression.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that an expression of a given type was expected.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="returnType">The expected type.</param>
    public void ReportMissingReturnExpression(TextLocation location, TypeSymbol returnType)
    {
        var message = $"An expression of type '{returnType}' is expected.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that an expression must have a value.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportExpressionMustHaveValue(TextLocation location)
    {
        var message = "Expression must have a value.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that a variable doesn't exist.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the variable.</param>
    public void ReportUndefinedVariable(TextLocation location, string name)
    {
        var message = $"Variable '{name}' doesn't exist.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that a name doesn't belong to a variable.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the variable.</param>
    public void ReportNotAVariable(TextLocation location, string name)
    {
        var message = $"'{name}' is not a variable.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that the specified variable is read-only and cannot be assigned.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the variable.</param>
    public void ReportCannotAssign(TextLocation location, string name)
    {
        var message = $"Variable '{name}' is read-only and cannot be assigned to.";
        Report(location, message);
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
        Report(location, message);
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
        Report(location, message);
    }

    /// <summary>
    /// Reports that the function doesn't exist.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The function name.</param>
    public void ReportUndefinedFunction(TextLocation location, string name)
    {
        var message = $"Function '{name}' doesn't exist.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that the name doesn't belong to a function.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The function name.</param>
    public void ReportNotAFunction(TextLocation location, string name)
    {
        var message = $"'{name}' is not a function.";
        Report(location, message);
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
        Report(location, message);
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
        Report(location, message);
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
        Report(location, message);
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
        Report(location, message);
    }

    /// <summary>
    /// Reports that we couldn't find the specified type.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The text associated to the type.</param>
    public void ReportUnableToFindType(TextLocation location, string text)
    {
        var message = $"Cannot find type {text}. Are you missing an import?";
        Report(location, message);
    }

    /// <summary>
    /// Reports that we couldn't find the specified member.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The text associated to the member.</param>
    public void ReportUnableToFindMember(TextLocation location, string text)
    {
        var message = $"Cannot find member {text}.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that we couldn't find the specified function.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The text associated to the function.</param>
    public void ReportUnableToFindFunction(TextLocation location, string text)
    {
        var message = $"Cannot find function {text}.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that top-level statements appear in more than one source file in
    /// the same compilation, which is not allowed.
    /// </summary>
    /// <param name="location">A location in one of the offending files.</param>
    public void ReportMultipleTopLevelFiles(TextLocation location)
    {
        var message = "Only one source file in a compilation may contain top-level statements.";
        Report(location, message);
    }

    /// <summary>
    /// Reports that the compilation contains both top-level statements and an
    /// explicit Main function, which is ambiguous.
    /// </summary>
    /// <param name="location">The location of the explicit Main function declaration.</param>
    public void ReportTopLevelStatementsConflictWithMain(TextLocation location)
    {
        var message = "Top-level statements cannot be used together with an explicit Main function.";
        Report(location, message);
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
        Report(location, message);
    }

    /// <summary>
    /// Reports a use of the reserved <c>fallthrough</c> keyword (ADR-0013: GSharp
    /// does not support Go-style implicit case fallthrough).
    /// </summary>
    /// <param name="location">The text location where <c>fallthrough</c> was found.</param>
    public void ReportFallthroughNotSupported(TextLocation location)
    {
        var message = "'fallthrough' is not supported (ADR-0013). GSharp 'switch' cases do not fall through.";
        Report(location, message);
    }

    /// <summary>
    /// Reports a duplicate <c>default</c> arm in a switch statement.
    /// </summary>
    /// <param name="location">The text location of the offending default arm.</param>
    public void ReportDuplicateSwitchDefault(TextLocation location)
    {
        var message = "A 'switch' statement can only have one 'default' arm.";
        Report(location, message);
    }

    /// <summary>
    /// Reports a non-constant value used in a switch case.
    /// </summary>
    /// <param name="location">The text location of the offending case value.</param>
    public void ReportSwitchCaseValueNotConstant(TextLocation location)
    {
        var message = "Switch case value must be a constant expression.";
        Report(location, message);
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
        Report(location, message);
    }

    /// <summary>
    /// Reports an accessibility modifier (<c>public</c>/<c>internal</c>/<c>private</c>) appearing on a construct that does not accept one.
    /// </summary>
    /// <param name="location">The text location of the modifier token.</param>
    /// <param name="modifier">The modifier text.</param>
    public void ReportAccessibilityModifierNotAllowedHere(TextLocation location, string modifier)
    {
        var message = $"Accessibility modifier '{modifier}' is not allowed here. It is only valid on top-level 'func', 'type', 'var', 'let' and 'const' declarations.";
        Report(location, message);
    }

    /// <summary>Reports an attempt to subclass a sealed (non-<c>open</c>) class. Phase 3.B.3 sub-step 3 / ADR-0017.</summary>
    /// <param name="location">The text location of the base-type identifier.</param>
    /// <param name="baseTypeName">The base type name.</param>
    public void ReportBaseClassNotOpen(TextLocation location, string baseTypeName)
    {
        Report(location, $"Class '{baseTypeName}' is not open; declare 'open class {baseTypeName}' to allow subclassing.");
    }

    /// <summary>Reports a method that overrides a base method without using <c>override</c>. ADR-0017.</summary>
    /// <param name="location">The text location of the offending declaration.</param>
    /// <param name="baseTypeName">The base type name.</param>
    /// <param name="methodName">The method name.</param>
    public void ReportMissingOverride(TextLocation location, string baseTypeName, string methodName)
    {
        Report(location, $"Method '{baseTypeName}.{methodName}' is overridable; add 'override' to redefine it.");
    }

    /// <summary>Reports an <c>override</c> method that does not match any open base method. ADR-0017.</summary>
    /// <param name="location">The text location of the offending declaration.</param>
    /// <param name="methodName">The method name.</param>
    public void ReportNoBaseMethodToOverride(TextLocation location, string methodName)
    {
        Report(location, $"Method '{methodName}' is marked 'override' but no matching open base method was found.");
    }

    /// <summary>Reports an <c>override</c> targeting a method that is not <c>open</c> (sealed override). ADR-0017.</summary>
    /// <param name="location">The text location of the offending declaration.</param>
    /// <param name="methodName">The method name.</param>
    public void ReportOverrideOfSealedMethod(TextLocation location, string methodName)
    {
        Report(location, $"Method '{methodName}' cannot override the base method because the base method is not open.");
    }

    /// <summary>Reports a signature mismatch between an <c>override</c> method and its base method.</summary>
    /// <param name="location">The text location of the offending declaration.</param>
    /// <param name="methodName">The method name.</param>
    public void ReportOverrideSignatureMismatch(TextLocation location, string methodName)
    {
        Report(location, $"Override of method '{methodName}' must match the base method's parameter types and return type.");
    }

    /// <summary>Reports an interface method declared with a body (ADR-0018: Phase 3 interfaces are signature-only).</summary>
    /// <param name="location">The text location of the offending method identifier.</param>
    /// <param name="methodName">The method name.</param>
    public void ReportInterfaceMethodHasBody(TextLocation location, string methodName)
    {
        Report(location, $"Interface method '{methodName}' may not have a body in this version of GSharp; see ADR-0018.");
    }

    /// <summary>Reports a class that fails to implement an interface method.</summary>
    /// <param name="location">The text location of the class identifier.</param>
    /// <param name="className">The implementing class.</param>
    /// <param name="interfaceName">The interface name.</param>
    /// <param name="methodName">The missing method.</param>
    public void ReportInterfaceMethodNotImplemented(TextLocation location, string className, string interfaceName, string methodName)
    {
        Report(location, $"Class '{className}' does not implement interface method '{interfaceName}.{methodName}'.");
    }

    private void Report(TextLocation location, string message)
    {
        var diagnostic = new Diagnostic(location, message);
        diagnostics.Add(diagnostic);
    }
}
