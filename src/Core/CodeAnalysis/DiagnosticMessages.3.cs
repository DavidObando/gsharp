// <copyright file="DiagnosticMessages.3.cs" company="GSharp">
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
    /// GS0407: a fixed-size buffer field's type was not a fixed-length array
    /// <c>[N]T</c> (ADR-0122 §10 / issue #1035).
    /// </summary>
    /// <param name="location">The text location of the field name.</param>
    /// <param name="fieldName">The field name.</param>
    public void ReportFixedBufferInvalidShape(TextLocation location, string fieldName)
    {
        Report(location, "GS0407", $"Fixed-size buffer field '{fieldName}' must have a fixed-length array element type '[N]T' (e.g. 'fixed {fieldName} [8]int32') (ADR-0122 §10).");
    }

    /// <summary>
    /// GS0408: a fixed-size buffer field declared a non-positive length
    /// (ADR-0122 §10 / issue #1035).
    /// </summary>
    /// <param name="location">The text location of the field name.</param>
    /// <param name="fieldName">The field name.</param>
    /// <param name="length">The invalid length.</param>
    public void ReportFixedBufferInvalidLength(TextLocation location, string fieldName, int length)
    {
        Report(location, "GS0408", $"Fixed-size buffer field '{fieldName}' must have a positive length; '{length}' is not allowed (ADR-0122 §10).");
    }

    /// <summary>
    /// GS0409: a fixed-size buffer element type is not a supported blittable
    /// primitive (ADR-0122 §10 / issue #1035).
    /// </summary>
    /// <param name="location">The text location of the field name.</param>
    /// <param name="typeName">The unsupported element type name.</param>
    public void ReportFixedBufferElementTypeNotSupported(TextLocation location, string typeName)
    {
        Report(location, "GS0409", $"Fixed-size buffer element type '{typeName}' is not supported; use a blittable primitive (bool, int8…int64, uint8…uint64, char, float32, float64) (ADR-0122 §10).");
    }

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
    {
        Report(location, "GS0410", "A from-end index marker '^' is only valid inside index brackets (e.g. 'arr[^1]' or 'arr[a..^b]') or after '..' in a standalone range upper bound ('a..^b'); a standalone range cannot start with '^'. Use an indexer, or parenthesise a one's-complement bound ('(^a)..b') (issue #1038).");
    }

    /// <summary>
    /// GS0411: a count-inferred <c>stackalloc []T</c> expression (ADR-0124 /
    /// issue #1041) was written without a brace-delimited initializer, so the
    /// element count cannot be determined. The count-inferred shape takes its
    /// length from the initializer (<c>stackalloc []T{a, b, …}</c>); supply an
    /// initializer or spell the count explicitly (<c>stackalloc [n]T</c>).
    /// </summary>
    /// <param name="location">The text location of the stackalloc expression.</param>
    public void ReportStackAllocCountInferredWithoutInitializer(TextLocation location)
    {
        Report(location, "GS0411", "A count-inferred 'stackalloc []T' requires a brace-delimited initializer to determine its length (e.g. 'stackalloc []int32{1, 2, 3}'); supply an initializer or spell the count explicitly ('stackalloc [n]T') (ADR-0124 / issue #1041).");
    }

    /// <summary>
    /// GS0412: a <c>stackalloc [n]T{…}</c> expression (ADR-0124 / issue #1041)
    /// gave an explicit constant count <c>n</c> that disagrees with the number
    /// of initializer elements. As in C#, the explicit length and the
    /// initializer element count must match exactly; use the count-inferred
    /// shape (<c>stackalloc []T{…}</c>) to avoid repeating the length.
    /// </summary>
    /// <param name="location">The text location of the stackalloc expression.</param>
    /// <param name="expected">The explicit count <c>n</c>.</param>
    /// <param name="actual">The number of initializer elements.</param>
    public void ReportStackAllocInitializerLengthMismatch(TextLocation location, int expected, int actual)
    {
        Report(location, "GS0412", $"A 'stackalloc [{expected}]T{{…}}' initializer must supply exactly {expected} element(s), but {actual} were given; the explicit count and the initializer length must match (ADR-0124 / issue #1041).");
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

    /// <summary>
    /// Reports that a <c>nameof(...)</c> argument is not a valid name
    /// reference (it must denote an identifier, member access, or type).
    /// </summary>
    /// <param name="location">The text location of the argument.</param>
    public void ReportNameOfRequiresNameReference(TextLocation location)
    {
        Report(location, "GS0190", "The argument to 'nameof' must be a name reference: an identifier, member access, or type.");
    }

    /// <summary>
    /// Reports a character literal that is missing a closing quote or
    /// whose body crosses a line terminator (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportUnterminatedCharLiteral(TextLocation location)
    {
        Report(location, "GS0191", "Unterminated character literal.");
    }

    /// <summary>
    /// Reports an empty character literal <c>''</c> (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportEmptyCharLiteral(TextLocation location)
    {
        Report(location, "GS0192", "Empty character literal; a character literal must contain exactly one code unit or escape.");
    }

    /// <summary>
    /// Reports a character literal containing more than one code unit
    /// (e.g. <c>'ab'</c>) per ADR-0046.
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportMultiCharCharLiteral(TextLocation location)
    {
        Report(location, "GS0193", "Character literal contains more than one code unit; use a string literal instead.");
    }

    /// <summary>
    /// Reports an unknown escape sequence inside a character literal
    /// (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    /// <param name="escapeChar">The unrecognised escape character.</param>
    public void ReportInvalidCharEscape(TextLocation location, char escapeChar)
    {
        Report(location, "GS0194", $"Unrecognised escape sequence '\\{escapeChar}' in character literal.");
    }

    /// <summary>
    /// Reports a malformed Unicode escape (<c>\\u</c>, <c>\\U</c>, or
    /// <c>\\x</c>) inside a character literal: too few hex digits, or in
    /// the case of <c>\\U</c>, a value outside the basic multilingual
    /// plane (ADR-0046).
    /// </summary>
    /// <param name="location">The literal's location.</param>
    public void ReportInvalidUnicodeEscape(TextLocation location)
    {
        Report(location, "GS0195", "Malformed Unicode escape in character literal.");
    }

    /// <summary>
    /// Reports an unrecognized backslash escape sequence inside a double-quoted
    /// string literal. Issue #531: interpreted strings now process C#/Go style
    /// escape sequences; any <c>\X</c> that is not in the recognized set is an
    /// error.
    /// </summary>
    /// <param name="location">The source location of the escape sequence.</param>
    /// <param name="escapeChar">The character following the backslash.</param>
    public void ReportInvalidStringEscape(TextLocation location, char escapeChar)
    {
        Report(location, "GS0269", $"Unrecognised escape sequence '\\{escapeChar}' in string literal.");
    }

    /// <summary>
    /// Reports an annotation lead-in (<c>@</c>) that is not followed by an
    /// identifier or a use-site target qualifier (ADR-0047 §1).
    /// </summary>
    /// <param name="location">The source location of the offending token.</param>
    public void ReportAnnotationExpected(TextLocation location)
    {
        Report(location, "GS0196", "Annotation name expected after '@'.");
    }

    /// <summary>
    /// Reports an annotation use-site target qualifier whose kind is not one
    /// of the canonical kinds defined in ADR-0047 §2 (<c>field</c>,
    /// <c>param</c>, <c>return</c>, <c>type</c>, <c>method</c>,
    /// <c>property</c>, <c>event</c>, <c>module</c>, <c>assembly</c>,
    /// <c>genericparam</c>).
    /// </summary>
    /// <param name="location">The source location of the offending kind identifier.</param>
    /// <param name="kind">The unrecognized kind text.</param>
    public void ReportAnnotationTargetInvalid(TextLocation location, string kind)
    {
        Report(location, "GS0197", $"Annotation target '{kind}' is not a recognized use-site kind. Expected one of: field, param, return, type, method, property, event, module, assembly, genericparam.");
    }

    /// <summary>
    /// Reports an annotation whose name cannot be resolved to any type
    /// reachable from the declaring scope (ADR-0047 §3).
    /// </summary>
    /// <param name="location">The source location of the offending annotation name.</param>
    /// <param name="name">The unresolved annotation name as written in source.</param>
    public void ReportAttributeTypeNotFound(TextLocation location, string name)
    {
        Report(location, "GS0198", $"Attribute type '{name}' could not be found. Looked up both '{name}' and '{name}Attribute'.");
    }

    /// <summary>
    /// Reports an annotation whose name resolves to both <c>Foo</c> and
    /// <c>FooAttribute</c> in the declaring scope (ADR-0047 §3). The user
    /// must qualify the name to disambiguate.
    /// </summary>
    /// <param name="location">The source location of the offending annotation name.</param>
    /// <param name="name">The ambiguous annotation name as written in source.</param>
    public void ReportAmbiguousAttributeName(TextLocation location, string name)
    {
        Report(location, "GS0199", $"Attribute name '{name}' is ambiguous between '{name}' and '{name}Attribute'. Qualify the name to disambiguate.");
    }

    /// <summary>
    /// Reports an annotation whose resolved type does not derive from
    /// <c>System.Attribute</c> (ADR-0047 §3).
    /// </summary>
    /// <param name="location">The source location of the offending annotation.</param>
    /// <param name="typeName">The type name that fails the attribute check.</param>
    public void ReportNotAnAttributeType(TextLocation location, string typeName)
    {
        Report(location, "GS0200", $"Type '{typeName}' is not an attribute class (it does not derive from System.Attribute).");
    }

    /// <summary>
    /// Reports a use-site target qualifier that is valid in isolation but
    /// not permitted at the current declaration position (ADR-0047 §4).
    /// </summary>
    /// <param name="location">The source location of the offending target.</param>
    /// <param name="kind">The disallowed target kind text.</param>
    /// <param name="position">A human-readable description of the declaration position.</param>
    public void ReportAttributeTargetInvalidForPosition(TextLocation location, string kind, string position)
    {
        Report(location, "GS0201", $"Attribute target '{kind}' is not valid on {position}.");
    }

    /// <summary>
    /// Reports an attribute argument whose value cannot be reduced to a
    /// compile-time constant of the recognised attribute-argument value
    /// space (ADR-0047 §3 / ECMA-335 II.23.3).
    /// </summary>
    /// <param name="location">The source location of the offending argument.</param>
    public void ReportAttributeArgumentNotConstant(TextLocation location)
    {
        Report(location, "GS0202", "Attribute arguments must be compile-time constants (primitive, string, typeof, enum, or 1-D array thereof).");
    }

    /// <summary>
    /// Reports a class declaration tagged with the <c>@Attribute</c>
    /// declaration sugar (ADR-0047 §5) that already declares an explicit
    /// base class other than <c>System.Attribute</c>. The implicit
    /// <c>System.Attribute</c> base imposed by the sugar conflicts with
    /// the user-supplied base.
    /// </summary>
    /// <param name="location">The location of the offending base-class identifier.</param>
    /// <param name="baseName">The user-supplied base-class name.</param>
    public void ReportAttributeClassExplicitBase(TextLocation location, string baseName)
    {
        Report(location, "GS0203", $"Class is tagged @Attribute and cannot also declare an explicit base class '{baseName}'. The @Attribute sugar implies ': System.Attribute'.");
    }

    /// <summary>
    /// Reports a reference to a symbol marked with
    /// <see cref="System.ObsoleteAttribute"/>. The diagnostic is a
    /// warning by default; if the attribute's <c>error</c> flag is set
    /// it is reported as an error (ADR-0047 §6).
    /// </summary>
    /// <param name="location">The source location of the use site.</param>
    /// <param name="name">The display name of the obsolete symbol.</param>
    /// <param name="message">The optional user message; may be <c>null</c>.</param>
    /// <param name="isError">When <c>true</c>, the diagnostic is reported as an error.</param>
    public void ReportObsoleteUse(TextLocation location, string name, string message, bool isError)
    {
        var text = string.IsNullOrEmpty(message)
            ? $"'{name}' is obsolete."
            : $"'{name}' is obsolete: '{message}'.";
        Report(location, "GS0204", text, isError ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// Reports a user-written annotation that names an attribute the
    /// compiler reserves for its own synthesis (ADR-0047 §6: the
    /// <c>Extension</c>, <c>AsyncStateMachine</c>, <c>CompilerGenerated</c>,
    /// <c>Nullable</c>, <c>NullableContext</c> family).
    /// </summary>
    /// <param name="location">The source location of the annotation.</param>
    /// <param name="name">The attribute name as written in source.</param>
    public void ReportAttributeReservedForCompiler(TextLocation location, string name)
    {
        Report(location, "GS0205", $"Attribute '{name}' is reserved for compiler synthesis and cannot be written in source.");
    }

    /// <summary>
    /// Reports GS0206 when an annotation lead-in (<c>@Name</c>) precedes a
    /// statement that does not accept annotations (only local
    /// <c>var</c>/<c>let</c>/<c>const</c> declarations do — see ADR-0047 §2
    /// and issue #187).
    /// </summary>
    /// <param name="location">The source location of the leading <c>@</c>.</param>
    public void ReportAnnotationsNotAllowedOnStatement(TextLocation location)
    {
        Report(location, "GS0206", "Annotations are only allowed on variable declarations (var/let/const), not on this statement.");
    }

    /// <summary>
    /// Reports GS0207 when <c>@EnumeratorCancellation</c> is applied to a
    /// parameter whose type is not <see cref="System.Threading.CancellationToken"/>
    /// (ADR-0047 §6 / ADR-0040: <c>EnumeratorCancellationAttribute</c> marks
    /// the cancellation-token parameter that the async-sequence rewriter
    /// threads through; non-token parameters cannot be threaded).
    /// </summary>
    /// <param name="location">The source location of the parameter declaration.</param>
    /// <param name="parameterName">The parameter's declared name.</param>
    /// <param name="actualTypeName">The parameter's declared type (display string).</param>
    public void ReportEnumeratorCancellationWrongType(TextLocation location, string parameterName, string actualTypeName)
    {
        Report(location, "GS0207", $"Parameter '{parameterName}' is annotated '@EnumeratorCancellation' but has type '{actualTypeName}'; only 'System.Threading.CancellationToken' parameters can carry this annotation.");
    }

    /// <summary>
    /// Reports GS0208 when <c>@EnumeratorCancellation</c> is applied to a
    /// parameter on a function whose return type is not an
    /// <c>async sequence</c> (i.e. <see cref="System.Collections.Generic.IAsyncEnumerable{T}"/>).
    /// The runtime only threads the per-enumerator cancellation token through
    /// <c>IAsyncEnumerable.GetAsyncEnumerator(CancellationToken)</c>, so the
    /// attribute is meaningless elsewhere (ADR-0040).
    /// </summary>
    /// <param name="location">The source location of the parameter declaration.</param>
    /// <param name="parameterName">The parameter's declared name.</param>
    public void ReportEnumeratorCancellationNotAsyncSequence(TextLocation location, string parameterName)
    {
        Report(location, "GS0208", $"Parameter '{parameterName}' is annotated '@EnumeratorCancellation' but its enclosing function is not an async sequence (does not return 'IAsyncEnumerable[T]').");
    }

    /// <summary>
    /// Reports GS0209 when an attribute is applied to a declaration whose CLR
    /// target is excluded by the attribute's <c>[AttributeUsage(ValidOn)]</c>.
    /// </summary>
    /// <param name="location">The annotation name location.</param>
    /// <param name="attributeName">The source-form attribute name.</param>
    /// <param name="position">A human description of the use-site declaration.</param>
    /// <param name="validOn">The flag set declared on the attribute class.</param>
    public void ReportAttributeUsageInvalidTarget(TextLocation location, string attributeName, string position, System.AttributeTargets validOn)
    {
        Report(location, "GS0209", $"Attribute '{attributeName}' is not valid on {position}; its [AttributeUsage] permits only: {validOn}.");
    }

    /// <summary>
    /// Reports GS0210 when an attribute is applied more than once to the
    /// same target and its <c>[AttributeUsage(AllowMultiple = false)]</c>
    /// (the C# default) forbids duplicates.
    /// </summary>
    /// <param name="location">The location of the duplicate annotation.</param>
    /// <param name="attributeName">The source-form attribute name.</param>
    public void ReportAttributeUsageDuplicate(TextLocation location, string attributeName)
    {
        Report(location, "GS0210", $"Duplicate attribute '{attributeName}'; this attribute type does not allow multiple applications (AllowMultiple = false).");
    }

    /// <summary>
    /// Reports GS0211. The diagnostic ID is reserved (issue #179 / ADR-0047 §6)
    /// for historical reasons — the v1.0 release flagged every use of
    /// <c>@DllImport</c> with it. ADR-0086 / issue #727 removed the blanket
    /// rejection; well-formed P/Invoke declarations now succeed and the
    /// remaining invalid-shape cases route through GS0322–GS0329. This
    /// fallback message is retained for callers that still report the old
    /// "not supported" path while a follow-up audits every call site; in the
    /// current codebase nothing fires it.
    /// </summary>
    /// <param name="location">The source location of the annotation.</param>
    /// <param name="name">The attribute name as written in source.</param>
    public void ReportDllImportNotSupported(TextLocation location, string name)
    {
        Report(location, "GS0211", $"Attribute '{name}' is reserved (ADR-0086 supersedes this rejection); use '@DllImport(\"library\")' on a function with a ';' body instead.");
    }

    /// <summary>
    /// Reports GS0212 when <c>[Conditional("SYMBOL")]</c> is applied to a
    /// function whose return type is not <c>void</c>. The CLR rule
    /// (matching C# <c>CS0578</c>) is that conditional-method calls may be
    /// elided at the call site, which is incompatible with a non-void result
    /// flowing into the surrounding expression. ADR-0047 §6 / issue #176.
    /// </summary>
    /// <param name="location">The source location of the function declaration.</param>
    /// <param name="functionName">The function's declared name.</param>
    public void ReportConditionalMethodMustReturnVoid(TextLocation location, string functionName)
    {
        Report(location, "GS0212", $"Function '{functionName}' is marked '@Conditional' but does not return 'void'; conditional methods must return 'void' because calls may be elided at the call site.");
    }

    /// <summary>GS9007: A type may contain at most one 'shared' block.</summary>
    /// <param name="location">The text location of the duplicate shared keyword.</param>
    public void ReportDuplicateSharedBlock(TextLocation location)
    {
        Report(location, "GS9007", "A type may contain at most one 'shared' block.");
    }

    /// <summary>
    /// ADR-0055: reports an interpolation hole whose alignment clause
    /// (<c>${expr,alignment}</c>) is not a constant integer.
    /// </summary>
    /// <param name="location">The text location of the offending hole.</param>
    /// <param name="text">The offending alignment text.</param>
    public void ReportInvalidInterpolationAlignment(TextLocation location, string text)
    {
        Report(location, "GS0220", $"Invalid interpolation alignment '{text}' (must be a constant integer).");
    }

    /// <summary>
    /// Issue #368: reports an interpolated string passed to an
    /// <c>[InterpolatedStringHandler]</c> parameter whose
    /// <c>[InterpolatedStringHandlerArgument]</c> forwarding could not be
    /// satisfied (an unknown referenced argument, a missing receiver, or no
    /// matching handler constructor).
    /// </summary>
    /// <param name="location">The text location of the interpolated argument.</param>
    /// <param name="reason">A human-readable description of the failure.</param>
    public void ReportInterpolatedStringHandlerArgument(TextLocation location, string reason)
    {
        Report(location, "GS0221", $"Cannot use the interpolated-string-handler argument: {reason}.");
    }

    /// <summary>
    /// ADR-0055: reports an interpolation hole (<c>${ … }</c>) that is never
    /// closed by a matching <c>}</c> before the end of the source.
    /// </summary>
    /// <param name="location">The text location of the unterminated hole.</param>
    public void ReportUnterminatedInterpolationHole(TextLocation location)
    {
        Report(location, "GS0222", "Unterminated interpolation hole; expected a closing '}'.");
    }

    /// <summary>
    /// ADR-0055: reports an empty interpolation hole (<c>${}</c>), which has no
    /// expression to evaluate.
    /// </summary>
    /// <param name="location">The text location of the empty hole.</param>
    public void ReportEmptyInterpolationHole(TextLocation location)
    {
        Report(location, "GS0223", "Empty interpolation hole; expected an expression between '${' and '}'.");
    }

    /// <summary>
    /// ADR-0055: reports an interpolation hole whose format clause is present
    /// but empty (<c>${expr:}</c>).
    /// </summary>
    /// <param name="location">The text location of the offending hole.</param>
    public void ReportEmptyInterpolationFormat(TextLocation location)
    {
        Report(location, "GS0224", "Empty format specifier; expected a format string after ':'.");
    }

    /// <summary>
    /// ADR-0055: reports a raw newline in the literal portion of an
    /// interpolated string. Newlines are only permitted inside <c>${ … }</c>
    /// holes, not in the literal text segments.
    /// </summary>
    /// <param name="location">The text location of the newline.</param>
    public void ReportNewlineInInterpolatedStringLiteral(TextLocation location)
    {
        Report(location, "GS0225", "Newline in the literal portion of an interpolated string; only '${ … }' holes may span lines.");
    }

    /// <summary>
    /// ADR-0056 §2: reports an attempt to assign through a read-only span
    /// element. A <c>ReadOnlySpan[T]</c> indexer is <c>ref readonly T</c>, so
    /// <c>span[i] = v</c> is not permitted (only <c>Span[T]</c> writes are).
    /// </summary>
    /// <param name="location">The text location of the offending assignment.</param>
    /// <param name="type">The read-only span type being written through.</param>
    public void ReportCannotAssignReadOnlySpanElement(TextLocation location, TypeSymbol type)
    {
        var message = $"Cannot assign through a read-only span element ('{type.Name}' is read-only).";
        Report(location, "GS0226", message);
    }

    /// <summary>
    /// ADR-0057 §P4: reports a documentation comment block that does not precede
    /// any documentable declaration (a "floating" doc comment).
    /// </summary>
    /// <param name="location">The text location of the floating documentation comment.</param>
    public void ReportFloatingDocumentationComment(TextLocation location)
    {
        Report(location, "GS0227", "Documentation comment is not attached to a declaration.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0057 §P4: reports a public API member that lacks documentation (opt-in via /warnondoc or similar mechanism).
    /// </summary>
    /// <param name="location">The text location of the undocumented declaration.</param>
    /// <param name="symbolName">The undocumented public symbol name.</param>
    public void ReportMissingDocumentation(TextLocation location, string symbolName)
    {
        Report(location, "GS0228", $"Missing documentation comment on public member '{symbolName}'.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0057 §P4: reports a @param or @typeparam tag whose name does not match
    /// any parameter in the documented member's signature.
    /// </summary>
    /// <param name="location">The text location of the documented declaration.</param>
    /// <param name="paramName">The unmatched parameter or type-parameter name.</param>
    /// <param name="symbolName">The documented symbol name.</param>
    public void ReportDocParamMismatch(TextLocation location, string paramName, string symbolName)
    {
        Report(location, "GS0229", $"Documentation @param '{paramName}' does not match any parameter of '{symbolName}'.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0057 §P4: reserved for unsupported Markdown constructs that cannot be
    /// represented in the documentation model.
    /// </summary>
    /// <param name="location">The text location of the unsupported Markdown construct.</param>
    /// <param name="detail">Details about the unsupported Markdown construct.</param>
    public void ReportUnsupportedDocumentationMarkdown(TextLocation location, string detail)
    {
        Report(location, "GS0230", $"Unsupported documentation Markdown: {detail}. Use ```xmldoc for complex XML-doc constructs.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// Reports GS0231 when a documentation comment contains an unknown block tag
    /// (e.g. <c>@return</c> instead of <c>@returns</c>).
    /// </summary>
    /// <param name="location">The location of the documentation comment.</param>
    /// <param name="tagName">The unrecognised tag text.</param>
    public void ReportUnknownDocumentationTag(TextLocation location, string tagName)
    {
        Report(location, "GS0231", $"Unknown documentation tag '{tagName}'. Valid tags are: @param, @typeparam, @returns, @remarks, @value, @exception, @seealso.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// Issue #410 / ADR-0029: reports that a synthesized data-struct member
    /// (<c>Equals</c>, <c>GetHashCode</c>, <c>ToString</c>, <c>op_Equality</c>,
    /// <c>op_Inequality</c>, or <c>Deconstruct</c>) was hand-written. The ADR
    /// forbids user-written versions so the contract of <c>data struct</c> is
    /// learnable and predictable.
    /// </summary>
    /// <param name="location">The text location of the member name.</param>
    /// <param name="typeName">The data struct type name.</param>
    /// <param name="memberName">The synthesized member name.</param>
    public void ReportDataStructSynthesizedMemberConflict(TextLocation location, string typeName, string memberName)
    {
        var message = $"Data struct '{typeName}' synthesizes member '{memberName}'; it cannot be declared explicitly.";
        Report(location, "GS0232", message);
    }

    /// <summary>
    /// ADR-0059 / issue #255: reports that a delegate declaration
    /// (<c>type Name = delegate …</c>) was not followed by a <c>func(...)</c>
    /// signature. Named delegates must take the shape
    /// <c>type Name = delegate func(params) ret</c>.
    /// </summary>
    /// <param name="location">The text location of the offending token.</param>
    public void ReportDelegateDeclarationRequiresFunc(TextLocation location)
    {
        Report(location, "GS0233", "Named delegate declaration requires 'func(...)' after 'delegate' (e.g. 'type Name = delegate func(sender Object, e EventArgs)').");
    }

    /// <summary>
    /// ADR-0059 / issue #255: reports a generic delegate declaration (e.g.
    /// <c>type Predicate[T any] = delegate func(value T) bool</c>) — generic
    /// delegate emit is not yet supported in v1 and is tracked as ADR-0059
    /// follow-up work.
    /// </summary>
    /// <param name="location">The text location of the delegate identifier.</param>
    /// <param name="typeName">The delegate type name.</param>
    public void ReportGenericDelegateNotSupported(TextLocation location, string typeName)
    {
        Report(location, "GS0234", $"Generic delegate declaration '{typeName}' is not yet supported; declare a non-generic named delegate type (ADR-0059 follow-up).");
    }

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
    {
        Report(location, "GS0235", $"Argument {argumentIndex} (parameter '{parameterName}') passes with ref-kind '{observed}' but the parameter is declared '{expected}'.");
    }

    /// <summary>
    /// ADR-0060: reports that an inline-declaration / discard form (<c>out var</c>, <c>out let</c>,
    /// or <c>out _</c>) was used outside an <c>out</c> argument position (e.g. with <c>ref</c>
    /// or <c>in</c>, or as a named-argument value, or in a non-argument expression position).
    /// </summary>
    /// <param name="location">The location of the offending construct.</param>
    public void ReportOutDeclarationOutsideOutArgument(TextLocation location)
    {
        Report(location, "GS0236", "An inline 'out var', 'out let', or 'out _' declaration is only allowed as an argument at an 'out' parameter position.");
    }

    /// <summary>
    /// ADR-0060 §5: reports an assignment to an <c>in</c> parameter inside the function body.
    /// </summary>
    /// <param name="location">The assignment location.</param>
    /// <param name="parameterName">The parameter name.</param>
    public void ReportCannotAssignToInParameter(TextLocation location, string parameterName)
    {
        Report(location, "GS0237", $"'in' parameter '{parameterName}' is read-only; remove the 'in' modifier on the declaration if mutation is intended.");
    }

    /// <summary>
    /// ADR-0060 §5: reports a return-path on which an <c>out</c> parameter has not been
    /// definitely assigned. The diagnostic locates the offending <c>return</c>.
    /// </summary>
    /// <param name="location">The location of the return statement (or the end-of-body for fall-through).</param>
    /// <param name="parameterName">The out parameter name.</param>
    public void ReportOutParameterNotAssigned(TextLocation location, string parameterName)
    {
        Report(location, "GS0238", $"Out parameter '{parameterName}' must be definitely assigned on every path before the function returns.");
    }

    /// <summary>
    /// ADR-0060 §8: user-facing twin of GS9003. Reports that a variable was passed by <c>ref</c>
    /// before being definitely assigned.
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="variableName">The variable name.</param>
    public void ReportVariableNotAssignedBeforeRef(TextLocation location, string variableName)
    {
        Report(location, "GS0239", $"Variable '{variableName}' is not definitely assigned before being passed by 'ref'.");
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
        Report(location, "GS0241", $"'ref'/'out'/'in' is not a legal modifier on the primary-constructor parameter '{parameterName}'; primary-ctor parameters materialize fields, and the CLR cannot store a managed pointer in a field. Move the constructor to an 'init(...)' body if a by-reference parameter is required.");
    }

    /// <summary>
    /// ADR-0060 §8: warns that a call passes a value at an <c>in</c> parameter position
    /// without the matching <c>in</c> modifier. The compiler does NOT silently spill the
    /// value; the user should write <c>in lvalue</c> or remove the <c>in</c> from the signature.
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="argumentIndex">The 1-based argument index.</param>
    /// <param name="parameterName">The parameter name on the callee.</param>
    public void ReportInArgumentMissingInModifier(TextLocation location, int argumentIndex, string parameterName)
    {
        Report(location, "GS0242", $"Argument {argumentIndex} (parameter '{parameterName}') is an 'in' parameter but the call does not use the 'in' modifier; pass 'in <lvalue>' or change the parameter to by-value.", DiagnosticSeverity.Warning);
    }

    /// <summary>
    /// ADR-0060 §2: rejects a managed-pointer type (`*T`) used as a parameter type. The CLR
    /// cannot encode a `*T` parameter without going through `ELEMENT_TYPE_BYREF` plus the
    /// matching attributes; use the keyword form (`ref name T` / `out name T` / `in name T`)
    /// to declare an explicit by-reference parameter.
    /// </summary>
    /// <param name="location">The parameter or type-clause location.</param>
    /// <param name="parameterName">The parameter name.</param>
    /// <param name="pointeeName">The pointee type name (e.g. "int32").</param>
    public void ReportPointerTypeCannotBeParameterType(TextLocation location, string parameterName, string pointeeName)
    {
        Report(location, "GS0243", $"Managed-pointer type '*{pointeeName}' is not a legal parameter type; use 'ref {parameterName} {pointeeName}', 'out {parameterName} {pointeeName}', or 'in {parameterName} {pointeeName}' instead.");
    }

    /// <summary>
    /// ADR-0060 §10: reports a ref-kind parameter on an <c>async</c>, <c>sequence</c>, or
    /// <c>async sequence</c> function. The state-machine rewriter cannot hoist a managed
    /// pointer into a field, so the parameter is rejected. (Same GS0226 family as the
    /// existing async/iterator restrictions.)
    /// </summary>
    /// <param name="location">The parameter location.</param>
    /// <param name="parameterName">The parameter name.</param>
    /// <param name="functionKind">"async", "sequence", or "async sequence".</param>
    public void ReportRefKindOnAsyncOrIterator(TextLocation location, string parameterName, string functionKind)
    {
        Report(location, "GS0226", $"Ref-kind parameter '{parameterName}' cannot appear on a {functionKind} function.");
    }

    /// <summary>
    /// Issue #343: reports a positional call argument written after a named call
    /// argument. Named arguments must come last; positional → named ordering is
    /// fixed by the parser to support unambiguous matching against the parameter
    /// list.
    /// </summary>
    /// <param name="location">The location of the offending positional argument.</param>
    public void ReportPositionalArgumentAfterNamedArgument(TextLocation location)
    {
        Report(location, "GS0244", "Positional argument cannot follow a named argument.");
    }

    /// <summary>
    /// Issue #343: reports a duplicate named argument at a call site (e.g.
    /// <c>F(x: 1, x: 2)</c>). Each named argument's name must be unique.
    /// </summary>
    /// <param name="location">The location of the duplicate named argument.</param>
    /// <param name="name">The duplicated parameter name.</param>
    public void ReportDuplicateNamedArgument(TextLocation location, string name)
    {
        Report(location, "GS0245", $"Named argument '{name}' specified more than once.");
    }

    /// <summary>
    /// Issue #343: reports a named call argument whose name does not match any
    /// parameter of the resolved callee.
    /// </summary>
    /// <param name="location">The location of the offending named argument.</param>
    /// <param name="callee">The callee name (for diagnostic context).</param>
    /// <param name="name">The argument name that did not match any parameter.</param>
    public void ReportNamedArgumentParameterNotFound(TextLocation location, string callee, string name)
    {
        Report(location, "GS0246", $"Named argument '{name}' does not match any parameter of '{callee}'.");
    }

    /// <summary>
    /// Issue #343: reports a named call argument whose target parameter is
    /// already supplied by a positional argument earlier in the same call.
    /// </summary>
    /// <param name="location">The location of the offending named argument.</param>
    /// <param name="name">The parameter name that was double-bound.</param>
    public void ReportNamedArgumentAlsoSpecifiedPositionally(TextLocation location, string name)
    {
        Report(location, "GS0247", $"Named argument '{name}' specifies a value for parameter '{name}' which was already given a positional value.");
    }

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): a function declaration carries a <c>ref</c> return modifier
    /// without an explicit return type clause (e.g. <c>func foo() ref { ... }</c>).
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> modifier.</param>
    public void ReportRefReturnRequiresReturnType(TextLocation location)
    {
        Report(location, "GS0248", "A 'ref' return modifier requires an explicit return type clause (e.g. 'ref int32').");
    }

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): a <c>ref</c> return modifier was placed on an
    /// <c>async</c> or sequence/async-sequence function; the state-machine rewriter cannot
    /// hoist a managed pointer into a state-machine field (ELEMENT_TYPE_BYREF is illegal
    /// in field signatures — ADR-0058 §2).
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> modifier.</param>
    /// <param name="kind">"async", "sequence", or "async sequence".</param>
    public void ReportRefReturnOnAsyncOrIterator(TextLocation location, string kind)
    {
        Report(location, "GS0249", $"'ref' return is not legal on an {kind} function; the state-machine rewriter cannot hoist a managed pointer.");
    }

    /// <summary>
    /// Issue #490: a <c>ref</c>-returning function declares its return type as <c>*T</c>
    /// (a managed pointer). The two are redundant — write <c>ref T</c> instead of <c>ref *T</c>.
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> modifier.</param>
    public void ReportRefReturnOfByRefType(TextLocation location)
    {
        Report(location, "GS0250", "'ref' return modifier is redundant when the declared return type is already a managed pointer ('*T'); write 'ref T' instead.");
    }

    /// <summary>
    /// Issue #490: a <c>return ref expr</c> statement appears inside a function whose
    /// declaration does not carry the <c>ref</c> return modifier.
    /// </summary>
    /// <param name="location">The location of the <c>ref</c> keyword on the return statement.</param>
    /// <param name="functionName">The enclosing function name.</param>
    public void ReportRefReturnInNonRefReturningFunction(TextLocation location, string functionName)
    {
        Report(location, "GS0251", $"'return ref' is not allowed in '{functionName}' because its declaration does not specify a 'ref' return type.");
    }

    /// <summary>
    /// Issue #490: a plain <c>return expr</c> statement appears inside a <c>ref</c>-returning function.
    /// The body must use <c>return ref &lt;lvalue&gt;</c>.
    /// </summary>
    /// <param name="location">The location of the <c>return</c> keyword.</param>
    /// <param name="functionName">The enclosing function name.</param>
    public void ReportRefReturnRequiredOnRefReturningFunction(TextLocation location, string functionName)
    {
        Report(location, "GS0252", $"Function '{functionName}' returns by reference; use 'return ref <lvalue>' instead of a plain 'return'.");
    }
}
