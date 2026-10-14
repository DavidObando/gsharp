// <copyright file="DiagnosticBag.Reports.Statements.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

partial class DiagnosticBag : IEnumerable[Diagnostic] {
    /// Reports that not all code paths return a value.
    /// @param location The text location where the error was found.
    func ReportAllPathsMustReturn(location TextLocation) -> Report(location, DiagnosticDescriptors.AllPathsMustReturn)

    /// Reports that a 'try' statement has neither catch nor finally clauses.
    /// @param location The text location of the 'try' keyword.
    func ReportTryWithoutCatchOrFinally(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.TryWithoutCatchOrFinally
    )

    /// Reports GS0570: a 'rethrow' with no enclosing 'catch' handler.
    /// @param location The text location of the 'rethrow' keyword.
    func ReportRethrowOutsideCatchHandler(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RethrowOutsideCatchHandler
    )

    /// Reports GS0571: a 'rethrow' inside a 'finally' that is nested inside the
    /// nearest enclosing 'catch' handler.
    /// @param location The text location of the 'rethrow' keyword.
    func ReportRethrowInsideNestedFinally(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RethrowInsideNestedFinally
    )

    /// Reports GS0572: an 'await' inside a 'catch' filter (ADR-0177).
    /// @param location The text location of the await expression.
    func ReportAwaitInsideCatchFilter(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.AwaitInsideCatchFilter
    )

    /// Reports GS0573: a 'catch' clause an earlier unfiltered clause already covers (ADR-0177).
    /// @param location The text location of the unreachable clause.
    /// @param earlierType The exception type caught by the earlier clause.
    /// @param thisType The exception type named by this clause.
    func ReportUnreachableCatchClause(location TextLocation, earlierType TypeSymbol, thisType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.UnreachableCatchClause,
        earlierType,
        thisType
    )

    /// Reports that a type used in a 'using' declaration does not implement IDisposable.
    /// @param location The text location of the using keyword.
    /// @param type The non-disposable type.
    func ReportTypeNotDisposable(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.TypeNotDisposable,
        type
    )

    /// Reports that the keyworkd can only be used inside of loops.
    /// @param location The text location where the error was found.
    /// @param text The keyword.
    func ReportInvalidBreakOrContinue(location TextLocation, text string) -> Report(
        location,
        DiagnosticDescriptors.InvalidBreakOrContinue,
        text
    )

    /// Reports that the return keyword can only be used inside of functions.
    /// @param location The text location where the error was found.
    func ReportInvalidReturn(location TextLocation) -> Report(location, DiagnosticDescriptors.InvalidReturn)

    /// Reports that the return value cannot be followed for an expression in functions without a return
    /// type.
    /// @param location The text location where the error was found.
    /// @param functionName The name of the function.
    func ReportInvalidReturnExpression(location TextLocation, functionName string) -> Report(
        location,
        DiagnosticDescriptors.InvalidReturnExpression,
        functionName
    )

    /// Reports that an expression of a given type was expected.
    /// @param location The text location where the error was found.
    /// @param returnType The expected type.
    func ReportMissingReturnExpression(location TextLocation, returnType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.MissingReturnExpression,
        returnType
    )

    /// Reports that the specified variable is read-only and cannot be assigned.
    /// @param location The text location where the error was found.
    /// @param name The name of the variable.
    func ReportCannotAssign(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.CannotAssign,
        name
    )

    /// Reports a field write through a non-addressable struct value, where the
    /// write would otherwise target a temporary copy and be discarded.
    /// @param location The assignment operator location.
    /// @param fieldName The field being assigned.
    /// @param receiverType The struct receiver type.
    func ReportFieldAssignmentThroughStructTemporary(
        location TextLocation,
        fieldName string,
        receiverType TypeSymbol
    ) -> Report(location, DiagnosticDescriptors.FieldAssignmentThroughStructTemporary, fieldName, receiverType)

    /// Issue #2834: reports a user-defined compound-assignment operator whose
    /// shape does not match the C# 14 contract (instance, one parameter, no
    /// return value).
    /// @param location The operator token location.
    /// @param operatorName The metadata operator name, e.g. `op_AdditionAssignment`.
    func ReportInvalidCompoundAssignmentOperatorShape(location TextLocation, operatorName string) -> Report(
        location,
        DiagnosticDescriptors.InvalidCompoundAssignmentOperatorShape,
        operatorName
    )

    /// Issue #2822: reports imported metadata whose public parameterless
    /// members cannot be distinguished by reflection.
    /// @param location The consuming source location.
    /// @param type The malformed imported type.
    /// @param memberName The ambiguous member name.
    func ReportAmbiguousImportedMember(location TextLocation, type TypeSymbol, memberName string) -> Report(
        location,
        DiagnosticDescriptors.AmbiguousImportedMember,
        type,
        memberName
    )

    /// Issue #946: reports that an `init`-only property was assigned
    /// outside of object initialization. An `init`-only property may only
    /// be assigned in the declaring type's constructor(s), in an object/
    /// aggregate initializer at the creation site, or within an `init`
    /// accessor of the same instance.
    /// @param location The text location where the error was found.
    /// @param name The name of the property.
    func ReportInitOnlyPropertyAssignment(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.InitOnlyPropertyAssignment,
        name
    )

