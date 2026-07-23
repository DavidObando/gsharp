// <copyright file="DiagnosticBag.Reports.Statements.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis;

public sealed partial class DiagnosticBag
{
    /// <summary>
    /// Reports that not all code paths return a value.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportAllPathsMustReturn(TextLocation location)
    => Report(location, DiagnosticDescriptors.AllPathsMustReturn);

    /// <summary>
    /// Reports that a 'try' statement has neither catch nor finally clauses.
    /// </summary>
    /// <param name="location">The text location of the 'try' keyword.</param>
    public void ReportTryWithoutCatchOrFinally(TextLocation location)
    => Report(location, DiagnosticDescriptors.TryWithoutCatchOrFinally);

    /// <summary>
    /// Reports that a type used in a 'using' declaration does not implement IDisposable.
    /// </summary>
    /// <param name="location">The text location of the using keyword.</param>
    /// <param name="type">The non-disposable type.</param>
    public void ReportTypeNotDisposable(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.TypeNotDisposable, type.Name);

    /// <summary>
    /// Reports that the keyworkd can only be used inside of loops.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The keyword.</param>
    public void ReportInvalidBreakOrContinue(TextLocation location, string text)
    => Report(location, DiagnosticDescriptors.InvalidBreakOrContinue, text);

    /// <summary>
    /// Reports that the return keyword can only be used inside of functions.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportInvalidReturn(TextLocation location)
    => Report(location, DiagnosticDescriptors.InvalidReturn);

    /// <summary>
    /// Reports that the return value cannot be followed for an expression in functions without a return type.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="functionName">The name of the function.</param>
    public void ReportInvalidReturnExpression(TextLocation location, string functionName)
    => Report(location, DiagnosticDescriptors.InvalidReturnExpression, functionName);

    /// <summary>
    /// Reports that an expression of a given type was expected.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="returnType">The expected type.</param>
    public void ReportMissingReturnExpression(TextLocation location, TypeSymbol returnType)
    => Report(location, DiagnosticDescriptors.MissingReturnExpression, returnType);

    /// <summary>
    /// Reports that the specified variable is read-only and cannot be assigned.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the variable.</param>
    public void ReportCannotAssign(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.CannotAssign, name);

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
    => Report(location, DiagnosticDescriptors.InitOnlyPropertyAssignment, name);

    /// <summary>
    /// Reports that <c>await</c> appears outside an <c>async</c> function (Phase 5.1 / ADR-0023).
    /// </summary>
    /// <param name="location">The text location where the <c>await</c> keyword appears.</param>
    public void ReportAwaitOutsideAsyncFunction(TextLocation location)
    => Report(location, DiagnosticDescriptors.AwaitOutsideAsyncFunction);

    /// <summary>
    /// Reports that the operand of an <c>await for v := range stream</c> statement is not an <c>IAsyncEnumerable[T]</c> (Phase 5.8 / ADR-0023).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    /// <param name="actualType">The actual type of the operand.</param>
    public void ReportTypeIsNotAsyncEnumerable(TextLocation location, TypeSymbol actualType)
    => Report(location, DiagnosticDescriptors.TypeIsNotAsyncEnumerable, actualType);

    /// <summary>
    /// Reports that a <c>yield</c> statement was used outside an iterator function (ADR-0040).
    /// </summary>
    /// <param name="location">The text location of the yield keyword.</param>
    public void ReportYieldOutsideIteratorFunction(TextLocation location)
    => Report(location, DiagnosticDescriptors.YieldOutsideIteratorFunction);

    /// <summary>
    /// Reports that the operand of a <c>go</c> statement is not a call expression (Phase 5.3 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    public void ReportGoOperandIsNotACall(TextLocation location)
    => Report(location, DiagnosticDescriptors.GoOperandIsNotACall);

    /// <summary>
    /// Reports that the operand of a <c>defer</c> statement is not a call expression (Phase 7.1 / ADR-0030).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    public void ReportDeferOperandIsNotACall(TextLocation location)
    => Report(location, DiagnosticDescriptors.DeferOperandIsNotACall);

