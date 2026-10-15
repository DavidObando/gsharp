// <copyright file="DiagnosticBag.Reports.Expressions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

partial class DiagnosticBag : IEnumerable[Diagnostic] {
    /// Reports that an enum member access references an unknown member.
    /// @param location The text location of the unknown member.
    /// @param memberName The unknown member name.
    /// @param enumName The enum name.
    func ReportUndefinedEnumMember(location TextLocation, memberName string, enumName string) -> Report(
        location,
        DiagnosticDescriptors.UndefinedEnumMember,
        enumName,
        memberName
    )

    /// Reports that a type doesn't exist.
    /// @param location The text location where the error was found.
    /// @param name The type name.
    func ReportUndefinedType(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.UndefinedType,
        name
    )

    /// Issue #2455: reports that a bare simple type name collides between two
    /// or more different top-level packages that are EACH visible via an
    /// explicit `import` somewhere in the compilation, so its identity
    /// cannot be determined from the reference alone. Distinct from
    /// (cref:ReportUndefinedType) (which means no type at all matched)
    /// the same way (cref:ReportAmbiguousImportedTypeReference) is distinct for
    /// imported CLR types.
    /// @param location The text location where the error was found.
    /// @param name The type name.
    func ReportAmbiguousSourceType(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.AmbiguousSourceType,
        name
    )

    /// Issue #3734: reports a bare type name that two or more explicitly
    /// written imports each resolve to a different CLR type. The reference
    /// still binds the first import's candidate, so this is a report about a
    /// choice the author did not make rather than a resolution failure.
    /// @param location The text location of the ambiguous name.
    /// @param name The bare name as written.
    /// @param ambiguity The colliding candidates.
    func ReportAmbiguousImportedTypeReference(location TextLocation, name string, ambiguity ImportedTypeAmbiguity) {
        var location = location
        // The same name is looked up repeatedly while binding one reference
        // (overload resolution, lambda re-binding); the reader should see the
        // collision once per site.
        if !reportedImportedTypeAmbiguities.Add(location.FileName + "|" + location.Span.Start.ToString() + "|" + name) {
            return
        }
        Report(
            location,
            DiagnosticDescriptors.AmbiguousImportedTypeReference,
            name,
            ambiguity.First.FullName ?? ambiguity.First.Name,
            ambiguity.Second.FullName ?? ambiguity.Second.Name,
            ambiguity.Chosen.FullName ?? ambiguity.Chosen.Name
        )
    }

    /// Issue #526: reports that the outer type exists but does not contain a nested
    /// type of the requested name.
    /// @param location The text location of the nested-type segment.
    /// @param outerTypeName The outer (containing) type's source-visible name.
    /// @param nestedName The nested-type segment that could not be resolved.
    func ReportUndefinedNestedType(location TextLocation, outerTypeName string, nestedName string) -> Report(
        location,
        DiagnosticDescriptors.UndefinedNestedType,
        outerTypeName,
        nestedName
    )

    /// Reports that the array length is not a valid non-negative integer literal.
    /// @param location The text location.
    /// @param text The length token text.
    func ReportInvalidArrayLength(location TextLocation, text string) -> Report(
        location,
        DiagnosticDescriptors.InvalidArrayLength,
        text
    )

    /// Reports that the number of array initialisers does not match the declared length.
    /// @param location The text location.
    /// @param expected The declared length.
    /// @param actual The provided initialiser count.
    func ReportArrayLiteralLengthMismatch(location TextLocation, expected int32, actual int32) -> Report(
        location,
        DiagnosticDescriptors.ArrayLiteralLengthMismatch,
        expected,
        actual
    )

    /// Reports that indexing was attempted on a non-array expression.
    /// @param location The text location.
    /// @param type The actual type.
    func ReportTypeNotIndexable(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.TypeNotIndexable,
        type
    )

    /// Reports rectangular-array index arity mismatch.
    /// @param location Diagnostic location.
    /// @param rank Declared array rank.
    /// @param indexCount Supplied index count.
    func ReportRectangularArrayIndexRankMismatch(location TextLocation, rank int32, indexCount int32) -> Report(
        location,
        DiagnosticDescriptors.RectangularArrayIndexRankMismatch,
        rank,
        indexCount
    )

    /// Reports a rectangular-array rank beyond the CLR limit.
    /// @param location Diagnostic location.
    /// @param rank Requested array rank.
    func ReportRectangularArrayRankTooLarge(location TextLocation, rank int32) -> Report(
        location,
        DiagnosticDescriptors.RectangularArrayRankTooLarge,
        rank
    )

    /// Reports non-constant rectangular-array initializer dimensions.
    /// @param location Diagnostic location.
    func ReportRectangularArrayInitializerRequiresConstantDimensions(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RectangularArrayInitializerRequiresConstantDimensions
    )

    /// Reports rectangular-array initializer element-count mismatch.
    /// @param location Diagnostic location.
    /// @param expected Required element count.
    /// @param actual Supplied element count.
    func ReportRectangularArrayInitializerLengthMismatch(location TextLocation, expected int64, actual int32) -> Report(
        location,
        DiagnosticDescriptors.RectangularArrayInitializerLengthMismatch,
        expected,
        actual
    )

    /// Reports that a built-in intrinsic was applied to an unsupported argument type.
    /// @param location The text location of the offending argument.
    /// @param name The intrinsic name.
    /// @param type The actual argument type.
    func ReportIntrinsicArgumentType(location TextLocation, name string, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.IntrinsicArgumentType,
        name,
        type
    )

    /// Reports that an expression must have a value.
    /// @param location The text location where the error was found.
    func ReportExpressionMustHaveValue(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.ExpressionMustHaveValue
    )

    /// Reports that a variable doesn't exist.
    /// @param location The text location where the error was found.
    /// @param name The name of the variable.
    func ReportUndefinedVariable(location TextLocation, name string) {
        // Issue #660 / #721: when the user writes 'null' (C# spelling) and no
        // symbol named `null` exists in scope, surface the GS0273 "did you
        // mean 'nil'?" diagnostic instead of the generic GS0125. The binder
        // also synthesises a `nil` literal so that target-type contexts (such
        // as `let x string? = null` or `Foo(null)` with a nullable parameter)
        // continue to typecheck without cascading errors.
        if name == "null" {
            ReportUseNilInsteadOfNull(location)
            return
        }
        Report(location, DiagnosticDescriptors.UndefinedVariable, name)
    }

    /// Reports that a name doesn't belong to a variable.
    /// @param location The text location where the error was found.
    /// @param name The name of the variable.
    func ReportNotAVariable(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.NotAVariable,
        name
    )

    /// Reports that the specified unary operator is not defined for the specified type.
    /// @param location The text location where the error was found.
    /// @param operatorText The operator text.
    /// @param operandType The operand type.
    func ReportUndefinedUnaryOperator(location TextLocation, operatorText string, operandType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.UndefinedUnaryOperator,
        operatorText,
        operandType
    )

    /// Reports that the specified unary operator is not defined for the specified types.
    /// @param location The text location where the error was found.
    /// @param operatorText The operator text.
    /// @param leftType The left operand type.
    /// @param rightType The right operand type.
    func ReportUndefinedBinaryOperator(
        location TextLocation,
        operatorText string,
        leftType TypeSymbol,
        rightType TypeSymbol
    ) -> Report(location, DiagnosticDescriptors.UndefinedBinaryOperator, operatorText, leftType, rightType)