    /// Reports that `await` appears outside an `async` function (Phase 5.1 / ADR-0023).
    /// @param location The text location where the `await` keyword appears.
    func ReportAwaitOutsideAsyncFunction(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.AwaitOutsideAsyncFunction
    )

    /// Reports that the operand of an `await for v := range stream` statement is not an
    /// `IAsyncEnumerable[T]` (Phase 5.8 / ADR-0023).
    /// @param location The text location of the operand.
    /// @param actualType The actual type of the operand.
    func ReportTypeIsNotAsyncEnumerable(location TextLocation, actualType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.TypeIsNotAsyncEnumerable,
        actualType
    )

    /// Reports that a `yield` statement was used outside an iterator function (ADR-0040).
    /// @param location The text location of the yield keyword.
    func ReportYieldOutsideIteratorFunction(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.YieldOutsideIteratorFunction
    )

    /// Reports that the operand of a `go` statement is not a call expression (Phase 5.3 / ADR-0022).
    /// @param location The text location of the operand.
    func ReportGoOperandIsNotACall(location TextLocation) -> Report(location, DiagnosticDescriptors.GoOperandIsNotACall)

    /// Reports that the operand of a `defer` statement is not a call expression (Phase 7.1 / ADR-0030).
    /// @param location The text location of the operand.
    func ReportDeferOperandIsNotACall(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.DeferOperandIsNotACall
    )

    /// Reports that the operand of a `defer` statement is a call with
    /// one or more `ref`/`out`/`in` arguments (issue #1635 NB-1).
    /// Eager argument capture spills each argument's evaluated value into a
    /// fresh readonly local ahead of the deferred invocation; a by-ref
    /// argument's value IS the address of its target storage, which cannot
    /// be spilled into an ordinary local without either aliasing an
    /// unrelated temp (silently breaking the by-ref contract) or requiring
    /// verifiable-IL support for spilled managed pointers that the emitter
    /// does not have. Rather than mis-defer the call, `defer` on such a call
    /// is rejected outright.
    /// @param location The text location of the operand.
    func ReportDeferOperandHasByRefArgument(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.DeferOperandHasByRefArgument
    )

    /// Reports that the operand of a `lock` statement is not a
    /// reference type (issue #1885). `lock` lowers to
    /// `System.Threading.Monitor.Enter/Exit`, which requires a
    /// reference-type argument; locking on a value type would box a fresh
    /// copy on every entry, defeating mutual exclusion (matches C# CS0185).
    /// @param location The text location of the operand.
    /// @param type The offending operand type.
    func ReportLockTargetMustBeReferenceType(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.LockTargetMustBeReferenceType,
        type
    )

    /// Reports that a generic local-function declaration (`let Name[T, ...] = func (...) ... { ... }`,
    /// issue #1886) is not a `let`-bound function-literal initializer. A generic function value cannot
    /// be represented as a delegate stored in a variable (a CLR delegate cannot close over an unbound
    /// generic method), so this form only makes sense as a direct `let` binding of a function literal.
    /// @param location The text location of the declaration's identifier.
    /// @param name The name of the declared local function.
    func ReportGenericLocalFunctionMustBeLetBoundLiteral(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.GenericLocalFunctionMustBeLetBoundLiteral,
        name,
        name
    )

    /// Reports that a generic local function (issue #1886) captures one or more outer variables. Generic
    /// local functions are emitted as genuine (non-delegate) generic methods, not closures; supporting
    /// captures would require a generic closure display-class with its own reified type parameters, which
    /// is out of scope for this feature.
    /// @param location The text location of the declaration's identifier.
    /// @param name The name of the declared local function.
    func ReportGenericLocalFunctionCannotCapture(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.GenericLocalFunctionCannotCapture,
        name
    )

    /// Reports a direct generic local whose required lexical host cannot be emitted.
    /// @param location The declaration identifier's location.
    /// @param name The generic local's name.
    /// @param owner The unsupported lexical owner.
    func ReportGenericLocalFunctionUnsupportedOwner(location TextLocation, name string, owner TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.GenericLocalFunctionUnsupportedOwner,
        name,
        owner
    )

    /// Reports that a local function references a type parameter owned by an enclosing generic
    /// method or class, directly in its own parameter type, return type, or body — the sibling
    /// invalid-IL shapes of issue #1940 (a GENERIC local function declaring its own
    /// `[T, ...]`) and issue #2016 (a NON-generic local function that captures no outer
    /// variables). A generic local function is hoisted to its own top-level static method
    /// carrying only its own type-parameter list as CLR method-generic (MVAR) slots; a
    /// non-generic, zero-capture local function is instead hoisted to a plain top-level static
    /// method (issue #1469's zero-capture fast path) unless nested inside a non-generic user
    /// type purely for accessibility. In both shapes, the enclosing method/class type parameter
    /// has no corresponding slot on the hoisted method, so referencing it would silently emit
    /// invalid IL (an unresolvable MVAR/VAR reference) that crashes at run time with
    /// `InvalidProgramException` or `BadImageFormatException` instead of failing to
    /// compile.
    /// @param location The text location of the declaration's identifier.
    /// @param name The name of the declared local function.
    /// @param enclosingTypeParameterName The name of the referenced enclosing type parameter.
    func ReportLocalFunctionCannotReferenceEnclosingTypeParameter(
        location TextLocation,
        name string,
        enclosingTypeParameterName string
    ) -> Report(
        location,
        DiagnosticDescriptors.LocalFunctionCannotReferenceEnclosingTypeParameter,
        name,
        enclosingTypeParameterName
    )

