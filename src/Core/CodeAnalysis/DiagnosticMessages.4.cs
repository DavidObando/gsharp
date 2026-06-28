// <copyright file="DiagnosticMessages.4.cs" company="GSharp">
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
    }

    /// <summary>
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

    /// <summary>
    /// ADR-0062: reports a general two-arm conditional whose branch types have no
    /// common result type under the conditional's common-type selection rules.
    /// </summary>
    /// <param name="location">The text location of the conditional expression.</param>
    /// <param name="trueType">The type of the true-branch expression.</param>
    /// <param name="falseType">The type of the false-branch expression.</param>
    public void ReportConditionalNoCommonResultType(TextLocation location, string trueType, string falseType)
    {
        Report(location, "GS0263", $"Conditional expression branches have no common result type — the true branch is '{trueType}' and the false branch is '{falseType}'. Add an explicit conversion to align the two arms.");
    }

    /// <summary>
    /// ADR-0063: reports a second user-defined callable declaration whose signature
    /// (parameter types + ref-kinds, excluding defaults and return type) duplicates an
    /// already-declared overload in the same declaration space.
    /// </summary>
    /// <param name="location">The location of the offending declaration.</param>
    /// <param name="name">The callable name.</param>
    /// <param name="signature">A short rendering of the duplicated signature.</param>
    public void ReportDuplicateOverloadSignature(TextLocation location, string name, string signature)
    {
        Report(location, "GS0264", $"An overload of '{name}' with signature '{signature}' is already declared. Two overloads must differ by parameter types or ref-kinds.");
    }

    /// <summary>
    /// ADR-0063 §3: reports an optional-parameter declaration that violates a v1
    /// restriction (non-constant default, optional <c>ref</c>/<c>out</c>/<c>in</c>, optional
    /// variadic, default on the receiver parameter, or unrepresentable constant for
    /// the parameter type).
    /// </summary>
    /// <param name="location">The location of the offending parameter clause.</param>
    /// <param name="parameterName">The parameter's source name.</param>
    /// <param name="reason">A short, user-visible reason for the rejection.</param>
    public void ReportInvalidOptionalParameter(TextLocation location, string parameterName, string reason)
    {
        Report(location, "GS0265", $"Optional parameter '{parameterName}' is invalid: {reason}");
    }

    /// <summary>
    /// ADR-0063 §6: reports a call whose argument list matches more than one applicable
    /// overload after generic inference, conversion, optional-parameter ranking, and the
    /// "fewest expanded defaults" tie-break.
    /// </summary>
    /// <param name="location">The call-site location.</param>
    /// <param name="name">The callable name.</param>
    public void ReportAmbiguousOverloadResolution(TextLocation location, string name)
    {
        Report(location, "GS0266", $"Call to '{name}' is ambiguous between multiple overloads. Disambiguate with explicit types or named arguments.");
    }

    /// <summary>
    /// ADR-0063 §6: reports a call to a name that resolves to an overload set, but
    /// no overload is applicable to the given argument list (after applying defaults
    /// and named-argument reordering).
    /// </summary>
    /// <param name="location">The call-site location.</param>
    /// <param name="name">The callable name.</param>
    public void ReportNoApplicableOverload(TextLocation location, string name)
    {
        Report(location, "GS0267", $"No overload of '{name}' is applicable to the given argument list.");
    }

    /// <summary>
    /// Reports that a <c>for x in expr</c> loop cannot be lowered because the
    /// collection type does not expose a usable <c>GetEnumerator()</c> method.
    /// </summary>
    /// <param name="location">The collection expression location.</param>
    /// <param name="type">The collection type.</param>
    public void ReportTypeNotIterable(TextLocation location, TypeSymbol type)
    {
        var message = $"Type '{type.Name}' does not implement a usable 'GetEnumerator()' method and cannot be iterated with 'for ... in'.";
        Report(location, "GS0268", message);
    }

    /// <summary>
    /// Issue #575: the <c>as</c> operator requires the target type to be either a
    /// reference type or a nullable value type (<c>T?</c>). A non-nullable value
    /// type is rejected because <c>as</c> must be able to yield <c>null</c> on failure.
    /// </summary>
    /// <param name="location">The expression location.</param>
    /// <param name="typeName">The non-nullable value type name.</param>
    public void ReportAsRequiresReferenceOrNullableType(TextLocation location, string typeName)
    {
        Report(location, "GS0270", $"The 'as' operator requires the target type to be a reference type or a nullable value type, but '{typeName}' is a non-nullable value type. Use 'as {typeName}?' instead.");
    }

    /// <summary>
    /// Reports that <c>await using let</c> appears outside an <c>async</c> function.
    /// </summary>
    /// <param name="location">The text location of the <c>await</c> keyword.</param>
    public void ReportAwaitUsingOutsideAsyncFunction(TextLocation location)
    {
        Report(location, "GS0271", "'await using let' can only be used inside an 'async func'.");
    }

    /// <summary>
    /// Reports that a type used in an <c>await using</c> declaration does not implement IAsyncDisposable.
    /// </summary>
    /// <param name="location">The text location of the await using keyword.</param>
    /// <param name="type">The non-async-disposable type.</param>
    public void ReportTypeNotAsyncDisposable(TextLocation location, TypeSymbol type)
    {
        Report(location, "GS0272", $"Type '{type.Name}' cannot be used in an 'await using' statement because it does not provide a public DisposeAsync() method returning ValueTask.");
    }

    /// <summary>
    /// Reports that the identifier <c>null</c> was used where the G# null
    /// literal <c>nil</c> is required. G# does not recognise <c>null</c> as
    /// a keyword — the correct spelling is <c>nil</c> (ADR-0081).
    /// </summary>
    /// <param name="location">The source location of the <c>null</c> identifier.</param>
    public void ReportUseNilInsteadOfNull(TextLocation location)
    {
        Report(location, "GS0273", "'null' is not a literal in G#. Did you mean 'nil'?");
    }

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
    {
        Report(location, "GS0274", $"'nil' cannot be assigned to parameter '{parameterName}' of non-nullable type '{typeName}'; consider changing the parameter type to '{typeName}?'.");
    }

    /// <summary>
    /// GS0275: Calling <c>.GetAwaiter().GetResult()</c> directly on a <c>ValueTask</c>/<c>ValueTask&lt;T&gt;</c>
    /// is unsafe due to its single-await semantics.
    /// </summary>
    /// <param name="location">The source location of the <c>.GetResult()</c> call.</param>
    public void ReportValueTaskDirectGetResult(TextLocation location)
    {
        Report(
            location,
            "GS0275",
            "Calling '.GetAwaiter().GetResult()' directly on a ValueTask/ValueTask<T> is unsafe due to its single-await semantics. Convert to Task first via '.AsTask()' (e.g. 'v.AsTask().GetAwaiter().GetResult()').",
            DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// GS0276: An if-expression used in value position has no <c>else</c> branch.
    /// Without an else, the expression cannot produce a value for all code paths.
    /// </summary>
    /// <param name="location">The source location of the <c>if</c> keyword.</param>
    public void ReportIfExpressionMissingElse(TextLocation location)
    {
        Report(location, "GS0276", "An if-expression in value position must have an 'else' branch so that all code paths produce a value.");
    }

    /// <summary>
    /// GS0277: A block in an if-expression value position has no trailing
    /// value-producing expression.
    /// </summary>
    /// <param name="location">The source location of the block's closing brace.</param>
    public void ReportBlockExpressionMissingTrailingExpression(TextLocation location)
    {
        Report(location, "GS0277", "A block in an if-expression value position must end with a value-producing expression.");
    }

    /// <summary>
    /// ADR-0065 §2: GS0278 — a <c>convenience init</c> body must begin with a
    /// self-delegation <c>init(args)</c> call.
    /// </summary>
    /// <param name="location">The source location of the convenience init declaration.</param>
    /// <param name="className">The owning class.</param>
    public void ReportConvenienceInitMustDelegate(TextLocation location, string className)
    {
        Report(location, "GS0278", $"Convenience initializer on class '{className}' must delegate to another initializer via 'init(args)' before any other statement.");
    }

    /// <summary>
    /// ADR-0065 §2: GS0279 — a <c>convenience init</c> may not declare an
    /// explicit <c>: base(args)</c> clause; convenience initializers must
    /// chain to another initializer in the same class, which transitively
    /// reaches a designated initializer that performs the base call.
    /// </summary>
    /// <param name="location">The source location of the <c>: base</c> clause.</param>
    /// <param name="className">The owning class.</param>
    public void ReportConvenienceInitMayNotCallBase(TextLocation location, string className)
    {
        Report(location, "GS0279", $"Convenience initializer on class '{className}' may not declare ': base(args)'; chain to another initializer with 'init(args)' instead.");
    }

    /// <summary>
    /// ADR-0065 §2: GS0280 — <c>init(args)</c> self-delegation only appears
    /// inside a constructor body of a class.
    /// </summary>
    /// <param name="location">The source location of the self-delegation call.</param>
    public void ReportInitDelegationOutsideCtor(TextLocation location)
    {
        Report(location, "GS0280", "'init(args)' constructor self-delegation is only valid inside a class constructor body.");
    }

    /// <summary>
    /// ADR-0065 §2: GS0281 — <c>init(args)</c> self-delegation is only legal
    /// inside a <c>convenience init</c>; designated initializers must chain
    /// to the base class with <c>: base(args)</c> instead.
    /// </summary>
    /// <param name="location">The source location of the self-delegation call.</param>
    /// <param name="className">The owning class.</param>
    public void ReportInitDelegationFromDesignated(TextLocation location, string className)
    {
        Report(location, "GS0281", $"Designated initializer on class '{className}' may not delegate to a sibling 'init(args)' overload; use ': base(args)' (or omit it) to chain to the base class.");
    }

    /// <summary>
    /// ADR-0065 §2: GS0282 — <c>init(args)</c> self-delegation must target a
    /// different constructor than the one being executed; recursive delegation
    /// would loop indefinitely.
    /// </summary>
    /// <param name="location">The source location of the self-delegation call.</param>
    /// <param name="className">The owning class.</param>
    public void ReportInitDelegationRecursive(TextLocation location, string className)
    {
        Report(location, "GS0282", $"Convenience initializer on class '{className}' may not delegate to itself; choose a different 'init(args)' overload.");
    }

    /// <summary>
    /// ADR-0065 §2: GS0283 — overload resolution found no matching sibling
    /// initializer for an <c>init(args)</c> self-delegation call.
    /// </summary>
    /// <param name="location">The source location of the self-delegation call.</param>
    /// <param name="className">The owning class.</param>
    public void ReportInitDelegationNoMatch(TextLocation location, string className)
    {
        Report(location, "GS0283", $"No applicable 'init(...)' overload on class '{className}' matches the arguments of this 'init(args)' self-delegation.");
    }

    /// <summary>
    /// ADR-0065 §5: GS0284 — a user-declared <c>init(...)</c> overload has the
    /// same signature as the constructor synthesized from the class's primary
    /// constructor parameter list.
    /// </summary>
    /// <param name="location">The source location of the offending <c>init</c> declaration.</param>
    /// <param name="className">The owning class.</param>
    /// <param name="signature">The signature description.</param>
    public void ReportInitDuplicatesPrimaryCtor(TextLocation location, string className, string signature)
    {
        Report(location, "GS0284", $"'init({signature})' on class '{className}' duplicates the synthesized primary-constructor overload; remove either the primary-constructor parameter list or this 'init' declaration.");
    }

    /// <summary>
    /// ADR-0070 / issue #707: GS0293 — a labeled <c>break</c> or <c>continue</c>
    /// names a loop that is not in scope.
    /// </summary>
    /// <param name="location">The source location of the offending label identifier.</param>
    /// <param name="keyword">The originating keyword (<c>break</c> or <c>continue</c>).</param>
    /// <param name="labelName">The unresolved label name.</param>
    public void ReportUnknownLoopLabel(TextLocation location, string keyword, string labelName)
    {
        Report(location, "GS0293", $"No enclosing loop is labeled '{labelName}' (in '{keyword} {labelName}').");
    }

    /// <summary>
    /// ADR-0070 / issue #707: GS0294 — a label prefix (<c>name:</c>) was
    /// applied to a statement that is not a loop. Only loops may carry a
    /// loop label.
    /// </summary>
    /// <param name="location">The source location of the offending label identifier.</param>
    /// <param name="labelName">The label name.</param>
    public void ReportLabelOnNonLoopStatement(TextLocation location, string labelName)
    {
        Report(location, "GS0294", $"Label '{labelName}' can only be applied to a loop statement (for / while / do-while).");
    }

    /// <summary>
    /// ADR-0070 / issue #707: GS0295 (warning) — a loop label shadows an
    /// enclosing live loop label of the same name. The inner label wins for
    /// nested <c>break</c> / <c>continue</c> resolution.
    /// </summary>
    /// <param name="location">The source location of the offending label identifier.</param>
    /// <param name="labelName">The shadowed label name.</param>
    public void ReportLabelShadowsEnclosingLoop(TextLocation location, string labelName)
    {
        Report(location, "GS0295", $"Label '{labelName}' shadows an enclosing loop label of the same name; the inner label wins for nested 'break'/'continue'.", DiagnosticSeverity.Warning);
    }

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
    {
        Report(location, "GS0296", $"The right-hand side of 'if let'/'guard let' binding '{bindingName}' must be of nullable type, but its type is '{actualType}'. Use a plain 'let {bindingName} = …' if no nullability strip is needed.");
    }

    /// <summary>
    /// ADR-0071 / issue #708: GS0297 — the else block of a <c>guard let</c>
    /// statement must unconditionally exit the enclosing scope. Accepted
    /// terminators are <c>return</c>, <c>throw</c>, <c>break</c>,
    /// <c>continue</c>, and any block whose last statement does so. An
    /// <c>if</c>/<c>else</c> qualifies only when both arms exit.
    /// </summary>
    /// <param name="location">The source location of the offending else clause.</param>
    public void ReportGuardLetElseMustExit(TextLocation location)
    {
        Report(location, "GS0297", "The else block of 'guard let' must unconditionally exit the enclosing scope (return, throw, break, or continue).");
    }

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
    {
        Report(location, "GS0298", $"The left-hand side of '??=' must be of nullable type, but its type is '{actualType}'. Either declare the target as '{actualType}?' or use a plain assignment.");
    }

    /// <summary>
    /// ADR-0072 / issue #709: GS0299 — the left-hand side of a
    /// null-coalescing compound assignment <c>??=</c> is not a supported
    /// assignable form. Accepted shapes are a local or parameter, an
    /// implicit field/property on <c>this</c>, a member field/property
    /// access (<c>obj.member</c>), or an indexer access (<c>obj[i]</c>).
    /// </summary>
    /// <param name="location">The source location of the offending operator.</param>
    public void ReportNullCoalescingAssignmentInvalidTarget(TextLocation location)
    {
        Report(location, "GS0299", "The left-hand side of '??=' must be assignable: a variable, parameter, field, property, or indexer.");
    }

    /// <summary>
    /// ADR-0073 / issue #710: GS0300 (warning) — the receiver of a
    /// null-conditional index access <c>a?[i]</c> is not of nullable type,
    /// so the null-check is dead code. Suggest the plain <c>a[i]</c> form
    /// to make the author's intent obvious.
    /// </summary>
    /// <param name="location">The source location of the offending operator.</param>
    /// <param name="actualType">The actual (non-nullable) receiver type.</param>
    public void ReportNullConditionalIndexReceiverNotNullable(TextLocation location, TypeSymbol actualType)
    {
        Report(location, "GS0300", $"The receiver of '?[...]' is of non-nullable type '{actualType}'. Use '[...]' instead.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0073 / issue #710: GS0301 — the null-conditional index access
    /// <c>a?[i]</c> cannot appear on the left-hand side of an assignment
    /// (matching C#'s CS0131 behavior). The author probably meant
    /// <c>if a != nil { a[i] = v }</c> or simply <c>a[i] = v</c> when the
    /// receiver is known to be non-nil.
    /// </summary>
    /// <param name="location">The source location of the offending operator.</param>
    public void ReportNullConditionalIndexAssignmentTarget(TextLocation location)
    {
        Report(location, "GS0301", "The null-conditional index access '?[...]' cannot appear on the left-hand side of an assignment. Guard the receiver explicitly (e.g. 'if a != nil { a[i] = v }') or use '[...]' when the receiver is known to be non-nil.");
    }

    /// <summary>
    /// ADR-0074 / issue #714: GS0302 (warning) — a switch-expression arm
    /// used the deprecated <c>-&gt;</c> separator. The token is being
    /// repurposed as the lambda-expression arrow; arms should use <c>:</c>.
    /// One release of overlap is provided; the <c>-&gt;</c> form is removed
    /// in a later release.
    /// </summary>
    /// <param name="location">The source location of the offending <c>-&gt;</c> token.</param>
    public void ReportSwitchExpressionArmArrowDeprecated(TextLocation location)
    {
        Report(location, "GS0302", "'->' in a switch-expression arm is deprecated; use ':' instead (ADR-0074).", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0075 / issue #715: GS0303 (warning) — a type-clause slot used the
    /// legacy <c>func(T1, T2, ...) R</c> spelling. The canonical form is the
    /// arrow function type <c>(T1, T2, ...) -&gt; R</c> (Kotlin/Swift style).
    /// Both forms are accepted for one release; the legacy form is removed in
    /// a later release.
    /// </summary>
    /// <param name="location">The source location of the offending <c>func</c> keyword.</param>
    public void ReportFunctionTypeClauseFuncKeywordDeprecated(TextLocation location)
    {
        Report(location, "GS0303", "'func(...)' as a type clause is deprecated; use the arrow form '(...) -> R' instead (ADR-0075).", DiagnosticSeverity.Warning);
    }

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
    {
        Report(location, "GS0304", $"Cannot infer the type of lambda parameter '{parameterName}'. The parameter has no explicit type and no target type is available; either add a type (e.g. '({parameterName} int32) -> ...') or declare the binding with an explicit function type (e.g. 'let f (int32) -> R = ...').", DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0077 / issue #717: GS0305 — the legacy short variable-declaration
    /// operator <c>:=</c> has been removed. Every binding site must spell
    /// <c>let name = expr</c> (immutable) or <c>var name = expr</c> (mutable).
    /// The lexer continues to tokenise <c>:=</c> so the parser can emit a
    /// single high-quality diagnostic at the offending token rather than
    /// cascading parse errors.
    /// </summary>
    /// <param name="location">The source location of the offending <c>:=</c> token.</param>
    /// <param name="migration">A context-specific replacement snippet
    /// (e.g. <c>let x = 1</c> or <c>var x = 1</c>) shown in the message.</param>
    public void ReportColonEqualsRemoved(TextLocation location, string migration)
    {
        Report(location, "GS0305", $"':=' short variable declaration has been removed; use 'let' (immutable) or 'var' (mutable) instead (e.g. '{migration}') (ADR-0077).", DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0078 / issue #718: GS0306 — the legacy <c>type Name &lt;agg-kw&gt; ...</c>
    /// declaration head has been removed. The aggregate-kind keyword
    /// (<c>class</c>, <c>struct</c>, <c>enum</c>, <c>interface</c>) is now the
    /// declaration keyword and precedes the name. The diagnostic message includes
    /// a concrete migration snippet so existing code can be ported by hand or
    /// with a mechanical rewrite.
    /// </summary>
    /// <param name="location">The source location of the offending <c>type</c> keyword.</param>
    /// <param name="migration">A context-specific replacement snippet (e.g. <c>class Point(x, y int32)</c>).</param>
    public void ReportOldTypeDeclarationFormRemoved(TextLocation location, string migration)
    {
        Report(location, "GS0306", $"The 'type Name <kind> ...' declaration head has been removed; use the kind keyword first (e.g. '{migration}') (ADR-0078).", DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0078 / issue #718: GS0307 — the <c>record</c> contextual keyword has
    /// been deleted. Records are spelled <c>data class</c> (reference) or
    /// <c>data struct</c> (value) with the aggregate keyword as the
    /// declaration head.
    /// </summary>
    /// <param name="location">The source location of the offending <c>record</c> identifier.</param>
    /// <param name="name">The aggregate name (used to build the migration snippet).</param>
    public void ReportRecordKeywordRemoved(TextLocation location, string name)
    {
        Report(location, "GS0307", $"The 'record' keyword has been removed; use 'data class {name}' (reference equality-bearing) or 'data struct {name}' (value equality-bearing) instead (ADR-0078).", DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0078 / issue #718: GS0308 — <c>inline</c> is only valid on
    /// <c>struct</c>. <c>inline class</c> is rejected because the inline value
    /// class (newtype) form only makes sense for value types.
    /// </summary>
    /// <param name="location">The source location of the offending <c>inline</c> modifier.</param>
    public void ReportInlineOnlyValidOnStruct(TextLocation location)
    {
        Report(location, "GS0308", "'inline' is only valid on 'struct'; use 'inline struct Name(field T)' for a newtype wrapper (ADR-0078).", DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0078 / issue #718: GS0309 — <c>open</c> is only valid on
    /// <c>class</c>. Structs are value types and cannot be subclassed; enums and
    /// interfaces define their own openness model.
    /// </summary>
    /// <param name="location">The source location of the offending <c>open</c> modifier.</param>
    /// <param name="kindName">The kind keyword that follows (e.g. <c>struct</c>).</param>
    public void ReportOpenOnlyValidOnClass(TextLocation location, string kindName)
    {
        Report(location, "GS0309", $"'open' is only valid on 'class'; '{kindName}' cannot be marked 'open' (ADR-0078).", DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0078 / issue #718: GS0310 — <c>sealed</c> is only valid on
    /// <c>class</c> and <c>interface</c>. Enums already form a closed
    /// hierarchy by construction; structs cannot be subclassed.
    /// </summary>
    /// <param name="location">The source location of the offending <c>sealed</c> modifier.</param>
    /// <param name="kindName">The kind keyword that follows.</param>
    public void ReportSealedOnlyValidOnClassOrInterface(TextLocation location, string kindName)
    {
        Report(location, "GS0310", $"'sealed' is only valid on 'class' or 'interface'; '{kindName}' cannot be marked 'sealed' (ADR-0078).", DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0078 / issue #718: GS0311 — <c>data</c> and <c>inline</c> cannot be
    /// combined. A <c>data struct</c> already carries field-wise equality; an
    /// <c>inline struct</c> compares by its single wrapped field. The two
    /// equality models are mutually exclusive.
    /// </summary>
    /// <param name="location">The source location of the offending modifier.</param>
    public void ReportDataAndInlineCannotCombine(TextLocation location)
    {
        Report(location, "GS0311", "'data' and 'inline' cannot be combined; choose one (ADR-0078).", DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0078 / issue #718: GS0312 — <c>open</c> and <c>sealed</c> on the
    /// same declaration are mutually exclusive (a class is either subclassable
    /// or part of a closed hierarchy).
    /// </summary>
    /// <param name="location">The source location of the second modifier.</param>
    public void ReportOpenAndSealedCannotCombine(TextLocation location)
    {
        Report(location, "GS0312", "'open' and 'sealed' cannot be combined on the same declaration (ADR-0078).", DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0078 / issue #718: GS0313 — a switch over a sealed-class hierarchy
    /// is missing a case for a known subtype.
    /// </summary>
    /// <param name="location">The source location of the switch keyword.</param>
    /// <param name="missingCaseName">The name of the missing case / subtype.</param>
    /// <param name="baseTypeName">The sealed-base type name.</param>
    public void ReportSealedHierarchyMissingCase(TextLocation location, string missingCaseName, string baseTypeName)
    {
        Report(location, "GS0313", $"Switch over sealed hierarchy '{baseTypeName}' is missing a case for '{missingCaseName}' (ADR-0078).", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0079 / issue #719: GS0314 — a receiver-clause method targets a
    /// type declared in the same package (the package "owns" the receiver
    /// type). Owned-type instance methods should be declared inside the
    /// type body; the receiver-clause form is reserved for non-owned types
    /// (imported CLR types or types from referenced packages). Soft warning
    /// during the one-release grace period; future tightening to error is
    /// tracked separately.
    /// </summary>
    /// <param name="location">The source location of the receiver type clause.</param>
    /// <param name="receiverTypeName">The owned receiver type name.</param>
    /// <param name="methodName">The receiver method's name.</param>
    public void ReportReceiverClauseOnOwnedType(TextLocation location, string receiverTypeName, string methodName)
    {
        Report(
            location,
            "GS0314",
            $"Receiver-clause methods are reserved for types this package does not own; declare '{methodName}' as a member of '{receiverTypeName}' instead (ADR-0079).",
            DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0080 / issue #720: GS0315 (warning) — a call-site or attribute named
    /// argument used the legacy <c>name = value</c> spelling. The canonical
    /// spelling is <c>name: value</c> (issue #343). Both forms parse during a
    /// one-release grace period; the <c>=</c> form is removed in a later
    /// release.
    /// </summary>
    /// <param name="location">The source location of the offending <c>=</c> token.</param>
    /// <param name="argumentName">The argument name on the left of the separator.</param>
    public void ReportNamedArgumentEqualsSeparatorDeprecated(TextLocation location, string argumentName)
    {
        Report(
            location,
            "GS0315",
            $"Named argument '{argumentName}' uses the deprecated '=' separator; use '{argumentName}: value' instead (ADR-0080).",
            DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0082 / issue #722: GS0316 — a Go-flavored concurrency syntactic
    /// form (<c>go</c>, <c>chan T</c>, <c>&lt;-ch</c>, <c>ch &lt;- v</c>,
    /// <c>select</c>, <c>close(ch)</c>, <c>make(chan T)</c>) was used in a
    /// compilation unit that does not <c>import Gsharp.Extensions.Go</c>.
    /// The Go-flavored surface is opt-in; the production concurrency surface
    /// is <c>scope</c> + <c>async</c> / <c>await</c>. The diagnostic names
    /// the triggering form so users see exactly what to fix.
    /// </summary>
    /// <param name="location">The source location of the offending keyword or operator.</param>
    /// <param name="form">The triggering syntactic form (e.g. <c>go</c>, <c>chan</c>, <c>&lt;-</c>, <c>select</c>, <c>close</c>, <c>make(chan)</c>).</param>
    public void ReportGoExtensionsImportRequired(TextLocation location, string form)
    {
        Report(
            location,
            "GS0316",
            $"'{form}' is provided by 'Gsharp.Extensions.Go'. Add 'import Gsharp.Extensions.Go' or use 'scope' + 'async'/'await' instead (ADR-0082).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0083 / issue #723: GS0317 — a Go-style built-in function
    /// (<c>len</c>, <c>cap</c>, <c>append</c>, <c>delete</c>) was called in
    /// a compilation unit that does not <c>import Gsharp.Extensions.Go</c>.
    /// The message names the built-in and, when there is a clean
    /// .NET-idiomatic replacement (<c>.Length</c>, <c>.Count</c>,
    /// <c>.Remove(k)</c>, <c>List[T].Add</c>), points the user at it as an
    /// alternative to the import. The <c>close(ch)</c> built-in keeps using
    /// <see cref="ReportGoExtensionsImportRequired"/> (GS0316) because it
    /// shares the channel surface with <c>chan</c> / <c>&lt;-</c> /
    /// <c>select</c>; the <c>make(chan T)</c> shape is gated through the
    /// inner <c>chan</c> type-clause check (also GS0316), so this
    /// diagnostic only fires for the strict built-in identifiers above.
    /// </summary>
    /// <param name="location">The source location of the offending built-in identifier.</param>
    /// <param name="builtin">The triggering built-in name (e.g. <c>len</c>, <c>cap</c>, <c>append</c>, <c>delete</c>).</param>
    /// <param name="suggestion">A short alternative form to recommend (e.g. <c>.Length</c>, <c>.Count</c>, <c>.Remove(k)</c>), or <c>null</c> when there is no clean .NET-idiomatic replacement.</param>
    public void ReportGoBuiltinRequiresImport(TextLocation location, string builtin, string suggestion)
    {
        var message = suggestion is null
            ? $"'{builtin}' is provided by 'Gsharp.Extensions.Go'. Add 'import Gsharp.Extensions.Go' (ADR-0083)."
            : $"'{builtin}' is provided by 'Gsharp.Extensions.Go'. Add 'import Gsharp.Extensions.Go' or call '{suggestion}' directly (ADR-0083).";

        Report(
            location,
            "GS0317",
            message,
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0085 / issue #726: GS0318 — a class implements two unrelated
    /// interfaces that each provide a default body for the same method
    /// signature, and the class does not declare its own override. The
    /// implementer must declare a same-name same-signature method to
    /// disambiguate (Java-style "explicit override" rule). The message
    /// names both interfaces and the disputed method so the fix is
    /// immediately apparent.
    /// </summary>
    /// <param name="location">The source location of the implementing class identifier.</param>
    /// <param name="className">The implementing class name.</param>
    /// <param name="methodName">The disputed method name.</param>
    /// <param name="firstInterfaceName">The name of the first interface providing a default.</param>
    /// <param name="secondInterfaceName">The name of the second interface providing a default.</param>
    public void ReportConflictingInterfaceDefaults(
        TextLocation location,
        string className,
        string methodName,
        string firstInterfaceName,
        string secondInterfaceName)
    {
        Report(
            location,
            "GS0318",
            $"Class '{className}' inherits conflicting default implementations of method '{methodName}' from interfaces '{firstInterfaceName}' and '{secondInterfaceName}'; declare an override on '{className}' to disambiguate (ADR-0085).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0085 / issue #726: GS0319 — a call site (or override) references
    /// an interface method that has been turned back into an abstract slot
    /// (its default body was removed in a later library version), and the
    /// implementer was relying on the inherited default. The binder fires
    /// this when an InterfaceImpl is satisfied solely through a default that
    /// has been replaced by an abstract signature. Reserved so binary-compat
    /// regressions surface with a dedicated, actionable error.
    /// </summary>
    /// <param name="location">The source location of the implementing class identifier.</param>
    /// <param name="className">The implementing class name.</param>
    /// <param name="interfaceName">The interface that dropped the default.</param>
    /// <param name="methodName">The method that lost its default body.</param>
    public void ReportInterfaceDefaultRemoved(
        TextLocation location,
        string className,
        string interfaceName,
        string methodName)
    {
        Report(
            location,
            "GS0319",
            $"Class '{className}' relied on a default implementation of '{interfaceName}.{methodName}' that has been removed; declare an explicit override on '{className}' (ADR-0085).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0085 / issue #726: GS0320 — a class declares <c>: I</c> but
    /// neither provides an implementation of an abstract method <c>M</c>
    /// declared on <c>I</c> nor inherits one through its class chain, and
    /// the interface deliberately marked <c>M</c> abstract (no default
    /// body). This is the "no default, no impl" anchor that complements
    /// the general GS0187 channel; it fires when DIM is *available* but
    /// not used to bridge the gap, so users see immediately that the
    /// interface intentionally requires an implementation.
    /// </summary>
    /// <param name="location">The source location of the implementing class identifier.</param>
    /// <param name="className">The implementing class name.</param>
    /// <param name="interfaceName">The interface declaring the abstract method.</param>
    /// <param name="methodName">The abstract method name.</param>
    public void ReportInterfaceAbstractMethodHasNoDefault(
        TextLocation location,
        string className,
        string interfaceName,
        string methodName)
    {
        Report(
            location,
            "GS0320",
            $"Class '{className}' does not implement abstract interface method '{interfaceName}.{methodName}', and the interface provides no default body (ADR-0085).",
            DiagnosticSeverity.Error);
    }
}