    /// Issue #3501: reports that tuple equality (`==` / `!=`) was
    /// applied to tuple operands of different arities.
    /// @param location The text location of the operator token.
    /// @param leftType The left tuple operand type.
    /// @param leftArity The left tuple's arity.
    /// @param rightType The right tuple operand type.
    /// @param rightArity The right tuple's arity.
    func ReportTupleEqualityArityMismatch(
        location TextLocation,
        leftType TypeSymbol,
        leftArity int32,
        rightType TypeSymbol,
        rightArity int32
    ) -> Report(location, DiagnosticDescriptors.TupleEqualityArityMismatch, leftType, leftArity, rightType, rightArity)

    /// ADR-0172: reports a tuple element name declared more than once on the
    /// same tuple type or literal.
    /// @param location The text location of the duplicate name.
    /// @param name The duplicated element name.
    func ReportDuplicateTupleElementName(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.DuplicateTupleElementName,
        name
    )

    /// ADR-0172: reports (as a warning) an element name that disagrees with
    /// the name the target tuple type declares at the same position.
    /// @param location The text location of the conversion or label.
    /// @param name The source element name being ignored.
    /// @param targetName The target type's name at that position.
    func ReportTupleElementNameMismatch(location TextLocation, name string, targetName string) -> Report(
        location,
        DiagnosticDescriptors.TupleElementNameMismatch,
        name,
        targetName
    )

    /// ADR-0172: reports a reserved tuple element name — `ItemN` at any
    /// position other than N, or `Rest`.
    /// @param location The text location of the name.
    /// @param name The reserved name.
    /// @param detail A clarifying suffix (e.g. " at this position; 'Item2' is only valid as the second
    /// element's name"), or an empty string.
    func ReportReservedTupleElementName(location TextLocation, name string, detail string) -> Report(
        location,
        DiagnosticDescriptors.ReservedTupleElementName,
        name,
        detail
    )

    /// ADR-0172: reports an element name attached to a parenthesized single
    /// element — grouping, not a tuple.
    /// @param location The text location of the stray name.
    func ReportTupleElementNameOutsideTuple(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.TupleElementNameOutsideTuple
    )

    /// ADR-0173: reports a variadic collection carrier (List/span) whose
    /// element type has no closed CLR construction shape at the call site
    /// (same-compilation erased element).
    /// @param location The call location.
    /// @param carrierType The declared carrier type.
    /// @param elementType The variadic element type.
    func ReportVariadicCarrierElementNotConstructible(
        location TextLocation,
        carrierType TypeSymbol,
        elementType TypeSymbol
    ) -> Report(location, DiagnosticDescriptors.VariadicCarrierElementNotConstructible, carrierType, elementType)

    /// Issue #4932: reports a nil comparison of a local whose declared type is a
    /// non-nullable reference type; the comparison is statically constant.
    /// @param location The text location of the comparison.
    /// @param localName The local's name.
    /// @param localType The local's declared type.
    /// @param constantResult The constant outcome text: `"false"` for `==`, `"true"` for `!=`.
    func ReportNilComparisonOfNonNullableLocal(
        location TextLocation,
        localName string,
        localType TypeSymbol,
        constantResult string
    ) -> Report(location, DiagnosticDescriptors.NilComparisonOfNonNullableLocal, localName, localType, constantResult)

    /// Issue #3317 / ADR-0159: reports that a nil comparison against a bare
    /// (non-`?`) magic collection type is statically constant — with
    /// sound empty-instance zero values such a value can never be nil, so
    /// `==` is always false and `!=` is always true.
    /// @param location The text location of the comparison.
    /// @param operandType The bare collection-typed operand's static type.
    /// @param constantResult The constant outcome text: `"false"` for `==`, `"true"` for `!=`.
    func ReportNilComparisonAlwaysConstant(
        location TextLocation,
        operandType TypeSymbol,
        constantResult string
    ) -> Report(location, DiagnosticDescriptors.NilComparisonAlwaysConstant, operandType, constantResult)

    /// Reports that the function doesn't exist.
    /// @param location The text location where the error was found.
    /// @param name The function name.
    func ReportUndefinedFunction(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.UndefinedFunction,
        name
    )

    /// Reports that the name doesn't belong to a function.
    /// @param location The text location where the error was found.
    /// @param name The function name.
    func ReportNotAFunction(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.NotAFunction,
        name
    )

    /// Reports that the operand of an `await` expression is not a Task (Phase 5.1 / ADR-0023).
    /// @param location The text location of the operand.
    /// @param actualType The actual type of the operand.
    func ReportTypeIsNotAwaitable(location TextLocation, actualType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.TypeIsNotAwaitable,
        actualType
    )

    /// Reports that the function requires a different amount of arguments.
    /// @param location The text location where the error was found.
    /// @param name The function name.
    /// @param expectedCount The expected argument count.
    /// @param actualCount The actual argument count.
    func ReportWrongArgumentCount(location TextLocation, name string, expectedCount int32, actualCount int32) -> Report(
        location,
        DiagnosticDescriptors.WrongArgumentCount,
        name,
        expectedCount,
        actualCount
    )

    /// Reports a call to a variadic function with too few fixed arguments (Phase 4.8).
    /// @param location The text location of the call.
    /// @param name The callee name.
    /// @param minimumCount The minimum required argument count (fixed parameters).
    /// @param actualCount The actual argument count provided.
    func ReportTooFewArgumentsForVariadic(
        location TextLocation,
        name string,
        minimumCount int32,
        actualCount int32
    ) -> Report(location, DiagnosticDescriptors.TooFewArgumentsForVariadic, name, minimumCount, actualCount)

    /// Reports a generic call whose explicit type-argument list has the wrong arity (Phase 4.1 / ADR-0020).
    /// @param location The text location of the type-argument list.
    /// @param name The callee name.
    /// @param expectedCount The expected number of type arguments.
    /// @param actualCount The actual number of type arguments.
    func ReportWrongTypeArgumentCount(
        location TextLocation,
        name string,
        expectedCount int32,
        actualCount int32
    ) -> Report(location, DiagnosticDescriptors.WrongTypeArgumentCount, name, expectedCount, actualCount)

    /// Reports a type-clause type-argument list applied to a non-generic type (Phase 4.3c / ADR-0020).
    /// @param location The text location of the offending identifier.
    /// @param name The type name.
    func ReportTypeNotGeneric(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.TypeNotGeneric,
        name
    )

    /// Reports a pointer or function-pointer type used as a CLR generic type argument.
    /// @param location The location of the pointer type clause.
    func ReportPointerGenericTypeArgument(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.PointerGenericTypeArgument
    )

    /// Reports a generic call whose type arguments could not be inferred from the value arguments (Phase
    /// 4.1 / ADR-0020).
    /// @param location The text location of the call.
    /// @param name The callee name.
    /// @param typeParameterName The unresolved type-parameter name.
    func ReportTypeArgumentInferenceFailed(location TextLocation, name string, typeParameterName string) -> Report(
        location,
        DiagnosticDescriptors.TypeArgumentInferenceFailed,
        typeParameterName,
        name,
        typeParameterName
    )