    /// Reports that the operand of a channel-receive expression (`<-ch`) is not a channel (Phase 5.5 /
    /// ADR-0022).
    /// @param location The text location of the operand.
    /// @param actualType The actual type of the operand.
    func ReportReceiveOperandIsNotChannel(location TextLocation, actualType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.ReceiveOperandIsNotChannel,
        actualType
    )

    /// Reports that the left-hand side of a channel-send statement is not a channel (Phase 5.5 / ADR-0022).
    /// @param location The text location of the left-hand side.
    /// @param actualType The actual type of the left-hand side.
    func ReportSendTargetIsNotChannel(location TextLocation, actualType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.SendTargetIsNotChannel,
        actualType
    )

    /// ADR-0174 D2: GS0549 — a send through an `in chan[T]` (receive-only) handle.
    /// @param location The location of the send operator.
    /// @param channelType The receive-only channel type.
    func ReportSendOnReceiveOnlyChannel(location TextLocation, channelType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.SendOnReceiveOnlyChannel,
        channelType
    )

    /// ADR-0174 D2: GS0550 — a receive through an `out chan[T]` (send-only) handle.
    /// @param location The location of the receive operator.
    /// @param channelType The send-only channel type.
    func ReportReceiveFromSendOnlyChannel(location TextLocation, channelType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.ReceiveFromSendOnlyChannel,
        channelType
    )

    /// ADR-0174 D3: GS0554 — a channel-receive binding form was given the wrong number of targets.
    /// @param location The location of the offending target list.
    /// @param form The canonical spelling of the form, for example `let value, ok = <-ch`.
    /// @param expected The expected target count in words, for example `two targets`.
    /// @param actual The number of targets the author wrote.
    func ReportChannelBindingTargetCount(location TextLocation, form string, expected string, actual int32) -> Report(
        location,
        DiagnosticDescriptors.ChannelBindingTargetCount,
        form,
        expected,
        actual
    )

    /// ADR-0174 D4: GS0558 — a suspending function is called from a non-suspending, non-async function and
    /// blocks the thread.
    /// @param location The call's location.
    /// @param calleeName The suspending function's name.
    func ReportSuspendingCallBlocks(location TextLocation, calleeName string) -> Report(
        location,
        DiagnosticDescriptors.SuspendingCallBlocks,
        calleeName
    )

    /// ADR-0174 D4: GS0574 — an `await` sits in a function whose signature inference may not change.
    /// @param location The `await`'s location.
    /// @param containerName The enclosing function's name.
    func ReportAwaitAtSuspensionBoundary(location TextLocation, containerName string) -> Report(
        location,
        DiagnosticDescriptors.AwaitAtSuspensionBoundary,
        containerName
    )

    /// ADR-0174 D4: GS0575 — an `await` sits in a `lock` body, whose monitor is thread-affine.
    /// @param location The `await`'s location.
    func ReportAwaitInsideLockBody(location TextLocation) -> Report(location, DiagnosticDescriptors.AwaitInsideLockBody)

    /// ADR-0174 D5: GS0576 — an `await` is nested in a `go` operand's arguments.
    /// @param location The `await`'s location.
    func ReportAwaitInsideGoOperand(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.AwaitInsideGoOperand
    )

    /// ADR-0174 D3: GS0555 — a `while let` initializer is a channel handle rather than a receive from one.
    /// @param location The location of the initializer.
    /// @param bindingName The binding's identifier.
    /// @param initializerText The initializer's source text.
    func ReportWhileLetOverChannelNeedsReceive(
        location TextLocation,
        bindingName string,
        initializerText string
    ) -> Report(location, DiagnosticDescriptors.WhileLetOverChannelNeedsReceive, bindingName, initializerText)

    /// ADR-0174 D12: GS0548 — `chan[T]()` constructs a rendezvous channel; advisory for the reader who
    /// wanted a buffer.
    /// @param location The location of the construction.
    /// @param elementTypeText The element type's display text.
    func ReportRendezvousChannelConstructed(location TextLocation, elementTypeText string) -> Report(
        location,
        DiagnosticDescriptors.RendezvousChannelConstructed,
        elementTypeText
    )

    /// Reports that the operand of `close(ch)` is not a channel (Phase 5.4 / ADR-0022).
    /// @param location The text location of the operand.
    /// @param actualType The actual type of the operand.
    func ReportCloseOperandIsNotChannel(location TextLocation, actualType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.CloseOperandIsNotChannel,
        actualType
    )

    /// Reports a `select` with no arms (Phase 5.6 / ADR-0022).
    /// @param location The text location of the `select` keyword.
    func ReportSelectWithNoCases(location TextLocation) -> Report(location, DiagnosticDescriptors.SelectWithNoCases)