    /// <summary>
    /// Reports that the operand of a <c>defer</c> statement is a call with
    /// one or more <c>ref</c>/<c>out</c>/<c>in</c> arguments (issue #1635 NB-1).
    /// Eager argument capture spills each argument's evaluated value into a
    /// fresh readonly local ahead of the deferred invocation; a by-ref
    /// argument's value IS the address of its target storage, which cannot
    /// be spilled into an ordinary local without either aliasing an
    /// unrelated temp (silently breaking the by-ref contract) or requiring
    /// verifiable-IL support for spilled managed pointers that the emitter
    /// does not have. Rather than mis-defer the call, `defer` on such a call
    /// is rejected outright.
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    public void ReportDeferOperandHasByRefArgument(TextLocation location)
    => Report(location, DiagnosticDescriptors.DeferOperandHasByRefArgument);

    /// <summary>
    /// Reports that the operand of a <c>lock</c> statement is not a
    /// reference type (issue #1885). <c>lock</c> lowers to
    /// <c>System.Threading.Monitor.Enter/Exit</c>, which requires a
    /// reference-type argument; locking on a value type would box a fresh
    /// copy on every entry, defeating mutual exclusion (matches C# CS0185).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    /// <param name="type">The offending operand type.</param>
    public void ReportLockTargetMustBeReferenceType(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.LockTargetMustBeReferenceType, type.Name);

    /// <summary>
    /// Reports that a generic local-function declaration (<c>let Name[T, ...] = func (...) ... { ... }</c>,
    /// issue #1886) is not a <c>let</c>-bound function-literal initializer. A generic function value cannot
    /// be represented as a delegate stored in a variable (a CLR delegate cannot close over an unbound
    /// generic method), so this form only makes sense as a direct <c>let</c> binding of a function literal.
    /// </summary>
    /// <param name="location">The text location of the declaration's identifier.</param>
    /// <param name="name">The name of the declared local function.</param>
    public void ReportGenericLocalFunctionMustBeLetBoundLiteral(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.GenericLocalFunctionMustBeLetBoundLiteral, name, name);

    /// <summary>
    /// Reports that a generic local function (issue #1886) captures one or more outer variables. Generic
    /// local functions are emitted as genuine (non-delegate) generic methods, not closures; supporting
    /// captures would require a generic closure display-class with its own reified type parameters, which
    /// is out of scope for this feature.
    /// </summary>
    /// <param name="location">The text location of the declaration's identifier.</param>
    /// <param name="name">The name of the declared local function.</param>
    public void ReportGenericLocalFunctionCannotCapture(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.GenericLocalFunctionCannotCapture, name);

    /// <summary>
    /// Reports that a local function references a type parameter owned by an enclosing generic
    /// method or class, directly in its own parameter type, return type, or body — the sibling
    /// invalid-IL shapes of issue #1940 (a GENERIC local function declaring its own
    /// <c>[T, ...]</c>) and issue #2016 (a NON-generic local function that captures no outer
    /// variables). A generic local function is hoisted to its own top-level static method
    /// carrying only its own type-parameter list as CLR method-generic (MVAR) slots; a
    /// non-generic, zero-capture local function is instead hoisted to a plain top-level static
    /// method (issue #1469's zero-capture fast path) unless nested inside a non-generic user
    /// type purely for accessibility. In both shapes, the enclosing method/class type parameter
    /// has no corresponding slot on the hoisted method, so referencing it would silently emit
    /// invalid IL (an unresolvable MVAR/VAR reference) that crashes at run time with
    /// <c>InvalidProgramException</c> or <c>BadImageFormatException</c> instead of failing to
    /// compile.
    /// </summary>
    /// <param name="location">The text location of the declaration's identifier.</param>
    /// <param name="name">The name of the declared local function.</param>
    /// <param name="enclosingTypeParameterName">The name of the referenced enclosing type parameter.</param>
    public void ReportLocalFunctionCannotReferenceEnclosingTypeParameter(TextLocation location, string name, string enclosingTypeParameterName)
    => Report(location, DiagnosticDescriptors.LocalFunctionCannotReferenceEnclosingTypeParameter, name, enclosingTypeParameterName);

