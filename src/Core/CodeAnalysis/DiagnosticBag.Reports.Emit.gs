// <copyright file="DiagnosticBag.Reports.Emit.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

partial class DiagnosticBag : IEnumerable[Diagnostic] {
    /// Reports an `@assembly:InternalsVisibleTo(...)` annotation whose
    /// single argument is not a string literal (the friend assembly name must
    /// be a compile-time constant known to gsc without full expression
    /// binding, since assembly attributes are resolved before type binding).
    /// @param location The source location of the offending argument.
    func ReportAssemblyAnnotationArgumentNotStringLiteral(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.AssemblyAnnotationArgumentNotStringLiteral
    )

    /// Issue #1921 code review: reports GS0466 when a named (property/field
    /// style) argument is used on a same-compilation user-defined attribute
    /// type. The emitter has no way to resolve the target member's CLR type
    /// for a type that hasn't been emitted yet, so named-arg emission for
    /// user attributes is not supported; rejecting it here at bind time turns
    /// what would otherwise be a silently-dropped argument into a clear
    /// compile error instead.
    /// @param location The source location of the named argument.
    /// @param attributeName The display name of the attribute type.
    /// @param argumentName The name of the rejected named argument.
    func ReportNamedArgumentsNotSupportedOnUserAttribute(
        location TextLocation,
        attributeName string,
        argumentName string
    ) -> Report(location, DiagnosticDescriptors.NamedArgumentsNotSupportedOnUserAttribute, argumentName, attributeName)

    /// Reports an attribute constructor argument placed after a member assignment.
    /// @param location The source location of the constructor argument.
    func ReportAttributeConstructorArgumentAfterMemberAssignment(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.AttributeConstructorArgumentAfterMemberAssignment
    )

    /// GS9001: Cannot take address of a non-lvalue expression.
    /// @param location The text location of the `&` operator.
    /// @param expressionText A textual representation of the offending expression.
    func ReportCannotTakeAddressOfNonLvalue(location TextLocation, expressionText string) -> Report(
        location,
        DiagnosticDescriptors.CannotTakeAddressOfNonLvalue,
        expressionText
    )

    /// GS9005: Cannot take address of a constant.
    /// @param location The text location of the `&` operator.
    /// @param constantName The constant name.
    func ReportCannotTakeAddressOfConstant(location TextLocation, constantName string) -> Report(
        location,
        DiagnosticDescriptors.CannotTakeAddressOfConstant,
        constantName
    )

    /// GS9006: Pointer type cannot be used as a field type.
    /// @param location The text location of the field declaration.
    /// @param typeName The pointer type name.
    func ReportPointerTypeCannotBeFieldType(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.PointerTypeCannotBeFieldType,
        typeName
    )

    /// GS9008: issue #2330 — an unmanaged pointer (`*T`) bound by a
    /// `fixed` statement (ADR-0125 / issue #1026) is only valid for the
    /// lifetime of the pin: the pinned handle is released when the enclosing
    /// `fixed` block exits. A nested closure may run after that point
    /// (or, for local functions, be invoked repeatedly across further pins),
    /// so capturing the pointer would let it escape its declaring scope's
    /// lifetime — the same "escape" concern as the existing by-ref-like
    /// (`ref struct`) and managed-pointer (`ref T`) capture
    /// rejections, but for an unmanaged pointer instead. Rejected here, at
    /// capture analysis, rather than left to reach
    /// `CaptureBoxingRewriter`/emission, which previously crashed with
    /// GS9998 ("has no local slot") because the pointer variable is
    /// declaration-less (bound directly by `BoundFixedStatement`, not a
    /// `BoundVariableDeclaration`) and was never boxed.
    /// @param location The text location of the capturing closure.
    /// @param variableName The captured fixed-pointer variable's name.
    func ReportFixedPointerCannotEscape(location TextLocation, variableName string) -> Report(
        location,
        DiagnosticDescriptors.FixedPointerCannotEscape,
        variableName
    )

    /// GS0398: an unmanaged pointer (ADR-0122 / issue #1014) targets a
    /// pointee type that is not blittable. Only `void`-equivalent
    /// (`uint8`) and blittable primitive pointees (and pointers to
    /// them) are supported; pointers to managed reference types or
    /// non-blittable structs are rejected.
    /// @param location The text location of the pointer type clause.
    /// @param pointeeName The illegal pointee type name.
    func ReportUnmanagedPointerIllegalPointee(location TextLocation, pointeeName string) -> Report(
        location,
        DiagnosticDescriptors.UnmanagedPointerIllegalPointee,
        pointeeName
    )

    /// GS0399: a `stackalloc [n]T` expression (ADR-0124 / issue #1024)
    /// names an element type `T` that is not unmanaged/blittable. Stack
    /// buffers are raw, GC-untracked memory, so only blittable primitives
    /// (`int8`…`int64`, `uint8`…`uint64`, `nint`,
    /// `nuint`, `float32`, `float64`, `bool`, `char`)
    /// and pointers are permitted as the element type.
    /// @param location The text location of the element-type identifier.
    /// @param typeName The illegal element type name.
    func ReportStackAllocElementTypeNotBlittable(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.StackAllocElementTypeNotBlittable,
        typeName
    )