    /// Reports GS0562: a batch operation on a rendezvous channel (ADR-0174 D10).
    /// @param location The call's location.
    /// @param channel The channel's name.
    func ReportBatchOnRendezvousChannel(location TextLocation, channel string) -> Report(
        location,
        DiagnosticDescriptors.BatchOnRendezvousChannel,
        channel
    )

    /// Reports GS0551: an `async let` with no enclosing `scope` to own it (ADR-0174 D15).
    /// @param location The `async` keyword's location.
    func ReportAsyncLetOutsideScope(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.AsyncLetOutsideScope
    )

    /// Reports GS0559: an `async let` binding that is never awaited (ADR-0174 D15).
    /// @param location The binding's location.
    /// @param name The binding's name.
    func ReportAsyncLetNeverAwaited(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.AsyncLetNeverAwaited,
        name
    )

    /// Reports GS0569: an `async let` binding read without `await` (ADR-0174 D15).
    /// @param location The read's location.
    /// @param name The binding's name.
    func ReportAsyncLetReadWithoutAwait(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.AsyncLetReadWithoutAwait,
        name
    )

    /// Reports GS0556: a select arm's `when` guard is not a `bool` (ADR-0174 D8).
    /// @param location The guard's location.
    /// @param type The guard's type.
    func ReportSelectArmGuardIsNotBoolean(location TextLocation, type TypeSymbol?) -> Report(
        location,
        DiagnosticDescriptors.SelectArmGuardIsNotBoolean,
        type?.ToString() ?? "?"
    )

    /// Reports GS0557: `case cancelled` with no ambient context to observe (ADR-0174 D8).
    /// @param location The arm's location.
    func ReportSelectCancelledArmNeedsContext(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.SelectCancelledArmNeedsContext
    )

    /// Reports GS0564: one channel is both sent to and received from by the same select (ADR-0174 D8).
    /// @param location The second arm's location.
    /// @param channel The channel's name.
    func ReportSelectChannelSentAndReceived(location TextLocation, channel string) -> Report(
        location,
        DiagnosticDescriptors.SelectChannelSentAndReceived,
        channel
    )

    /// Reports a `select` with more than one `default` arm (Phase 5.6 / ADR-0022).
    /// @param location The text location of the duplicate `default` keyword.
    func ReportSelectDuplicateDefault(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.SelectDuplicateDefault
    )

    /// Reports that a deconstruction target has the wrong number of elements.
    /// @param location The text location where the error was found.
    /// @param expected The expected number of elements.
    /// @param actual The actual number of elements.
    func ReportDeconstructionFieldCountMismatch(location TextLocation, expected int32, actual int32) -> Report(
        location,
        DiagnosticDescriptors.DeconstructionFieldCountMismatch,
        expected,
        actual
    )

    /// Reports that positional deconstruction needs a tuple or data struct.
    /// @param location The text location where the error was found.
    /// @param type The actual initializer type.
    func ReportDeconstructionRequiresTupleOrDataStruct(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.DeconstructionRequiresTupleOrDataStruct,
        type
    )

    /// Reports that a multi-target assignment or short variable declaration has
    /// a different number of targets and values.
    /// @param location The text location of the statement.
    /// @param targetCount The number of left-hand targets.
    /// @param valueCount The number of right-hand values.
    func ReportMultiAssignmentMismatch(location TextLocation, targetCount int32, valueCount int32) -> Report(
        location,
        DiagnosticDescriptors.MultiAssignmentMismatch,
        targetCount,
        valueCount
    )

    /// Reports an expression that cannot be used as a multi-assignment target.
    /// @param location The invalid target location.
    func ReportInvalidMultiAssignmentTarget(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.InvalidMultiAssignmentTarget
    )

    /// Reports a misplaced `fallthrough` statement (issue #3501 A3:
    /// `fallthrough` is legal only as the LAST statement of a switch
    /// case body).
    /// @param location The text location where `fallthrough` was found.
    func ReportFallthroughNotSupported(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.FallthroughNotSupported
    )

    /// Reports a `fallthrough` in the final arm of a switch (issue #3501 A3).
    /// @param location The text location of the `fallthrough` keyword.
    func ReportFallthroughInFinalArm(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.FallthroughInFinalArm
    )

    /// Reports a `fallthrough` whose target arm declares pattern bindings or a guard (issue #3501 A3).
    /// @param location The text location of the `fallthrough` keyword.
    func ReportFallthroughTargetHasBindings(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.FallthroughTargetHasBindings
    )

    /// Reports a redundant `!!` whose operand is already non-nullable (issue #3501 noise reduction).
    /// @param location The text location of the `!!` operator token.
    func ReportRedundantNullAssertion(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RedundantNullAssertion
    )

    /// Reports a duplicate `default` arm in a switch statement.
    /// @param location The text location of the offending default arm.
    func ReportDuplicateSwitchDefault(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.DuplicateSwitchDefault
    )

    /// Reports a non-constant value used in a switch case.
    /// @param location The text location of the offending case value.
    func ReportSwitchCaseValueNotConstant(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.SwitchCaseValueNotConstant
    )

    /// Reports a switch case value whose type doesn't match the discriminant.
    /// @param location The text location of the offending case value.
    /// @param caseType The case value type.
    /// @param switchType The switched-on discriminant type.
    func ReportSwitchCaseTypeMismatch(location TextLocation, caseType TypeSymbol, switchType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.SwitchCaseTypeMismatch,
        caseType,
        switchType
    )