    /// Reports a generic call whose type argument does not satisfy the declared constraint (Phase 4.2 /
    /// ADR-0020).
    /// @param location The text location of the offending type argument or call.
    /// @param typeParameterName The type-parameter name (e.g. `T`).
    /// @param typeArgument The supplied type argument.
    /// @param constraintDescription A human-readable description of the constraint (e.g. `comparable`).
    func ReportTypeArgumentDoesNotSatisfyConstraint(
        location TextLocation,
        typeParameterName string,
        typeArgument TypeSymbol,
        constraintDescription string
    ) -> Report(
        location,
        DiagnosticDescriptors.TypeArgumentDoesNotSatisfyConstraint,
        typeArgument,
        typeParameterName,
        constraintDescription
    )

    /// Issue #4037: reports an OPEN instantiation of a constrained generic
    /// whose type argument is the enclosing declaration's own type parameter,
    /// and that parameter does not forward the constraint the definition
    /// requires (`class Unforwarded[T] : Handler[T]`).
    /// @param location The text location of the offending instantiation.
    /// @param argumentTypeParameterName The supplied type parameter (e.g. `T`).
    /// @param declaredTypeParameterName The definition's type-parameter name (e.g. `TOptions`).
    /// @param constraintDescription A human-readable description of the constraint that is not forwarded.
    func ReportTypeParameterDoesNotForwardConstraint(
        location TextLocation,
        argumentTypeParameterName string,
        declaredTypeParameterName string,
        constraintDescription string
    ) -> Report(
        location,
        DiagnosticDescriptors.TypeParameterDoesNotForwardConstraint,
        argumentTypeParameterName,
        declaredTypeParameterName,
        constraintDescription
    )

    /// Reports that the parameter requires a value of a different type.
    /// @param location The text location where the error was found.
    /// @param name The parameter name.
    /// @param expectedType The expected type.
    /// @param actualType The actual type.
    func ReportWrongArgumentType(
        location TextLocation,
        name string,
        expectedType TypeSymbol,
        actualType TypeSymbol
    ) -> Report(location, DiagnosticDescriptors.WrongArgumentType, name, expectedType, actualType)

    /// Issue #4422: GS0154 for a by-reference argument whose storage is a
    /// value-type `V?` at a `V` parameter (or the reverse). The text
    /// says why: `V?` is `Nullable<V>`, a different runtime
    /// type, not an annotation.
    /// @param location The argument's location.
    /// @param name The parameter name.
    /// @param parameterType The parameter's pointee type.
    /// @param storageType The argument's storage type.
    func ReportWrongValueNullableByRefArgument(
        location TextLocation,
        name string,
        parameterType TypeSymbol,
        storageType TypeSymbol
    ) {
        let nullableSide = if storageType is NullableTypeSymbol storageNullable {
            storageNullable
        } else {
            parameterType as NullableTypeSymbol
        }
        let underlying = nullableSide?.UnderlyingType ?? storageType
        let reason = "$storageType' — '$underlying?' is a Nullable<$underlying>, a different runtime type from '$underlying"
        ReportWrongArgumentType(location, name, parameterType, reason)
    }

    /// GS0154 with the given text in place of the argument type.
    /// @param location The text location where the error was found.
    /// @param name The parameter name.
    /// @param expectedType The expected type.
    /// @param actualDescription The argument type, with any explanation.
    func ReportWrongArgumentType(
        location TextLocation,
        name string,
        expectedType TypeSymbol,
        actualDescription string
    ) -> Report(location, DiagnosticDescriptors.WrongArgumentType, name, expectedType, actualDescription)

    /// Issue #4422: GS0612 — a by-reference argument's storage type differs
    /// from the parameter type only in reference nullability.
    /// @param location The argument's location.
    /// @param refKind The parameter's ref kind, spelled as in source (`ref`, `out`, `in`).
    /// @param name The parameter name.
    /// @param parameterType The parameter type.
    /// @param storageType The argument's storage type.
    /// @param reason Which way a nil can flow through the shared storage.
    func ReportByRefArgumentNullabilityMismatch(
        location TextLocation,
        refKind string,
        name string,
        parameterType TypeSymbol,
        storageType TypeSymbol,
        reason string
    ) -> Report(
        location,
        DiagnosticDescriptors.ByRefArgumentNullabilityMismatch,
        refKind,
        name,
        storageType,
        parameterType,
        reason
    )

    /// Rerpots that there's no conversion from one type to the other.
    /// @param location The text location where the error was found.
    /// @param fromType From type.
    /// @param toType To type.
    func ReportCannotConvert(location TextLocation, fromType TypeSymbol, toType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.CannotConvert,
        fromType,
        toType
    )

    /// Reports why a requested structural projection is unsafe or incomplete.
    /// @param location The projection source location.
    /// @param fromType The source type.
    /// @param toType The target type.
    /// @param reason The compile-time planning failure.
    func ReportStructuralProjectionFailure(
        location TextLocation,
        fromType TypeSymbol,
        toType TypeSymbol,
        reason string
    ) -> Report(location, DiagnosticDescriptors.StructuralProjectionFailure, fromType, toType, reason)

    /// Reports that there's no implicit conversion from one type to the other.
    /// @param location The text location where the error was found.
    /// @param fromType From type.
    /// @param toType To type.
    func ReportCannotConvertImplicitly(location TextLocation, fromType TypeSymbol, toType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.CannotConvertImplicitly,
        fromType,
        toType
    )

    /// Issue #337: reports that a CLR member method group cannot be converted to
    /// the expected target type (it is not a compatible delegate type, or no
    /// overload matches the delegate signature).
    /// @param location The text location where the error was found.
    /// @param methodName The method-group name.
    /// @param toType The expected target type.
    func ReportCannotConvertMethodGroup(location TextLocation, methodName string, toType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.CannotConvertMethodGroup,
        methodName,
        toType
    )

    /// Reports that a method group escaped a call or delegate-conversion
    /// context and was used as an ordinary value.
    /// @param location The method-group name location.
    /// @param methodGroupKind The source and dispatch kind of method group.
    /// @param methodName The method-group name.
    func ReportMethodGroupRequiresTarget(location TextLocation, methodGroupKind string, methodName string) -> Report(
        location,
        DiagnosticDescriptors.MethodGroupRequiresTarget,
        methodGroupKind,
        methodName
    )

    /// Issue #367: reports that a by-ref-like (`ref struct`) value is used in
    /// a position that would let it escape the stack. By-ref-like types such as
    /// `Span[T]`, `ReadOnlySpan[T]`, and
    /// `DefaultInterpolatedStringHandler` may be declared as locals and
    /// passed around, but the CLR forbids boxing them, storing them in fields of a
    /// non-ref-struct, capturing them in closures, hoisting them into
    /// async/iterator state machines, and using them as generic type arguments.
    /// @param location The text location of the illegal use.
    /// @param type The by-ref-like type.
    /// @param reason A description of why the value would escape.
    func ReportByRefLikeEscape(location TextLocation, type TypeSymbol, reason string) -> Report(
        location,
        DiagnosticDescriptors.ByRefLikeEscape,
        type,
        reason
    )

    /// Reports that we couldn't find the specified type.
    /// @param location The text location where the error was found.
    /// @param text The text associated to the type.
    func ReportUnableToFindType(location TextLocation, text string) -> Report(
        location,
        DiagnosticDescriptors.UnableToFindType,
        text
    )

    /// Reports that a qualified namespace/package path resolved, but its next
    /// segment did not name a type.
    /// @param location The missing type segment's location.
    /// @param typeName The missing simple type name.
    /// @param prefix The longest resolvable namespace/package prefix.
    /// @param isPackage Whether [`prefix`](paramref) is a source package.
    func ReportUnableToFindQualifiedType(
        location TextLocation,
        typeName string,
        prefix string,
        isPackage bool
    ) -> ReportUnableToFindType(
        location,
        "'$typeName' in ${(if isPackage { "package" } else { "namespace" })} '$prefix'"
    )