    /// GS0400: a `fixed` (pinning) statement (ADR-0125 / issue #1026)
    /// appears outside an `unsafe` context. A `fixed` statement binds
    /// a raw unmanaged pointer `*T` into the pinned buffer, which is only
    /// legal inside an `unsafe` context (consistent with ADR-0122).
    /// @param location The text location of the `fixed` keyword.
    func ReportFixedRequiresUnsafeContext(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.FixedRequiresUnsafeContext
    )

    /// GS0401: the source of a `fixed` (pinning) statement (ADR-0125 /
    /// issues #1026, #1043) is not a pinnable managed buffer. A managed array
    /// (`[]T`), a `string`, a span-like type exposing a public
    /// instance `ref T GetPinnableReference()` (e.g. `System.Span[T]` /
    /// `System.ReadOnlySpan[T]`), or a fixed-size buffer field of a
    /// variable (issue #4378) can be pinned; the pointer's element type must
    /// also match the buffer's.
    /// @param location The text location of the pinned source expression.
    /// @param typeName The unpinnable source type name.
    func ReportFixedSourceNotPinnable(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.FixedSourceNotPinnable,
        typeName
    )

    /// GS0507 (ADR-0125 amendment, issue #4378): a `fixed` statement pins a
    /// fixed-size buffer field reached through an already-fixed variable (a
    /// local, a by-value parameter, or a pointer dereference). Such storage
    /// cannot move, so there is nothing to pin — the buffer is used directly as
    /// a pointer. Mirrors C#'s CS0213.
    /// @param location The text location of the pinned source expression.
    /// @param bufferName The fixed-size buffer field name.
    func ReportFixedBufferAlreadyFixed(location TextLocation, bufferName string) -> Report(
        location,
        DiagnosticDescriptors.FixedBufferAlreadyFixed,
        bufferName
    )

    /// GS0506: an `await` or `yield` suspension point appears in a
    /// `fixed` body. A pinned local cannot survive state-machine
    /// suspension, so the suspension must move outside the fixed statement.
    /// @param location The location of the `await` or `yield` keyword.
    /// @param keyword The rejected keyword.
    func ReportFixedStatementCannotSuspend(location TextLocation, keyword string) -> Report(
        location,
        DiagnosticDescriptors.FixedStatementCannotSuspend,
        keyword
    )

    /// GS0519: a default interpolated-string hole has a ByRefLike type without
    /// a usable parameterless `ToString()` method. Generic
    /// `AppendFormatted<T>` cannot close over stack-only values.
    /// @param location The source location of the interpolation hole.
    /// @param type The rejected ByRefLike type.
    func ReportByRefLikeInterpolationUnsupported(location TextLocation, type TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.ByRefLikeInterpolationUnsupported,
        type
    )

    /// GS0545 (issue #3730): the framework the compilation references does not
    /// declare the `DefaultInterpolatedStringHandler` surface interpolated
    /// strings lower onto. Previously the lowering read that surface off the
    /// SDK <em>hosting</em> gsc, so a target lacking the handler still compiled
    /// — emitting a `TypeRef` scoped to the host's
    /// `System.Private.CoreLib` and reporting success.
    /// @param location The source location of the interpolated string or hole.
    /// @param missingMember The handler type or member the target framework does not provide.
    func ReportInterpolatedStringHandlerUnavailable(location TextLocation, missingMember string) -> Report(
        location,
        DiagnosticDescriptors.InterpolatedStringHandlerUnavailable,
        missingMember
    )

    /// GS0403: a `void`-element pointer (`*void`, the faithful mapping
    /// of C# `void*`; ADR-0122 §3 / issue #1033) was directly dereferenced
    /// (`*p`), indexed (`p[i]`), or used in pointer arithmetic
    /// (`p + i`, `p - i`, `p - q`). A `*void` carries no
    /// element type, so it must first be cast to a typed pointer `*T`
    /// (e.g. `*int32(p)`) before any of these operations.
    /// @param location The text location of the offending operation.
    /// @param operation A short description of the rejected operation (e.g. "dereference", "index",
    /// "perform arithmetic on").
    func ReportVoidPointerOperationNotAllowed(location TextLocation, operation string) -> Report(
        location,
        DiagnosticDescriptors.VoidPointerOperationNotAllowed,
        operation
    )

    /// GS0404: a managed function-pointer type clause `*func(T) R`
    /// (ADR-0122 §9 / issue #1035) appears outside an `unsafe` context.
    /// Like the raw pointer `*T`, a function pointer is only legal inside
    /// an `unsafe` context.
    /// @param location The text location of the leading `*`.
    func ReportUnmanagedPointerOutsideUnsafe(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.UnmanagedPointerOutsideUnsafe
    )

    /// GS0405: `&Method` (ADR-0122 §9 / issue #1035) produced a
    /// function pointer whose signature does not match the target
    /// function-pointer type, or the address-of operand was not a single
    /// static method group.
    /// @param location The text location of the address-of expression.
    /// @param detail A short description of the mismatch.
    func ReportFunctionPointerAddressOfMismatch(location TextLocation, detail string) -> Report(
        location,
        DiagnosticDescriptors.FunctionPointerAddressOfMismatch,
        detail
    )