    /// Reports that a property pattern was used on a non-aggregate type.
    /// @param location The text location.
    /// @param type The discriminant type.
    func ReportPropertyPatternRequiresStructOrClass(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.PropertyPatternRequiresStructOrClass,
        type
    )

    /// Reports that a property pattern references an unknown field.
    /// @param location The text location.
    /// @param fieldName The field name.
    /// @param type The containing type.
    func ReportUndefinedFieldOnType(location TextLocation, fieldName string, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.UndefinedFieldOnType,
        type,
        fieldName
    )

    /// Reports that a relational pattern operator is not defined for a type.
    /// @param location The text location.
    /// @param op The operator kind.
    /// @param type The operand type.
    func ReportRelationalPatternOperatorUndefined(location TextLocation, op SyntaxKind, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.RelationalPatternOperatorUndefined,
        SyntaxFacts.GetTextOrEmpty(op),
        type
    )

    /// Reports that a list pattern was used on a non-array/slice type.
    /// @param location The text location.
    /// @param type The discriminant type.
    func ReportListPatternRequiresArrayOrSlice(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.ListPatternRequiresArrayOrSlice,
        type
    )

    /// Reports a switch expression without a default arm.
    /// @param location The text location of the switch expression.
    func ReportSwitchExpressionMissingDefault(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.SwitchExpressionMissingDefault
    )

    /// Reports a non-exhaustive switch expression over a closed discriminant.
    /// @param location The text location of the switch expression.
    /// @param discriminantTypeName The discriminant type description.
    /// @param missingNames The missing variant names.
    func ReportSwitchExpressionNotExhaustive(
        location TextLocation,
        discriminantTypeName string,
        missingNames IEnumerable[string]
    ) -> Report(
        location,
        DiagnosticDescriptors.SwitchExpressionNotExhaustive,
        discriminantTypeName,
        FormatMissingNames(missingNames)
    )

    /// Reports a non-exhaustive switch statement over a closed discriminant.
    /// @param location The text location of the switch statement.
    /// @param discriminantTypeName The discriminant type description.
    /// @param missingNames The missing variant names.
    func ReportSwitchStatementNotExhaustive(
        location TextLocation,
        discriminantTypeName string,
        missingNames IEnumerable[string]
    ) -> Report(
        location,
        DiagnosticDescriptors.SwitchStatementNotExhaustive,
        discriminantTypeName,
        FormatMissingNames(missingNames)
    )

    /// Reports a switch-expression arm whose result type does not match the unified result type.
    /// @param location The text location of the offending arm.
    /// @param armType The arm result type.
    /// @param expectedType The expected result type.
    func ReportSwitchExpressionArmTypeMismatch(
        location TextLocation,
        armType TypeSymbol,
        expectedType TypeSymbol
    ) -> Report(location, DiagnosticDescriptors.SwitchExpressionArmTypeMismatch, expectedType, armType)

    /// GS9003: Variable must be definitely assigned before being passed by ref.
    /// @param location The text location of the argument.
    /// @param variableName The variable name.
    func ReportVariableNotDefinitelyAssignedForRef(location TextLocation, variableName string) -> Report(
        location,
        DiagnosticDescriptors.VariableNotDefinitelyAssignedForRef,
        variableName
    )

    /// GS0402: the operand of a prefix/postfix increment (`++`) or
    /// decrement (`--`) expression is not a writable lvalue (ADR-0126 /
    /// issue #1027). The operand must be a variable, field, array element, or
    /// indexer — the same set of targets accepted by a compound assignment.
    /// @param location The text location of the offending operand.
    /// @param operatorText The increment/decrement operator text (`++` or `--`).
    func ReportInvalidIncrementDecrementTarget(location TextLocation, operatorText string) -> Report(
        location,
        DiagnosticDescriptors.InvalidIncrementDecrementTarget,
        operatorText
    )

    /// ADR-0056 §2: reports an attempt to assign through a read-only span
    /// element. A `ReadOnlySpan[T]` indexer is `ref readonly T`, so
    /// `span[i] = v` is not permitted (only `Span[T]` writes are).
    /// @param location The text location of the offending assignment.
    /// @param type The read-only span type being written through.
    func ReportCannotAssignReadOnlySpanElement(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.CannotAssignReadOnlySpanElement,
        type
    )

    /// ADR-0060 §5: reports an assignment to an `in` parameter inside the function body.
    /// @param location The assignment location.
    /// @param parameterName The parameter name.
    func ReportCannotAssignToInParameter(location TextLocation, parameterName string) -> Report(
        location,
        DiagnosticDescriptors.CannotAssignToInParameter,
        parameterName
    )

    /// ADR-0060 §5: reports a return-path on which an `out` parameter has not been
    /// definitely assigned. The diagnostic locates the offending `return`.
    /// @param location The location of the return statement (or the end-of-body for fall-through).
    /// @param parameterName The out parameter name.
    func ReportOutParameterNotAssigned(location TextLocation, parameterName string) -> Report(
        location,
        DiagnosticDescriptors.OutParameterNotAssigned,
        parameterName
    )