    /// <summary>
    /// Reports that the operand of a channel-receive expression (<c>&lt;-ch</c>) is not a channel (Phase 5.5 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    /// <param name="actualType">The actual type of the operand.</param>
    public void ReportReceiveOperandIsNotChannel(TextLocation location, TypeSymbol actualType)
    => Report(location, DiagnosticDescriptors.ReceiveOperandIsNotChannel, actualType);

    /// <summary>
    /// Reports that the left-hand side of a channel-send statement is not a channel (Phase 5.5 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the left-hand side.</param>
    /// <param name="actualType">The actual type of the left-hand side.</param>
    public void ReportSendTargetIsNotChannel(TextLocation location, TypeSymbol actualType)
    => Report(location, DiagnosticDescriptors.SendTargetIsNotChannel, actualType);

    /// <summary>
    /// Reports that the operand of <c>close(ch)</c> is not a channel (Phase 5.4 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    /// <param name="actualType">The actual type of the operand.</param>
    public void ReportCloseOperandIsNotChannel(TextLocation location, TypeSymbol actualType)
    => Report(location, DiagnosticDescriptors.CloseOperandIsNotChannel, actualType);

    /// <summary>
    /// Reports a <c>select</c> with no arms (Phase 5.6 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the <c>select</c> keyword.</param>
    public void ReportSelectWithNoCases(TextLocation location)
    => Report(location, DiagnosticDescriptors.SelectWithNoCases);

    /// <summary>
    /// Reports a <c>select</c> with more than one <c>default</c> arm (Phase 5.6 / ADR-0022).
    /// </summary>
    /// <param name="location">The text location of the duplicate <c>default</c> keyword.</param>
    public void ReportSelectDuplicateDefault(TextLocation location)
    => Report(location, DiagnosticDescriptors.SelectDuplicateDefault);

    /// <summary>Reports that a deconstruction target has the wrong number of elements.</summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="expected">The expected number of elements.</param>
    /// <param name="actual">The actual number of elements.</param>
    public void ReportDeconstructionFieldCountMismatch(TextLocation location, int expected, int actual)
    => Report(location, DiagnosticDescriptors.DeconstructionFieldCountMismatch, expected, actual);

    /// <summary>Reports that positional deconstruction needs a tuple or data struct.</summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="type">The actual initializer type.</param>
    public void ReportDeconstructionRequiresTupleOrDataStruct(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.DeconstructionRequiresTupleOrDataStruct, type);

    /// <summary>
    /// Reports that a multi-target assignment or short variable declaration has
    /// a different number of targets and values.
    /// </summary>
    /// <param name="location">The text location of the statement.</param>
    /// <param name="targetCount">The number of left-hand targets.</param>
    /// <param name="valueCount">The number of right-hand values.</param>
    public void ReportMultiAssignmentMismatch(TextLocation location, int targetCount, int valueCount)
    => Report(location, DiagnosticDescriptors.MultiAssignmentMismatch, targetCount, valueCount);

    /// <summary>
    /// Reports a use of the reserved <c>fallthrough</c> keyword (ADR-0013: GSharp
    /// does not support Go-style implicit case fallthrough).
    /// </summary>
    /// <param name="location">The text location where <c>fallthrough</c> was found.</param>
    public void ReportFallthroughNotSupported(TextLocation location)
    => Report(location, DiagnosticDescriptors.FallthroughNotSupported);

    /// <summary>
    /// Reports a duplicate <c>default</c> arm in a switch statement.
    /// </summary>
    /// <param name="location">The text location of the offending default arm.</param>
    public void ReportDuplicateSwitchDefault(TextLocation location)
    => Report(location, DiagnosticDescriptors.DuplicateSwitchDefault);