    /// GS0406: a fixed-size buffer field `fixed name [N]T` (ADR-0122 §10 /
    /// issue #1035) appears outside an `unsafe` context.
    /// @param location The text location of the `fixed` keyword.
    func ReportFixedBufferRequiresUnsafeContext(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.FixedBufferRequiresUnsafeContext
    )

    /// GS0407: a fixed-size buffer field's type was not a fixed-length array
    /// `[N]T` (ADR-0122 §10 / issue #1035).
    /// @param location The text location of the field name.
    /// @param fieldName The field name.
    func ReportFixedBufferInvalidShape(location TextLocation, fieldName string) -> Report(
        location,
        DiagnosticDescriptors.FixedBufferInvalidShape,
        fieldName,
        fieldName
    )

    /// GS0408: a fixed-size buffer field declared a non-positive length
    /// (ADR-0122 §10 / issue #1035).
    /// @param location The text location of the field name.
    /// @param fieldName The field name.
    /// @param length The invalid length.
    func ReportFixedBufferInvalidLength(location TextLocation, fieldName string, length int32) -> Report(
        location,
        DiagnosticDescriptors.FixedBufferInvalidLength,
        fieldName,
        length
    )

    /// GS0409: a fixed-size buffer element type is not a supported blittable
    /// primitive (ADR-0122 §10 / issue #1035).
    /// @param location The text location of the field name.
    /// @param typeName The unsupported element type name.
    func ReportFixedBufferElementTypeNotSupported(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.FixedBufferElementTypeNotSupported,
        typeName
    )

    /// GS0411: a count-inferred `stackalloc []T` expression (ADR-0124 /
    /// issue #1041) was written without a brace-delimited initializer, so the
    /// element count cannot be determined. The count-inferred shape takes its
    /// length from the initializer (`stackalloc []T{a, b, …}`); supply an
    /// initializer or spell the count explicitly (`stackalloc [n]T`).
    /// @param location The text location of the stackalloc expression.
    func ReportStackAllocCountInferredWithoutInitializer(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.StackAllocCountInferredWithoutInitializer
    )

    /// GS0412: a `stackalloc [n]T{…}` expression (ADR-0124 / issue #1041)
    /// gave an explicit constant count `n` that disagrees with the number
    /// of initializer elements. As in C#, the explicit length and the
    /// initializer element count must match exactly; use the count-inferred
    /// shape (`stackalloc []T{…}`) to avoid repeating the length.
    /// @param location The text location of the stackalloc expression.
    /// @param expected The explicit count `n`.
    /// @param actual The number of initializer elements.
    func ReportStackAllocInitializerLengthMismatch(location TextLocation, expected int32, actual int32) -> Report(
        location,
        DiagnosticDescriptors.StackAllocInitializerLengthMismatch,
        expected,
        expected,
        actual
    )

    /// Reports an annotation whose name cannot be resolved to any type
    /// reachable from the declaring scope (ADR-0047 §3).
    /// @param location The source location of the offending annotation name.
    /// @param name The unresolved annotation name as written in source.
    func ReportAttributeTypeNotFound(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.AttributeTypeNotFound,
        name,
        name,
        name
    )

    /// Reports an annotation whose name resolves to both `Foo` and
    /// `FooAttribute` in the declaring scope (ADR-0047 §3). The user
    /// must qualify the name to disambiguate.
    /// @param location The source location of the offending annotation name.
    /// @param name The ambiguous annotation name as written in source.
    func ReportAmbiguousAttributeName(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.AmbiguousAttributeName,
        name,
        name,
        name
    )

    /// Reports an annotation whose resolved type does not derive from
    /// `System.Attribute` (ADR-0047 §3).
    /// @param location The source location of the offending annotation.
    /// @param typeName The type name that fails the attribute check.
    func ReportNotAnAttributeType(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.NotAnAttributeType,
        typeName
    )

    /// Reports a use-site target qualifier that is valid in isolation but
    /// not permitted at the current declaration position (ADR-0047 §4).
    /// @param location The source location of the offending target.
    /// @param kind The disallowed target kind text.
    /// @param position A human-readable description of the declaration position.
    func ReportAttributeTargetInvalidForPosition(location TextLocation, kind string, position string) -> Report(
        location,
        DiagnosticDescriptors.AttributeTargetInvalidForPosition,
        kind,
        position
    )

    /// Reports an attribute argument whose value cannot be reduced to a
    /// compile-time constant of the recognised attribute-argument value
    /// space (ADR-0047 §3 / ECMA-335 II.23.3).
    /// @param location The source location of the offending argument.
    func ReportAttributeArgumentNotConstant(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.AttributeArgumentNotConstant
    )

    /// Issue #4143: reports a parameter of an attribute class's own
    /// constructor (primary or explicit) whose declared type is not a valid
    /// attribute parameter type (C#'s CS0181), on the attribute class's
    /// declaration rather than on any particular use site.
    /// @param location The source location of the offending parameter.
    /// @param parameterName The offending parameter's name.
    /// @param typeName The offending parameter's declared type name.
    func ReportAttributeConstructorParameterInvalidType(
        location TextLocation,
        parameterName string,
        typeName string
    ) -> Report(location, DiagnosticDescriptors.AttributeConstructorParameterInvalidType, parameterName, typeName)

