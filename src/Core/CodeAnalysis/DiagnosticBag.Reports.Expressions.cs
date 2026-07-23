// <copyright file="DiagnosticBag.Reports.Expressions.cs" company="GSharp">
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
    /// Reports that an enum member access references an unknown member.
    /// </summary>
    /// <param name="location">The text location of the unknown member.</param>
    /// <param name="memberName">The unknown member name.</param>
    /// <param name="enumName">The enum name.</param>
    public void ReportUndefinedEnumMember(TextLocation location, string memberName, string enumName)
    => Report(location, DiagnosticDescriptors.UndefinedEnumMember, enumName, memberName);

    /// <summary>
    /// Reports that a type doesn't exist.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The type name.</param>
    public void ReportUndefinedType(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.UndefinedType, name);

    /// <summary>
    /// Issue #2455: reports that a bare simple type name collides between two
    /// or more different top-level packages that are EACH visible via an
    /// explicit <c>import</c> somewhere in the compilation, so its identity
    /// cannot be determined from the reference alone. Distinct from
    /// <see cref="ReportUndefinedType"/> (which means no type at all matched)
    /// the same way <see cref="ReportAmbiguousImportedType"/> is distinct for
    /// imported CLR types.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The type name.</param>
    public void ReportAmbiguousSourceType(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.AmbiguousSourceType, name);

    /// <summary>
    /// Issue #526: reports that the outer type exists but does not contain a nested
    /// type of the requested name.
    /// </summary>
    /// <param name="location">The text location of the nested-type segment.</param>
    /// <param name="outerTypeName">The outer (containing) type's source-visible name.</param>
    /// <param name="nestedName">The nested-type segment that could not be resolved.</param>
    public void ReportUndefinedNestedType(TextLocation location, string outerTypeName, string nestedName)
    => Report(location, DiagnosticDescriptors.UndefinedNestedType, outerTypeName, nestedName);

    /// <summary>
    /// Reports that the array length is not a valid non-negative integer literal.
    /// </summary>
    /// <param name="location">The text location.</param>
    /// <param name="text">The length token text.</param>
    public void ReportInvalidArrayLength(TextLocation location, string text)
    => Report(location, DiagnosticDescriptors.InvalidArrayLength, text);

    /// <summary>
    /// Reports that the number of array initialisers does not match the declared length.
    /// </summary>
    /// <param name="location">The text location.</param>
    /// <param name="expected">The declared length.</param>
    /// <param name="actual">The provided initialiser count.</param>
    public void ReportArrayLiteralLengthMismatch(TextLocation location, int expected, int actual)
    => Report(location, DiagnosticDescriptors.ArrayLiteralLengthMismatch, expected, actual);

    /// <summary>
    /// Reports that indexing was attempted on a non-array expression.
    /// </summary>
    /// <param name="location">The text location.</param>
    /// <param name="type">The actual type.</param>
    public void ReportTypeNotIndexable(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.TypeNotIndexable, type.Name);

    /// <summary>
    /// Reports that a built-in intrinsic was applied to an unsupported argument type.
    /// </summary>
    /// <param name="location">The text location of the offending argument.</param>
    /// <param name="name">The intrinsic name.</param>
    /// <param name="type">The actual argument type.</param>
    public void ReportIntrinsicArgumentType(TextLocation location, string name, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.IntrinsicArgumentType, name, type.Name);

    /// <summary>
    /// Reports that an expression must have a value.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportExpressionMustHaveValue(TextLocation location)
    => Report(location, DiagnosticDescriptors.ExpressionMustHaveValue);

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

        Report(location, DiagnosticDescriptors.UndefinedVariable, name);
    }

    /// <summary>
    /// Reports that a name doesn't belong to a variable.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The name of the variable.</param>
    public void ReportNotAVariable(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.NotAVariable, name);

    /// <summary>
    /// Reports that the specified unary operator is not defined for the specified type.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="operatorText">The operator text.</param>
    /// <param name="operandType">The operand type.</param>
    public void ReportUndefinedUnaryOperator(TextLocation location, string operatorText, TypeSymbol operandType)
    => Report(location, DiagnosticDescriptors.UndefinedUnaryOperator, operatorText, operandType);

    /// <summary>
    /// Reports that the specified unary operator is not defined for the specified types.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="operatorText">The operator text.</param>
    /// <param name="leftType">The left operand type.</param>
    /// <param name="rightType">The right operand type.</param>
    public void ReportUndefinedBinaryOperator(TextLocation location, string operatorText, TypeSymbol leftType, TypeSymbol rightType)
    => Report(location, DiagnosticDescriptors.UndefinedBinaryOperator, operatorText, leftType, rightType);

    /// <summary>
    /// Reports that the function doesn't exist.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The function name.</param>
    public void ReportUndefinedFunction(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.UndefinedFunction, name);

    /// <summary>
    /// Reports that the name doesn't belong to a function.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The function name.</param>
    public void ReportNotAFunction(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.NotAFunction, name);

    /// <summary>
    /// Reports that the operand of an <c>await</c> expression is not a Task (Phase 5.1 / ADR-0023).
    /// </summary>
    /// <param name="location">The text location of the operand.</param>
    /// <param name="actualType">The actual type of the operand.</param>
    public void ReportTypeIsNotAwaitable(TextLocation location, TypeSymbol actualType)
    => Report(location, DiagnosticDescriptors.TypeIsNotAwaitable, actualType);

    /// <summary>
    /// Reports that the function requires a different amount of arguments.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The function name.</param>
    /// <param name="expectedCount">The expected argument count.</param>
    /// <param name="actualCount">The actual argument count.</param>
    public void ReportWrongArgumentCount(TextLocation location, string name, int expectedCount, int actualCount)
    => Report(location, DiagnosticDescriptors.WrongArgumentCount, name, expectedCount, actualCount);

    /// <summary>Reports a call to a variadic function with too few fixed arguments (Phase 4.8).</summary>
    /// <param name="location">The text location of the call.</param>
    /// <param name="name">The callee name.</param>
    /// <param name="minimumCount">The minimum required argument count (fixed parameters).</param>
    /// <param name="actualCount">The actual argument count provided.</param>
    public void ReportTooFewArgumentsForVariadic(TextLocation location, string name, int minimumCount, int actualCount)
    => Report(location, DiagnosticDescriptors.TooFewArgumentsForVariadic, name, minimumCount, actualCount);

    /// <summary>Reports a generic call whose explicit type-argument list has the wrong arity (Phase 4.1 / ADR-0020).</summary>
    /// <param name="location">The text location of the type-argument list.</param>
    /// <param name="name">The callee name.</param>
    /// <param name="expectedCount">The expected number of type arguments.</param>
    /// <param name="actualCount">The actual number of type arguments.</param>
    public void ReportWrongTypeArgumentCount(TextLocation location, string name, int expectedCount, int actualCount)
    => Report(location, DiagnosticDescriptors.WrongTypeArgumentCount, name, expectedCount, actualCount);

    /// <summary>Reports a type-clause type-argument list applied to a non-generic type (Phase 4.3c / ADR-0020).</summary>
    /// <param name="location">The text location of the offending identifier.</param>
    /// <param name="name">The type name.</param>
    public void ReportTypeNotGeneric(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.TypeNotGeneric, name);

    /// <summary>Reports a generic call whose type arguments could not be inferred from the value arguments (Phase 4.1 / ADR-0020).</summary>
    /// <param name="location">The text location of the call.</param>
    /// <param name="name">The callee name.</param>
    /// <param name="typeParameterName">The unresolved type-parameter name.</param>
    public void ReportTypeArgumentInferenceFailed(TextLocation location, string name, string typeParameterName)
    => Report(location, DiagnosticDescriptors.TypeArgumentInferenceFailed, typeParameterName, name, typeParameterName);

    /// <summary>Reports a generic call whose type argument does not satisfy the declared constraint (Phase 4.2 / ADR-0020).</summary>
    /// <param name="location">The text location of the offending type argument or call.</param>
    /// <param name="typeParameterName">The type-parameter name (e.g. <c>T</c>).</param>
    /// <param name="typeArgument">The supplied type argument.</param>
    /// <param name="constraintDescription">A human-readable description of the constraint (e.g. <c>comparable</c>).</param>
    public void ReportTypeArgumentDoesNotSatisfyConstraint(TextLocation location, string typeParameterName, TypeSymbol typeArgument, string constraintDescription)
    => Report(location, DiagnosticDescriptors.TypeArgumentDoesNotSatisfyConstraint, typeArgument, typeParameterName, constraintDescription);

    /// <summary>
    /// Reports that the parameter requires a value of a different type.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="name">The parameter name.</param>
    /// <param name="expectedType">The expected type.</param>
    /// <param name="actualType">The actual type.</param>
    public void ReportWrongArgumentType(TextLocation location, string name, TypeSymbol expectedType, TypeSymbol actualType)
    => Report(location, DiagnosticDescriptors.WrongArgumentType, name, expectedType, actualType);

    /// <summary>
    /// Rerpots that there's no conversion from one type to the other.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="fromType">From type.</param>
    /// <param name="toType">To type.</param>
    public void ReportCannotConvert(TextLocation location, TypeSymbol fromType, TypeSymbol toType)
    => Report(location, DiagnosticDescriptors.CannotConvert, fromType, toType);

    /// <summary>Reports why a requested structural projection is unsafe or incomplete.</summary>
    /// <param name="location">The projection source location.</param>
    /// <param name="fromType">The source type.</param>
    /// <param name="toType">The target type.</param>
    /// <param name="reason">The compile-time planning failure.</param>
    public void ReportStructuralProjectionFailure(
        TextLocation location,
        TypeSymbol fromType,
        TypeSymbol toType,
        string reason)
    => Report(location, DiagnosticDescriptors.StructuralProjectionFailure, fromType, toType, reason);

    /// <summary>
    /// Reports that there's no implicit conversion from one type to the other.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="fromType">From type.</param>
    /// <param name="toType">To type.</param>
    public void ReportCannotConvertImplicitly(TextLocation location, TypeSymbol fromType, TypeSymbol toType)
    => Report(location, DiagnosticDescriptors.CannotConvertImplicitly, fromType, toType);

    /// <summary>
    /// Issue #337: reports that a CLR member method group cannot be converted to
    /// the expected target type (it is not a compatible delegate type, or no
    /// overload matches the delegate signature).
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="methodName">The method-group name.</param>
    /// <param name="toType">The expected target type.</param>
    public void ReportCannotConvertMethodGroup(TextLocation location, string methodName, TypeSymbol toType)
    => Report(location, DiagnosticDescriptors.CannotConvertMethodGroup, methodName, toType);

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
    => Report(location, DiagnosticDescriptors.ByRefLikeEscape, type, reason);

    /// <summary>
    /// Reports that we couldn't find the specified type.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The text associated to the type.</param>
    public void ReportUnableToFindType(TextLocation location, string text)
    => Report(location, DiagnosticDescriptors.UnableToFindType, text);

    /// <summary>
    /// Reports that we couldn't find the specified member.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The text associated to the member.</param>
    public void ReportUnableToFindMember(TextLocation location, string text)
    => Report(location, DiagnosticDescriptors.UnableToFindMember, text);

    /// <summary>
    /// Reports that we couldn't find the specified function.
    /// </summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="text">The text associated to the function.</param>
    public void ReportUnableToFindFunction(TextLocation location, string text)
    => Report(location, DiagnosticDescriptors.UnableToFindFunction, text);

    /// <summary>
    /// Reports that an overloaded call (constructor, static method, or
    /// instance method) is ambiguous between two or more applicable
    /// candidates under the binder's "better function member" rules.
    /// </summary>
    /// <param name="location">The text location of the call expression.</param>
    /// <param name="name">The function or constructor name.</param>
    /// <param name="candidateCount">The number of tied applicable candidates.</param>
    /// <param name="candidateSignatures">
    /// Issue #505: optional list of pre-formatted candidate signatures
    /// (e.g. <c>Equal[T](T, T)</c>). When supplied, the diagnostic enumerates
    /// the competing overloads so the caller can decide how to disambiguate
    /// (typically by adding an explicit type argument or casting). Pass
    /// <see langword="null"/> when the call site only knows the count.
    /// </param>
    public void ReportAmbiguousOverload(TextLocation location, string name, int candidateCount, IEnumerable<string> candidateSignatures = null)
    {
        var candidates = candidateSignatures?
            .Where(s => !string.IsNullOrEmpty(s))
            .ToArray();
        var candidateList = candidates is { Length: > 0 }
            ? string.Format(
                DiagnosticDescriptors.AmbiguousOverloadCandidatesMessageFormat,
                string.Join("; ", candidates))
            : string.Empty;
        Report(location, DiagnosticDescriptors.AmbiguousOverload, name, candidateCount, candidateList);
    }

    /// <summary>Reports that copy/with syntax was applied to a non-data-struct value.</summary>
    /// <param name="location">The text location where the error was found.</param>
    /// <param name="type">The actual receiver type.</param>
    public void ReportCopyOrWithNotDataStruct(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.CopyOrWithNotDataStruct, type);

    /// <summary>Reports that named arguments were used outside the scoped data-struct copy syntax.</summary>
    /// <param name="location">The text location where the error was found.</param>
    public void ReportNamedArgumentOnlyValidForCopy(TextLocation location)
    => Report(location, DiagnosticDescriptors.NamedArgumentOnlyValidForCopy);

    /// <summary>
    /// Issue #950: GS0379 — a <c>protected</c> member of <paramref name="declaringTypeName"/>
    /// was accessed from code that is neither the declaring type nor a type
    /// deriving from it. A <c>protected</c> member is only reachable from the
    /// declaring type and the bodies of its derived types.
    /// </summary>
    /// <param name="location">The text location of the offending access.</param>
    /// <param name="memberName">The protected member's name.</param>
    /// <param name="declaringTypeName">The declaring type's name.</param>
    public void ReportProtectedMemberInaccessible(TextLocation location, string memberName, string declaringTypeName)
    => Report(location, DiagnosticDescriptors.ProtectedMemberInaccessible, declaringTypeName, memberName, declaringTypeName);

    /// <summary>
    /// Issue #2044: GS0472 — a <c>private</c> member of
    /// <paramref name="declaringTypeName"/> was accessed (read or written)
    /// from code outside that type's body. A <c>private</c> member is only
    /// reachable from within its declaring top-level type (including any
    /// nested types declared inside it).
    /// </summary>
    /// <param name="location">The text location of the offending access.</param>
    /// <param name="memberName">The private member's name.</param>
    /// <param name="declaringTypeName">The declaring type's name.</param>
    public void ReportPrivateMemberInaccessible(TextLocation location, string memberName, string declaringTypeName)
    => Report(location, DiagnosticDescriptors.PrivateMemberInaccessible, declaringTypeName, memberName, declaringTypeName);

    /// <summary>
    /// Issue #2044: reports the inaccessible-member diagnostic matching
    /// <paramref name="accessibility"/> (GS0379 for <c>protected</c>, GS0472
    /// for <c>private</c>). Callers gate this behind
    /// <see cref="Symbols.AccessibilityChecker.IsAccessible"/> returning
    /// <see langword="false"/>, so <paramref name="accessibility"/> is always
    /// one of those two values here.
    /// </summary>
    /// <param name="location">The text location of the offending access.</param>
    /// <param name="memberName">The inaccessible member's name.</param>
    /// <param name="declaringTypeName">The declaring type's name.</param>
    /// <param name="accessibility">The member's declared accessibility.</param>
    public void ReportMemberInaccessible(TextLocation location, string memberName, string declaringTypeName, Accessibility accessibility)
    {
        if (accessibility == Accessibility.Private)
        {
            ReportPrivateMemberInaccessible(location, memberName, declaringTypeName);
        }
        else
        {
            ReportProtectedMemberInaccessible(location, memberName, declaringTypeName);
        }
    }

    /// <summary>
    /// Issue #1016: GS0392 — a range/slice expression (<c>a[lo..hi]</c>) was
    /// applied to a value whose type cannot be sliced. Sliceable targets are
    /// arrays/slices, <c>string</c>, span-like types with an <c>int Length</c>
    /// (or <c>Count</c>) plus a <c>Slice(int, int)</c> method, and types with a
    /// <c>System.Range</c> indexer.
    /// </summary>
    /// <param name="location">The text location of the range expression.</param>
    /// <param name="type">The non-sliceable target type.</param>
    public void ReportTypeNotSliceable(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.TypeNotSliceable, type.Name);

    /// <summary>GS9002: Argument must be passed by reference.</summary>
    /// <param name="location">The text location of the argument.</param>
    /// <param name="argumentIndex">The 1-based argument position.</param>
    /// <param name="methodName">The target method name.</param>
    public void ReportArgumentMustBePassedByRef(TextLocation location, int argumentIndex, string methodName)
    => Report(location, DiagnosticDescriptors.ArgumentMustBePassedByRef, argumentIndex, methodName);

    /// <summary>GS9004: By-ref value cannot escape its declaring scope.</summary>
    /// <param name="location">The text location of the escape attempt.</param>
    /// <param name="reason">Description of the escape (capture in lambda, return, store in field).</param>
    public void ReportByRefCannotEscape(TextLocation location, string reason)
    => Report(location, DiagnosticDescriptors.ByRefCannotEscape, reason);

    /// <summary>
    /// GS0410: a from-end index marker <c>^</c> appeared where it is not
    /// allowed — at the very start of a standalone range expression
    /// (<c>^a..b</c>) or as a bare expression. The leading <c>^</c> is
    /// ambiguous with the one's-complement unary operator, so it is only
    /// recognised as a from-end marker inside index brackets
    /// (<c>arr[^1]</c>, <c>arr[a..^b]</c>) or after <c>..</c> in a standalone
    /// range upper bound (<c>a..^b</c>) (issue #1038).
    /// </summary>
    /// <param name="location">The text location of the <c>^</c> marker.</param>
    public void ReportFromEndMarkerNotAllowedInStandaloneRange(TextLocation location)
    => Report(location, DiagnosticDescriptors.FromEndMarkerNotAllowedInStandaloneRange);

    /// <summary>
    /// Reports that a <c>nameof(...)</c> argument is not a valid name
    /// reference (it must denote an identifier, member access, or type).
    /// </summary>
    /// <param name="location">The text location of the argument.</param>
    public void ReportNameOfRequiresNameReference(TextLocation location)
    => Report(location, DiagnosticDescriptors.NameOfRequiresNameReference);

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
    => Report(location, DiagnosticDescriptors.RefKindMismatch, argumentIndex, parameterName, observed, expected);

    /// <summary>
    /// ADR-0060: reports that an inline-declaration / discard form (<c>out var</c>, <c>out let</c>,
    /// or <c>out _</c>) was used outside an <c>out</c> argument position (e.g. with <c>ref</c>
    /// or <c>in</c>, or as a named-argument value, or in a non-argument expression position).
    /// </summary>
    /// <param name="location">The location of the offending construct.</param>
    public void ReportOutDeclarationOutsideOutArgument(TextLocation location)
    => Report(location, DiagnosticDescriptors.OutDeclarationOutsideOutArgument);

    /// <summary>
    /// ADR-0060 §8: warns that a call passes a value at an <c>in</c> parameter position
    /// without the matching <c>in</c> modifier. The compiler does NOT silently spill the
    /// value; the user should write <c>in lvalue</c> or remove the <c>in</c> from the signature.
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="argumentIndex">The 1-based argument index.</param>
    /// <param name="parameterName">The parameter name on the callee.</param>
    public void ReportInArgumentMissingInModifier(TextLocation location, int argumentIndex, string parameterName)
    => Report(location, DiagnosticDescriptors.InArgumentMissingInModifier, argumentIndex, parameterName);

    /// <summary>
    /// Issue #343: reports a positional call argument written after a named call
    /// argument. Named arguments must come last; positional → named ordering is
    /// fixed by the parser to support unambiguous matching against the parameter
    /// list.
    /// </summary>
    /// <param name="location">The location of the offending positional argument.</param>
    public void ReportPositionalArgumentAfterNamedArgument(TextLocation location)
    => Report(location, DiagnosticDescriptors.PositionalArgumentAfterNamedArgument);

    /// <summary>
    /// Issue #343: reports a duplicate named argument at a call site (e.g.
    /// <c>F(x: 1, x: 2)</c>). Each named argument's name must be unique.
    /// </summary>
    /// <param name="location">The location of the duplicate named argument.</param>
    /// <param name="name">The duplicated parameter name.</param>
    public void ReportDuplicateNamedArgument(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.DuplicateNamedArgument, name);

    /// <summary>
    /// Issue #343: reports a named call argument whose name does not match any
    /// parameter of the resolved callee.
    /// </summary>
    /// <param name="location">The location of the offending named argument.</param>
    /// <param name="callee">The callee name (for diagnostic context).</param>
    /// <param name="name">The argument name that did not match any parameter.</param>
    public void ReportNamedArgumentParameterNotFound(TextLocation location, string callee, string name)
    => Report(location, DiagnosticDescriptors.NamedArgumentParameterNotFound, name, callee);

    /// <summary>
    /// Issue #343: reports a named call argument whose target parameter is
    /// already supplied by a positional argument earlier in the same call.
    /// </summary>
    /// <param name="location">The location of the offending named argument.</param>
    /// <param name="name">The parameter name that was double-bound.</param>
    public void ReportNamedArgumentAlsoSpecifiedPositionally(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.NamedArgumentAlsoSpecifiedPositionally, name, name);

    /// <summary>
    /// ADR-0061: reports a conditional ref-argument expression that surfaces outside of
    /// a ref-kind modifier payload (<c>ref</c>/<c>out</c>/<c>in</c>) or an <c>&amp;</c> operand.
    /// </summary>
    /// <param name="location">The text location of the conditional expression.</param>
    public void ReportConditionalRefArgumentOutsideRefContext(TextLocation location)
    => Report(location, DiagnosticDescriptors.ConditionalRefArgumentOutsideRefContext);

    /// <summary>
    /// ADR-0061: reports that the two branches of a conditional ref-argument produce
    /// values of different (non-identical) types.
    /// </summary>
    /// <param name="location">The text location of the conditional expression.</param>
    /// <param name="trueType">The type of the true-branch lvalue.</param>
    /// <param name="falseType">The type of the false-branch lvalue.</param>
    public void ReportConditionalRefArgumentBranchTypeMismatch(TextLocation location, string trueType, string falseType)
    => Report(location, DiagnosticDescriptors.ConditionalRefArgumentBranchTypeMismatch, trueType, falseType);

    /// <summary>
    /// ADR-0061: reports an inline-declaration (<c>out var</c>/<c>out let</c>/<c>out _</c>)
    /// appearing inside a branch of a conditional ref-argument. A new local declared on
    /// only one branch is semantically incoherent.
    /// </summary>
    /// <param name="location">The text location of the offending inline declaration.</param>
    public void ReportInlineDeclarationInConditionalRefBranch(TextLocation location)
    => Report(location, DiagnosticDescriptors.InlineDeclarationInConditionalRefBranch);

    /// <summary>
    /// ADR-0061: reports an inner ref-kind modifier on a conditional ref-argument branch
    /// that does not match the outer modifier.
    /// </summary>
    /// <param name="location">The text location of the offending inner modifier.</param>
    /// <param name="outerModifier">The outer modifier text (<c>ref</c>/<c>out</c>/<c>in</c>).</param>
    /// <param name="innerModifier">The inner modifier text observed.</param>
    public void ReportConditionalRefArgumentInnerModifierMismatch(TextLocation location, string outerModifier, string innerModifier)
    => Report(location, DiagnosticDescriptors.ConditionalRefArgumentInnerModifierMismatch, innerModifier, outerModifier);

    /// <summary>
    /// ADR-0062: reports a general two-arm conditional whose branch types have no
    /// common result type under the conditional's common-type selection rules.
    /// </summary>
    /// <param name="location">The text location of the conditional expression.</param>
    /// <param name="trueType">The type of the true-branch expression.</param>
    /// <param name="falseType">The type of the false-branch expression.</param>
    public void ReportConditionalNoCommonResultType(TextLocation location, string trueType, string falseType)
    => Report(location, DiagnosticDescriptors.ConditionalNoCommonResultType, trueType, falseType);

    /// <summary>
    /// ADR-0063 §6: reports a call whose argument list matches more than one applicable
    /// overload after generic inference, conversion, optional-parameter ranking, and the
    /// "fewest expanded defaults" tie-break.
    /// </summary>
    /// <param name="location">The call-site location.</param>
    /// <param name="name">The callable name.</param>
    public void ReportAmbiguousOverloadResolution(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.AmbiguousOverloadResolution, name);

    /// <summary>
    /// ADR-0063 §6: reports a call to a name that resolves to an overload set, but
    /// no overload is applicable to the given argument list (after applying defaults
    /// and named-argument reordering).
    /// </summary>
    /// <param name="location">The call-site location.</param>
    /// <param name="name">The callable name.</param>
    public void ReportNoApplicableOverload(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.NoApplicableOverload, name);

    /// <summary>
    /// Issue #575: the <c>as</c> operator requires the target type to be either a
    /// reference type or a nullable value type (<c>T?</c>). A non-nullable value
    /// type is rejected because <c>as</c> must be able to yield <c>null</c> on failure.
    /// </summary>
    /// <param name="location">The expression location.</param>
    /// <param name="typeName">The non-nullable value type name.</param>
    public void ReportAsRequiresReferenceOrNullableType(TextLocation location, string typeName)
    => Report(location, DiagnosticDescriptors.AsRequiresReferenceOrNullableType, typeName, typeName);

    /// <summary>
    /// Reports that <c>nil</c> was supplied as an attribute argument for a
    /// parameter whose type is not nullable. The user should make the
    /// corresponding parameter nullable (e.g. <c>string?</c> instead of
    /// <c>string</c>).
    /// </summary>
    /// <param name="location">The source location of the <c>nil</c> literal.</param>
    /// <param name="parameterName">The name of the target method parameter.</param>
    /// <param name="typeName">The non-nullable type name.</param>
    public void ReportNilNotAssignableToNonNullableParameter(TextLocation location, string parameterName, string typeName)
    => Report(location, DiagnosticDescriptors.NilNotAssignableToNonNullableParameter, parameterName, typeName, typeName);

    /// <summary>
    /// GS0275: Calling <c>.GetAwaiter().GetResult()</c> directly on a <c>ValueTask</c>/<c>ValueTask&lt;T&gt;</c>
    /// is unsafe due to its single-await semantics.
    /// </summary>
    /// <param name="location">The source location of the <c>.GetResult()</c> call.</param>
    public void ReportValueTaskDirectGetResult(TextLocation location)
    => Report(location, DiagnosticDescriptors.ValueTaskDirectGetResult);

    /// <summary>
    /// GS0276: An if-expression used in value position has no <c>else</c> branch.
    /// Without an else, the expression cannot produce a value for all code paths.
    /// </summary>
    /// <param name="location">The source location of the <c>if</c> keyword.</param>
    public void ReportIfExpressionMissingElse(TextLocation location)
    => Report(location, DiagnosticDescriptors.IfExpressionMissingElse);

    /// <summary>
    /// GS0277: A block in an if-expression value position has no trailing
    /// value-producing expression.
    /// </summary>
    /// <param name="location">The source location of the block's closing brace.</param>
    public void ReportBlockExpressionMissingTrailingExpression(TextLocation location)
    => Report(location, DiagnosticDescriptors.BlockExpressionMissingTrailingExpression);

    /// <summary>
    /// ADR-0072 / issue #709: GS0298 — the left-hand side of a
    /// null-coalescing compound assignment <c>??=</c> must be of nullable
    /// type. The operator only fills the slot when it currently reads as
    /// nil, so a non-nullable target is necessarily a no-op (and almost
    /// always a programmer error).
    /// </summary>
    /// <param name="location">The source location of the offending operator.</param>
    /// <param name="actualType">The actual (non-nullable) left-hand-side type.</param>
    public void ReportNullCoalescingAssignmentTargetNotNullable(TextLocation location, TypeSymbol actualType)
    => Report(location, DiagnosticDescriptors.NullCoalescingAssignmentTargetNotNullable, actualType, actualType);

    /// <summary>
    /// ADR-0072 / issue #709: GS0299 — the left-hand side of a
    /// null-coalescing compound assignment <c>??=</c> is not a supported
    /// assignable form. Accepted shapes are a local or parameter, an
    /// implicit field/property on <c>this</c>, a member field/property
    /// access (<c>obj.member</c>), or an indexer access (<c>obj[i]</c>).
    /// </summary>
    /// <param name="location">The source location of the offending operator.</param>
    public void ReportNullCoalescingAssignmentInvalidTarget(TextLocation location)
    => Report(location, DiagnosticDescriptors.NullCoalescingAssignmentInvalidTarget);

    /// <summary>
    /// ADR-0073 / issue #710: GS0300 (warning) — the receiver of a
    /// null-conditional index access <c>a?[i]</c> is not of nullable type,
    /// so the null-check is dead code. Suggest the plain <c>a[i]</c> form
    /// to make the author's intent obvious.
    /// </summary>
    /// <param name="location">The source location of the offending operator.</param>
    /// <param name="actualType">The actual (non-nullable) receiver type.</param>
    public void ReportNullConditionalIndexReceiverNotNullable(TextLocation location, TypeSymbol actualType)
    => Report(location, DiagnosticDescriptors.NullConditionalIndexReceiverNotNullable, actualType);

    /// <summary>
    /// ADR-0073 / issue #710: GS0301 — the null-conditional index access
    /// <c>a?[i]</c> cannot appear on the left-hand side of an assignment
    /// (matching C#'s CS0131 behavior). The author probably meant
    /// <c>if a != nil { a[i] = v }</c> or simply <c>a[i] = v</c> when the
    /// receiver is known to be non-nil.
    /// </summary>
    /// <param name="location">The source location of the offending operator.</param>
    public void ReportNullConditionalIndexAssignmentTarget(TextLocation location)
    => Report(location, DiagnosticDescriptors.NullConditionalIndexAssignmentTarget);

    /// <summary>
    /// ADR-0076 / issue #716: GS0304 — an arrow-lambda binding cannot resolve
    /// its parameter type because neither side of the binding supplies one.
    /// The lambda parameter has no explicit type clause AND there is no target
    /// type (e.g. an explicit binding type, or a target-typed conversion
    /// context) to infer it from. Either type the parameter
    /// (<c>(p int32) -&gt; body</c>) or give the binding an explicit
    /// function type (<c>let f (int32) -&gt; R = (p) -&gt; body</c>).
    /// </summary>
    /// <param name="location">The source location of the untyped parameter.</param>
    /// <param name="parameterName">The name of the untyped lambda parameter.</param>
    public void ReportLambdaBindingTypeCannotBeInferred(TextLocation location, string parameterName)
    => Report(location, DiagnosticDescriptors.LambdaBindingTypeCannotBeInferred, parameterName, parameterName);

    /// <summary>Reports GS0497 for an async iterator function literal, whose state-machine synthesis is unsupported.</summary>
    /// <param name="location">The function literal's source location.</param>
    /// <param name="returnType">The unsupported async-iterator return type.</param>
    public void ReportAsyncIteratorFunctionLiteralNotSupported(TextLocation location, TypeSymbol returnType)
    => Report(location, DiagnosticDescriptors.AsyncIteratorFunctionLiteralNotSupported, returnType);

    /// <summary>
    /// Reports GS0362 — ADR-0100 / issue #795: a bare <c>default</c>
    /// literal appears in a position where no target type can be
    /// inferred. The bare form is only valid in target-typed positions:
    /// the initializer of a <c>let</c>/<c>var</c>/<c>const</c> binding
    /// that names a type, the operand of <c>return</c> when the
    /// enclosing function's return type is known, an argument to a
    /// typed parameter, or a branch of a <c>?:</c> typed by the sibling
    /// branch. Outside these contexts, write the explicit form
    /// <c>default(T)</c>.
    /// </summary>
    /// <param name="location">The offending bare-<c>default</c> location.</param>
    public void ReportBareDefaultNoTargetType(TextLocation location)
    => Report(location, DiagnosticDescriptors.BareDefaultNoTargetType);

    /// <summary>
    /// Reports GS0333 — ADR-0089 / issue #755: the dispatch expression
    /// <c>T.Member(...)</c> where <c>T</c> is a generic type parameter
    /// constrained to some interface(s) refers to a name that is not a
    /// static-virtual member on any of those interfaces.
    /// </summary>
    /// <param name="location">The accessor expression location.</param>
    /// <param name="typeParameterName">The type parameter name.</param>
    /// <param name="memberName">The looked-up static member name.</param>
    public void ReportStaticVirtualMemberNotFoundOnTypeParameter(
        TextLocation location,
        string typeParameterName,
        string memberName)
    => Report(location, DiagnosticDescriptors.StaticVirtualMemberNotFoundOnTypeParameter, typeParameterName, memberName);

    /// <summary>
    /// ADR-0090 / issue #756: GS0334 — external code attempted to call a
    /// <c>private</c> helper on an interface from outside the interface's
    /// own declaration. The helper is part of the interface's
    /// implementation, not its contract; only sibling members may call it.
    /// </summary>
    /// <param name="location">The offending call expression location.</param>
    /// <param name="interfaceName">The owning interface's display name.</param>
    /// <param name="methodName">The private helper's name.</param>
    public void ReportPrivateInterfaceMemberNotAccessible(
        TextLocation location,
        string interfaceName,
        string methodName)
    => Report(location, DiagnosticDescriptors.PrivateInterfaceMemberNotAccessible, interfaceName, methodName);

    /// <summary>
    /// ADR-0091 / issue #757: GS0338 — a <c>base[IFoo].M(...)</c> call
    /// expression refers to an interface that is not in the enclosing
    /// type's implemented-interface set, or the call appears outside any
    /// instance member of a user-declared class/struct.
    /// </summary>
    /// <param name="location">The source location of the offending expression.</param>
    /// <param name="enclosingTypeName">The display name of the enclosing class/struct, or a placeholder for non-member contexts.</param>
    /// <param name="interfaceName">The interface name as it appears in <c>base[…]</c>.</param>
    public void ReportBaseInterfaceCallTypeDoesNotImplementInterface(
        TextLocation location,
        string enclosingTypeName,
        string interfaceName)
    => Report(location, DiagnosticDescriptors.BaseInterfaceCallTypeDoesNotImplementInterface, interfaceName, enclosingTypeName, interfaceName);

    /// <summary>
    /// ADR-0091 / issue #757: GS0339 — a <c>base[IFoo].M(...)</c> call
    /// expression names a member <c>M</c> that does not exist on
    /// <c>IFoo</c>.
    /// </summary>
    /// <param name="location">The source location of the method identifier.</param>
    /// <param name="interfaceName">The interface that lacks the member.</param>
    /// <param name="methodName">The missing member name.</param>
    public void ReportBaseInterfaceCallMemberNotFound(
        TextLocation location,
        string interfaceName,
        string methodName)
    => Report(location, DiagnosticDescriptors.BaseInterfaceCallMemberNotFound, interfaceName, methodName);

    /// <summary>
    /// ADR-0091 / issue #757: GS0340 — a <c>base[IFoo].M(...)</c> call
    /// expression refers to an interface member that <em>is</em> declared
    /// on <c>IFoo</c> but is abstract (no default body); there is nothing
    /// to delegate to.
    /// </summary>
    /// <param name="location">The source location of the method identifier.</param>
    /// <param name="interfaceName">The interface name.</param>
    /// <param name="methodName">The abstract member name.</param>
    public void ReportBaseInterfaceCallMemberIsAbstract(
        TextLocation location,
        string interfaceName,
        string methodName)
    => Report(location, DiagnosticDescriptors.BaseInterfaceCallMemberIsAbstract, interfaceName, methodName, interfaceName);

    /// <summary>
    /// ADR-0091 / issue #757: GS0341 — a <c>base[IFoo].M(...)</c> call
    /// expression targets a <c>private</c> helper on <c>IFoo</c>. Private
    /// interface helpers (ADR-0090) are intentionally invisible to
    /// implementers; the explicit-base call form does not bypass that
    /// restriction.
    /// </summary>
    /// <param name="location">The source location of the method identifier.</param>
    /// <param name="interfaceName">The owning interface name.</param>
    /// <param name="methodName">The private helper name.</param>
    public void ReportBaseInterfaceCallTargetsPrivateHelper(
        TextLocation location,
        string interfaceName,
        string methodName)
    => Report(location, DiagnosticDescriptors.BaseInterfaceCallTargetsPrivateHelper, interfaceName, methodName, interfaceName, methodName);

    /// <summary>
    /// Issue #986: GS0383 — a <c>base.M(...)</c> (or
    /// <c>base[BaseClass].M(...)</c>) call appears outside an instance member
    /// of a class, so there is no <c>base</c> to delegate to. Fires for
    /// top-level functions, <c>shared</c> statics, and structs (which have no
    /// base class). Issue #1260: a class deriving only from <c>System.Object</c>
    /// (or another imported/BCL base) no longer fires this — those inherited
    /// members are reachable via <c>base</c> — and a missing member is reported
    /// as GS0384 instead.
    /// </summary>
    /// <param name="location">The source location of the offending <c>base</c> expression.</param>
    /// <param name="enclosingTypeName">The display name of the enclosing type, or a placeholder for non-member contexts.</param>
    public void ReportBaseClassCallHasNoBaseClass(
        TextLocation location,
        string enclosingTypeName)
    => Report(location, DiagnosticDescriptors.BaseClassCallHasNoBaseClass, enclosingTypeName);

    /// <summary>
    /// Issue #986: GS0384 — a <c>base.M(...)</c> (or
    /// <c>base[BaseClass].M(...)</c>) call names a member <c>M</c> that does
    /// not exist on any base class of the enclosing type.
    /// </summary>
    /// <param name="location">The source location of the method identifier.</param>
    /// <param name="baseTypeName">The nearest base class searched.</param>
    /// <param name="methodName">The missing member name.</param>
    public void ReportBaseClassCallMemberNotFound(
        TextLocation location,
        string baseTypeName,
        string methodName)
    => Report(location, DiagnosticDescriptors.BaseClassCallMemberNotFound, baseTypeName, methodName);

    /// <summary>
    /// Issue #986: GS0385 — a <c>base[Type].M(...)</c> call names a
    /// <c>Type</c> in the brackets that is not the enclosing type's actual
    /// base class.
    /// </summary>
    /// <param name="location">The source location of the bracketed type clause.</param>
    /// <param name="enclosingTypeName">The display name of the enclosing class.</param>
    /// <param name="selectorTypeName">The type named in the brackets.</param>
    public void ReportBaseClassCallSelectorNotBaseClass(
        TextLocation location,
        string enclosingTypeName,
        string selectorTypeName)
    => Report(location, DiagnosticDescriptors.BaseClassCallSelectorNotBaseClass, selectorTypeName, selectorTypeName, enclosingTypeName);

    /// <summary>
    /// Issue #1260: GS0413 — a <c>base.M(...)</c> (or <c>base.Prop</c>) access
    /// targets an <c>abstract</c> member of an imported/BCL base class that has
    /// no base implementation to delegate to (e.g. <c>base.Read(...)</c> where
    /// <c>System.IO.Stream.Read(byte[],int,int)</c> is abstract). Mirrors C#'s
    /// CS0205 ("cannot call an abstract base member").
    /// </summary>
    /// <param name="location">The source location of the offending member identifier.</param>
    /// <param name="baseTypeName">The imported base type that declares the abstract member.</param>
    /// <param name="memberName">The abstract member's name.</param>
    public void ReportBaseClassCallAbstractMember(
        TextLocation location,
        string baseTypeName,
        string memberName)
    => Report(location, DiagnosticDescriptors.BaseClassCallAbstractMember, baseTypeName, memberName);

    /// <summary>
    /// Issue #1201: GS0414 — an unqualified reference to a <c>shared</c>
    /// (static) member that is exposed by two or more types imported via
    /// <c>import Ns.Type</c> (the G# spelling of C#'s <c>using static</c>).
    /// Mirrors C#'s CS0121 ambiguity for using-static members: the reference is
    /// only an error when it is actually used and more than one imported type
    /// contributes a member of that name. Qualify the reference with the owning
    /// type name (<c>Type.Member</c>) to disambiguate.
    /// </summary>
    /// <param name="location">The source location of the ambiguous member identifier.</param>
    /// <param name="name">The ambiguous member name.</param>
    public void ReportAmbiguousImportedStaticMember(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.AmbiguousImportedStaticMember, name);

    /// <summary>
    /// Issue #2012 (N3): an explicit-arity open-generic <c>typeof(Name[_,
    /// ...])</c> whose base name + requested arity (e.g. <c>Func`1</c>)
    /// resolves to two or more DIFFERENT CLR types across the imports in
    /// scope. Distinct from <see cref="ReportUndefinedType"/> (which means no
    /// type matched at all): here at least two imports each contribute a
    /// candidate and they disagree, so the previous behavior of reporting
    /// "type doesn't exist" was a misleading diagnostic for a genuinely
    /// different failure mode (nothing was undefined — too many things were
    /// defined). Mirrors the wording of <see cref="ReportAmbiguousImportedStaticMember"/>
    /// (#1201) for the analogous ambiguous-import-member case.
    /// </summary>
    /// <param name="location">The source location of the ambiguous type reference.</param>
    /// <param name="name">The ambiguous arity-suffixed type name (e.g. <c>Func`1</c>).</param>
    public void ReportAmbiguousImportedType(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.AmbiguousImportedType, name);

    /// <summary>
    /// ADR-0146 / issue #2243: GS0485 — an anonymous-object literal
    /// (<c>object { ... }</c> / <c>data object { ... }</c>) declared an
    /// <c>init</c> or <c>deinit</c> member. Anonymous objects support fields,
    /// methods, and events only; constructors and destructors are not allowed.
    /// </summary>
    /// <param name="location">The source location of the offending <c>init</c>/<c>deinit</c> keyword.</param>
    /// <param name="memberKeyword">The rejected member keyword spelling (<c>init</c> or <c>deinit</c>).</param>
    public void ReportInitDeinitNotAllowedInAnonymousObject(TextLocation location, string memberKeyword)
    => Report(location, DiagnosticDescriptors.InitDeinitNotAllowedInAnonymousObject, memberKeyword);

    /// <summary>
    /// ADR-0146 / issue #2243: GS0486 — a field member of a "rich"
    /// anonymous object (one with a base/interface clause, method, or event)
    /// omitted its type annotation. Rich anonymous objects materialize fields
    /// as ordinary class fields, which require an explicit type; type
    /// inference from the initializer is only available on the field-only
    /// <c>object { ... }</c> / <c>data object { ... }</c> forms.
    /// </summary>
    /// <param name="location">The source location of the offending field name.</param>
    /// <param name="fieldName">The field member's name.</param>
    public void ReportInferredFieldTypeNotAllowedInRichAnonymousObject(TextLocation location, string fieldName)
    => Report(location, DiagnosticDescriptors.InferredFieldTypeNotAllowedInRichAnonymousObject, fieldName);

    /// <summary>
    /// Issue #987: GS0386 — an attempt to construct (instantiate) an abstract
    /// class. A class is abstract when it declares (or inherits without
    /// overriding) an abstract method — a no-body <c>open func F() R;</c>. Like
    /// C#'s CS0144, this is a clean compile-time error rather than a runtime
    /// <c>MemberAccessException</c>.
    /// </summary>
    /// <param name="location">The source location of the construction expression.</param>
    /// <param name="typeName">The display name of the abstract type.</param>
    public void ReportCannotInstantiateAbstractType(TextLocation location, string typeName)
    => Report(location, DiagnosticDescriptors.CannotInstantiateAbstractType, typeName);

    /// <summary>
    /// Reports GS0369 — issue #479 / ADR-0117: a collection initializer
    /// (<c>Type[…]{ elements }</c>) was applied to a target type that is not a
    /// collection — it exposes no accessible instance <c>Add</c> method (for a
    /// bare element or <c>key: value</c> entry) nor a settable indexer (for an
    /// <c>[key] = value</c> entry). Use an object initializer
    /// (<c>Type(){ Prop = value }</c>) for property/field initialization, or
    /// construct a list/set/dictionary type that supports <c>Add</c>.
    /// </summary>
    /// <param name="location">The source location of the initializer.</param>
    /// <param name="type">The non-collection target type.</param>
    public void ReportTypeNotCollectionInitializable(TextLocation location, TypeSymbol type)
    => Report(location, DiagnosticDescriptors.TypeNotCollectionInitializable, type);

    /// <summary>
    /// Issue #988: GS0389 — a type parameter is constructed (<c>T()</c>) but it
    /// carries no <c>init()</c> default-constructor constraint, so the compiler
    /// cannot guarantee an accessible parameterless constructor exists. Mirrors
    /// C#'s CS0304. The fix is to add an <c>init()</c> constraint to the type
    /// parameter (e.g. <c>[T init()]</c>). (Constraint keyword renamed from
    /// <c>new()</c> to <c>init()</c> by issue #997.)
    /// </summary>
    /// <param name="location">The source location of the constructing identifier.</param>
    /// <param name="typeParameterName">The name of the type parameter being constructed.</param>
    public void ReportConstructedTypeParameterRequiresNewConstraint(
        TextLocation location,
        string typeParameterName)
    => Report(location, DiagnosticDescriptors.ConstructedTypeParameterRequiresNewConstraint, typeParameterName, typeParameterName, typeParameterName);
}