    /// Reports that we couldn't find the specified member.
    /// @param location The text location where the error was found.
    /// @param text The text associated to the member.
    func ReportUnableToFindMember(location TextLocation, text string) -> Report(
        location,
        DiagnosticDescriptors.UnableToFindMember,
        text
    )

    /// GS0503: Reports a direct call through a nullable delegate receiver without a valid narrowing.
    /// @param location The nullable receiver location.
    /// @param receiverName The receiver spelling.
    /// @param nullSafeInvocation The null-safe call syntax valid for this receiver shape.
    func ReportNullableDelegateReceiverInvocation(
        location TextLocation,
        receiverName string,
        nullSafeInvocation string?
    ) {
        // A null token means the caller had no receiver syntax to derive one
        // from. Interpolating it would render "Use '' for null-safe
        // invocation"; drop the clause instead so the advice stays readable.
        let advice = if nullSafeInvocation == nil {
            "Bind it with 'if let', or assert non-null with '!!' before calling."
        } else {
            "Use '$nullSafeInvocation' for null-safe invocation, bind it with 'if let', or assert non-null with '!!' before calling."
        }
        Report(location, DiagnosticDescriptors.NullableDelegateReceiverInvocation, receiverName, advice)
    }

    /// Reports that we couldn't find the specified function.
    /// @param location The text location where the error was found.
    /// @param text The text associated to the function.
    func ReportUnableToFindFunction(location TextLocation, text string) -> Report(
        location,
        DiagnosticDescriptors.UnableToFindFunction,
        "Cannot find function $text."
    )

    /// Issue #4013: reports a call to a member the receiver's type implements
    /// only as an explicit interface implementation, so it is not part of that
    /// type's own surface and is reachable only through an interface-typed
    /// receiver.
    /// @param location The text location where the error was found.
    /// @param typeName The receiver type as spelled in G#.
    /// @param memberName The member name the call site used.
    /// @param interfaceName The interface declaring the member.
    func ReportExplicitInterfaceMemberNotOnTypeSurface(
        location TextLocation,
        typeName string,
        memberName string,
        interfaceName string
    ) -> Report(
        location,
        DiagnosticDescriptors.ExplicitInterfaceMemberNotOnTypeSurface,
        typeName,
        memberName,
        interfaceName
    )

    /// Reports a function call whose receiver lacks a valid non-null narrowing.
    /// @param location The text location where the error was found.
    /// @param functionName The called function.
    /// @param receiverName The nullable receiver spelling.
    func ReportUnableToFindFunction(location TextLocation, functionName string, receiverName string) -> Report(
        location,
        DiagnosticDescriptors.UnableToFindFunction,
        "Cannot call function $functionName because receiver '$receiverName' may be nil. Use '?.' for a null-safe call or bind it with 'if let'."
    )

    /// Reports GS0159 for a call on a receiver the author stated is
    /// `T?` (issue #4287). The name says what the report means; the
    /// report itself is the receiver-name form of
    /// (cref:ReportUnableToFindFunction(TextLocation, string, string)),
    /// which already carried this message.
    /// @param location The text location where the error was found.
    /// @param functionName The called function.
    /// @param receiverName The nullable receiver spelling.
    func ReportNilableReceiverCall(
        location TextLocation,
        functionName string,
        receiverName string
    ) -> ReportUnableToFindFunction(location, functionName, receiverName)

    /// Reports that an overloaded call (constructor, static method, or
    /// instance method) is ambiguous between two or more applicable
    /// candidates under the binder's "better function member" rules.
    /// @param location The text location of the call expression.
    /// @param name The function or constructor name.
    /// @param candidateCount The number of tied applicable candidates.
    /// @param candidateSignatures Issue #505: optional list of pre-formatted candidate signatures
    /// (e.g. `Equal[T](T, T)`). When supplied, the diagnostic enumerates
    /// the competing overloads so the caller can decide how to disambiguate
    /// (typically by adding an explicit type argument or casting). Pass
    /// `null` when the call site only knows the count.
    func ReportAmbiguousOverload(
        location TextLocation,
        name string,
        candidateCount int32,
        candidateSignatures IEnumerable[string]? = nil
    ) {
        let candidates = List[string]()
        if candidateSignatures != nil {
            for signature in candidateSignatures {
                if !string.IsNullOrEmpty(signature) {
                    candidates.Add(signature)
                }
            }
        }
        let candidateList = if candidates.Count > 0 {
            string.Format(DiagnosticDescriptors.AmbiguousOverloadCandidatesMessageFormat, string.Join("; ", candidates))
        } else {
            string.Empty
        }
        Report(location, DiagnosticDescriptors.AmbiguousOverload, name, candidateCount, candidateList)
    }

    /// Reports that copy/with syntax was applied to a non-data-struct value.
    /// @param location The text location where the error was found.
    /// @param type The actual receiver type.
    func ReportCopyOrWithNotDataStruct(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.CopyOrWithNotDataStruct,
        type
    )

    /// Reports that named arguments were used outside the scoped data-struct copy syntax.
    /// @param location The text location where the error was found.
    func ReportNamedArgumentOnlyValidForCopy(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.NamedArgumentOnlyValidForCopy
    )

    /// Issue #950: GS0379 — a `protected` member of [`declaringTypeName`](paramref)
    /// was accessed from code that is neither the declaring type nor a type
    /// deriving from it. A `protected` member is only reachable from the
    /// declaring type and the bodies of its derived types.
    /// @param location The text location of the offending access.
    /// @param memberName The protected member's name.
    /// @param declaringTypeName The declaring type's name.
    func ReportProtectedMemberInaccessible(
        location TextLocation,
        memberName string,
        declaringTypeName string
    ) -> Report(
        location,
        DiagnosticDescriptors.ProtectedMemberInaccessible,
        declaringTypeName,
        memberName,
        declaringTypeName
    )

    /// Issue #2044: GS0472 — a `private` member of
    /// [`declaringTypeName`](paramref) was accessed (read or written)
    /// from code outside that type's body. A `private` member is only
    /// reachable from within its declaring top-level type (including any
    /// nested types declared inside it).
    /// @param location The text location of the offending access.
    /// @param memberName The private member's name.
    /// @param declaringTypeName The declaring type's name.
    func ReportPrivateMemberInaccessible(location TextLocation, memberName string, declaringTypeName string) -> Report(
        location,
        DiagnosticDescriptors.PrivateMemberInaccessible,
        declaringTypeName,
        memberName,
        declaringTypeName
    )

    /// Issue #2044: reports the inaccessible-member diagnostic matching
    /// [`accessibility`](paramref) (GS0379 for `protected`, GS0472
    /// for `private`). Callers gate this behind
    /// (cref:Symbols.AccessibilityChecker.IsAccessible) returning
    /// `false`, so [`accessibility`](paramref) is always
    /// one of those two values here.
    /// @param location The text location of the offending access.
    /// @param memberName The inaccessible member's name.
    /// @param declaringTypeName The declaring type's name.
    /// @param accessibility The member's declared accessibility.
    func ReportMemberInaccessible(
        location TextLocation,
        memberName string,
        declaringTypeName string,
        accessibility Accessibility
    ) {
        if accessibility == Accessibility.Private {
            ReportPrivateMemberInaccessible(location, memberName, declaringTypeName)
        } else {
            ReportProtectedMemberInaccessible(location, memberName, declaringTypeName)
        }
    }