    /// ADR-0060 §8: user-facing twin of GS9003. Reports that a variable was passed by `ref`
    /// before being definitely assigned.
    /// @param location The argument location.
    /// @param variableName The variable name.
    func ReportVariableNotAssignedBeforeRef(location TextLocation, variableName string) -> Report(
        location,
        DiagnosticDescriptors.VariableNotAssignedBeforeRef,
        variableName
    )

    /// Issue #3316 / ADR-0159: reports a use of a channel-typed local that some
    /// control-flow path can reach without a preceding assignment. A bare
    /// `chan T` slot has no usable zero value (the ADR-0159 carve-out),
    /// so — unlike zero-valued locals — declared-without-initializer channel
    /// locals are flow-checked by (cref:Binding.DefiniteAssignmentAnalyzer)
    /// with C#'s CS0165 semantics: declaring is free, using before definite
    /// assignment is the error.
    /// @param location The location of the offending use.
    /// @param name The local's name.
    /// @param channelTypeName The channel type name (e.g. `chan int32`), spliced into the suggested `make`
    /// remedy.
    func ReportChannelLocalUsedBeforeAssignment(location TextLocation, name string, channelTypeName string) -> Report(
        location,
        DiagnosticDescriptors.ChannelLocalUsedBeforeAssignment,
        name,
        channelTypeName
    )

    /// Issue #490 (ADR-0060 follow-up): a function declaration carries a `ref` return modifier
    /// without an explicit return type clause (e.g. `func foo() ref { ... }`).
    /// @param location The location of the `ref` modifier.
    func ReportRefReturnRequiresReturnType(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RefReturnRequiresReturnType
    )

    /// Issue #490 (ADR-0060 follow-up): a `ref` return modifier was placed on an
    /// `async` or sequence/async-sequence function; the state-machine rewriter cannot
    /// hoist a managed pointer into a state-machine field (ELEMENT_TYPE_BYREF is illegal
    /// in field signatures — ADR-0058 §2).
    /// @param location The location of the `ref` modifier.
    /// @param kind "async", "sequence", or "async sequence".
    func ReportRefReturnOnAsyncOrIterator(location TextLocation, kind string) -> Report(
        location,
        DiagnosticDescriptors.RefReturnOnAsyncOrIterator,
        kind
    )

    /// Issue #490: a `ref`-returning function declares its return type as `*T`
    /// (a managed pointer). The two are redundant — write `ref T` instead of `ref *T`.
    /// @param location The location of the `ref` modifier.
    func ReportRefReturnOfByRefType(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RefReturnOfByRefType
    )

    /// Issue #490: a `return ref expr` statement appears inside a function whose
    /// declaration does not carry the `ref` return modifier.
    /// @param location The location of the `ref` keyword on the return statement.
    /// @param functionName The enclosing function name.
    func ReportRefReturnInNonRefReturningFunction(location TextLocation, functionName string) -> Report(
        location,
        DiagnosticDescriptors.RefReturnInNonRefReturningFunction,
        functionName
    )

    /// Issue #490: a plain `return expr` statement appears inside a `ref`-returning function.
    /// The body must use `return ref <lvalue>`.
    /// @param location The location of the `return` keyword.
    /// @param functionName The enclosing function name.
    func ReportRefReturnRequiredOnRefReturningFunction(location TextLocation, functionName string) -> Report(
        location,
        DiagnosticDescriptors.RefReturnRequiredOnRefReturningFunction,
        functionName
    )

    /// Issue #490: the operand of `return ref` is not an lvalue (literal, arithmetic
    /// expression, call result, etc.). Only variables, fields, array elements, dereferences,
    /// and conditional expressions whose branches are themselves lvalues can be returned by ref.
    /// @param location The location of the offending expression.
    func ReportRefReturnRequiresLvalue(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RefReturnRequiresLvalue
    )

    /// Issue #490 (ADR-0058 ref-safe-to-escape): the operand of `return ref` refers to
    /// storage that dies at function exit (a local variable, a `scoped` parameter, or a
    /// field/element rooted in one of those). Returning that pointer would expose dangling
    /// memory to the caller.
    /// @param location The location of the offending expression.
    func ReportRefReturnEscapesLocalScope(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RefReturnEscapesLocalScope
    )

    /// ADR-0184 / issue #376 (the CS8170 analogue): the operand of
    /// `return ref` is rooted at the enclosing struct member's own
    /// receiver, whose ref-safe-context is the method body unless the member
    /// is marked `@UnscopedRef`. Reported in place of the generic
    /// (cref:DiagnosticDescriptors.RefReturnEscapesLocalScope) so the
    /// remedy is named rather than left as "function-local storage".
    /// @param location The location of the offending expression.
    func ReportUnscopedRefRequiredForInstanceState(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.UnscopedRefRequiredForInstanceState
    )

    /// ADR-0184 amendment, caller side (the CS8156 analogue): the operand of
    /// `return ref` forwards a reference out of a member invoked on a
    /// READ-ONLY receiver — an `in` parameter, a `ref readonly`
    /// alias, or a `ref readonly` call/property result. The emitter
    /// defensively copies such a receiver into a function-local temp before
    /// the call, so the returned reference aliases the temp and dangles once
    /// the function returns. Reported in place of the generic
    /// (cref:DiagnosticDescriptors.RefReturnEscapesLocalScope) because
    /// the copy has no spelling in the source the author wrote.
    /// @param location The location of the offending expression.
    func ReportRefReturnThroughDefensivelyCopiedReceiver(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RefReturnThroughDefensivelyCopiedReceiver
    )