    /// <summary>
    /// Reports a non-constant value used in a switch case.
    /// </summary>
    /// <param name="location">The text location of the offending case value.</param>
    public void ReportSwitchCaseValueNotConstant(TextLocation location)
    => Report(location, DiagnosticDescriptors.SwitchCaseValueNotConstant);

    /// <summary>
    /// Reports a switch case value whose type doesn't match the discriminant.
    /// </summary>
    /// <param name="location">The text location of the offending case value.</param>
    /// <param name="caseType">The case value type.</param>
    /// <param name="switchType">The switched-on discriminant type.</param>
    public void ReportSwitchCaseTypeMismatch(TextLocation location, TypeSymbol caseType, TypeSymbol switchType)
    => Report(location, DiagnosticDescriptors.SwitchCaseTypeMismatch, caseType, switchType);

    /// <summary>Reports that a property pattern was used on a non-aggregate type.</summary>
    /// <param name="location">The text location.</param>
    /// <param name="type">The discriminant type.</param>
    public void ReportPropertyPatternRequiresStructOrClass(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.PropertyPatternRequiresStructOrClass, type);

    /// <summary>Reports that a property pattern references an unknown field.</summary>
    /// <param name="location">The text location.</param>
    /// <param name="fieldName">The field name.</param>
    /// <param name="type">The containing type.</param>
    public void ReportUndefinedFieldOnType(TextLocation location, string fieldName, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.UndefinedFieldOnType, type, fieldName);

    /// <summary>Reports that a relational pattern operator is not defined for a type.</summary>
    /// <param name="location">The text location.</param>
    /// <param name="op">The operator kind.</param>
    /// <param name="type">The operand type.</param>
    public void ReportRelationalPatternOperatorUndefined(TextLocation location, SyntaxKind op, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.RelationalPatternOperatorUndefined, SyntaxFacts.GetText(op), type);

    /// <summary>Reports that a list pattern was used on a non-array/slice type.</summary>
    /// <param name="location">The text location.</param>
    /// <param name="type">The discriminant type.</param>
    public void ReportListPatternRequiresArrayOrSlice(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.ListPatternRequiresArrayOrSlice, type);

    /// <summary>
    /// Reports a switch expression without a default arm.
    /// </summary>
    /// <param name="location">The text location of the switch expression.</param>
    public void ReportSwitchExpressionMissingDefault(TextLocation location)
    => Report(location, DiagnosticDescriptors.SwitchExpressionMissingDefault);

    /// <summary>
    /// Reports a non-exhaustive switch expression over a closed discriminant.
    /// </summary>
    /// <param name="location">The text location of the switch expression.</param>
    /// <param name="discriminantTypeName">The discriminant type description.</param>
    /// <param name="missingNames">The missing variant names.</param>
    public void ReportSwitchExpressionNotExhaustive(TextLocation location, string discriminantTypeName, IEnumerable<string> missingNames)
    => Report(location, DiagnosticDescriptors.SwitchExpressionNotExhaustive, discriminantTypeName, FormatMissingNames(missingNames));

    /// <summary>
    /// Reports a non-exhaustive switch statement over a closed discriminant.
    /// </summary>
    /// <param name="location">The text location of the switch statement.</param>
    /// <param name="discriminantTypeName">The discriminant type description.</param>
    /// <param name="missingNames">The missing variant names.</param>
    public void ReportSwitchStatementNotExhaustive(TextLocation location, string discriminantTypeName, IEnumerable<string> missingNames)
    => Report(location, DiagnosticDescriptors.SwitchStatementNotExhaustive, discriminantTypeName, FormatMissingNames(missingNames));

    /// <summary>
    /// Reports a switch-expression arm whose result type does not match the unified result type.
    /// </summary>
    /// <param name="location">The text location of the offending arm.</param>
    /// <param name="armType">The arm result type.</param>
    /// <param name="expectedType">The expected result type.</param>
    public void ReportSwitchExpressionArmTypeMismatch(TextLocation location, TypeSymbol armType, TypeSymbol expectedType)
    => Report(location, DiagnosticDescriptors.SwitchExpressionArmTypeMismatch, expectedType, armType);