    /// Issue #1016: GS0392 — a range/slice expression (`a[lo..hi]`) was
    /// applied to a value whose type cannot be sliced. Sliceable targets are
    /// arrays/slices, `string`, span-like types with an `int Length`
    /// (or `Count`) plus a `Slice(int, int)` method, and types with a
    /// `System.Range` indexer.
    /// @param location The text location of the range expression.
    /// @param type The non-sliceable target type.
    func ReportTypeNotSliceable(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.TypeNotSliceable,
        type
    )

    /// GS9002: Argument must be passed by reference.
    /// @param location The text location of the argument.
    /// @param argumentIndex The 1-based argument position.
    /// @param methodName The target method name.
    func ReportArgumentMustBePassedByRef(location TextLocation, argumentIndex int32, methodName string) -> Report(
        location,
        DiagnosticDescriptors.ArgumentMustBePassedByRef,
        argumentIndex,
        methodName
    )

    /// GS9009: Readonly storage cannot satisfy a writable ref/out parameter.
    /// @param location The call location.
    /// @param argumentIndex The 1-based argument position.
    /// @param methodName The target method name.
    /// @param refKind The writable parameter modifier.
    func ReportReadOnlyArgumentForWritableRef(
        location TextLocation,
        argumentIndex int32,
        methodName string,
        refKind string
    ) -> Report(location, DiagnosticDescriptors.ReadOnlyArgumentForWritableRef, argumentIndex, methodName, refKind)

    /// GS9004: By-ref value cannot escape its declaring scope.
    /// @param location The text location of the escape attempt.
    /// @param reason Description of the escape (capture in lambda, return, store in field).
    func ReportByRefCannotEscape(location TextLocation, reason string) -> Report(
        location,
        DiagnosticDescriptors.ByRefCannotEscape,
        reason
    )

    /// GS9010 / issue #4259: a `ref`/`out`/`in` parameter of the enclosing
    /// function was captured by a closure (lambda or local function). Capturing a
    /// by-ref parameter into a heap-allocated closure is unsound — the referent's
    /// lifetime is not guaranteed to outlive the closure — so the capture is rejected
    /// rather than silently compiled into a by-value snapshot. Distinct from a
    /// `ref`/`var ref` LOCAL alias capture, which is a separate
    /// ParameterSymbol-free capture kind rejected by its own GS9011 (issue #4271).
    /// @param location The text location of the closure whose body captures the parameter.
    /// @param parameterName The captured parameter's name.
    /// @param refKindKeyword "ref", "out", or "in".
    func ReportRefParameterCannotBeCaptured(
        location TextLocation,
        parameterName string,
        refKindKeyword string
    ) -> Report(location, DiagnosticDescriptors.RefParameterCannotBeCaptured, parameterName, refKindKeyword)

    /// GS9011 / issue #4271: a `ref`/`var ref` LOCAL alias of the enclosing
    /// function was captured by a closure (lambda or local function). Like the
    /// GS9010 ref-parameter capture, this is unsound — the alias's slot holds a
    /// managed pointer, and the CLR gives no way to keep it alive in a heap-allocated
    /// closure; unlike an ordinary captured local, it cannot be made safe by boxing
    /// it into a shared cell either (that would corrupt the aliasing itself). Rejected
    /// rather than silently compiled into a by-value snapshot that loses write-through.
    /// @param location The text location of the closure whose body captures the alias.
    /// @param localName The captured alias local's name.
    func ReportRefLocalAliasCannotBeCaptured(location TextLocation, localName string) -> Report(
        location,
        DiagnosticDescriptors.RefLocalAliasCannotBeCaptured,
        localName
    )

    /// Reports that a `nameof(...)` argument is not a valid name
    /// reference (it must denote an identifier, member access, or type).
    /// @param location The text location of the argument.
    func ReportNameOfRequiresNameReference(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.NameOfRequiresNameReference
    )

    /// ADR-0060: reports that an argument's ref-kind modifier (or its absence) does not match
    /// the parameter's declared ref-kind at a call site. Replaces the lower-level GS9002 for
    /// keyword-form call sites with a more targeted message naming both observed and expected.
    /// @param location The argument location.
    /// @param argumentIndex The 1-based argument index.
    /// @param parameterName The parameter name on the callee.
    /// @param expected The expected ref-kind ("none", "ref", "out", "in").
    /// @param observed The observed ref-kind ("none", "ref", "out", "in").
    func ReportRefKindMismatch(
        location TextLocation,
        argumentIndex int32,
        parameterName string,
        expected string,
        observed string
    ) -> Report(location, DiagnosticDescriptors.RefKindMismatch, argumentIndex, parameterName, observed, expected)

    /// ADR-0060: reports that an inline-declaration / discard form (`out var`, `out let`,
    /// or `out _`) was used outside an `out` argument position (e.g. with `ref`
    /// or `in`, or as a named-argument value, or in a non-argument expression position).
    /// @param location The location of the offending construct.
    func ReportOutDeclarationOutsideOutArgument(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.OutDeclarationOutsideOutArgument
    )

    /// Issue #343: reports a positional call argument written after a named call
    /// argument. Named arguments must come last; positional → named ordering is
    /// fixed by the parser to support unambiguous matching against the parameter
    /// list.
    /// @param location The location of the offending positional argument.
    func ReportPositionalArgumentAfterNamedArgument(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.PositionalArgumentAfterNamedArgument
    )

    /// Issue #343: reports a duplicate named argument at a call site (e.g.
    /// `F(x: 1, x: 2)`). Each named argument's name must be unique.
    /// @param location The location of the duplicate named argument.
    /// @param name The duplicated parameter name.
    func ReportDuplicateNamedArgument(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.DuplicateNamedArgument,
        name
    )

    /// Issue #343: reports a named call argument whose name does not match any
    /// parameter of the resolved callee.
    /// @param location The location of the offending named argument.
    /// @param callee The callee name (for diagnostic context).
    /// @param name The argument name that did not match any parameter.
    func ReportNamedArgumentParameterNotFound(location TextLocation, callee string, name string) -> Report(
        location,
        DiagnosticDescriptors.NamedArgumentParameterNotFound,
        name,
        callee
    )

    /// Issue #343: reports a named call argument whose target parameter is
    /// already supplied by a positional argument earlier in the same call.
    /// @param location The location of the offending named argument.
    /// @param name The parameter name that was double-bound.
    func ReportNamedArgumentAlsoSpecifiedPositionally(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.NamedArgumentAlsoSpecifiedPositionally,
        name,
        name
    )

    /// ADR-0061: reports a conditional ref-argument expression that surfaces outside of
    /// a ref-kind modifier payload (`ref`/`out`/`in`) or an `&` operand.
    /// @param location The text location of the conditional expression.
    func ReportConditionalRefArgumentOutsideRefContext(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.ConditionalRefArgumentOutsideRefContext
    )

    /// ADR-0061: reports that the two branches of a conditional ref-argument produce
    /// values of different (non-identical) types.
    /// @param location The text location of the conditional expression.
    /// @param trueType The type of the true-branch lvalue.
    /// @param falseType The type of the false-branch lvalue.
    func ReportConditionalRefArgumentBranchTypeMismatch(
        location TextLocation,
        trueType string,
        falseType string
    ) -> Report(location, DiagnosticDescriptors.ConditionalRefArgumentBranchTypeMismatch, trueType, falseType)