    /// Issue #491 (ADR-0060 follow-up): reports a ref-aliasing local declaration whose
    /// initializer is not an lvalue. `let ref` / `var ref` binds the local as
    /// an alias for an existing storage slot — the RHS must therefore be a variable, a
    /// field/property access, an indexer access, or a dereference of a managed pointer.
    /// @param location The `ref` modifier location.
    /// @param exprText The source text of the offending RHS expression.
    func ReportRefLocalRhsMustBeLvalue(location TextLocation, exprText string) -> Report(
        location,
        DiagnosticDescriptors.RefLocalRhsMustBeLvalue,
        exprText
    )

    /// Issue #491 (ADR-0060 follow-up): reports a ref-aliasing local whose initializer's
    /// ref-safe-to-escape scope is narrower than the local's declaring scope. The aliased
    /// storage would not outlive the local; reading or writing through the alias is therefore
    /// unsafe. Reported, for example, when binding a ref local to a value whose pointee lives
    /// in a `scoped` ref struct or to a temporary that the local would outlive.
    /// @param location The `ref` modifier location.
    /// @param variableName The local name.
    func ReportRefLocalRhsHasNarrowerEscapeScope(location TextLocation, variableName string) -> Report(
        location,
        DiagnosticDescriptors.RefLocalRhsHasNarrowerEscapeScope,
        variableName
    )

    /// Issue #491 (ADR-0060 follow-up): reports the `ref` aliasing modifier on a
    /// declaration that cannot legally store a managed pointer — a top-level binding
    /// (emitted as a static field), a local in an `async` function or iterator
    /// (hoisted into a state-machine field), or a `const` declaration.
    /// @param location The `ref` modifier location.
    /// @param variableName The local name.
    /// @param context Description of the disallowed context (e.g. "a top-level variable").
    func ReportRefLocalCannotBeDeclaredHere(location TextLocation, variableName string, context string) -> Report(
        location,
        DiagnosticDescriptors.RefLocalCannotBeDeclaredHere,
        variableName,
        context
    )

    /// Reports that a `for x in expr` loop cannot be lowered because the
    /// collection type does not expose a usable `GetEnumerator()` method.
    /// @param location The collection expression location.
    /// @param type The collection type.
    func ReportTypeNotIterable(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.TypeNotIterable,
        type
    )

    /// Reports that `await using let` appears outside an `async` function.
    /// @param location The text location of the `await` keyword.
    func ReportAwaitUsingOutsideAsyncFunction(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.AwaitUsingOutsideAsyncFunction
    )

    /// Reports that a type used in an `await using` declaration does not implement IAsyncDisposable.
    /// @param location The text location of the await using keyword.
    /// @param type The non-async-disposable type.
    func ReportTypeNotAsyncDisposable(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.TypeNotAsyncDisposable,
        type
    )

    /// ADR-0070 / issue #707: GS0293 — a labeled `break` or `continue`
    /// names a loop that is not in scope.
    /// @param location The source location of the offending label identifier.
    /// @param keyword The originating keyword (`break` or `continue`).
    /// @param labelName The unresolved label name.
    func ReportUnknownLoopLabel(location TextLocation, keyword string, labelName string) -> Report(
        location,
        DiagnosticDescriptors.UnknownLoopLabel,
        labelName,
        keyword,
        labelName
    )

    /// ADR-0070 / issue #1884: GS0469 — a `goto` targets a label name
    /// that is never defined anywhere in the enclosing function.
    /// @param location The source location of the offending label identifier.
    /// @param labelName The unresolved label name.
    func ReportUndefinedGotoLabel(location TextLocation, labelName string) -> Report(
        location,
        DiagnosticDescriptors.UndefinedGotoLabel,
        labelName
    )

    /// ADR-0070 / issue #1884: GS0470 — two `goto` labels with the same
    /// name are declared in the same enclosing function. The label namespace
    /// is local to the enclosing function (ADR-0070), so this is an error
    /// even when the two labels are in disjoint nested blocks.
    /// @param location The source location of the second (duplicate) label declaration.
    /// @param labelName The duplicated label name.
    func ReportDuplicateGotoLabel(location TextLocation, labelName string) -> Report(
        location,
        DiagnosticDescriptors.DuplicateGotoLabel,
        labelName
    )

    /// Reports a function-wide goto that enters a catch or finally handler.
    /// @param location The source location of the goto label identifier.
    /// @param labelName The target label name.
    func ReportGotoIntoExceptionHandler(location TextLocation, labelName string) -> Report(
        location,
        DiagnosticDescriptors.GotoIntoExceptionHandler,
        labelName
    )

    /// ADR-0070 / issue #707: GS0295 (warning) — a loop label shadows an
    /// enclosing live loop label of the same name. The inner label wins for
    /// nested `break` / `continue` resolution.
    /// @param location The source location of the offending label identifier.
    /// @param labelName The shadowed label name.
    func ReportLabelShadowsEnclosingLoop(location TextLocation, labelName string) -> Report(
        location,
        DiagnosticDescriptors.LabelShadowsEnclosingLoop,
        labelName
    )

