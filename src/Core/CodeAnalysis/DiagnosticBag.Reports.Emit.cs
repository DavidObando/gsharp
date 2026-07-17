// <copyright file="DiagnosticBag.Reports.Emit.cs" company="GSharp">
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
    /// Reports an <c>@assembly:InternalsVisibleTo(...)</c> annotation whose
    /// single argument is not a string literal (the friend assembly name must
    /// be a compile-time constant known to gsc without full expression
    /// binding, since assembly attributes are resolved before type binding).
    /// </summary>
    /// <param name="location">The source location of the offending argument.</param>
    public void ReportAssemblyAnnotationArgumentNotStringLiteral(TextLocation location)
    => Report(location, DiagnosticDescriptors.AssemblyAnnotationArgumentNotStringLiteral);

    /// <summary>
    /// Issue #1921 code review: reports GS0466 when a named (property/field
    /// style) argument is used on a same-compilation user-defined attribute
    /// type. The emitter has no way to resolve the target member's CLR type
    /// for a type that hasn't been emitted yet, so named-arg emission for
    /// user attributes is not supported; rejecting it here at bind time turns
    /// what would otherwise be a silently-dropped argument into a clear
    /// compile error instead.
    /// </summary>
    /// <param name="location">The source location of the named argument.</param>
    /// <param name="attributeName">The display name of the attribute type.</param>
    /// <param name="argumentName">The name of the rejected named argument.</param>
    public void ReportNamedArgumentsNotSupportedOnUserAttribute(TextLocation location, string attributeName, string argumentName)
    => Report(location, DiagnosticDescriptors.NamedArgumentsNotSupportedOnUserAttribute, argumentName, attributeName);

    /// <summary>GS9001: Cannot take address of a non-lvalue expression.</summary>
    /// <param name="location">The text location of the <c>&amp;</c> operator.</param>
    /// <param name="expressionText">A textual representation of the offending expression.</param>
    public void ReportCannotTakeAddressOfNonLvalue(TextLocation location, string expressionText)
    => Report(location, DiagnosticDescriptors.CannotTakeAddressOfNonLvalue, expressionText);

    /// <summary>GS9005: Cannot take address of a constant.</summary>
    /// <param name="location">The text location of the <c>&amp;</c> operator.</param>
    /// <param name="constantName">The constant name.</param>
    public void ReportCannotTakeAddressOfConstant(TextLocation location, string constantName)
    => Report(location, DiagnosticDescriptors.CannotTakeAddressOfConstant, constantName);

    /// <summary>GS9006: Pointer type cannot be used as a field type.</summary>
    /// <param name="location">The text location of the field declaration.</param>
    /// <param name="typeName">The pointer type name.</param>
    public void ReportPointerTypeCannotBeFieldType(TextLocation location, string typeName)
    => Report(location, DiagnosticDescriptors.PointerTypeCannotBeFieldType, typeName);

    /// <summary>
    /// GS9008: issue #2330 — an unmanaged pointer (<c>*T</c>) bound by a
    /// <c>fixed</c> statement (ADR-0125 / issue #1026) is only valid for the
    /// lifetime of the pin: the pinned handle is released when the enclosing
    /// <c>fixed</c> block exits. A nested closure may run after that point
    /// (or, for local functions, be invoked repeatedly across further pins),
    /// so capturing the pointer would let it escape its declaring scope's
    /// lifetime — the same "escape" concern as the existing by-ref-like
    /// (<c>ref struct</c>) and managed-pointer (<c>ref T</c>) capture
    /// rejections, but for an unmanaged pointer instead. Rejected here, at
    /// capture analysis, rather than left to reach
    /// <c>CaptureBoxingRewriter</c>/emission, which previously crashed with
    /// GS9998 ("has no local slot") because the pointer variable is
    /// declaration-less (bound directly by <c>BoundFixedStatement</c>, not a
    /// <c>BoundVariableDeclaration</c>) and was never boxed.
    /// </summary>
    /// <param name="location">The text location of the capturing closure.</param>
    /// <param name="variableName">The captured fixed-pointer variable's name.</param>
    public void ReportFixedPointerCannotEscape(TextLocation location, string variableName)
    => Report(location, DiagnosticDescriptors.FixedPointerCannotEscape, variableName);

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
    => Report(location, DiagnosticDescriptors.UnmanagedPointerIllegalPointee, pointeeName);

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
    => Report(location, DiagnosticDescriptors.StackAllocElementTypeNotBlittable, typeName);

    /// <summary>
    /// GS0400: a <c>fixed</c> (pinning) statement (ADR-0125 / issue #1026)
    /// appears outside an <c>unsafe</c> context. A <c>fixed</c> statement binds
    /// a raw unmanaged pointer <c>*T</c> into the pinned buffer, which is only
    /// legal inside an <c>unsafe</c> context (consistent with ADR-0122).
    /// </summary>
    /// <param name="location">The text location of the <c>fixed</c> keyword.</param>
    public void ReportFixedRequiresUnsafeContext(TextLocation location)
    => Report(location, DiagnosticDescriptors.FixedRequiresUnsafeContext);

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
    => Report(location, DiagnosticDescriptors.FixedSourceNotPinnable, typeName);

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
    => Report(location, DiagnosticDescriptors.VoidPointerOperationNotAllowed, operation);

    /// <summary>
    /// GS0404: a managed function-pointer type clause <c>*func(T) R</c>
    /// (ADR-0122 §9 / issue #1035) appears outside an <c>unsafe</c> context.
    /// Like the raw pointer <c>*T</c>, a function pointer is only legal inside
    /// an <c>unsafe</c> context.
    /// </summary>
    /// <param name="location">The text location of the leading <c>*</c>.</param>
    public void ReportUnmanagedPointerOutsideUnsafe(TextLocation location)
    => Report(location, DiagnosticDescriptors.UnmanagedPointerOutsideUnsafe);

    /// <summary>
    /// GS0405: <c>&amp;Method</c> (ADR-0122 §9 / issue #1035) produced a
    /// function pointer whose signature does not match the target
    /// function-pointer type, or the address-of operand was not a single
    /// static method group.
    /// </summary>
    /// <param name="location">The text location of the address-of expression.</param>
    /// <param name="detail">A short description of the mismatch.</param>
    public void ReportFunctionPointerAddressOfMismatch(TextLocation location, string detail)
    => Report(location, DiagnosticDescriptors.FunctionPointerAddressOfMismatch, detail);

    /// <summary>
    /// GS0406: a fixed-size buffer field <c>fixed name [N]T</c> (ADR-0122 §10 /
    /// issue #1035) appears outside an <c>unsafe</c> context.
    /// </summary>
    /// <param name="location">The text location of the <c>fixed</c> keyword.</param>
    public void ReportFixedBufferRequiresUnsafeContext(TextLocation location)
    => Report(location, DiagnosticDescriptors.FixedBufferRequiresUnsafeContext);

    /// <summary>
    /// GS0407: a fixed-size buffer field's type was not a fixed-length array
    /// <c>[N]T</c> (ADR-0122 §10 / issue #1035).
    /// </summary>
    /// <param name="location">The text location of the field name.</param>
    /// <param name="fieldName">The field name.</param>
    public void ReportFixedBufferInvalidShape(TextLocation location, string fieldName)
    => Report(location, DiagnosticDescriptors.FixedBufferInvalidShape, fieldName, fieldName);

    /// <summary>
    /// GS0408: a fixed-size buffer field declared a non-positive length
    /// (ADR-0122 §10 / issue #1035).
    /// </summary>
    /// <param name="location">The text location of the field name.</param>
    /// <param name="fieldName">The field name.</param>
    /// <param name="length">The invalid length.</param>
    public void ReportFixedBufferInvalidLength(TextLocation location, string fieldName, int length)
    => Report(location, DiagnosticDescriptors.FixedBufferInvalidLength, fieldName, length);

    /// <summary>
    /// GS0409: a fixed-size buffer element type is not a supported blittable
    /// primitive (ADR-0122 §10 / issue #1035).
    /// </summary>
    /// <param name="location">The text location of the field name.</param>
    /// <param name="typeName">The unsupported element type name.</param>
    public void ReportFixedBufferElementTypeNotSupported(TextLocation location, string typeName)
    => Report(location, DiagnosticDescriptors.FixedBufferElementTypeNotSupported, typeName);

    /// <summary>
    /// GS0411: a count-inferred <c>stackalloc []T</c> expression (ADR-0124 /
    /// issue #1041) was written without a brace-delimited initializer, so the
    /// element count cannot be determined. The count-inferred shape takes its
    /// length from the initializer (<c>stackalloc []T{a, b, …}</c>); supply an
    /// initializer or spell the count explicitly (<c>stackalloc [n]T</c>).
    /// </summary>
    /// <param name="location">The text location of the stackalloc expression.</param>
    public void ReportStackAllocCountInferredWithoutInitializer(TextLocation location)
    => Report(location, DiagnosticDescriptors.StackAllocCountInferredWithoutInitializer);

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
    => Report(location, DiagnosticDescriptors.StackAllocInitializerLengthMismatch, expected, expected, actual);

    /// <summary>
    /// Reports an annotation whose name cannot be resolved to any type
    /// reachable from the declaring scope (ADR-0047 §3).
    /// </summary>
    /// <param name="location">The source location of the offending annotation name.</param>
    /// <param name="name">The unresolved annotation name as written in source.</param>
    public void ReportAttributeTypeNotFound(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.AttributeTypeNotFound, name, name, name);

    /// <summary>
    /// Reports an annotation whose name resolves to both <c>Foo</c> and
    /// <c>FooAttribute</c> in the declaring scope (ADR-0047 §3). The user
    /// must qualify the name to disambiguate.
    /// </summary>
    /// <param name="location">The source location of the offending annotation name.</param>
    /// <param name="name">The ambiguous annotation name as written in source.</param>
    public void ReportAmbiguousAttributeName(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.AmbiguousAttributeName, name, name, name);

    /// <summary>
    /// Reports an annotation whose resolved type does not derive from
    /// <c>System.Attribute</c> (ADR-0047 §3).
    /// </summary>
    /// <param name="location">The source location of the offending annotation.</param>
    /// <param name="typeName">The type name that fails the attribute check.</param>
    public void ReportNotAnAttributeType(TextLocation location, string typeName)
    => Report(location, DiagnosticDescriptors.NotAnAttributeType, typeName);

    /// <summary>
    /// Reports a use-site target qualifier that is valid in isolation but
    /// not permitted at the current declaration position (ADR-0047 §4).
    /// </summary>
    /// <param name="location">The source location of the offending target.</param>
    /// <param name="kind">The disallowed target kind text.</param>
    /// <param name="position">A human-readable description of the declaration position.</param>
    public void ReportAttributeTargetInvalidForPosition(TextLocation location, string kind, string position)
    => Report(location, DiagnosticDescriptors.AttributeTargetInvalidForPosition, kind, position);

    /// <summary>
    /// Reports an attribute argument whose value cannot be reduced to a
    /// compile-time constant of the recognised attribute-argument value
    /// space (ADR-0047 §3 / ECMA-335 II.23.3).
    /// </summary>
    /// <param name="location">The source location of the offending argument.</param>
    public void ReportAttributeArgumentNotConstant(TextLocation location)
    => Report(location, DiagnosticDescriptors.AttributeArgumentNotConstant);

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
    => Report(location, DiagnosticDescriptors.AttributeClassExplicitBase, baseName);

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
        var detail = string.IsNullOrEmpty(message)
            ? string.Empty
            : string.Format(DiagnosticDescriptors.ObsoleteUseDetailMessageFormat, message);
        ReportWithErrorPromotion(location, DiagnosticDescriptors.ObsoleteUse, isError, name, detail);
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
    => Report(location, DiagnosticDescriptors.AttributeReservedForCompiler, name);

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
    => Report(location, DiagnosticDescriptors.EnumeratorCancellationWrongType, parameterName, actualTypeName);

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
    => Report(location, DiagnosticDescriptors.EnumeratorCancellationNotAsyncSequence, parameterName);

    /// <summary>
    /// Reports GS0209 when an attribute is applied to a declaration whose CLR
    /// target is excluded by the attribute's <c>[AttributeUsage(ValidOn)]</c>.
    /// </summary>
    /// <param name="location">The annotation name location.</param>
    /// <param name="attributeName">The source-form attribute name.</param>
    /// <param name="position">A human description of the use-site declaration.</param>
    /// <param name="validOn">The flag set declared on the attribute class.</param>
    public void ReportAttributeUsageInvalidTarget(TextLocation location, string attributeName, string position, System.AttributeTargets validOn)
    => Report(location, DiagnosticDescriptors.AttributeUsageInvalidTarget, attributeName, position, validOn);

    /// <summary>
    /// Reports GS0210 when an attribute is applied more than once to the
    /// same target and its <c>[AttributeUsage(AllowMultiple = false)]</c>
    /// (the C# default) forbids duplicates.
    /// </summary>
    /// <param name="location">The location of the duplicate annotation.</param>
    /// <param name="attributeName">The source-form attribute name.</param>
    public void ReportAttributeUsageDuplicate(TextLocation location, string attributeName)
    => Report(location, DiagnosticDescriptors.AttributeUsageDuplicate, attributeName);

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
    => Report(location, DiagnosticDescriptors.DllImportNotSupported, name);

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
    => Report(location, DiagnosticDescriptors.ConditionalMethodMustReturnVoid, functionName);

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
    => Report(location, DiagnosticDescriptors.PointerTypeCannotBeParameterType, pointeeName, parameterName, pointeeName, parameterName, pointeeName, parameterName, pointeeName);

    /// <summary>
    /// Reports GS0322 when <c>@DllImport</c> is applied without a non-empty
    /// string library name as the first positional argument (ADR-0086 §3 / issue #727).
    /// </summary>
    /// <param name="location">The annotation location.</param>
    public void ReportDllImportMissingLibraryName(TextLocation location)
    => Report(location, DiagnosticDescriptors.DllImportMissingLibraryName);

    /// <summary>
    /// Reports GS0323 when a P/Invoke parameter or return type is not in the
    /// supported marshalling table (ADR-0086 §2 / issue #727).
    /// </summary>
    /// <param name="location">The offending type-clause location.</param>
    /// <param name="typeName">The display name of the unsupported type.</param>
    public void ReportPInvokeUnsupportedMarshallingType(TextLocation location, string typeName)
    => Report(location, DiagnosticDescriptors.PInvokeUnsupportedMarshallingType, typeName);

    /// <summary>
    /// Reports GS0324 when a function carries <c>@DllImport</c> but also has a
    /// managed body (ADR-0086 §1 / issue #727). P/Invoke stubs must use a
    /// <c>;</c> body marker.
    /// </summary>
    /// <param name="location">The body-block location.</param>
    /// <param name="functionName">The declared function name.</param>
    public void ReportPInvokeMustNotHaveBody(TextLocation location, string functionName)
    => Report(location, DiagnosticDescriptors.PInvokeMustNotHaveBody, functionName);

    /// <summary>
    /// Reports GS0325 when a function uses a <c>;</c> body marker but is not
    /// annotated with <c>@DllImport</c> (ADR-0086 §1 / issue #727). A
    /// semicolon-only body is reserved for P/Invoke declarations.
    /// </summary>
    /// <param name="location">The function-identifier location.</param>
    /// <param name="functionName">The declared function name.</param>
    public void ReportSemicolonBodyRequiresDllImport(TextLocation location, string functionName)
    => Report(location, DiagnosticDescriptors.SemicolonBodyRequiresDllImport, functionName);

    /// <summary>
    /// Reports GS0326 when <c>@DllImport</c> is applied to a function shape
    /// that v1 P/Invoke does not support — instance method, async, generic,
    /// extension function, ref-returning function (ADR-0086 §1).
    /// </summary>
    /// <param name="location">The function-identifier location.</param>
    /// <param name="functionName">The declared function name.</param>
    /// <param name="reason">A short reason for the rejection.</param>
    public void ReportDllImportInvalidFunctionShape(TextLocation location, string functionName, string reason)
    => Report(location, DiagnosticDescriptors.DllImportInvalidFunctionShape, functionName, reason);

    /// <summary>
    /// Reports GS0327 when a <c>CharSet:</c> argument to <c>@DllImport</c> is
    /// not a valid <see cref="System.Runtime.InteropServices.CharSet"/> member
    /// value (ADR-0086 §3).
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="value">The supplied raw value (display string).</param>
    public void ReportDllImportInvalidCharSet(TextLocation location, string value)
    => Report(location, DiagnosticDescriptors.DllImportInvalidCharSet, value);

    /// <summary>
    /// Reports GS0328 when a <c>CallingConvention:</c> argument to
    /// <c>@DllImport</c> is not a valid
    /// <see cref="System.Runtime.InteropServices.CallingConvention"/> member
    /// value (ADR-0086 §3).
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="value">The supplied raw value (display string).</param>
    public void ReportDllImportInvalidCallingConvention(TextLocation location, string value)
    => Report(location, DiagnosticDescriptors.DllImportInvalidCallingConvention, value);

    /// <summary>
    /// Reports GS0329 when the <c>EntryPoint:</c> argument to
    /// <c>@DllImport</c> is not a non-empty string literal (ADR-0086 §3).
    /// </summary>
    /// <param name="location">The argument location.</param>
    public void ReportDllImportInvalidEntryPoint(TextLocation location)
    => Report(location, DiagnosticDescriptors.DllImportInvalidEntryPoint);

    /// <summary>
    /// ADR-0092 / issue #758: GS0342 — a function carries both
    /// <c>@DllImport</c> and <c>@LibraryImport</c>. The two P/Invoke
    /// attribute shapes are mutually exclusive on the same declaration.
    /// </summary>
    /// <param name="location">The location of the offending function identifier.</param>
    /// <param name="functionName">The function name.</param>
    public void ReportPInvokeMixedDllAndLibraryImport(TextLocation location, string functionName)
    => Report(location, DiagnosticDescriptors.PInvokeMixedDllAndLibraryImport, functionName);

    /// <summary>
    /// ADR-0092 / issue #758: GS0343 — a <c>StringMarshalling:</c> argument
    /// to <c>@LibraryImport</c> is not a valid
    /// <see cref="System.Runtime.InteropServices.StringMarshalling"/> member
    /// value (<c>Utf8</c>, <c>Utf16</c>, or <c>Custom</c>).
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="value">The supplied raw value (display string).</param>
    public void ReportLibraryImportInvalidStringMarshalling(TextLocation location, string value)
    => Report(location, DiagnosticDescriptors.LibraryImportInvalidStringMarshalling, value);

    /// <summary>
    /// ADR-0092 / issue #758: GS0344 — an <c>@LibraryImport</c> function
    /// uses a <c>string</c> parameter or return type without specifying
    /// <c>StringMarshalling: StringMarshalling.Utf8</c> or
    /// <c>StringMarshalling.Utf16</c>. Unlike <c>@DllImport</c>,
    /// <c>@LibraryImport</c> does not infer a default; the stub generator
    /// must know which encoding to emit.
    /// </summary>
    /// <param name="location">The location of the offending function identifier.</param>
    /// <param name="functionName">The function name.</param>
    public void ReportLibraryImportRequiresStringMarshalling(TextLocation location, string functionName)
    => Report(location, DiagnosticDescriptors.LibraryImportRequiresStringMarshalling, functionName);

    /// <summary>
    /// ADR-0093 / issue #759: GS0346 — a <c>@StructLayout(...)</c>
    /// annotation supplies a <see cref="System.Runtime.InteropServices.LayoutKind"/>
    /// value other than <c>Sequential</c> or <c>Explicit</c>. <c>Auto</c>
    /// is rejected because Auto-layout types are not portable across
    /// the P/Invoke boundary (field reordering is permitted at load time).
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="value">The supplied raw value (display string).</param>
    public void ReportStructLayoutInvalidLayoutKind(TextLocation location, string value)
    => Report(location, DiagnosticDescriptors.StructLayoutInvalidLayoutKind, value);

    /// <summary>
    /// ADR-0093 / issue #759: GS0347 — a field of a type declared with
    /// <c>@StructLayout(LayoutKind.Explicit)</c> is missing the required
    /// <c>@FieldOffset(N)</c> annotation. Every field of an Explicit-layout
    /// type must declare its byte offset.
    /// </summary>
    /// <param name="location">The field-identifier location.</param>
    /// <param name="fieldName">The field name.</param>
    /// <param name="typeName">The owning struct or class name.</param>
    public void ReportFieldOffsetRequiredOnExplicitLayout(TextLocation location, string fieldName, string typeName)
    => Report(location, DiagnosticDescriptors.FieldOffsetRequiredOnExplicitLayout, fieldName, typeName);

    /// <summary>
    /// ADR-0093 / issue #759: GS0348 — a field carries a <c>@FieldOffset</c>
    /// annotation but its declaring type is not declared with
    /// <c>@StructLayout(LayoutKind.Explicit)</c>. Field offsets are only
    /// meaningful inside Explicit-layout types.
    /// </summary>
    /// <param name="location">The <c>@FieldOffset</c> annotation location.</param>
    /// <param name="fieldName">The field name.</param>
    /// <param name="typeName">The owning struct or class name.</param>
    public void ReportFieldOffsetInvalidOnNonExplicitLayout(TextLocation location, string fieldName, string typeName)
    => Report(location, DiagnosticDescriptors.FieldOffsetInvalidOnNonExplicitLayout, fieldName, typeName);

    /// <summary>
    /// ADR-0093 / issue #759: GS0349 — a struct or class type used in a
    /// P/Invoke parameter or return position is not blittable. The user
    /// must add <c>@StructLayout(LayoutKind.Sequential)</c> (or
    /// <c>Explicit</c>) and ensure every field has a blittable type.
    /// </summary>
    /// <param name="location">The offending type-clause location.</param>
    /// <param name="typeName">The display name of the offending type.</param>
    public void ReportPInvokeNonBlittableType(TextLocation location, string typeName)
    => Report(location, DiagnosticDescriptors.PInvokeNonBlittableType, typeName);

    /// <summary>
    /// ADR-0093 / issue #759: GS0350 — the integer argument of
    /// <c>@FieldOffset(N)</c> is not a non-negative <c>int32</c> constant.
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="value">The supplied raw value (display string).</param>
    public void ReportFieldOffsetInvalidValue(TextLocation location, string value)
    => Report(location, DiagnosticDescriptors.FieldOffsetInvalidValue, value);

    /// <summary>
    /// ADR-0093 / issue #759: GS0351 — a class type is used as the return
    /// type of a P/Invoke function. v1 supports class types only as
    /// parameters (passed by reference); the return-value ownership /
    /// allocation contract is deferred to a future ADR.
    /// </summary>
    /// <param name="location">The return-type clause location.</param>
    /// <param name="typeName">The class display name.</param>
    public void ReportPInvokeClassReturnNotSupported(TextLocation location, string typeName)
    => Report(location, DiagnosticDescriptors.PInvokeClassReturnNotSupported, typeName);

    /// <summary>
    /// ADR-0094 / issue #760: GS0352 — a <c>ref</c>/<c>out</c>/<c>in</c>
    /// parameter on a P/Invoke declaration uses a pointee type that is not
    /// byref-marshalling-compatible. The runtime marshals the parameter as
    /// <c>T*</c>, which requires the pointee to be blittable. The fix is
    /// to use a blittable primitive (e.g. <c>int32</c>, <c>int64</c>,
    /// <c>nint</c>) or a struct annotated with <c>@StructLayout</c> whose
    /// fields are all blittable. <c>ref string</c> in particular needs an
    /// explicit <c>nint</c> + <c>Marshal.PtrToStringUTF8</c> round trip;
    /// the runtime cannot infer the unmanaged encoding for a byref slot.
    /// </summary>
    /// <param name="location">The offending parameter-type-clause location.</param>
    /// <param name="parameterName">The parameter name (for the message).</param>
    /// <param name="pointeeTypeName">The unsupported pointee type display name.</param>
    public void ReportPInvokeNonBlittableByRefPointee(TextLocation location, string parameterName, string pointeeTypeName)
    => Report(location, DiagnosticDescriptors.PInvokeNonBlittableByRefPointee, parameterName, pointeeTypeName);

    /// <summary>
    /// ADR-0095 / issue #761: GS0353 — a delegate-typed parameter on a
    /// P/Invoke declaration is missing the
    /// <c>@UnmanagedFunctionPointer</c> attribute. Without that attribute
    /// the runtime cannot synthesize a stable function-pointer thunk for
    /// the delegate, and the call site has no way to communicate a
    /// calling convention to the native callee. The fix is to apply
    /// <c>@UnmanagedFunctionPointer(CallingConvention.Cdecl)</c> (or the
    /// appropriate calling convention) to the delegate declaration.
    /// </summary>
    /// <param name="location">The offending parameter-type-clause location.</param>
    /// <param name="parameterName">The parameter name (for the message).</param>
    /// <param name="delegateTypeName">The delegate type name.</param>
    public void ReportPInvokeDelegateMissingUnmanagedFunctionPointer(TextLocation location, string parameterName, string delegateTypeName)
    => Report(location, DiagnosticDescriptors.PInvokeDelegateMissingUnmanagedFunctionPointer, parameterName, delegateTypeName);

    /// <summary>
    /// ADR-0095 / issue #761: GS0354 — the calling convention named in a
    /// raw function-pointer type clause (<c>unmanaged[CC] (...) -&gt; R</c>)
    /// is not one of the supported values. The recognised conventions are
    /// <c>Cdecl</c>, <c>Stdcall</c>, <c>Thiscall</c>, <c>Fastcall</c>.
    /// </summary>
    /// <param name="location">The offending calling-convention identifier location.</param>
    /// <param name="name">The unrecognised identifier.</param>
    public void ReportFunctionPointerUnknownCallingConvention(TextLocation location, string name)
    => Report(location, DiagnosticDescriptors.FunctionPointerUnknownCallingConvention, name);

    /// <summary>
    /// ADR-0095 / issue #761: GS0355 — a delegate-typed value is being
    /// returned from a P/Invoke declaration. Returning a managed
    /// delegate from native code is not supported because the runtime
    /// would have to allocate a managed wrapper without knowing the
    /// lifetime contract of the function-pointer it received. The fix
    /// is to declare the return as <c>unmanaged[CC] (...) -&gt; R</c>
    /// (a raw function pointer) or <c>nint</c> (an opaque handle that
    /// the caller can wrap manually with
    /// <c>Marshal.GetDelegateForFunctionPointer</c>).
    /// </summary>
    /// <param name="location">The offending return-type-clause location.</param>
    /// <param name="delegateTypeName">The delegate type name.</param>
    public void ReportPInvokeDelegateReturnNotSupported(TextLocation location, string delegateTypeName)
    => Report(location, DiagnosticDescriptors.PInvokeDelegateReturnNotSupported, delegateTypeName);

    /// <summary>
    /// ADR-0095 / issue #761: GS0356 — a raw function-pointer type clause
    /// is missing its required calling-convention slot. The syntax is
    /// <c>unmanaged[CC] (T1, T2, ...) -&gt; R</c>; the <c>[CC]</c> bracket
    /// list is mandatory and the convention must be one of <c>Cdecl</c>,
    /// <c>Stdcall</c>, <c>Thiscall</c>, <c>Fastcall</c>.
    /// </summary>
    /// <param name="location">The offending location (typically the <c>unmanaged</c> keyword).</param>
    public void ReportFunctionPointerMissingCallingConvention(TextLocation location)
    => Report(location, DiagnosticDescriptors.FunctionPointerMissingCallingConvention);

    /// <summary>
    /// ADR-0096 / issue #762: GS0357 — the <c>UnmanagedType</c> value
    /// passed to <c>@MarshalAs(...)</c> is not in the v1 supported set.
    /// The supported values are <c>LPStr</c>, <c>LPWStr</c>,
    /// <c>LPUTF8Str</c>, <c>BStr</c>, <c>LPArray</c>, <c>SafeArray</c>,
    /// <c>I1</c>, <c>U1</c>, <c>I2</c>, <c>U2</c>, <c>I4</c>, <c>U4</c>,
    /// <c>I8</c>, <c>U8</c>, <c>Bool</c>, <c>VariantBool</c>,
    /// <c>SysInt</c>, <c>SysUInt</c>, <c>Struct</c>, <c>ByValTStr</c>,
    /// and <c>ByValArray</c>. Everything else (custom marshallers,
    /// <c>IUnknown</c>, <c>FunctionPtr</c>, …) is filed as a follow-up.
    /// </summary>
    /// <param name="location">The offending <c>@MarshalAs(...)</c> argument location.</param>
    /// <param name="value">The display text of the rejected value.</param>
    public void ReportMarshalAsUnsupportedUnmanagedType(TextLocation location, string value)
    => Report(location, DiagnosticDescriptors.MarshalAsUnsupportedUnmanagedType, value);

    /// <summary>
    /// ADR-0096 / issue #762: GS0358 — the resolved
    /// <see cref="System.Runtime.InteropServices.UnmanagedType"/> is
    /// not compatible with the parameter's G# type. Examples:
    /// <c>LPWStr</c> on an <c>int32</c>, <c>LPArray</c> on a
    /// <c>string</c>, <c>I4</c> on a <c>string</c>. The message
    /// includes the rejected pair so users can pick a compatible
    /// override from the table in ADR-0096 §3.
    /// </summary>
    /// <param name="location">The offending parameter type-clause location.</param>
    /// <param name="parameterName">The parameter name.</param>
    /// <param name="parameterType">The display name of the G# parameter type.</param>
    /// <param name="unmanagedType">The display name of the <see cref="System.Runtime.InteropServices.UnmanagedType"/> override.</param>
    public void ReportMarshalAsIncompatibleType(TextLocation location, string parameterName, string parameterType, string unmanagedType)
    => Report(location, DiagnosticDescriptors.MarshalAsIncompatibleType, unmanagedType, parameterName, parameterType);

    /// <summary>
    /// ADR-0096 / issue #762: GS0359 — the <c>@MarshalAs(...)</c>
    /// annotation is missing a knob that is mandatory for the chosen
    /// <see cref="System.Runtime.InteropServices.UnmanagedType"/>.
    /// Examples: <c>ByValTStr</c> requires <c>SizeConst</c>;
    /// <c>ByValArray</c> requires <c>SizeConst</c>; <c>LPArray</c>
    /// requires at least one of <c>SizeConst</c> or <c>SizeParamIndex</c>
    /// for the runtime to know the element count.
    /// </summary>
    /// <param name="location">The offending <c>@MarshalAs(...)</c> annotation location.</param>
    /// <param name="parameterName">The parameter name.</param>
    /// <param name="unmanagedType">The display name of the <see cref="System.Runtime.InteropServices.UnmanagedType"/> override.</param>
    /// <param name="missingArgument">The display name of the missing knob (e.g. <c>SizeConst</c>).</param>
    public void ReportMarshalAsMissingRequiredArgument(TextLocation location, string parameterName, string unmanagedType, string missingArgument)
    => Report(location, DiagnosticDescriptors.MarshalAsMissingRequiredArgument, unmanagedType, parameterName, missingArgument);

    /// <summary>
    /// ADR-0096 / issue #762: GS0360 — <c>@MarshalAs</c> is rejected on
    /// the offending P/Invoke parameter. The two cases reported under
    /// this code are:
    /// <list type="bullet">
    /// <item>The enclosing function is not a P/Invoke
    /// (<c>@DllImport</c> or <c>@LibraryImport</c>) declaration —
    /// <c>@MarshalAs</c> on a managed function's parameter has no
    /// CLR-defined meaning and is rejected to avoid silently dropping
    /// the user's intent.</item>
    /// <item>The enclosing function is a <c>@LibraryImport</c> stub and
    /// the offending parameter is a <c>string</c>. The outer marshalling
    /// stub uses the function-wide <c>StringMarshalling</c> knob to pick
    /// its encoding; a per-parameter override would require generating
    /// per-parameter outer-stub code, which v1.0 of <c>@LibraryImport</c>
    /// does not surface. Use <c>StringMarshalling</c> on the
    /// <c>@LibraryImport(...)</c> annotation instead.</item>
    /// </list>
    /// </summary>
    /// <param name="location">The offending <c>@MarshalAs(...)</c> annotation location.</param>
    /// <param name="parameterName">The parameter name.</param>
    /// <param name="reason">The case-specific reason (one of the bullets above).</param>
    public void ReportMarshalAsRejected(TextLocation location, string parameterName, string reason)
    => Report(location, DiagnosticDescriptors.MarshalAsRejected, parameterName, reason);

    /// <summary>
    /// Issue #2130: GS0473 — a lambda being converted to an expression tree
    /// uses a language construct that G# deliberately rejects in expression-
    /// tree form, matching the C#/Roslyn restriction model.
    /// </summary>
    /// <param name="location">The source location of the unsupported construct.</param>
    /// <param name="feature">The rejected construct description.</param>
    public void ReportExpressionTreeUnsupported(TextLocation location, string feature)
    => Report(location, DiagnosticDescriptors.ExpressionTreeUnsupported, feature);

    /// <summary>
    /// Issue #2130: GS0474 — a target <c>Expression[T]</c> uses a type
    /// argument that is not a delegate type, so a lambda cannot convert to it.
    /// </summary>
    /// <param name="location">The source location of the attempted conversion.</param>
    /// <param name="targetType">The invalid target type.</param>
    public void ReportExpressionTreeTargetMustBeDelegate(TextLocation location, TypeSymbol targetType)
    => Report(location, DiagnosticDescriptors.ExpressionTreeTargetMustBeDelegate, targetType);

    /// <summary>
    /// Issue #1336: GS0415 — a <c>sizeof(T)</c> expression names a type that is
    /// not an unmanaged type. <c>sizeof</c> measures the unmanaged byte size of
    /// its operand, so the operand must be a blittable primitive, an enum, a
    /// pointer, a blittable value struct, or a generic type parameter
    /// constrained <c>unmanaged</c>; managed reference types and non-blittable
    /// structs are rejected (mirrors C#'s <c>sizeof</c> over unmanaged types).
    /// </summary>
    /// <param name="location">The text location of the measured type clause.</param>
    /// <param name="typeName">The illegal measured type name.</param>
    public void ReportSizeOfRequiresUnmanagedType(TextLocation location, string typeName)
    => Report(location, DiagnosticDescriptors.SizeOfRequiresUnmanagedType, typeName);
}