    /// Reports a class declaration tagged with the `@Attribute`
    /// declaration sugar (ADR-0047 §5) that already declares an explicit
    /// base class other than `System.Attribute`. The implicit
    /// `System.Attribute` base imposed by the sugar conflicts with
    /// the user-supplied base.
    /// @param location The location of the offending base-class identifier.
    /// @param baseName The user-supplied base-class name.
    func ReportAttributeClassExplicitBase(location TextLocation, baseName string) -> Report(
        location,
        DiagnosticDescriptors.AttributeClassExplicitBase,
        baseName
    )

    /// Reports a reference to a symbol marked with
    /// (cref:System.ObsoleteAttribute). The diagnostic is a
    /// warning by default; if the attribute's `error` flag is set
    /// it is reported as an error (ADR-0047 §6).
    /// @param location The source location of the use site.
    /// @param name The display name of the obsolete symbol.
    /// @param message The optional user message; may be `null`.
    /// @param isError When `true`, the diagnostic is reported as an error.
    func ReportObsoleteUse(location TextLocation, name string, message string?, isError bool) {
        let detail = if string.IsNullOrEmpty(message) {
            string.Empty
        } else {
            string.Format(DiagnosticDescriptors.ObsoleteUseDetailMessageFormat, message)
        }
        ReportWithErrorPromotion(location, DiagnosticDescriptors.ObsoleteUse, isError, name, detail)
    }

    /// Reports a user-written annotation that names an attribute the
    /// compiler reserves for its own synthesis (ADR-0047 §6: the
    /// `Extension`, `AsyncStateMachine`, `CompilerGenerated`,
    /// `Nullable`, `NullableContext` family).
    /// @param location The source location of the annotation.
    /// @param name The attribute name as written in source.
    func ReportAttributeReservedForCompiler(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.AttributeReservedForCompiler,
        name
    )

    /// Reports GS0207 when `@EnumeratorCancellation` is applied to a
    /// parameter whose type is not (cref:System.Threading.CancellationToken)
    /// (ADR-0047 §6 / ADR-0040: `EnumeratorCancellationAttribute` marks
    /// the cancellation-token parameter that the async-sequence rewriter
    /// threads through; non-token parameters cannot be threaded).
    /// @param location The source location of the parameter declaration.
    /// @param parameterName The parameter's declared name.
    /// @param actualTypeName The parameter's declared type (display string).
    func ReportEnumeratorCancellationWrongType(
        location TextLocation,
        parameterName string,
        actualTypeName string
    ) -> Report(location, DiagnosticDescriptors.EnumeratorCancellationWrongType, parameterName, actualTypeName)

    /// Reports GS0208 when `@EnumeratorCancellation` is applied to a
    /// parameter on a function whose return type is not an
    /// `async sequence` (i.e. (cref:System.Collections.Generic.IAsyncEnumerable{T})).
    /// The runtime only threads the per-enumerator cancellation token through
    /// `IAsyncEnumerable.GetAsyncEnumerator(CancellationToken)`, so the
    /// attribute is meaningless elsewhere (ADR-0040).
    /// @param location The source location of the parameter declaration.
    /// @param parameterName The parameter's declared name.
    func ReportEnumeratorCancellationNotAsyncSequence(location TextLocation, parameterName string) -> Report(
        location,
        DiagnosticDescriptors.EnumeratorCancellationNotAsyncSequence,
        parameterName
    )

    /// Reports GS0209 when an attribute is applied to a declaration whose CLR
    /// target is excluded by the attribute's `[AttributeUsage(ValidOn)]`.
    /// @param location The annotation name location.
    /// @param attributeName The source-form attribute name.
    /// @param position A human description of the use-site declaration.
    /// @param validOn The flag set declared on the attribute class.
    func ReportAttributeUsageInvalidTarget(
        location TextLocation,
        attributeName string,
        position string,
        validOn AttributeTargets
    ) -> Report(location, DiagnosticDescriptors.AttributeUsageInvalidTarget, attributeName, position, validOn)

    /// Reports GS0210 when an attribute is applied more than once to the
    /// same target and its `[AttributeUsage(AllowMultiple = false)]`
    /// (the C# default) forbids duplicates.
    /// @param location The location of the duplicate annotation.
    /// @param attributeName The source-form attribute name.
    func ReportAttributeUsageDuplicate(location TextLocation, attributeName string) -> Report(
        location,
        DiagnosticDescriptors.AttributeUsageDuplicate,
        attributeName
    )

    /// Reports GS0211. The diagnostic ID is reserved (issue #179 / ADR-0047 §6)
    /// for historical reasons — the v1.0 release flagged every use of
    /// `@DllImport` with it. ADR-0086 / issue #727 removed the blanket
    /// rejection; well-formed P/Invoke declarations now succeed and the
    /// remaining invalid-shape cases route through GS0322–GS0329. This
    /// fallback message is retained for callers that still report the old
    /// "not supported" path while a follow-up audits every call site; in the
    /// current codebase nothing fires it.
    /// @param location The source location of the annotation.
    /// @param name The attribute name as written in source.
    func ReportDllImportNotSupported(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.DllImportNotSupported,
        name
    )