    /// ADR-0061: reports an inline-declaration (`out var`/`out let`/`out _`)
    /// appearing inside a branch of a conditional ref-argument. A new local declared on
    /// only one branch is semantically incoherent.
    /// @param location The text location of the offending inline declaration.
    func ReportInlineDeclarationInConditionalRefBranch(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.InlineDeclarationInConditionalRefBranch
    )

    /// ADR-0061: reports an inner ref-kind modifier on a conditional ref-argument branch
    /// that does not match the outer modifier.
    /// @param location The text location of the offending inner modifier.
    /// @param outerModifier The outer modifier text (`ref`/`out`/`in`).
    /// @param innerModifier The inner modifier text observed.
    func ReportConditionalRefArgumentInnerModifierMismatch(
        location TextLocation,
        outerModifier string,
        innerModifier string
    ) -> Report(
        location,
        DiagnosticDescriptors.ConditionalRefArgumentInnerModifierMismatch,
        innerModifier,
        outerModifier
    )

    /// ADR-0062: reports a general two-arm conditional whose branch types have no
    /// common result type under the conditional's common-type selection rules.
    /// @param location The text location of the conditional expression.
    /// @param trueType The type of the true-branch expression.
    /// @param falseType The type of the false-branch expression.
    func ReportConditionalNoCommonResultType(location TextLocation, trueType string, falseType string) -> Report(
        location,
        DiagnosticDescriptors.ConditionalNoCommonResultType,
        trueType,
        falseType
    )

    /// ADR-0063 §6: reports a call whose argument list matches more than one applicable
    /// overload after generic inference, conversion, optional-parameter ranking, and the
    /// "fewest expanded defaults" tie-break.
    /// @param location The call-site location.
    /// @param name The callable name.
    func ReportAmbiguousOverloadResolution(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.AmbiguousOverloadResolution,
        name
    )

    /// Reports that an unconstrained type parameter prevents choosing between
    /// compiler-generated reference-type and value-type nullable iterator variants.
    /// @param location The call-site location.
    /// @param name The iterator function name.
    /// @param typeParameterName The unconstrained caller type parameter.
    func ReportUnconstrainedNullableIteratorCall(
        location TextLocation,
        name string,
        typeParameterName string
    ) -> Report(location, DiagnosticDescriptors.UnconstrainedNullableIteratorCall, name, typeParameterName)

    /// ADR-0063 §6: reports a call to a name that resolves to an overload set, but
    /// no overload is applicable to the given argument list (after applying defaults
    /// and named-argument reordering).
    /// @param location The call-site location.
    /// @param name The callable name.
    func ReportNoApplicableOverload(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.NoApplicableOverload,
        name
    )

    /// Issue #575: the `as` operator requires the target type to be either a
    /// reference type or a nullable value type (`T?`). A non-nullable value
    /// type is rejected because `as` must be able to yield `null` on failure.
    /// @param location The expression location.
    /// @param typeName The non-nullable value type name.
    func ReportAsRequiresReferenceOrNullableType(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.AsRequiresReferenceOrNullableType,
        typeName,
        typeName
    )

    /// Reports that `nil` was supplied as an attribute argument for a
    /// parameter whose type is not nullable. The user should make the
    /// corresponding parameter nullable (e.g. `string?` instead of
    /// `string`).
    /// @param location The source location of the `nil` literal.
    /// @param parameterName The name of the target method parameter.
    /// @param typeName The non-nullable type name.
    func ReportNilNotAssignableToNonNullableParameter(
        location TextLocation,
        parameterName string,
        typeName string
    ) -> Report(
        location,
        DiagnosticDescriptors.NilNotAssignableToNonNullableParameter,
        parameterName,
        typeName,
        typeName
    )

    /// GS0275: Calling `.GetAwaiter().GetResult()` directly on a `ValueTask`/`ValueTask<T>`
    /// is unsafe due to its single-await semantics.
    /// @param location The source location of the `.GetResult()` call.
    func ReportValueTaskDirectGetResult(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.ValueTaskDirectGetResult
    )

    /// GS0276: An if-expression used in value position has no `else` branch.
    /// Without an else, the expression cannot produce a value for all code paths.
    /// @param location The source location of the `if` keyword.
    func ReportIfExpressionMissingElse(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.IfExpressionMissingElse
    )

    /// GS0277: A block expression in value position has no trailing
    /// value-producing expression.
    /// @param location The source location of the block's closing brace.
    func ReportBlockExpressionMissingTrailingExpression(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.BlockExpressionMissingTrailingExpression
    )

    /// ADR-0072 / issue #709: GS0298 — the left-hand side of a
    /// null-coalescing compound assignment `??=` must be of nullable
    /// type. The operator only fills the slot when it currently reads as
    /// nil, so a non-nullable target is necessarily a no-op (and almost
    /// always a programmer error).
    /// @param location The source location of the offending operator.
    /// @param actualType The actual (non-nullable) left-hand-side type.
    func ReportNullCoalescingAssignmentTargetNotNullable(location TextLocation, actualType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.NullCoalescingAssignmentTargetNotNullable,
        actualType,
        actualType
    )

    /// ADR-0072 / issue #709: GS0299 — the left-hand side of a
    /// null-coalescing compound assignment `??=` is not a supported
    /// assignable form. Accepted shapes are a local or parameter, an
    /// implicit field/property on `this`, a member field/property
    /// access (`obj.member`), or an indexer access (`obj[i]`).
    /// @param location The source location of the offending operator.
    func ReportNullCoalescingAssignmentInvalidTarget(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.NullCoalescingAssignmentInvalidTarget
    )

    /// ADR-0073 / issue #710: GS0300 (warning) — the receiver of a
    /// null-conditional index access `a?[i]` is not of nullable type,
    /// so the null-check is dead code. Suggest the plain `a[i]` form
    /// to make the author's intent obvious.
    /// @param location The source location of the offending operator.
    /// @param actualType The actual (non-nullable) receiver type.
    func ReportNullConditionalIndexReceiverNotNullable(location TextLocation, actualType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.NullConditionalIndexReceiverNotNullable,
        actualType
    )

    /// ADR-0073 / issue #710: GS0301 — the null-conditional index access
    /// `a?[i]` cannot appear on the left-hand side of an assignment
    /// (matching C#'s CS0131 behavior). The author probably meant
    /// `if a != nil { a[i] = v }` or simply `a[i] = v` when the
    /// receiver is known to be non-nil.
    /// @param location The source location of the offending operator.
    func ReportNullConditionalIndexAssignmentTarget(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.NullConditionalIndexAssignmentTarget
    )

    /// ADR-0076 / issue #716: GS0304 — an arrow-lambda binding cannot resolve
    /// its parameter type because neither side of the binding supplies one.
    /// The lambda parameter has no explicit type clause AND there is no target
    /// type (e.g. an explicit binding type, or a target-typed conversion
    /// context) to infer it from. Either type the parameter
    /// (`(p int32) -> body`) or give the binding an explicit
    /// function type (`let f (int32) -> R = (p) -> body`).
    /// @param location The source location of the untyped parameter.
    /// @param parameterName The name of the untyped lambda parameter.
    func ReportLambdaBindingTypeCannotBeInferred(location TextLocation, parameterName string) -> Report(
        location,
        DiagnosticDescriptors.LambdaBindingTypeCannotBeInferred,
        parameterName,
        parameterName
    )