    /// <summary>GS9003: Variable must be definitely assigned before being passed by ref.</summary>
    /// <param name="location">The text location of the argument.</param>
    /// <param name="variableName">The variable name.</param>
    public void ReportVariableNotDefinitelyAssignedForRef(TextLocation location, string variableName)
    => Report(location, DiagnosticDescriptors.VariableNotDefinitelyAssignedForRef, variableName);

    /// <summary>
    /// GS0402: the operand of a prefix/postfix increment (<c>++</c>) or
    /// decrement (<c>--</c>) expression is not a writable lvalue (ADR-0126 /
    /// issue #1027). The operand must be a variable, field, array element, or
    /// indexer — the same set of targets accepted by a compound assignment.
    /// </summary>
    /// <param name="location">The text location of the offending operand.</param>
    /// <param name="operatorText">The increment/decrement operator text (<c>++</c> or <c>--</c>).</param>
    public void ReportInvalidIncrementDecrementTarget(TextLocation location, string operatorText)
    => Report(location, DiagnosticDescriptors.InvalidIncrementDecrementTarget, operatorText);

    /// <summary>
    /// ADR-0056 §2: reports an attempt to assign through a read-only span
    /// element. A <c>ReadOnlySpan[T]</c> indexer is <c>ref readonly T</c>, so
    /// <c>span[i] = v</c> is not permitted (only <c>Span[T]</c> writes are).
    /// </summary>
    /// <param name="location">The text location of the offending assignment.</param>
    /// <param name="type">The read-only span type being written through.</param>
    public void ReportCannotAssignReadOnlySpanElement(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.CannotAssignReadOnlySpanElement, type.Name);

    /// <summary>
    /// ADR-0060 §5: reports an assignment to an <c>in</c> parameter inside the function body.
    /// </summary>
    /// <param name="location">The assignment location.</param>
    /// <param name="parameterName">The parameter name.</param>
    public void ReportCannotAssignToInParameter(TextLocation location, string parameterName)
    => Report(location, DiagnosticDescriptors.CannotAssignToInParameter, parameterName);

    /// <summary>
    /// ADR-0060 §5: reports a return-path on which an <c>out</c> parameter has not been
    /// definitely assigned. The diagnostic locates the offending <c>return</c>.
    /// </summary>
    /// <param name="location">The location of the return statement (or the end-of-body for fall-through).</param>
    /// <param name="parameterName">The out parameter name.</param>
    public void ReportOutParameterNotAssigned(TextLocation location, string parameterName)
    => Report(location, DiagnosticDescriptors.OutParameterNotAssigned, parameterName);