    /// Reports GS0212 when `[Conditional("SYMBOL")]` is applied to a
    /// function whose return type is not `void`. The CLR rule
    /// (matching C# `CS0578`) is that conditional-method calls may be
    /// elided at the call site, which is incompatible with a non-void result
    /// flowing into the surrounding expression. ADR-0047 §6 / issue #176.
    /// @param location The source location of the function declaration.
    /// @param functionName The function's declared name.
    func ReportConditionalMethodMustReturnVoid(location TextLocation, functionName string) -> Report(
        location,
        DiagnosticDescriptors.ConditionalMethodMustReturnVoid,
        functionName
    )

    /// ADR-0060 §2: rejects a managed-pointer type (`*T`) used as a parameter type. The CLR
    /// cannot encode a `*T` parameter without going through `ELEMENT_TYPE_BYREF` plus the
    /// matching attributes; use the keyword form (`ref name T` / `out name T` / `in name T`)
    /// to declare an explicit by-reference parameter.
    /// @param location The parameter or type-clause location.
    /// @param parameterName The parameter name.
    /// @param pointeeName The pointee type name (e.g. "int32").
    func ReportPointerTypeCannotBeParameterType(
        location TextLocation,
        parameterName string,
        pointeeName string
    ) -> Report(
        location,
        DiagnosticDescriptors.PointerTypeCannotBeParameterType,
        pointeeName,
        parameterName,
        pointeeName,
        parameterName,
        pointeeName,
        parameterName,
        pointeeName
    )

    /// Reports GS0322 when `@DllImport` is applied without a non-empty
    /// string library name as the first positional argument (ADR-0086 §3 / issue #727).
    /// @param location The annotation location.
    func ReportDllImportMissingLibraryName(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.DllImportMissingLibraryName
    )

    /// Reports GS0323 when a P/Invoke parameter or return type is not in the
    /// supported marshalling table (ADR-0086 §2 / issue #727).
    /// @param location The offending type-clause location.
    /// @param typeName The display name of the unsupported type.
    func ReportPInvokeUnsupportedMarshallingType(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.PInvokeUnsupportedMarshallingType,
        typeName
    )

    /// Reports GS0324 when a function carries `@DllImport` but also has a
    /// managed body (ADR-0086 §1 / issue #727). P/Invoke stubs must use a
    /// `;` body marker.
    /// @param location The body-block location.
    /// @param functionName The declared function name.
    func ReportPInvokeMustNotHaveBody(location TextLocation, functionName string) -> Report(
        location,
        DiagnosticDescriptors.PInvokeMustNotHaveBody,
        functionName
    )

    /// Reports GS0325 when a function uses a `;` body marker but is not
    /// annotated with `@DllImport` (ADR-0086 §1 / issue #727). A
    /// semicolon-only body is reserved for P/Invoke declarations.
    /// @param location The function-identifier location.
    /// @param functionName The declared function name.
    func ReportSemicolonBodyRequiresDllImport(location TextLocation, functionName string) -> Report(
        location,
        DiagnosticDescriptors.SemicolonBodyRequiresDllImport,
        functionName
    )

    /// Reports GS0326 when `@DllImport` is applied to a function shape
    /// that v1 P/Invoke does not support — instance method, async, generic,
    /// extension function, ref-returning function (ADR-0086 §1).
    /// @param location The function-identifier location.
    /// @param attributeName The P/Invoke attribute used: `DllImport` or `LibraryImport`.
    /// @param functionName The declared function name.
    /// @param reason A short reason for the rejection.
    func ReportDllImportInvalidFunctionShape(
        location TextLocation,
        attributeName string,
        functionName string,
        reason string
    ) -> Report(location, DiagnosticDescriptors.DllImportInvalidFunctionShape, attributeName, functionName, reason)

    /// Reports GS0327 when a `CharSet:` argument to `@DllImport` is
    /// not a valid (cref:System.Runtime.InteropServices.CharSet) member
    /// value (ADR-0086 §3).
    /// @param location The argument location.
    /// @param value The supplied raw value (display string).
    func ReportDllImportInvalidCharSet(location TextLocation, value string) -> Report(
        location,
        DiagnosticDescriptors.DllImportInvalidCharSet,
        value
    )

    /// Reports GS0328 when a `CallingConvention:` argument to
    /// `@DllImport` is not a valid
    /// (cref:System.Runtime.InteropServices.CallingConvention) member
    /// value (ADR-0086 §3).
    /// @param location The argument location.
    /// @param value The supplied raw value (display string).
    func ReportDllImportInvalidCallingConvention(location TextLocation, value string) -> Report(
        location,
        DiagnosticDescriptors.DllImportInvalidCallingConvention,
        value
    )