    /// ADR-0185: reports GS0592 for a tuple-destructuring arrow-lambda
    /// parameter pattern (`(x string, y int) -> ...`) with fewer than
    /// two elements — G# has no 1-tuples, so a single-element pattern can
    /// never correspond to a real tuple-typed argument.
    /// @param location The destructuring pattern's closing-parenthesis location.
    /// @param elementCount The actual (too-small) element count.
    func ReportDestructuringParameterRequiresAtLeastTwoElements(location TextLocation, elementCount int32) -> Report(
        location,
        DiagnosticDescriptors.DestructuringParameterRequiresAtLeastTwoElements,
        elementCount
    )

    /// Reports GS0497 for an async iterator function literal, whose state-machine synthesis is unsupported.
    /// @param location The function literal's source location.
    /// @param returnType The unsupported async-iterator return type.
    func ReportAsyncIteratorFunctionLiteralNotSupported(location TextLocation, returnType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.AsyncIteratorFunctionLiteralNotSupported,
        returnType
    )

    /// Reports GS0362 — ADR-0100 / issue #795: a bare `default`
    /// literal appears in a position where no target type can be
    /// inferred. The bare form is only valid in target-typed positions:
    /// the initializer of a `let`/`var`/`const` binding
    /// that names a type, the operand of `return` when the
    /// enclosing function's return type is known, an argument to a
    /// typed parameter, or a branch of a `?:` typed by the sibling
    /// branch. Outside these contexts, write the explicit form
    /// `default(T)`.
    /// @param location The offending bare-`default` location.
    func ReportBareDefaultNoTargetType(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.BareDefaultNoTargetType
    )

    /// Reports GS0333 — ADR-0089 / issue #755: the dispatch expression
    /// `T.Member(...)` where `T` is a generic type parameter
    /// constrained to some interface(s) either does not name a member or
    /// names no static-virtual member on any of those interfaces.
    /// @param location The accessor expression location.
    /// @param typeParameterName The type parameter name.
    /// @param memberName The looked-up static member name.
    func ReportStaticVirtualMemberNotFoundOnTypeParameter(
        location TextLocation,
        typeParameterName string,
        memberName string
    ) -> Report(
        location,
        DiagnosticDescriptors.StaticVirtualMemberNotFoundOnTypeParameter,
        typeParameterName,
        memberName
    )

    /// ADR-0090 / issue #756: GS0334 — external code attempted to call a
    /// `private` helper on an interface from outside the interface's
    /// own declaration. The helper is part of the interface's
    /// implementation, not its contract; only sibling members may call it.
    /// @param location The offending call expression location.
    /// @param interfaceName The owning interface's display name.
    /// @param methodName The private helper's name.
    func ReportPrivateInterfaceMemberNotAccessible(
        location TextLocation,
        interfaceName string,
        methodName string
    ) -> Report(location, DiagnosticDescriptors.PrivateInterfaceMemberNotAccessible, interfaceName, methodName)

    /// ADR-0091 / issue #757: GS0338 — a `base[IFoo].M(...)` call
    /// expression refers to an interface that is not in the enclosing
    /// type's implemented-interface set, or the call appears outside any
    /// instance member of a user-declared class/struct.
    /// @param location The source location of the offending expression.
    /// @param enclosingTypeName The display name of the enclosing class/struct, or a placeholder for
    /// non-member contexts.
    /// @param interfaceName The interface name as it appears in `base[…]`.
    func ReportBaseInterfaceCallTypeDoesNotImplementInterface(
        location TextLocation,
        enclosingTypeName string,
        interfaceName string
    ) -> Report(
        location,
        DiagnosticDescriptors.BaseInterfaceCallTypeDoesNotImplementInterface,
        interfaceName,
        enclosingTypeName,
        interfaceName
    )

    /// ADR-0091 / issue #757: GS0339 — a `base[IFoo].M(...)` call
    /// expression names a member `M` that does not exist on
    /// `IFoo`.
    /// @param location The source location of the method identifier.
    /// @param interfaceName The interface that lacks the member.
    /// @param methodName The missing member name.
    func ReportBaseInterfaceCallMemberNotFound(
        location TextLocation,
        interfaceName string,
        methodName string
    ) -> Report(location, DiagnosticDescriptors.BaseInterfaceCallMemberNotFound, interfaceName, methodName)

    /// ADR-0091 / issue #757: GS0340 — a `base[IFoo].M(...)` call
    /// expression refers to an interface member that <em>is</em> declared
    /// on `IFoo` but is abstract (no default body); there is nothing
    /// to delegate to.
    /// @param location The source location of the method identifier.
    /// @param interfaceName The interface name.
    /// @param methodName The abstract member name.
    func ReportBaseInterfaceCallMemberIsAbstract(
        location TextLocation,
        interfaceName string,
        methodName string
    ) -> Report(
        location,
        DiagnosticDescriptors.BaseInterfaceCallMemberIsAbstract,
        interfaceName,
        methodName,
        interfaceName
    )

    /// ADR-0091 / issue #757: GS0341 — a `base[IFoo].M(...)` call
    /// expression targets a `private` helper on `IFoo`. Private
    /// interface helpers (ADR-0090) are intentionally invisible to
    /// implementers; the explicit-base call form does not bypass that
    /// restriction.
    /// @param location The source location of the method identifier.
    /// @param interfaceName The owning interface name.
    /// @param methodName The private helper name.
    func ReportBaseInterfaceCallTargetsPrivateHelper(
        location TextLocation,
        interfaceName string,
        methodName string
    ) -> Report(
        location,
        DiagnosticDescriptors.BaseInterfaceCallTargetsPrivateHelper,
        interfaceName,
        methodName,
        interfaceName,
        methodName
    )

    /// Issue #986: GS0383 — a `base.M(...)` (or
    /// `base[BaseClass].M(...)`) call appears outside an instance member
    /// of a class, so there is no `base` to delegate to. Fires for
    /// top-level functions, `shared` statics, and structs (which have no
    /// base class). Issue #1260: a class deriving only from `System.Object`
    /// (or another imported/BCL base) no longer fires this — those inherited
    /// members are reachable via `base` — and a missing member is reported
    /// as GS0384 instead.
    /// @param location The source location of the offending `base` expression.
    /// @param enclosingTypeName The display name of the enclosing type, or a placeholder for non-member
    /// contexts.
    func ReportBaseClassCallHasNoBaseClass(location TextLocation, enclosingTypeName string) -> Report(
        location,
        DiagnosticDescriptors.BaseClassCallHasNoBaseClass,
        enclosingTypeName
    )

    /// Issue #986: GS0384 — a `base.M(...)` (or
    /// `base[BaseClass].M(...)`) call names a member `M` that does
    /// not exist on any base class of the enclosing type.
    /// @param location The source location of the method identifier.
    /// @param baseTypeName The nearest base class searched.
    /// @param methodName The missing member name.
    func ReportBaseClassCallMemberNotFound(location TextLocation, baseTypeName string, methodName string) -> Report(
        location,
        DiagnosticDescriptors.BaseClassCallMemberNotFound,
        baseTypeName,
        methodName
    )