    /// ADR-0071 / ADR-0163: GS0296 — the right-hand side of an
    /// `if let`, `guard let`, or `while let` binding is not
    /// of nullable type.
    /// The binding form is intended to strip a single layer of nullability;
    /// applying it to a non-nullable value would do nothing useful and is
    /// almost certainly a programmer error.
    /// @param location The source location of the offending initializer.
    /// @param bindingName The name introduced by the binding.
    /// @param actualType The actual (non-nullable) initializer type.
    func ReportIfLetInitializerMustBeNullable(
        location TextLocation,
        bindingName string,
        actualType TypeSymbol
    ) -> Report(location, DiagnosticDescriptors.IfLetInitializerMustBeNullable, bindingName, actualType, bindingName)

    /// ADR-0071 / issue #708: GS0297 — the else block of a `guard let`
    /// statement must unconditionally exit the enclosing scope. Accepted
    /// terminators are `return`, `throw`, `break`,
    /// `continue`, and any block whose last statement does so. An
    /// `if`/`else` qualifies only when both arms exit.
    /// @param location The source location of the offending else clause.
    func ReportGuardLetElseMustExit(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.GuardLetElseMustExit
    )

    /// ADR-0078 / issue #718: GS0313 — a switch over a sealed-class hierarchy
    /// is missing a case for a known subtype.
    /// @param location The source location of the switch keyword.
    /// @param missingCaseName The name of the missing case / subtype.
    /// @param baseTypeName The sealed-base type name.
    func ReportSealedHierarchyMissingCase(location TextLocation, missingCaseName string, baseTypeName string) -> Report(
        location,
        DiagnosticDescriptors.SealedHierarchyMissingCase,
        baseTypeName,
        missingCaseName
    )

    /// Issue #1505: GS0416 — a list pattern contains more than one slice
    /// ("rest") subpattern (`..`). A list pattern admits at most one slice
    /// element; the elements before it form the fixed prefix and the elements
    /// after it form the fixed suffix. Mirrors C#'s CS8980.
    /// @param location The source location of the offending `..` token.
    func ReportMultipleSlicePatternsInListPattern(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.MultipleSlicePatternsInListPattern
    )

    /// Issue #1603: GS0418 — a `using` or `await using` statement's
    /// declaration was a tuple or named deconstruction (`let (a, b) = …`
    /// or `let { … } = …`) rather than a single variable declaration.
    /// `using` disposes exactly one bound value, so deconstruction is not
    /// supported there; report a diagnostic instead of crashing the parser.
    /// @param location The text location of the offending declaration.
    func ReportUsingRequiresSingleVariableDeclaration(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.UsingRequiresSingleVariableDeclaration
    )

    /// Reports GS0367 — issue #836: a `yield` statement appears
    /// lexically inside a `try` block that also has one or more
    /// `catch` clauses. The C# spec (§15.14) and ECMA-335 forbid
    /// this combination because the iterator state machine cannot
    /// safely resume into a protected region from a synthesized
    /// dispatch. Wrap the `yield` in a separate `try`/
    /// `finally` instead, or move the exception-handling block to
    /// the consumer (`for v in iter()`) side.
    /// @param location The source location of the offending
    /// `yield` keyword.
    func ReportYieldInsideTryWithCatch(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.YieldInsideTryWithCatch
    )

    /// Issue #992: GS0390 — a type pattern that introduces a binding variable
    /// appears under an `or` or `not` pattern combinator, where the
    /// variable would not be definitely assigned when the arm runs. Mirrors
    /// C#'s CS8780. Use the discard identifier `_` instead, or restructure
    /// the pattern.
    /// @param location The source location of the binding identifier.
    /// @param variableName The name of the would-be binding variable.
    func ReportPatternVariableNotAllowedUnderOrNot(location TextLocation, variableName string) -> Report(
        location,
        DiagnosticDescriptors.PatternVariableNotAllowedUnderOrNot,
        variableName
    )

    /// Issue #3351 / ADR-0166: reports the switch binding spelling
    /// (`name is Type`) inside a boolean `is`-expression pattern.
    /// @param location The source location of the binding identifier.
    /// @param variableName The rejected binding name.
    func ReportPatternBindingNotAllowedInIsExpression(location TextLocation, variableName string) -> Report(
        location,
        DiagnosticDescriptors.PatternBindingNotAllowedInIsExpression,
        variableName
    )

    /// ADR-0166 / issue #3409: reports a read of a pattern variable outside
    /// the region its match dominates.
    /// @param location The source location of the read.
    /// @param variableName The pattern variable name.
    func ReportPatternVariableNotDefinitelyAssigned(location TextLocation, variableName string) -> Report(
        location,
        DiagnosticDescriptors.PatternVariableNotDefinitelyAssigned,
        variableName
    )

    shared {
        private func FormatMissingNames(missingNames IEnumerable[string]) string {
            let displayed = List[string]()
            var count = 0
            for name in missingNames {
                if count < 3 {
                    displayed.Add("'$name'")
                }
                count++
            }
            if count > 3 {
                displayed.Add("…")
            }
            return string.Join(", ", displayed)
        }
    }
}