    /// Reports GS0329 when the `EntryPoint:` argument to
    /// `@DllImport` is not a non-empty string literal (ADR-0086 §3).
    /// @param location The argument location.
    func ReportDllImportInvalidEntryPoint(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.DllImportInvalidEntryPoint
    )

    /// ADR-0092 / issue #758: GS0342 — a function carries both
    /// `@DllImport` and `@LibraryImport`. The two P/Invoke
    /// attribute shapes are mutually exclusive on the same declaration.
    /// @param location The location of the offending function identifier.
    /// @param functionName The function name.
    func ReportPInvokeMixedDllAndLibraryImport(location TextLocation, functionName string) -> Report(
        location,
        DiagnosticDescriptors.PInvokeMixedDllAndLibraryImport,
        functionName
    )

    /// ADR-0092 / issue #758: GS0343 — a `StringMarshalling:` argument
    /// to `@LibraryImport` is not a valid
    /// (cref:System.Runtime.InteropServices.StringMarshalling) member
    /// value (`Utf8`, `Utf16`, or `Custom`).
    /// @param location The argument location.
    /// @param value The supplied raw value (display string).
    func ReportLibraryImportInvalidStringMarshalling(location TextLocation, value string) -> Report(
        location,
        DiagnosticDescriptors.LibraryImportInvalidStringMarshalling,
        value
    )

    /// ADR-0092 / issue #758: GS0344 — an `@LibraryImport` function
    /// uses a `string` parameter or return type without specifying
    /// `StringMarshalling: StringMarshalling.Utf8` or
    /// `StringMarshalling.Utf16`. Unlike `@DllImport`,
    /// `@LibraryImport` does not infer a default; the stub generator
    /// must know which encoding to emit.
    /// @param location The location of the offending function identifier.
    /// @param functionName The function name.
    func ReportLibraryImportRequiresStringMarshalling(location TextLocation, functionName string) -> Report(
        location,
        DiagnosticDescriptors.LibraryImportRequiresStringMarshalling,
        functionName
    )

    /// ADR-0093 / issue #759: GS0346 — a `@StructLayout(...)`
    /// annotation supplies a (cref:System.Runtime.InteropServices.LayoutKind)
    /// value other than `Sequential` or `Explicit`. `Auto`
    /// is rejected because Auto-layout types are not portable across
    /// the P/Invoke boundary (field reordering is permitted at load time).
    /// @param location The argument location.
    /// @param value The supplied raw value (display string).
    func ReportStructLayoutInvalidLayoutKind(location TextLocation, value string) -> Report(
        location,
        DiagnosticDescriptors.StructLayoutInvalidLayoutKind,
        value
    )

    /// ADR-0093 / issue #759: GS0347 — a field of a type declared with
    /// `@StructLayout(LayoutKind.Explicit)` is missing the required
    /// `@FieldOffset(N)` annotation. Every field of an Explicit-layout
    /// type must declare its byte offset.
    /// @param location The field-identifier location.
    /// @param fieldName The field name.
    /// @param typeName The owning struct or class name.
    func ReportFieldOffsetRequiredOnExplicitLayout(location TextLocation, fieldName string, typeName string) -> Report(
        location,
        DiagnosticDescriptors.FieldOffsetRequiredOnExplicitLayout,
        fieldName,
        typeName
    )

    /// ADR-0093 / issue #759: GS0348 — a field carries a `@FieldOffset`
    /// annotation but its declaring type is not declared with
    /// `@StructLayout(LayoutKind.Explicit)`. Field offsets are only
    /// meaningful inside Explicit-layout types.
    /// @param location The `@FieldOffset` annotation location.
    /// @param fieldName The field name.
    /// @param typeName The owning struct or class name.
    func ReportFieldOffsetInvalidOnNonExplicitLayout(
        location TextLocation,
        fieldName string,
        typeName string
    ) -> Report(location, DiagnosticDescriptors.FieldOffsetInvalidOnNonExplicitLayout, fieldName, typeName)

    /// ADR-0093 / issue #759: GS0349 — a struct or class type used in a
    /// P/Invoke parameter or return position is not blittable. The user
    /// must add `@StructLayout(LayoutKind.Sequential)` (or
    /// `Explicit`) and ensure every field has a blittable type.
    /// @param location The offending type-clause location.
    /// @param typeName The display name of the offending type.
    func ReportPInvokeNonBlittableType(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.PInvokeNonBlittableType,
        typeName
    )

    /// ADR-0093 / issue #759: GS0350 — the integer argument of
    /// `@FieldOffset(N)` is not a non-negative `int32` constant.
    /// @param location The argument location.
    /// @param value The supplied raw value (display string).
    func ReportFieldOffsetInvalidValue(location TextLocation, value string) -> Report(
        location,
        DiagnosticDescriptors.FieldOffsetInvalidValue,
        value
    )

    /// Issue #3115: GS0518 — an explicit layout misaligns a reference-typed
    /// field or overlaps it with non-reference storage, which the CLR loader rejects.
    /// @param location The invalid field identifier location.
    /// @param typeName The owning type name.
    /// @param referenceFieldName The reference-typed field name.
    /// @param reason The invalid alignment or overlap.
    func ReportExplicitLayoutReferenceStorageInvalid(
        location TextLocation,
        typeName string,
        referenceFieldName string,
        reason string
    ) -> Report(
        location,
        DiagnosticDescriptors.ExplicitLayoutReferenceStorageInvalid,
        typeName,
        referenceFieldName,
        reason
    )