    /// <summary>
    /// ADR-0060 §8: user-facing twin of GS9003. Reports that a variable was passed by <c>ref</c>
    /// before being definitely assigned.
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="variableName">The variable name.</param>
    public void ReportVariableNotAssignedBeforeRef(TextLocation location, string variableName)
    => Report(location, DiagnosticDescriptors.VariableNotAssignedBeforeRef, variableName);

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): a function declaration carries a <c>ref</c> return modifier
    /// without an explicit return type clause (e.g. <c>func foo() ref { ... }</c>).
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> modifier.</param>
    public void ReportRefReturnRequiresReturnType(TextLocation location)
    => Report(location, DiagnosticDescriptors.RefReturnRequiresReturnType);

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): a <c>ref</c> return modifier was placed on an
    /// <c>async</c> or sequence/async-sequence function; the state-machine rewriter cannot
    /// hoist a managed pointer into a state-machine field (ELEMENT_TYPE_BYREF is illegal
    /// in field signatures — ADR-0058 §2).
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> modifier.</param>
    /// <param name="kind">"async", "sequence", or "async sequence".</param>
    public void ReportRefReturnOnAsyncOrIterator(TextLocation location, string kind)
    => Report(location, DiagnosticDescriptors.RefReturnOnAsyncOrIterator, kind);

    /// <summary>
    /// Issue #490: a <c>ref</c>-returning function declares its return type as <c>*T</c>
    /// (a managed pointer). The two are redundant — write <c>ref T</c> instead of <c>ref *T</c>.
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> modifier.</param>
    public void ReportRefReturnOfByRefType(TextLocation location)
    => Report(location, DiagnosticDescriptors.RefReturnOfByRefType);

    /// <summary>
    /// Issue #490: a <c>return ref expr</c> statement appears inside a function whose
    /// declaration does not carry the <c>ref</c> return modifier.
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> keyword on the return statement.</param>
    /// <param name="functionName">The enclosing function name.</param>
    public void ReportRefReturnInNonRefReturningFunction(TextLocation location, string functionName)
    => Report(location, DiagnosticDescriptors.RefReturnInNonRefReturningFunction, functionName);

    /// <summary>
    /// Issue #490: a plain <c>return expr</c> statement appears inside a <c>ref</c>-returning function.
    /// The body must use <c>return ref &lt;lvalue&gt;</c>.
    /// </summary>
    /// <param name="location">The location of the <c>return</c> keyword.</param>
    /// <param name="functionName">The enclosing function name.</param>
    public void ReportRefReturnRequiredOnRefReturningFunction(TextLocation location, string functionName)
    => Report(location, DiagnosticDescriptors.RefReturnRequiredOnRefReturningFunction, functionName);

    /// <summary>
    /// Issue #490: the operand of <c>return ref</c> is not an lvalue (literal, arithmetic
    /// expression, call result, etc.). Only variables, fields, array elements, dereferences,
    /// and conditional expressions whose branches are themselves lvalues can be returned by ref.
    /// </summary>
    /// <param name="location">The location of the offending expression.</param>
    public void ReportRefReturnRequiresLvalue(TextLocation location)
    => Report(location, DiagnosticDescriptors.RefReturnRequiresLvalue);

    /// <summary>
    /// Issue #490 (ADR-0058 ref-safe-to-escape): the operand of <c>return ref</c> refers to
    /// storage that dies at function exit (a local variable, a <c>scoped</c> parameter, or a
    /// field/element rooted in one of those). Returning that pointer would expose dangling
    /// memory to the caller.
    /// </summary>
    /// <param name="location">The location of the offending expression.</param>
    public void ReportRefReturnEscapesLocalScope(TextLocation location)
    => Report(location, DiagnosticDescriptors.RefReturnEscapesLocalScope);

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): reports a ref-aliasing local declaration whose
    /// initializer is not an lvalue. <c>let ref</c> / <c>var ref</c> binds the local as
    /// an alias for an existing storage slot — the RHS must therefore be a variable, a
    /// field/property access, an indexer access, or a dereference of a managed pointer.
    /// </summary>
    /// <param name="location">The <c>ref</c> modifier location.</param>
    /// <param name="exprText">The source text of the offending RHS expression.</param>
    public void ReportRefLocalRhsMustBeLvalue(TextLocation location, string exprText)
    => Report(location, DiagnosticDescriptors.RefLocalRhsMustBeLvalue, exprText);

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
    => Report(location, DiagnosticDescriptors.RefLocalRhsHasNarrowerEscapeScope, variableName);

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
    => Report(location, DiagnosticDescriptors.RefLocalCannotBeDeclaredHere, variableName, context);

    /// <summary>
    /// Reports that a <c>for x in expr</c> loop cannot be lowered because the
    /// collection type does not expose a usable <c>GetEnumerator()</c> method.
    /// </summary>
    /// <param name="location">The collection expression location.</param>
    /// <param name="type">The collection type.</param>
    public void ReportTypeNotIterable(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.TypeNotIterable, type.Name);

    /// <summary>
    /// Reports that <c>await using let</c> appears outside an <c>async</c> function.
    /// </summary>
    /// <param name="location">The text location of the <c>await</c> keyword.</param>
    public void ReportAwaitUsingOutsideAsyncFunction(TextLocation location)
    => Report(location, DiagnosticDescriptors.AwaitUsingOutsideAsyncFunction);

    /// <summary>
    /// Reports that a type used in an <c>await using</c> declaration does not implement IAsyncDisposable.
    /// </summary>
    /// <param name="location">The text location of the await using keyword.</param>
    /// <param name="type">The non-async-disposable type.</param>
    public void ReportTypeNotAsyncDisposable(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.TypeNotAsyncDisposable, type.Name);

    /// <summary>
    /// ADR-0070 / issue #707: GS0293 — a labeled <c>break</c> or <c>continue</c>
    /// names a loop that is not in scope.
    /// </summary>
    /// <param name="location">The source location of the offending label identifier.</param>
    /// <param name="keyword">The originating keyword (<c>break</c> or <c>continue</c>).</param>
    /// <param name="labelName">The unresolved label name.</param>
    public void ReportUnknownLoopLabel(TextLocation location, string keyword, string labelName)
    => Report(location, DiagnosticDescriptors.UnknownLoopLabel, labelName, keyword, labelName);

    /// <summary>
    /// ADR-0070 / issue #1884: GS0469 — a <c>goto</c> targets a label name
    /// that is never defined anywhere in the enclosing function.
    /// </summary>
    /// <param name="location">The source location of the offending label identifier.</param>
    /// <param name="labelName">The unresolved label name.</param>
    public void ReportUndefinedGotoLabel(TextLocation location, string labelName)
    => Report(location, DiagnosticDescriptors.UndefinedGotoLabel, labelName);

    /// <summary>
    /// ADR-0070 / issue #1884: GS0470 — two <c>goto</c> labels with the same
    /// name are declared in the same enclosing function. The label namespace
    /// is local to the enclosing function (ADR-0070), so this is an error
    /// even when the two labels are in disjoint nested blocks.
    /// </summary>
    /// <param name="location">The source location of the second (duplicate) label declaration.</param>
    /// <param name="labelName">The duplicated label name.</param>
    public void ReportDuplicateGotoLabel(TextLocation location, string labelName)
    => Report(location, DiagnosticDescriptors.DuplicateGotoLabel, labelName);

    /// <summary>
    /// Reports a function-wide goto that enters a catch or finally handler.
    /// </summary>
    /// <param name="location">The source location of the goto label identifier.</param>
    /// <param name="labelName">The target label name.</param>
    public void ReportGotoIntoExceptionHandler(TextLocation location, string labelName)
    => Report(location, DiagnosticDescriptors.GotoIntoExceptionHandler, labelName);

    /// <summary>
    /// ADR-0070 / issue #707: GS0295 (warning) — a loop label shadows an
    /// enclosing live loop label of the same name. The inner label wins for
    /// nested <c>break</c> / <c>continue</c> resolution.
    /// </summary>
    /// <param name="location">The source location of the offending label identifier.</param>
    /// <param name="labelName">The shadowed label name.</param>
    public void ReportLabelShadowsEnclosingLoop(TextLocation location, string labelName)
    => Report(location, DiagnosticDescriptors.LabelShadowsEnclosingLoop, labelName);

    /// <summary>
    /// ADR-0071 / issue #708: GS0296 — the right-hand side of an
    /// <c>if let</c> / <c>guard let</c> binding is not of nullable type.
    /// The binding form is intended to strip a single layer of nullability;
    /// applying it to a non-nullable value would do nothing useful and is
    /// almost certainly a programmer error.
    /// </summary>
    /// <param name="location">The source location of the offending initializer.</param>
    /// <param name="bindingName">The name introduced by the binding.</param>
    /// <param name="actualType">The actual (non-nullable) initializer type.</param>
    public void ReportIfLetInitializerMustBeNullable(TextLocation location, string bindingName, TypeSymbol actualType)
    => Report(location, DiagnosticDescriptors.IfLetInitializerMustBeNullable, bindingName, actualType, bindingName);

    /// <summary>
    /// ADR-0071 / issue #708: GS0297 — the else block of a <c>guard let</c>
    /// statement must unconditionally exit the enclosing scope. Accepted
    /// terminators are <c>return</c>, <c>throw</c>, <c>break</c>,
    /// <c>continue</c>, and any block whose last statement does so. An
    /// <c>if</c>/<c>else</c> qualifies only when both arms exit.
    /// </summary>
    /// <param name="location">The source location of the offending else clause.</param>
    public void ReportGuardLetElseMustExit(TextLocation location)
    => Report(location, DiagnosticDescriptors.GuardLetElseMustExit);

    /// <summary>
    /// ADR-0078 / issue #718: GS0313 — a switch over a sealed-class hierarchy
    /// is missing a case for a known subtype.
    /// </summary>
    /// <param name="location">The source location of the switch keyword.</param>
    /// <param name="missingCaseName">The name of the missing case / subtype.</param>
    /// <param name="baseTypeName">The sealed-base type name.</param>
    public void ReportSealedHierarchyMissingCase(TextLocation location, string missingCaseName, string baseTypeName)
    => Report(location, DiagnosticDescriptors.SealedHierarchyMissingCase, baseTypeName, missingCaseName);

    /// <summary>
    /// Issue #1505: GS0416 — a list pattern contains more than one slice
    /// ("rest") subpattern (<c>..</c>). A list pattern admits at most one slice
    /// element; the elements before it form the fixed prefix and the elements
    /// after it form the fixed suffix. Mirrors C#'s CS8980.
    /// </summary>
    /// <param name="location">The source location of the offending <c>..</c> token.</param>
    public void ReportMultipleSlicePatternsInListPattern(TextLocation location)
    => Report(location, DiagnosticDescriptors.MultipleSlicePatternsInListPattern);

    /// <summary>
    /// Issue #1603: GS0418 — a <c>using</c> or <c>await using</c> statement's
    /// declaration was a tuple or named deconstruction (<c>let (a, b) = …</c>
    /// or <c>let { … } = …</c>) rather than a single variable declaration.
    /// <c>using</c> disposes exactly one bound value, so deconstruction is not
    /// supported there; report a diagnostic instead of crashing the parser.
    /// </summary>
    /// <param name="location">The text location of the offending declaration.</param>
    public void ReportUsingRequiresSingleVariableDeclaration(TextLocation location)
    => Report(location, DiagnosticDescriptors.UsingRequiresSingleVariableDeclaration);

    /// <summary>
    /// Reports GS0367 — issue #836: a <c>yield</c> statement appears
    /// lexically inside a <c>try</c> block that also has one or more
    /// <c>catch</c> clauses. The C# spec (§15.14) and ECMA-335 forbid
    /// this combination because the iterator state machine cannot
    /// safely resume into a protected region from a synthesized
    /// dispatch. Wrap the <c>yield</c> in a separate <c>try</c>/
    /// <c>finally</c> instead, or move the exception-handling block to
    /// the consumer (<c>for v in iter()</c>) side.
    /// </summary>
    /// <param name="location">The source location of the offending
    /// <c>yield</c> keyword.</param>
    public void ReportYieldInsideTryWithCatch(TextLocation location)
    => Report(location, DiagnosticDescriptors.YieldInsideTryWithCatch);

    /// <summary>
    /// Issue #992: GS0390 — a type pattern that introduces a binding variable
    /// appears under an <c>or</c> or <c>not</c> pattern combinator, where the
    /// variable would not be definitely assigned when the arm runs. Mirrors
    /// C#'s CS8780. Use the discard identifier <c>_</c> instead, or restructure
    /// the pattern.
    /// </summary>
    /// <param name="location">The source location of the binding identifier.</param>
    /// <param name="variableName">The name of the would-be binding variable.</param>
    public void ReportPatternVariableNotAllowedUnderOrNot(
        TextLocation location,
        string variableName)
    => Report(location, DiagnosticDescriptors.PatternVariableNotAllowedUnderOrNot, variableName);

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
}
