// <copyright file="DiagnosticMessages.2.cs" company="GSharp">
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
        var message = $"Call to '{name}' is ambiguous between {candidateCount} applicable overloads.";
        if (candidateSignatures != null)
        {
            var lines = candidateSignatures.Where(s => !string.IsNullOrEmpty(s)).ToArray();
            if (lines.Length > 0)
            {
                var builder = new System.Text.StringBuilder(message);
                builder.Append(" Candidates: ");
                for (var i = 0; i < lines.Length; i++)
                {
                    if (i > 0)
                    {
                        builder.Append("; ");
                    }

                    builder.Append(lines[i]);
                }

                builder.Append('.');
                message = builder.ToString();
            }
        }

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
    /// Reports that top-level statements appear in more than one *package* in
    /// the same compilation, which is not allowed (ADR-0066). The earlier
    /// ADR-0028 widened the rule from "one source file" to "one package";
    /// the message text matches the package-scoped rule the binder actually
    /// enforces.
    /// </summary>
    /// <param name="location">A location in one of the offending files.</param>
    public void ReportMultipleTopLevelFiles(TextLocation location)
    {
        var message = "Top-level statements may appear in at most one package per compilation.";
        Report(location, "GS0165", message);
    }

    /// <summary>
    /// Reports that the compilation contains both top-level statements and an
    /// explicit Main function, which is ambiguous. ADR-0066 D6: this is a
    /// warning rather than an error — when both shapes coexist, the
    /// synthesized top-level entry point wins and the explicit Main is
    /// shadowed. C# behaves the same way (CS7022 is a warning).
    /// </summary>
    /// <param name="location">The location of the explicit Main function declaration.</param>
    public void ReportTopLevelStatementsConflictWithMain(TextLocation location)
    {
        var message = "The entry point of the program is global statements; ignoring the explicit Main function entry point.";
        Report(location, "GS0166", message, DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0066 D2: reports that top-level statements mix bare <c>return;</c> and
    /// <c>return &lt;expr&gt;;</c> shapes. The synthesized entry point has a
    /// single return type (either <c>void</c> or <c>int</c>), so the user must
    /// pick one return shape across all TLS.
    /// </summary>
    /// <param name="location">The location of the first offending return statement.</param>
    public void ReportTopLevelReturnShapeMismatch(TextLocation location)
    {
        var message = "Top-level statements mix bare `return;` and `return <expr>;`. Choose one return shape so the synthesized entry point has a single return type.";
        Report(location, "GS0287", message);
    }

    /// <summary>
    /// ADR-0067: reports that a field declaration inside a <c>struct</c>,
    /// <c>class</c>, or <c>shared</c> block was written without a leading
    /// <c>var</c> or <c>let</c> keyword. Field declarations now require
    /// one of these binding keywords to distinguish mutable (<c>var</c>)
    /// from read-only (<c>let</c>) storage and to keep type bodies
    /// visually consistent with property, event, and method members.
    /// </summary>
    /// <param name="location">The location of the offending token.</param>
    public void ReportFieldDeclarationRequiresVarOrLet(TextLocation location)
    {
        var message = "Field declarations require a 'var' (mutable), 'let' (read-only), or 'const' (compile-time constant) keyword.";
        Report(location, "GS0288", message);
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
    /// Reports that top-level statements within a single source file are not
    /// contiguous — they are split into two or more blocks separated by a
    /// type or function declaration (ADR-0066 deferred decision D5). Emitted
    /// as a <b>warning</b> so the established G# Go-style trailing-TLS
    /// idiom (decls first, then a single TLS block) keeps working
    /// unchanged, while genuinely interleaved layouts still surface a hint.
    /// </summary>
    /// <param name="location">The location of the misplaced top-level statement.</param>
    public void ReportTopLevelStatementsMustBeContiguous(TextLocation location)
    {
        var message = "Top-level statements should form a single contiguous block within a file — interleaving them with type or function declarations is hard to read.";
        Report(location, "GS0286", message, DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0066 deferred decision D4: reports that top-level statements appear
    /// in a compilation that produces a library, not an executable. Mirrors
    /// C#'s CS8805. Without this guard the binder would silently synthesize
    /// a <c>&lt;Main&gt;$</c> inside the emitted <c>.dll</c> that the runtime
    /// will never invoke.
    /// </summary>
    /// <param name="location">The location of the first offending top-level statement.</param>
    public void ReportTopLevelStatementsInLibrary(TextLocation location)
    {
        var message = "Top-level statements are not allowed in a library project. Set <OutputType>Exe</OutputType> on the project, or move the statements into an explicit `func Main()`.";
        Report(location, "GS0285", message);
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
    {
        Report(
            location,
            "GS0379",
            $"'{declaringTypeName}.{memberName}' is inaccessible due to its protection level: a 'protected' member is only accessible within '{declaringTypeName}' and types derived from it.");
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
    /// Issue #1016: GS0392 — a range/slice expression (<c>a[lo..hi]</c>) was
    /// applied to a value whose type cannot be sliced. Sliceable targets are
    /// arrays/slices, <c>string</c>, span-like types with an <c>int Length</c>
    /// (or <c>Count</c>) plus a <c>Slice(int, int)</c> method, and types with a
    /// <c>System.Range</c> indexer.
    /// </summary>
    /// <param name="location">The text location of the range expression.</param>
    /// <param name="type">The non-sliceable target type.</param>
    public void ReportTypeNotSliceable(TextLocation location, TypeSymbol type)
    {
        Report(location, "GS0392", $"Type '{type.Name}' cannot be sliced with a range ('..') expression.");
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
    /// GS0398: an unmanaged pointer (ADR-0122 / issue #1014) targets a
    /// pointee type that is not blittable. Only <c>void</c>-equivalent
    /// (<c>uint8</c>) and blittable primitive pointees (and pointers to
    /// them) are supported; pointers to managed reference types or
    /// non-blittable structs are rejected.
    /// </summary>
    /// <param name="location">The text location of the pointer type clause.</param>
    /// <param name="pointeeName">The illegal pointee type name.</param>
    public void ReportUnmanagedPointerIllegalPointee(TextLocation location, string pointeeName)
    {
        Report(location, "GS0398", $"Unmanaged pointer to '{pointeeName}' is not supported; the pointee must be a blittable primitive, a blittable value struct, or another pointer (ADR-0122).");
    }

    /// <summary>
    /// GS0399: a <c>stackalloc [n]T</c> expression (ADR-0124 / issue #1024)
    /// names an element type <c>T</c> that is not unmanaged/blittable. Stack
    /// buffers are raw, GC-untracked memory, so only blittable primitives
    /// (<c>int8</c>…<c>int64</c>, <c>uint8</c>…<c>uint64</c>, <c>nint</c>,
    /// <c>nuint</c>, <c>float32</c>, <c>float64</c>, <c>bool</c>, <c>char</c>)
    /// and pointers are permitted as the element type.
    /// </summary>
    /// <param name="location">The text location of the element-type identifier.</param>
    /// <param name="typeName">The illegal element type name.</param>
    public void ReportStackAllocElementTypeNotBlittable(TextLocation location, string typeName)
    {
        Report(location, "GS0399", $"'stackalloc' element type '{typeName}' must be a blittable/unmanaged type (a primitive or pointer); managed types are not supported (ADR-0124).");
    }

    /// <summary>
    /// GS0400: a <c>fixed</c> (pinning) statement (ADR-0125 / issue #1026)
    /// appears outside an <c>unsafe</c> context. A <c>fixed</c> statement binds
    /// a raw unmanaged pointer <c>*T</c> into the pinned buffer, which is only
    /// legal inside an <c>unsafe</c> context (consistent with ADR-0122).
    /// </summary>
    /// <param name="location">The text location of the <c>fixed</c> keyword.</param>
    public void ReportFixedRequiresUnsafeContext(TextLocation location)
    {
        Report(location, "GS0400", "A 'fixed' statement requires an 'unsafe' context (it binds a raw unmanaged pointer into the pinned buffer); place it inside an 'unsafe func', 'unsafe { … }' block, or 'unsafe' type (ADR-0125).");
    }

    /// <summary>
    /// GS0401: the source of a <c>fixed</c> (pinning) statement (ADR-0125 /
    /// issues #1026, #1043) is not a pinnable managed buffer. A managed array
    /// (<c>[]T</c>), a <c>string</c>, or a span-like type exposing a public
    /// instance <c>ref T GetPinnableReference()</c> (e.g. <c>System.Span[T]</c> /
    /// <c>System.ReadOnlySpan[T]</c>) can be pinned; the pointer's element type
    /// must also match the buffer's.
    /// </summary>
    /// <param name="location">The text location of the pinned source expression.</param>
    /// <param name="typeName">The unpinnable source type name.</param>
    public void ReportFixedSourceNotPinnable(TextLocation location, string typeName)
    {
        Report(location, "GS0401", $"A 'fixed' statement cannot pin a value of type '{typeName}'; the source must be a managed array ('[]T'), a 'string', or a span-like type with a public 'ref T GetPinnableReference()' (e.g. 'System.Span[T]'/'System.ReadOnlySpan[T]'), and the pointer's element type must match the buffer's (ADR-0125).");
    }

    /// <summary>
    /// GS0402: the operand of a prefix/postfix increment (<c>++</c>) or
    /// decrement (<c>--</c>) expression is not a writable lvalue (ADR-0126 /
    /// issue #1027). The operand must be a variable, field, array element, or
    /// indexer — the same set of targets accepted by a compound assignment.
    /// </summary>
    /// <param name="location">The text location of the offending operand.</param>
    /// <param name="operatorText">The increment/decrement operator text (<c>++</c> or <c>--</c>).</param>
    public void ReportInvalidIncrementDecrementTarget(TextLocation location, string operatorText)
    {
        Report(location, "GS0402", $"The operand of '{operatorText}' must be a writable variable, field, array element, or indexer (ADR-0126).");
    }

    /// <summary>
    /// GS0403: a <c>void</c>-element pointer (<c>*void</c>, the faithful mapping
    /// of C# <c>void*</c>; ADR-0122 §3 / issue #1033) was directly dereferenced
    /// (<c>*p</c>), indexed (<c>p[i]</c>), or used in pointer arithmetic
    /// (<c>p + i</c>, <c>p - i</c>, <c>p - q</c>). A <c>*void</c> carries no
    /// element type, so it must first be cast to a typed pointer <c>*T</c>
    /// (e.g. <c>*int32(p)</c>) before any of these operations.
    /// </summary>
    /// <param name="location">The text location of the offending operation.</param>
    /// <param name="operation">A short description of the rejected operation (e.g. "dereference", "index", "perform arithmetic on").</param>
    public void ReportVoidPointerOperationNotAllowed(TextLocation location, string operation)
    {
        Report(location, "GS0403", $"Cannot {operation} a void pointer '*void'; it has no element type. Cast it to a typed pointer first (e.g. '*int32(p)') (ADR-0122 §3).");
    }

    /// <summary>
    /// GS0404: a managed function-pointer type clause <c>*func(T) R</c>
    /// (ADR-0122 §9 / issue #1035) appears outside an <c>unsafe</c> context.
    /// Like the raw pointer <c>*T</c>, a function pointer is only legal inside
    /// an <c>unsafe</c> context.
    /// </summary>
    /// <param name="location">The text location of the leading <c>*</c>.</param>
    public void ReportUnmanagedPointerOutsideUnsafe(TextLocation location)
    {
        Report(location, "GS0404", "A managed function-pointer type '*func(...) R' requires an 'unsafe' context; place it inside an 'unsafe func', 'unsafe { … }' block, or 'unsafe' type (ADR-0122 §9).");
    }

    /// <summary>
    /// GS0405: <c>&amp;Method</c> (ADR-0122 §9 / issue #1035) produced a
    /// function pointer whose signature does not match the target
    /// function-pointer type, or the address-of operand was not a single
    /// static method group.
    /// </summary>
    /// <param name="location">The text location of the address-of expression.</param>
    /// <param name="detail">A short description of the mismatch.</param>
    public void ReportFunctionPointerAddressOfMismatch(TextLocation location, string detail)
    {
        Report(location, "GS0405", $"Cannot take the address of this method as a function pointer: {detail} (ADR-0122 §9).");
    }

    /// <summary>
    /// GS0406: a fixed-size buffer field <c>fixed name [N]T</c> (ADR-0122 §10 /
    /// issue #1035) appears outside an <c>unsafe</c> context.
    /// </summary>
    /// <param name="location">The text location of the <c>fixed</c> keyword.</param>
    public void ReportFixedBufferRequiresUnsafeContext(TextLocation location)
    {
        Report(location, "GS0406", "A fixed-size buffer field 'fixed name [N]T' requires an 'unsafe' context; declare it inside an 'unsafe struct' (ADR-0122 §10).");
    }
}