    /// Issue #986: GS0385 — a `base[Type].M(...)` call names a
    /// `Type` in the brackets that is not the enclosing type's actual
    /// base class.
    /// @param location The source location of the bracketed type clause.
    /// @param enclosingTypeName The display name of the enclosing class.
    /// @param selectorTypeName The type named in the brackets.
    func ReportBaseClassCallSelectorNotBaseClass(
        location TextLocation,
        enclosingTypeName string,
        selectorTypeName string
    ) -> Report(
        location,
        DiagnosticDescriptors.BaseClassCallSelectorNotBaseClass,
        selectorTypeName,
        selectorTypeName,
        enclosingTypeName
    )

    /// Issue #1260: GS0413 — a `base.M(...)` (or `base.Prop`) access
    /// targets an `abstract` member of an imported/BCL base class that has
    /// no base implementation to delegate to (e.g. `base.Read(...)` where
    /// `System.IO.Stream.Read(byte[],int,int)` is abstract). Mirrors C#'s
    /// CS0205 ("cannot call an abstract base member").
    /// @param location The source location of the offending member identifier.
    /// @param baseTypeName The imported base type that declares the abstract member.
    /// @param memberName The abstract member's name.
    func ReportBaseClassCallAbstractMember(location TextLocation, baseTypeName string, memberName string) -> Report(
        location,
        DiagnosticDescriptors.BaseClassCallAbstractMember,
        baseTypeName,
        memberName
    )

    /// Issue #1201: GS0414 — an unqualified reference to a `shared`
    /// (static) member that is exposed by two or more types imported via
    /// `import Ns.Type` (the G# spelling of C#'s `using static`).
    /// Mirrors C#'s CS0121 ambiguity for using-static members: the reference is
    /// only an error when it is actually used and more than one imported type
    /// contributes a member of that name. Qualify the reference with the owning
    /// type name (`Type.Member`) to disambiguate.
    /// @param location The source location of the ambiguous member identifier.
    /// @param name The ambiguous member name.
    func ReportAmbiguousImportedStaticMember(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.AmbiguousImportedStaticMember,
        name
    )

    /// Issue #2012 (N3): an explicit-arity open-generic `typeof(Name[_,
    /// ...])` whose base name + requested arity (e.g. `Func`1`)
    /// resolves to two or more DIFFERENT CLR types across the imports in
    /// scope. Distinct from (cref:ReportUndefinedType) (which means no
    /// type matched at all): here at least two imports each contribute a
    /// candidate and they disagree, so the previous behavior of reporting
    /// "type doesn't exist" was a misleading diagnostic for a genuinely
    /// different failure mode (nothing was undefined — too many things were
    /// defined). Mirrors the wording of (cref:ReportAmbiguousImportedStaticMember)
    /// (#1201) for the analogous ambiguous-import-member case.
    /// @param location The source location of the ambiguous type reference.
    /// @param name The ambiguous arity-suffixed type name (e.g. `Func`1`).
    func ReportAmbiguousImportedType(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.AmbiguousImportedType,
        name
    )

    /// ADR-0146 / issue #2243: GS0485 — an anonymous-object literal
    /// (`object { ... }` / `data object { ... }`) declared an
    /// `init` or `deinit` member. Anonymous objects support fields,
    /// methods, and events only; constructors and destructors are not allowed.
    /// @param location The source location of the offending `init`/`deinit` keyword.
    /// @param memberKeyword The rejected member keyword spelling (`init` or `deinit`).
    func ReportInitDeinitNotAllowedInAnonymousObject(location TextLocation, memberKeyword string) -> Report(
        location,
        DiagnosticDescriptors.InitDeinitNotAllowedInAnonymousObject,
        memberKeyword
    )

    /// ADR-0146 / issue #2243: GS0486 — a field member of a "rich"
    /// anonymous object (one with a base/interface clause, method, or event)
    /// omitted its type annotation. Rich anonymous objects materialize fields
    /// as ordinary class fields, which require an explicit type; type
    /// inference from the initializer is only available on the field-only
    /// `object { ... }` / `data object { ... }` forms.
    /// @param location The source location of the offending field name.
    /// @param fieldName The field member's name.
    func ReportInferredFieldTypeNotAllowedInRichAnonymousObject(location TextLocation, fieldName string) -> Report(
        location,
        DiagnosticDescriptors.InferredFieldTypeNotAllowedInRichAnonymousObject,
        fieldName
    )

    /// Reports that an omitted rich anonymous field type cannot be inferred safely.
    /// @param location The field identifier location.
    /// @param fieldName The field name.
    func ReportRichAnonymousFieldInference(location TextLocation, fieldName string) -> Report(
        location,
        DiagnosticDescriptors.RichAnonymousFieldInference,
        fieldName
    )

    /// Reports a compile-time structural adaptation failure.
    /// @param location The adaptation expression location.
    /// @param sourceType The source type display.
    /// @param targetType The target interface display.
    /// @param reason The exact unsupported or mismatched contract.
    func ReportStructuralAdaptation(
        location TextLocation,
        sourceType string,
        targetType string,
        reason string
    ) -> Report(location, DiagnosticDescriptors.StructuralAdaptation, sourceType, targetType, reason)

    /// Issue #987: GS0386 — an attempt to construct (instantiate) an abstract
    /// class. A class is abstract when it declares (or inherits without
    /// overriding) an abstract method — a no-body `open func F() R;`. Like
    /// C#'s CS0144, this is a clean compile-time error rather than a runtime
    /// `MemberAccessException`.
    /// @param location The source location of the construction expression.
    /// @param typeName The display name of the abstract type.
    func ReportCannotInstantiateAbstractType(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.CannotInstantiateAbstractType,
        typeName
    )

    /// Reports GS0369 — issue #479 / ADR-0117: a collection initializer
    /// (`Type[…]{ elements }`) was applied to a target type that is not a
    /// collection — it exposes no accessible instance `Add` method (for a
    /// bare element or `key: value` entry) nor a settable indexer (for an
    /// `[key] = value` entry). Use an object initializer
    /// (`Type(){ Prop = value }`) for property/field initialization, or
    /// construct a list/set/dictionary type that supports `Add`.
    /// @param location The source location of the initializer.
    /// @param type The non-collection target type.
    func ReportTypeNotCollectionInitializable(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.TypeNotCollectionInitializable,
        type
    )

    /// Issue #988: GS0389 — a type parameter is constructed (`T()`) but it
    /// carries no `init()` default-constructor constraint, so the compiler
    /// cannot guarantee an accessible parameterless constructor exists. Mirrors
    /// C#'s CS0304. The fix is to add an `init()` constraint to the type
    /// parameter (e.g. `[T init()]`). (Constraint keyword renamed from
    /// `new()` to `init()` by issue #997.)
    /// @param location The source location of the constructing identifier.
    /// @param typeParameterName The name of the type parameter being constructed.
    func ReportConstructedTypeParameterRequiresNewConstraint(location TextLocation, typeParameterName string) -> Report(
        location,
        DiagnosticDescriptors.ConstructedTypeParameterRequiresNewConstraint,
        typeParameterName,
        typeParameterName,
        typeParameterName
    )

    /// Reports GS0588 — issue #4219 (umbrella remainder): a `ref`-returning
    /// function literal was written somewhere other than the initializer of
    /// a `let name = func (...) ref T { ... }` local function declaration
    /// (e.g. passed as an argument, or assigned to a `var`).
    /// @param location The source location of the literal's `ref` return modifier.
    func ReportRefReturningFunctionLiteralRequiresDirectLocalFunction(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.RefReturningFunctionLiteralRequiresDirectLocalFunction
    )
}
