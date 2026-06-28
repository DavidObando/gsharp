// <copyright file="DiagnosticMessages.6.cs" company="GSharp">
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
    {
        Report(
            location,
            "GS0339",
            $"Interface '{interfaceName}' does not declare a member named '{methodName}' (ADR-0091).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0340",
            $"Interface member '{interfaceName}.{methodName}' is abstract and has no default body to delegate to via 'base[{interfaceName}]' (ADR-0091). Implement the method directly or delegate to a different interface that supplies a default.",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0341",
            $"'base[{interfaceName}].{methodName}' cannot target the private interface helper '{interfaceName}.{methodName}'; private helpers are invisible to implementers (ADR-0090 / ADR-0091).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0383",
            $"'base' is not valid here: '{enclosingTypeName}' must be an instance member of a class that has a base class to use 'base.Member(...)' (issue #986).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0384",
            $"Base class '{baseTypeName}' does not declare an accessible method named '{methodName}' to call via 'base' (issue #986).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0385",
            $"'base[{selectorTypeName}]' is not valid: '{selectorTypeName}' is not a base class of '{enclosingTypeName}'. Use the immediate base class name, or the plain 'base.Member(...)' form (issue #986).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0413",
            $"Cannot call the abstract base member '{baseTypeName}.{memberName}' via 'base'; it has no base implementation to delegate to (issue #1260).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0414",
            $"Reference to '{name}' is ambiguous between members of two or more imported types; qualify it with the owning type name (issue #1201).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0386",
            $"Cannot create an instance of the abstract type '{typeName}' (issue #987).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Issue #987: GS0387 — a concrete (non-<c>open</c>) class derives from an
    /// abstract base but does not override every inherited abstract method. The
    /// class must either override the member or be declared <c>open</c> (and so
    /// remain abstract itself). Mirrors C#'s CS0534.
    /// </summary>
    /// <param name="location">The source location of the offending class identifier.</param>
    /// <param name="className">The concrete class that fails to implement the member.</param>
    /// <param name="declaringTypeName">The type that declares the abstract member.</param>
    /// <param name="memberName">The abstract member's name.</param>
    public void ReportAbstractMemberNotImplemented(
        TextLocation location,
        string className,
        string declaringTypeName,
        string memberName)
    {
        Report(
            location,
            "GS0387",
            $"'{className}' does not implement inherited abstract member '{declaringTypeName}.{memberName}' (issue #987).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Issue #987: GS0388 — a no-body method (an abstract member) appears where
    /// it is not permitted. An abstract method must be declared <c>open</c> and
    /// may only live inside an <c>open class</c>. Mirrors C#'s CS0513/CS0500.
    /// </summary>
    /// <param name="location">The source location of the offending method identifier.</param>
    /// <param name="methodName">The bodyless method's name.</param>
    /// <param name="className">The enclosing class name.</param>
    public void ReportAbstractMethodRequiresOpenClass(
        TextLocation location,
        string methodName,
        string className)
    {
        Report(
            location,
            "GS0388",
            $"Abstract method '{methodName}' must be declared 'open' inside an 'open class'; '{className}' is not open or the method omits 'open' (issue #987).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0367",
            "'yield' cannot appear inside a 'try' block that has a 'catch' clause; only 'try'/'finally' is supported around 'yield' (issue #836).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0368 — issue #881: an interface <c>func</c> declaration with
    /// no <c>{ … }</c> body is missing its terminating <c>;</c>. A bodyless
    /// <c>func</c> is the no-body (abstract) form, and G# requires <c>;</c> as
    /// the universal no-body marker for every <c>func</c> declaration (matching
    /// the P/Invoke shape from ADR-0086). A <c>func</c> that carries a
    /// <c>{ … }</c> block (default-interface method or default shared slot) must
    /// not take a <c>;</c>.
    /// </summary>
    /// <param name="location">The source location where the <c>;</c> is
    /// expected (immediately after the return-type clause).</param>
    /// <param name="methodName">The name of the offending interface method.</param>
    public void ReportInterfaceMethodMissingSemicolon(TextLocation location, string methodName)
    {
        Report(
            location,
            "GS0368",
            $"Interface method '{methodName}' has no body and must be terminated with ';' (ADR-0085); a bodyless 'func' uses ';' as its no-body marker, mirroring P/Invoke.",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0369",
            $"Type '{type}' cannot be initialized with a collection initializer because it has no accessible 'Add' method or settable indexer (issue #479).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0370 — ADR-0118 / issue #944: an indexer member
    /// (<c>prop this[…] T { … }</c>) was declared with no index parameters.
    /// An indexer must declare at least one parameter.
    /// </summary>
    /// <param name="location">The source location of the indexer declaration.</param>
    public void ReportIndexerRequiresParameter(TextLocation location)
    {
        Report(
            location,
            "GS0370",
            "An indexer member must declare at least one parameter, e.g. 'prop this[i int32] T { … }' (issue #944).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0371 — ADR-0118 / issue #944: an indexer member
    /// (<c>prop this[…] T</c>) was declared without an accessor body. An
    /// indexer must declare a <c>get</c> and/or <c>set</c> accessor with a
    /// body; there is no auto-indexer form.
    /// </summary>
    /// <param name="location">The source location of the indexer declaration.</param>
    public void ReportIndexerRequiresAccessorBody(TextLocation location)
    {
        Report(
            location,
            "GS0371",
            "An indexer member must declare a 'get' and/or 'set' accessor with a body; there is no auto-indexer form (issue #944).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0389",
            $"Cannot construct '{typeParameterName}()' because type parameter '{typeParameterName}' has no 'init()' constraint; add an 'init()' constraint (e.g. '[{typeParameterName} init()]') to allow construction (issue #988).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0390",
            $"A pattern variable ('{variableName}') may not be declared under an 'or' or 'not' pattern; it would not be definitely assigned. Use '_' instead (issue #992).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Issue #1017: GS0393 — a user-defined conversion operator
    /// (<c>func operator implicit/explicit (x T) U</c>) must declare exactly one
    /// parameter (the source operand) passed by value.
    /// </summary>
    /// <param name="location">The source location of the operator name.</param>
    /// <param name="isExplicit">Whether the operator is <c>explicit</c>.</param>
    public void ReportConversionOperatorRequiresSingleParameter(TextLocation location, bool isExplicit)
    {
        var kind = isExplicit ? "explicit" : "implicit";
        Report(
            location,
            "GS0393",
            $"A user-defined '{kind}' conversion operator must take exactly one by-value parameter (the source operand).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Issue #1017: GS0394 — a user-defined conversion operator must convert to
    /// or from the enclosing user type, and source and target must differ
    /// (mirrors C# CS0555/CS0556).
    /// </summary>
    /// <param name="location">The source location of the operator name.</param>
    public void ReportConversionOperatorMustInvolveEnclosingType(TextLocation location)
    {
        Report(
            location,
            "GS0394",
            "A user-defined conversion operator must convert to or from a user type declared in the same package, and its source and target types must differ.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Issue #1017: GS0395 — two user-defined conversion operators on the same
    /// type convert between the same source/target pair (mirrors C# CS0557).
    /// </summary>
    /// <param name="location">The source location of the operator name.</param>
    /// <param name="sourceType">The conversion source type.</param>
    /// <param name="targetType">The conversion target type.</param>
    public void ReportDuplicateConversionOperator(TextLocation location, TypeSymbol sourceType, TypeSymbol targetType)
    {
        Report(
            location,
            "GS0395",
            $"Duplicate user-defined conversion operator: a conversion from '{sourceType?.Name}' to '{targetType?.Name}' is already declared on this type.",
            DiagnosticSeverity.Error);
    }

    private void Report(TextLocation location, string id, string message, DiagnosticSeverity severity = DiagnosticSeverity.Error)
    {
        var diagnostic = new Diagnostic(location, id, severity, message);
        diagnostics.Add(diagnostic);
    }
}