    /// ADR-0093 / issue #759: GS0351 — a class type is used as the return
    /// type of a P/Invoke function. v1 supports class types only as
    /// parameters (passed by reference); the return-value ownership /
    /// allocation contract is deferred to a future ADR.
    /// @param location The return-type clause location.
    /// @param typeName The class display name.
    func ReportPInvokeClassReturnNotSupported(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.PInvokeClassReturnNotSupported,
        typeName
    )

    /// ADR-0094 / issue #760: GS0352 — a `ref`/`out`/`in`
    /// parameter on a P/Invoke declaration uses a pointee type that is not
    /// byref-marshalling-compatible. The runtime marshals the parameter as
    /// `T*`, which requires the pointee to be blittable. The fix is
    /// to use a blittable primitive (e.g. `int32`, `int64`,
    /// `nint`) or a struct annotated with `@StructLayout` whose
    /// fields are all blittable. `ref string` in particular needs an
    /// explicit `nint` + `Marshal.PtrToStringUTF8` round trip;
    /// the runtime cannot infer the unmanaged encoding for a byref slot.
    /// @param location The offending parameter-type-clause location.
    /// @param parameterName The parameter name (for the message).
    /// @param pointeeTypeName The unsupported pointee type display name.
    func ReportPInvokeNonBlittableByRefPointee(
        location TextLocation,
        parameterName string,
        pointeeTypeName string
    ) -> Report(location, DiagnosticDescriptors.PInvokeNonBlittableByRefPointee, parameterName, pointeeTypeName)

    /// ADR-0095 / issue #761: GS0353 — a delegate-typed parameter on a
    /// P/Invoke declaration is missing the
    /// `@UnmanagedFunctionPointer` attribute. Without that attribute
    /// the runtime cannot synthesize a stable function-pointer thunk for
    /// the delegate, and the call site has no way to communicate a
    /// calling convention to the native callee. The fix is to apply
    /// `@UnmanagedFunctionPointer(CallingConvention.Cdecl)` (or the
    /// appropriate calling convention) to the delegate declaration.
    /// @param location The offending parameter-type-clause location.
    /// @param parameterName The parameter name (for the message).
    /// @param delegateTypeName The delegate type name.
    func ReportPInvokeDelegateMissingUnmanagedFunctionPointer(
        location TextLocation,
        parameterName string,
        delegateTypeName string
    ) -> Report(
        location,
        DiagnosticDescriptors.PInvokeDelegateMissingUnmanagedFunctionPointer,
        parameterName,
        delegateTypeName
    )

    /// ADR-0095 / issue #761: GS0354 — the calling convention named in a
    /// raw function-pointer type clause (`unmanaged[CC] (...) -> R`)
    /// is not one of the supported values. The recognised conventions are
    /// `Cdecl`, `Stdcall`, `Thiscall`, `Fastcall`.
    /// @param location The offending calling-convention identifier location.
    /// @param name The unrecognised identifier.
    func ReportFunctionPointerUnknownCallingConvention(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.FunctionPointerUnknownCallingConvention,
        name
    )

    /// ADR-0095 / issue #761: GS0355 — a delegate-typed value is being
    /// returned from a P/Invoke declaration. Returning a managed
    /// delegate from native code is not supported because the runtime
    /// would have to allocate a managed wrapper without knowing the
    /// lifetime contract of the function-pointer it received. The fix
    /// is to declare the return as `unmanaged[CC] (...) -> R`
    /// (a raw function pointer) or `nint` (an opaque handle that
    /// the caller can wrap manually with
    /// `Marshal.GetDelegateForFunctionPointer`).
    /// @param location The offending return-type-clause location.
    /// @param delegateTypeName The delegate type name.
    func ReportPInvokeDelegateReturnNotSupported(location TextLocation, delegateTypeName string) -> Report(
        location,
        DiagnosticDescriptors.PInvokeDelegateReturnNotSupported,
        delegateTypeName
    )

    // GS0356 (missing calling-convention slot) retired by ADR-0095 v2 /
    // issue #3611: bare `unmanaged (T) -> R` is now the platform-default
    // unmanaged convention. The id stays reserved in DiagnosticDescriptors.
    /// ADR-0096 / issue #762: GS0357 — the `UnmanagedType` value
    /// passed to `@MarshalAs(...)` is not in the v1 supported set.
    /// The supported values are `LPStr`, `LPWStr`,
    /// `LPUTF8Str`, `BStr`, `LPArray`, `SafeArray`,
    /// `I1`, `U1`, `I2`, `U2`, `I4`, `U4`,
    /// `I8`, `U8`, `Bool`, `VariantBool`,
    /// `SysInt`, `SysUInt`, `Struct`, `ByValTStr`,
    /// and `ByValArray`. Everything else (custom marshallers,
    /// `IUnknown`, `FunctionPtr`, …) is filed as a follow-up.
    /// @param location The offending `@MarshalAs(...)` argument location.
    /// @param value The display text of the rejected value.
    func ReportMarshalAsUnsupportedUnmanagedType(location TextLocation, value string) -> Report(
        location,
        DiagnosticDescriptors.MarshalAsUnsupportedUnmanagedType,
        value
    )

