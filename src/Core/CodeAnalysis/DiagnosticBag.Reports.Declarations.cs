// <copyright file="DiagnosticBag.Reports.Declarations.cs" company="GSharp">
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
    /// Reports that a <c>data class</c>/<c>data struct</c> was declared with
    /// no fields. Zero-field data types are supported as of issue #2363 (see
    /// ADR-0029); this diagnostic is retained for source/API stability in
    /// case a future invalid zero-field shape needs to be rejected, and
    /// reports the actual declaration kind ("class" or "struct") rather than
    /// unconditionally naming it a "struct".
    /// </summary>
    /// <param name="location">The text location of the struct identifier.</param>
    /// <param name="name">The struct name.</param>
    /// <param name="isClass">True if the declaration is a <c>class</c>; false if it is a <c>struct</c>.</param>
    public void ReportEmptyDataStruct(TextLocation location, string name, bool isClass)
    {
        var kind = isClass ? "class" : "struct";
        var message = $"'data {kind} {name}' requires at least one field; use '{kind}' instead.";
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
    /// Reports that an enum member's explicit value (issue #1912) isn't a
    /// constant-foldable int32 expression.
    /// </summary>
    /// <param name="location">The text location of the value expression.</param>
    /// <param name="memberName">The enum member name.</param>
    /// <param name="enumName">The enum name.</param>
    public void ReportEnumMemberValueNotConstant(TextLocation location, string memberName, string enumName)
    {
        var message = $"Enum member '{enumName}.{memberName}' explicit value must be a constant int32 expression (literals, +, -, |, &, ^, <<, >>, unary +/-/~, or a reference to an already-declared sibling member).";
        Report(location, "GS0467", message);
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

    /// <summary>Reports an interface type-parameter used in a position incompatible with its declared variance (Phase 4.3c / ADR-0021).</summary>
    /// <param name="location">The text location of the offending use.</param>
    /// <param name="typeParameterName">The type-parameter name.</param>
    /// <param name="declaredVariance">The declared variance (in/out).</param>
    /// <param name="usedPosition">The position the type-parameter was used in (input/output).</param>
    public void ReportTypeParameterVariancePositionViolation(TextLocation location, string typeParameterName, string declaredVariance, string usedPosition)
    {
        Report(location, "GS0150", $"Type parameter '{typeParameterName}' declared '{declaredVariance}' cannot appear in {usedPosition} position.");
    }

    /// <summary>Reports a type used as a type-parameter constraint that is neither an interface nor a class (issue #1052 generalised the former sealed-interface restriction; issue #1056 additionally permits base-class constraints, so this now fires only for value types such as a struct or enum).</summary>
    /// <param name="location">The text location of the constraint reference.</param>
    /// <param name="typeName">The offending type name.</param>
    public void ReportConstraintNotInterface(TextLocation location, string typeName)
    {
        Report(location, "GS0153", $"Type '{typeName}' cannot be used as a type-parameter constraint because it is neither an interface nor a class.");
    }

    /// <summary>
    /// Issue #948: a <c>const</c> field must be given an initializer (a
    /// compile-time constant value). Reported when a <c>const</c> field
    /// declaration omits the <c>= expr</c> initializer.
    /// </summary>
    /// <param name="location">The location of the const field identifier.</param>
    /// <param name="name">The const field name.</param>
    public void ReportConstFieldRequiresInitializer(TextLocation location, string name)
    {
        Report(location, "GS0375", $"Const field '{name}' must have a compile-time constant initializer (e.g. 'const {name} T = value').");
    }

    /// <summary>
    /// Issue #948: a <c>const</c> field initializer must be a compile-time
    /// constant expression. Reported when the bound initializer cannot be
    /// folded to a literal value.
    /// </summary>
    /// <param name="location">The location of the offending initializer.</param>
    /// <param name="name">The const field name.</param>
    public void ReportConstFieldInitializerNotConstant(TextLocation location, string name)
    {
        Report(location, "GS0376", $"The initializer for const field '{name}' must be a compile-time constant expression.");
    }

    /// <summary>
    /// Issue #948: an instance field initializer (the <c>= expr</c> on a
    /// <c>let</c>/<c>var</c> field) runs before the constructor body and
    /// therefore cannot reference <c>this</c>, other instance members, or
    /// constructor parameters — matching C# field-initializer rules.
    /// </summary>
    /// <param name="location">The location of the offending reference.</param>
    /// <param name="memberName">The referenced instance member / parameter name.</param>
    public void ReportFieldInitializerCannotReferenceInstanceMember(TextLocation location, string memberName)
    {
        Report(location, "GS0377", $"A field initializer cannot reference the instance member or constructor parameter '{memberName}' (field initializers run before the constructor body, so 'this' is not available). Assign it in an 'init(...)' constructor instead.");
    }

    /// <summary>
    /// ADR-0068 / issue #698: reports a <c>deinit</c> destructor declaration
    /// on a non-class type. <c>deinit</c> lowers to a CLR finalizer, which
    /// the CLR does not run for value types, so it is only legal inside a
    /// <c>class</c> body.
    /// </summary>
    /// <param name="location">The location of the offending <c>deinit</c> keyword.</param>
    /// <param name="typeName">The enclosing type's name (may be empty).</param>
    /// <param name="enclosingKind">The enclosing type-introducer keyword (<c>struct</c>, etc.).</param>
    public void ReportDeinitOnNonClass(TextLocation location, string typeName, SyntaxKind enclosingKind)
    {
        var kindText = enclosingKind == SyntaxKind.StructKeyword ? "struct" : enclosingKind.ToString();
        var typeText = string.IsNullOrEmpty(typeName) ? "this type" : "'" + typeName + "'";
        var message = $"'deinit' is only valid on a class type — {typeText} is a {kindText}.";
        Report(location, "GS0289", message);
    }

    /// <summary>
    /// ADR-0068 / issue #698: reports a duplicate <c>deinit</c> declaration
    /// on the same class. A class instance is finalized at most once by the
    /// CLR garbage collector, so only one <c>deinit</c> body may be emitted
    /// as the type's <c>Finalize</c> override.
    /// </summary>
    /// <param name="location">The location of the duplicate <c>deinit</c> keyword.</param>
    /// <param name="className">The enclosing class's name.</param>
    public void ReportDuplicateDeinit(TextLocation location, string className)
    {
        var classText = string.IsNullOrEmpty(className) ? "this class" : "Class '" + className + "'";
        var message = $"{classText} declares more than one 'deinit'; only the first declaration emits a finalizer.";
        Report(location, "GS0290", message);
    }

    /// <summary>
    /// ADR-0068 / issue #698: reports a <c>deinit</c> declaration that
    /// carries a parameter list. Destructors take no parameters — the CLR
    /// invokes <c>Finalize()</c> with no arguments.
    /// </summary>
    /// <param name="location">The location of the offending open paren.</param>
    public void ReportDeinitMayNotDeclareParameters(TextLocation location)
    {
        var message = "'deinit' may not declare parameters — the CLR invokes the destructor with no arguments.";
        Report(location, "GS0291", message);
    }

    /// <summary>
    /// ADR-0068 / issue #698: reports a <c>deinit</c> declaration that
    /// carries a return type. Destructors always return <c>void</c> — the
    /// CLR's <c>Finalize</c> override may not return a value.
    /// </summary>
    /// <param name="location">The location of the offending return type token.</param>
    public void ReportDeinitMayNotDeclareReturnType(TextLocation location)
    {
        var message = "'deinit' may not declare a return type — the CLR finalizer always returns void.";
        Report(location, "GS0292", message);
    }

    /// <summary>
    /// Issue #950: GS0380 — the <c>protected</c> modifier appears on a member
    /// (or nested type) whose enclosing type is not an inheritable
    /// <c>open class</c>. Nothing can derive from a non-<c>open</c> class, a
    /// <c>struct</c>, a sealed type, an interface, or a top-level declaration,
    /// so <c>protected</c> there is meaningless.
    /// </summary>
    /// <param name="location">The text location of the <c>protected</c> modifier.</param>
    public void ReportProtectedRequiresOpenType(TextLocation location)
    {
        Report(
            location,
            "GS0380",
            "'protected' is only allowed on members of an 'open class' (a type that can be inherited). Mark the enclosing class 'open', or use a different accessibility.");
    }

    /// <summary>Reports an attempt to subclass a sealed (non-<c>open</c>) class. Phase 3.B.3 sub-step 3 / ADR-0017.</summary>
    /// <param name="location">The text location of the base-type identifier.</param>
    /// <param name="baseTypeName">The base type name.</param>
    public void ReportBaseClassNotOpen(TextLocation location, string baseTypeName)
    {
        Report(location, "GS0181", $"Class '{baseTypeName}' is not open; declare 'open class {baseTypeName}' to allow subclassing.");
    }

    /// <summary>
    /// Issue #949: reports a class that directly names itself as its own base
    /// class (e.g. <c>class A : A</c> or the generic <c>class A[T] : A[T]</c>),
    /// which is an illegal self-inheritance cycle. Note that naming the
    /// enclosing type merely as a generic type argument of a base/interface
    /// type — the common <c>class Shape : IEquatable[Shape]</c> pattern — is
    /// legal and is not reported here.
    /// </summary>
    /// <param name="location">The text location of the base-type identifier.</param>
    /// <param name="typeName">The declaring type name.</param>
    public void ReportClassInheritsFromItself(TextLocation location, string typeName)
    {
        Report(location, "GS0378", $"Class '{typeName}' cannot inherit from itself.");
    }

    /// <summary>
    /// Issue #973: reports a class that participates in a transitive base-class
    /// inheritance cycle (e.g. <c>class B : C</c> together with
    /// <c>class C : B</c>). The two-phase declaration model (#973) declares all
    /// type-name shells before binding any base clause, so such mutually
    /// forward-referencing cycles can no longer be screened out by declaration
    /// order and must be detected explicitly once every base class is resolved.
    /// Direct self-inheritance (<c>class A : A</c>) is reported separately by
    /// <see cref="ReportClassInheritsFromItself"/>.
    /// </summary>
    /// <param name="location">The text location of the base-type clause.</param>
    /// <param name="typeName">The declaring type name.</param>
    public void ReportClassInheritanceCycle(TextLocation location, string typeName)
    {
        Report(location, "GS0381", $"Class '{typeName}' is part of an inheritance cycle.");
    }

    /// <summary>
    /// Issue #976: GS0382 — a <c>struct</c> (value type) named a class or
    /// another struct in its <c>: …</c> clause. A CLR value type always derives
    /// from <c>System.ValueType</c> and cannot declare a user base type; its
    /// clause may list interfaces only.
    /// </summary>
    /// <param name="location">The text location of the offending base type.</param>
    /// <param name="structName">The declaring struct's name.</param>
    /// <param name="baseTypeName">The illegal base type's name.</param>
    public void ReportStructCannotHaveBaseClass(TextLocation location, string structName, string baseTypeName)
    {
        Report(location, "GS0382", $"Struct '{structName}' cannot declare base type '{baseTypeName}'; a struct may only implement interfaces.");
    }

    /// <summary>
    /// Issue #1006: GS0391 — an <c>interface</c> named a class or struct in its
    /// base-interface clause (e.g. <c>interface B : SomeClass</c>). An
    /// interface may only extend other interfaces.
    /// </summary>
    /// <param name="location">The text location of the offending base type.</param>
    /// <param name="interfaceName">The declaring interface's name.</param>
    /// <param name="baseTypeName">The illegal base type's name.</param>
    public void ReportInterfaceCannotHaveClassBase(TextLocation location, string interfaceName, string baseTypeName)
    {
        Report(location, "GS0391", $"Interface '{interfaceName}' cannot declare base type '{baseTypeName}'; an interface may only extend other interfaces.");
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

    /// <summary>
    /// ADR-0085 (issue #726): GS0186 — previously reported when an interface
    /// method carried a body in Phase 3 (ADR-0018 deferral). The deferral was
    /// reversed by ADR-0085, which implements default-interface methods, so
    /// this diagnostic is no longer emitted. The slot is preserved (rather
    /// than reused) so historical references in changelogs and PRs still
    /// resolve correctly.
    /// </summary>
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
        Report(location, "GS0419", $"Property '{propertyName}' cannot be an auto-property in a data struct; use a computed property with an explicit body instead.");
    }

    /// <summary>ADR-0051: reports an <c>open</c> member declared on a class that is not itself <c>open</c>.</summary>
    /// <param name="location">The text location of the <c>open</c> modifier.</param>
    /// <param name="memberName">The member name.</param>
    public void ReportOpenMemberInNonOpenClass(TextLocation location, string memberName)
    {
        Report(location, "GS0421", $"Member '{memberName}' is marked 'open' but the enclosing class is not open.");
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

    /// <summary>GS9007: A type may contain at most one 'shared' block.</summary>
    /// <param name="location">The text location of the duplicate shared keyword.</param>
    public void ReportDuplicateSharedBlock(TextLocation location)
    {
        Report(location, "GS9007", "A type may contain at most one 'shared' block.");
    }

    /// <summary>
    /// Issue #410 / ADR-0029: reports that a synthesized data-struct member
    /// (<c>Equals</c>, <c>GetHashCode</c>, <c>ToString</c>, <c>op_Equality</c>,
    /// <c>op_Inequality</c>, or <c>Deconstruct</c>) was hand-written. The ADR
    /// forbids user-written versions so the contract of <c>data struct</c> is
    /// learnable and predictable.
    /// </summary>
    /// <param name="location">The text location of the member name.</param>
    /// <param name="typeName">The data type name.</param>
    /// <param name="isClass"><see langword="true"/> when the type is a data class; otherwise a data struct.</param>
    /// <param name="memberName">The synthesized member name.</param>
    public void ReportDataStructSynthesizedMemberConflict(TextLocation location, string typeName, bool isClass, string memberName)
    {
        var kind = isClass ? "class" : "struct";
        var message = $"Data {kind} '{typeName}' synthesizes member '{memberName}'; it cannot be declared explicitly.";
        Report(location, "GS0232", message);
    }

    /// <summary>
    /// Issue #2361 / ADR-0029 follow-up: reports that a data class/struct's
    /// hand-written <c>ToString</c> declaration is incompatible with the slot
    /// it would need to suppress/replace (<c>public string ToString()</c> —
    /// zero parameters, non-static, non-generic, non-async, returning
    /// <c>string</c>). Unlike the other five synthesized names (which are
    /// always rejected via <see cref="ReportDataStructSynthesizedMemberConflict"/>),
    /// a <c>ToString</c> declaration gets this more specific diagnostic so the
    /// message can describe the exact shape it must match.
    /// </summary>
    /// <param name="location">The text location of the member name.</param>
    /// <param name="typeName">The data type name.</param>
    /// <param name="isClass"><see langword="true"/> when the type is a data class; otherwise a data struct.</param>
    public void ReportIncompatibleDataToStringOverride(TextLocation location, string typeName, bool isClass)
    {
        var kind = isClass ? "class" : "struct";
        var message = $"Data {kind} '{typeName}' declares 'ToString' with an incompatible shape; a data {kind} may only override ToString as 'public ToString() string' (no parameters, not static, not generic, not async, returning 'string').";
        Report(location, "GS0487", message);
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
        Report(location, "GS0424", $"'ref'/'out'/'in' is not a legal modifier on the primary-constructor parameter '{parameterName}'; primary-ctor parameters materialize fields, and the CLR cannot store a managed pointer in a field. Move the constructor to an 'init(...)' body if a by-reference parameter is required.");
    }

    /// <summary>
    /// ADR-0060 §10: reports a ref-kind parameter on an <c>async</c>, <c>sequence</c>, or
    /// <c>async sequence</c> function. The state-machine rewriter cannot hoist a managed
    /// pointer into a field, so the parameter is rejected.
    /// </summary>
    /// <param name="location">The parameter location.</param>
    /// <param name="parameterName">The parameter name.</param>
    /// <param name="functionKind">"async", "sequence", or "async sequence".</param>
    public void ReportRefKindOnAsyncOrIterator(TextLocation location, string parameterName, string functionKind)
    {
        Report(location, "GS0422", $"Ref-kind parameter '{parameterName}' cannot appear on a {functionKind} function.");
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

    /// <summary>
    /// ADR-0085 / issue #726: GS0321 — a deferred modifier (currently
    /// <c>static</c> or <c>private</c>) appears on an interface method
    /// declaration. ADR-0085 intentionally keeps DIM minimal in this PR
    /// (instance-virtual default methods only); static-virtuals and
    /// private helpers are tracked as follow-ups and are rejected here.
    /// </summary>
    /// <param name="location">The source location of the offending modifier or method identifier.</param>
    /// <param name="modifier">The triggering modifier (e.g. <c>static</c>, <c>private</c>).</param>
    /// <param name="methodName">The owning interface method name.</param>
    public void ReportInterfaceMethodModifierDeferred(
        TextLocation location,
        string modifier,
        string methodName)
    {
        Report(
            location,
            "GS0321",
            $"Modifier '{modifier}' on interface method '{methodName}' is not supported in this version of GSharp; see ADR-0085 for the deferred-features list.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0361 — ADR-0097 / issue #775: a type-parameter constraint
    /// list combines mutually exclusive flag constraints. The forbidden
    /// combinations are <c>class struct</c> (a type cannot simultaneously
    /// be a reference type and a value type) and <c>struct init()</c> (the
    /// <c>init()</c> flag is implied by — and redundant with — <c>struct</c>
    /// at the CLR level; ECMA-335 II.10.1.7 already forces both bits
    /// whenever the value-type constraint is set, so the explicit
    /// <c>init()</c> is rejected to keep the surface unambiguous).
    /// </summary>
    /// <param name="location">The offending constraint location.</param>
    /// <param name="typeParameterName">The type-parameter name (e.g. <c>T</c>).</param>
    /// <param name="first">The first constraint keyword (e.g. <c>class</c>).</param>
    /// <param name="second">The second constraint keyword (e.g. <c>struct</c>).</param>
    public void ReportTypeParameterConstraintConflict(TextLocation location, string typeParameterName, string first, string second)
    {
        Report(
            location,
            "GS0361",
            $"Type parameter '{typeParameterName}' carries the mutually exclusive constraints '{first}' and '{second}' (ADR-0097).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0364 — ADR-0101 / issue #799: more than one variadic
    /// parameter (<c>...T</c>) appeared in the same parameter list. A signature
    /// may declare at most one variadic parameter, and it must be the last
    /// parameter.
    /// </summary>
    /// <param name="location">The location of the second (or later) variadic parameter.</param>
    /// <param name="name">The offending parameter name.</param>
    public void ReportMultipleVariadicParameters(TextLocation location, string name)
    {
        Report(
            location,
            "GS0364",
            $"At most one variadic parameter is allowed in a signature; '{name}' is the second.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0365 — ADR-0102 follow-up / issue #818: a variadic
    /// parameter slot in an anonymous function-type clause
    /// (<c>(T1, ...T2) -&gt; R</c>) must spell its element type with the
    /// slice form <c>[]T</c>. The <c>...</c> marker turns the slot into a
    /// pack/passthrough call site, so the storage type must be a slice the
    /// trailing positional arguments can pack into.
    /// </summary>
    /// <param name="location">The location of the offending parameter type clause.</param>
    /// <param name="typeName">The non-slice type name that was supplied.</param>
    public void ReportVariadicParameterMustBeSlice(TextLocation location, string typeName)
    {
        Report(
            location,
            "GS0365",
            $"A variadic parameter slot in an anonymous function-type clause must use the slice form '[]T'; got '{typeName}'.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0330 — ADR-0089 / issue #755 (issue #865 revision): a
    /// non-<c>func</c> member appears inside an interface <c>shared { … }</c>
    /// block. Only static-virtual <c>func</c> members (abstract or default) are
    /// allowed there; interface static state (<c>var</c> / <c>let</c> /
    /// <c>const</c> / <c>prop</c> / <c>event</c>) is deferred to a future ADR.
    /// </summary>
    /// <param name="location">The source location of the offending declaration.</param>
    /// <param name="interfaceName">The owning interface name.</param>
    public void ReportInterfaceSharedMemberMustBeFunc(TextLocation location, string interfaceName)
    {
        Report(
            location,
            "GS0330",
            $"Only 'func' members are allowed inside the 'shared' block of interface '{interfaceName}'; interface static state is not supported in this release (ADR-0089).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0396 — ADR-0089 / issue #1019: a static-virtual interface
    /// property declared inside an interface <c>shared { … }</c> block carries
    /// an accessor *body* (a default static slot). Default-bodied static
    /// interface properties are deferred (interface properties are abstract
    /// slots only in this release); declare an abstract slot
    /// (<c>prop Name T { get; }</c> / <c>prop Name T;</c>) instead, or expose a
    /// default via a static <c>func</c> in the interface shared block.
    /// </summary>
    /// <param name="location">The offending accessor location.</param>
    /// <param name="interfaceName">The owning interface name.</param>
    /// <param name="propertyName">The static interface property name.</param>
    public void ReportDefaultStaticInterfacePropertyNotSupported(
        TextLocation location,
        string interfaceName,
        string propertyName)
    {
        Report(
            location,
            "GS0396",
            $"Static interface property '{interfaceName}.{propertyName}' may not have an accessor body; default-bodied static interface properties are not supported in this release — declare an abstract slot ('prop {propertyName} T;' or '{{ get; }}') instead (ADR-0089).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0397 — ADR-0089 / issue #1019: a struct/class that declares it
    /// implements an interface with one or more static-virtual abstract
    /// *properties* does not provide a matching static property (in its own
    /// <c>shared { … }</c> block) for some of those slots.
    /// </summary>
    /// <param name="location">The implementer declaration head location.</param>
    /// <param name="structName">The implementer type name.</param>
    /// <param name="interfaceName">The interface symbol display.</param>
    /// <param name="propertyName">The unimplemented static-virtual property name.</param>
    /// <param name="detail">A short clause describing what is missing (e.g. "getter").</param>
    public void ReportStaticVirtualInterfacePropertyNotImplemented(
        TextLocation location,
        string structName,
        string interfaceName,
        string propertyName,
        string detail)
    {
        Report(
            location,
            "GS0397",
            $"Type '{structName}' does not implement static-virtual interface property '{interfaceName}.{propertyName}' ({detail}) (ADR-0089).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0331 — ADR-0089 / issue #755: a struct that declares it
    /// implements an interface with one or more static-virtual abstract
    /// members does not provide the matching <c>shared { func … }</c>
    /// override for some of those slots.
    /// </summary>
    /// <param name="location">The struct declaration head location.</param>
    /// <param name="structName">The implementer struct name.</param>
    /// <param name="interfaceName">The interface symbol display.</param>
    /// <param name="methodName">The unimplemented static-virtual method name.</param>
    public void ReportStaticVirtualInterfaceMethodNotImplemented(
        TextLocation location,
        string structName,
        string interfaceName,
        string methodName)
    {
        Report(
            location,
            "GS0331",
            $"Struct '{structName}' does not implement static-virtual interface method '{interfaceName}.{methodName}', and the interface provides no default body (ADR-0089).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0332 — ADR-0089 / issue #755: a struct declares a
    /// non-<c>static</c> instance method with the same name and signature
    /// as a static-virtual interface slot. Instance methods cannot satisfy
    /// a static-virtual contract; the implementer must declare the method
    /// inside a <c>shared { ... }</c> block (ADR-0053) with the matching
    /// signature.
    /// </summary>
    /// <param name="location">The offending instance-method declaration location.</param>
    /// <param name="structName">The implementer struct name.</param>
    /// <param name="interfaceName">The interface symbol display.</param>
    /// <param name="methodName">The interface slot name.</param>
    public void ReportNonStaticMemberForStaticVirtualSlot(
        TextLocation location,
        string structName,
        string interfaceName,
        string methodName)
    {
        Report(
            location,
            "GS0332",
            $"Struct '{structName}' declares instance method '{methodName}' but interface '{interfaceName}.{methodName}' is static-virtual; declare it inside a 'shared {{ ... }}' block (ADR-0089).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0090 / issue #756: GS0335 — a <c>private</c> interface method was
    /// declared without a body. A private helper is part of the interface's
    /// own implementation and must therefore supply one; no implementer is
    /// allowed to satisfy the contract because no implementer is allowed to
    /// see the slot.
    /// </summary>
    /// <param name="location">The offending method-identifier location.</param>
    /// <param name="methodName">The helper's name.</param>
    public void ReportPrivateInterfaceMemberRequiresBody(
        TextLocation location,
        string methodName)
    {
        Report(
            location,
            "GS0335",
            $"Private interface method '{methodName}' must have a body (ADR-0090).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0090 / issue #756: GS0336 — an implementing class or struct
    /// declared a method whose name + signature matches a <c>private</c>
    /// helper on one of its implemented interfaces. Private helpers are
    /// invisible to implementers; declaring a same-name method is almost
    /// always an unintentional clash.
    /// </summary>
    /// <param name="location">The offending member's identifier location.</param>
    /// <param name="implementerName">The implementing class / struct name.</param>
    /// <param name="interfaceName">The interface owning the helper.</param>
    /// <param name="methodName">The clashing method name.</param>
    public void ReportImplementerOverridesPrivateInterfaceMember(
        TextLocation location,
        string implementerName,
        string interfaceName,
        string methodName)
    {
        Report(
            location,
            "GS0336",
            $"'{implementerName}.{methodName}' clashes with private interface helper '{interfaceName}.{methodName}'; private interface helpers are invisible to implementers and cannot be overridden or satisfied (ADR-0090). Rename '{methodName}' on '{implementerName}'.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0090 / issue #756: GS0337 — a <c>private</c> modifier appears on
    /// an interface property or event declaration. ADR-0090 deliberately
    /// keeps the surface to <c>private func</c>; private interface
    /// properties / events are out of scope for this release.
    /// </summary>
    /// <param name="location">The offending modifier's source location.</param>
    /// <param name="memberKind">The offending member kind (<c>property</c> / <c>event</c>).</param>
    /// <param name="memberName">The owning member's name.</param>
    public void ReportPrivateInterfaceMemberKindNotSupported(
        TextLocation location,
        string memberKind,
        string memberName)
    {
        Report(
            location,
            "GS0337",
            $"'private' is not supported on interface {memberKind} '{memberName}'; ADR-0090 only allows 'private' on interface methods.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0144 / issue #2201: GS0484 — the <c>partial</c> contextual modifier
    /// was applied to an aggregate kind that cannot be partial. Only
    /// <c>class</c>, <c>struct</c>, and <c>interface</c> declarations may be
    /// partial; <c>enum</c> is rejected at parse time.
    /// </summary>
    /// <param name="location">The source location of the offending <c>partial</c> modifier.</param>
    /// <param name="kind">The rejected aggregate kind spelling (e.g. <c>enum</c>).</param>
    public void ReportPartialNotValidOnKind(TextLocation location, string kind)
    {
        Report(
            location,
            "GS0484",
            $"'partial' is not valid on '{kind}'; only 'class', 'struct', and 'interface' declarations can be partial.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0144 / issue #2201: GS0475 — a declaration in a partial-type group
    /// lacks the <c>partial</c> modifier while another declaration of the same
    /// type carries it (the analog of C# CS0260).
    /// </summary>
    /// <param name="location">The source location of the non-partial declaration's identifier.</param>
    /// <param name="name">The type name.</param>
    public void ReportPartialModifierMissing(TextLocation location, string name)
    {
        Report(
            location,
            "GS0475",
            $"Missing 'partial' modifier on declaration of type '{name}'; another partial declaration of this type exists.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0144 / issue #2201: GS0476 — the parts of a partial type disagree on
    /// aggregate kind (<c>class</c> vs <c>struct</c> vs <c>interface</c>).
    /// </summary>
    /// <param name="location">The source location of the mismatched declaration's identifier.</param>
    /// <param name="name">The type name.</param>
    public void ReportPartialKindMismatch(TextLocation location, string name)
    {
        Report(
            location,
            "GS0476",
            $"Partial declarations of '{name}' must all be the same aggregate kind ('class', 'struct', or 'interface').",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0144 / issue #2201: GS0477 — two parts of a partial type state
    /// different accessibility modifiers.
    /// </summary>
    /// <param name="location">The source location of the conflicting accessibility modifier.</param>
    /// <param name="name">The type name.</param>
    public void ReportPartialAccessibilityConflict(TextLocation location, string name)
    {
        Report(
            location,
            "GS0477",
            $"Partial declarations of '{name}' have conflicting accessibility modifiers.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0144 / issue #2201: GS0478 — one part of a partial type is <c>open</c>
    /// and another is <c>sealed</c>.
    /// </summary>
    /// <param name="location">The source location of the conflicting declaration's identifier.</param>
    /// <param name="name">The type name.</param>
    public void ReportPartialOpenSealedConflict(TextLocation location, string name)
    {
        Report(
            location,
            "GS0478",
            $"Partial declarations of '{name}' have conflicting 'open'/'sealed' modifiers.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0144 / issue #2201: GS0479 — a <c>data</c>/<c>inline</c>/<c>ref</c>
    /// modifier that changes how each part's body binds appears on some but not
    /// all parts of a partial type.
    /// </summary>
    /// <param name="location">The source location of the part missing the modifier.</param>
    /// <param name="modifier">The modifier spelling (<c>data</c>, <c>inline</c>, or <c>ref</c>).</param>
    /// <param name="name">The type name.</param>
    public void ReportPartialModifierMustMatchAllParts(TextLocation location, string modifier, string name)
    {
        Report(
            location,
            "GS0479",
            $"The '{modifier}' modifier must appear on every partial declaration of '{name}'.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0144 / issue #2201: GS0480 — the parts of a partial type declare
    /// differing type-parameter lists (names, arity, order, or constraints).
    /// </summary>
    /// <param name="location">The source location of the mismatched declaration's identifier.</param>
    /// <param name="name">The type name.</param>
    public void ReportPartialTypeParameterMismatch(TextLocation location, string name)
    {
        Report(
            location,
            "GS0480",
            $"Partial declarations of '{name}' must have identical type parameter lists (including names and constraints).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0144 / issue #2201: GS0481 — the parts of a partial type have
    /// conflicting base clauses (differing base class, or base-constructor
    /// arguments on more than one part).
    /// </summary>
    /// <param name="location">The source location of the conflicting declaration's identifier.</param>
    /// <param name="name">The type name.</param>
    public void ReportPartialBaseClauseConflict(TextLocation location, string name)
    {
        Report(
            location,
            "GS0481",
            $"Partial declarations of '{name}' have conflicting base clauses; only one part may supply base-constructor arguments and any repeated base class must match.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0144 / issue #2201: GS0482 — more than one part of a partial type
    /// declares a primary constructor.
    /// </summary>
    /// <param name="location">The source location of the offending declaration's identifier.</param>
    /// <param name="name">The type name.</param>
    public void ReportPartialMultiplePrimaryConstructors(TextLocation location, string name)
    {
        Report(
            location,
            "GS0482",
            $"Only one partial declaration of '{name}' may declare a primary constructor.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0144 / issue #2201: GS0483 — more than one part of a partial type
    /// declares a <c>deinit</c>.
    /// </summary>
    /// <param name="location">The source location of the offending <c>deinit</c>.</param>
    /// <param name="name">The type name.</param>
    public void ReportPartialMultipleDeinit(TextLocation location, string name)
    {
        Report(
            location,
            "GS0483",
            $"Partial declarations of '{name}' declare more than one 'deinit'.",
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

    /// <summary>
    /// ADR-0149: GS0492 — an explicit-interface qualifier clause
    /// (<c>func (X) M(...)</c> / <c>prop (X) P T</c> / <c>event (X) E T</c>)
    /// referenced a type that is not an interface.
    /// </summary>
    /// <param name="location">The source location of the clause's type reference.</param>
    /// <param name="typeName">The display name of the non-interface type.</param>
    /// <param name="memberName">The declared member name.</param>
    public void ReportExplicitInterfaceClauseTypeNotInterface(TextLocation location, string typeName, string memberName)
    {
        Report(
            location,
            "GS0492",
            $"'{typeName}' is not an interface; the explicit-interface qualifier clause on '{memberName}' must reference an interface type.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0149: GS0493 — an explicit-interface qualifier clause referenced an
    /// interface the containing type does not implement.
    /// </summary>
    /// <param name="location">The source location of the clause's type reference.</param>
    /// <param name="containingTypeName">The containing class/struct name.</param>
    /// <param name="interfaceName">The referenced interface's name.</param>
    /// <param name="memberName">The declared member name.</param>
    public void ReportExplicitInterfaceClauseNotImplemented(TextLocation location, string containingTypeName, string interfaceName, string memberName)
    {
        Report(
            location,
            "GS0493",
            $"'{containingTypeName}' does not implement interface '{interfaceName}'; the explicit-interface qualifier clause on '{memberName}' requires an implemented interface.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0149: GS0494 — an explicit-interface qualifier clause's interface
    /// is implemented, but no member on it matches the declared name,
    /// signature, or accessor shape.
    /// </summary>
    /// <param name="location">The source location of the declared member.</param>
    /// <param name="interfaceName">The referenced interface's name.</param>
    /// <param name="memberName">The declared member name.</param>
    public void ReportExplicitInterfaceClauseMemberNotFound(TextLocation location, string interfaceName, string memberName)
    {
        Report(
            location,
            "GS0494",
            $"'{interfaceName}' has no member '{memberName}' matching this declaration's signature/accessor shape.",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// ADR-0149: GS0495 — two members of the same containing type both carry
    /// an explicit-interface qualifier clause that resolves to the same
    /// interface member.
    /// </summary>
    /// <param name="location">The source location of the second (duplicate) declaration.</param>
    /// <param name="interfaceName">The shared target interface's name.</param>
    /// <param name="memberName">The shared target member name.</param>
    public void ReportDuplicateExplicitInterfaceImplementation(TextLocation location, string interfaceName, string memberName)
    {
        Report(
            location,
            "GS0495",
            $"'{interfaceName}.{memberName}' is already explicitly implemented elsewhere in this type.",
            DiagnosticSeverity.Error);
    }
}