    /// ADR-0096 / issue #762: GS0358 — the resolved
    /// (cref:System.Runtime.InteropServices.UnmanagedType) is
    /// not compatible with the parameter's G# type. Examples:
    /// `LPWStr` on an `int32`, `LPArray` on a
    /// `string`, `I4` on a `string`. The message
    /// includes the rejected pair so users can pick a compatible
    /// override from the table in ADR-0096 §3.
    /// @param location The offending parameter type-clause location.
    /// @param parameterName The parameter name.
    /// @param parameterType The display name of the G# parameter type.
    /// @param unmanagedType The display name of the (cref:System.Runtime.InteropServices.UnmanagedType)
    /// override.
    func ReportMarshalAsIncompatibleType(
        location TextLocation,
        parameterName string,
        parameterType string,
        unmanagedType string
    ) -> Report(location, DiagnosticDescriptors.MarshalAsIncompatibleType, unmanagedType, parameterName, parameterType)

    /// ADR-0096 / issue #762: GS0359 — the `@MarshalAs(...)`
    /// annotation is missing a knob that is mandatory for the chosen
    /// (cref:System.Runtime.InteropServices.UnmanagedType).
    /// Examples: `ByValTStr` requires `SizeConst`;
    /// `ByValArray` requires `SizeConst`; `LPArray`
    /// requires at least one of `SizeConst` or `SizeParamIndex`
    /// for the runtime to know the element count.
    /// @param location The offending `@MarshalAs(...)` annotation location.
    /// @param parameterName The parameter name.
    /// @param unmanagedType The display name of the (cref:System.Runtime.InteropServices.UnmanagedType)
    /// override.
    /// @param missingArgument The display name of the missing knob (e.g. `SizeConst`).
    func ReportMarshalAsMissingRequiredArgument(
        location TextLocation,
        parameterName string,
        unmanagedType string,
        missingArgument string
    ) -> Report(
        location,
        DiagnosticDescriptors.MarshalAsMissingRequiredArgument,
        unmanagedType,
        parameterName,
        missingArgument
    )

    /// ADR-0096 / issue #762: GS0360 — `@MarshalAs` is rejected on
    /// the offending P/Invoke parameter. The two cases reported under
    /// this code are:
    /// - The enclosing function is not a P/Invoke (`@DllImport` or `@LibraryImport`) declaration —
    /// `@MarshalAs` on a managed function's parameter has no CLR-defined meaning and is rejected to avoid
    /// silently dropping the user's intent.
    /// - The enclosing function is a `@LibraryImport` stub and the offending parameter is a `string`. The
    /// outer marshalling stub uses the function-wide `StringMarshalling` knob to pick its encoding; a
    /// per-parameter override would require generating per-parameter outer-stub code, which v1.0 of
    /// `@LibraryImport` does not surface. Use `StringMarshalling` on the `@LibraryImport(...)` annotation
    /// instead.
    /// @param location The offending `@MarshalAs(...)` annotation location.
    /// @param parameterName The parameter name.
    /// @param reason The case-specific reason (one of the bullets above).
    func ReportMarshalAsRejected(location TextLocation, parameterName string, reason string) -> Report(
        location,
        DiagnosticDescriptors.MarshalAsRejected,
        parameterName,
        reason
    )

    /// Issue #2130: GS0473 — a lambda being converted to an expression tree
    /// uses a language construct that G# deliberately rejects in expression-
    /// tree form, matching the C#/Roslyn restriction model.
    /// @param location The source location of the unsupported construct.
    /// @param feature The rejected construct description.
    func ReportExpressionTreeUnsupported(location TextLocation, feature string) -> Report(
        location,
        DiagnosticDescriptors.ExpressionTreeUnsupported,
        feature
    )

    /// Issue #2130: GS0474 — a target `Expression[T]` uses a type
    /// argument that is not a delegate type, so a lambda cannot convert to it.
    /// @param location The source location of the attempted conversion.
    /// @param targetType The invalid target type.
    func ReportExpressionTreeTargetMustBeDelegate(location TextLocation, targetType TypeSymbol) -> Report(
        location,
        DiagnosticDescriptors.ExpressionTreeTargetMustBeDelegate,
        targetType
    )

    /// Issue #1336: GS0415 — a `sizeof(T)` expression names a type that is
    /// not an unmanaged type. `sizeof` measures the unmanaged byte size of
    /// its operand, so the operand must be a blittable primitive, an enum, a
    /// pointer, a blittable value struct, or a generic type parameter
    /// constrained `unmanaged`; managed reference types and non-blittable
    /// structs are rejected (mirrors C#'s `sizeof` over unmanaged types).
    /// @param location The text location of the measured type clause.
    /// @param typeName The illegal measured type name.
    func ReportSizeOfRequiresUnmanagedType(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.SizeOfRequiresUnmanagedType,
        typeName
    )
}
