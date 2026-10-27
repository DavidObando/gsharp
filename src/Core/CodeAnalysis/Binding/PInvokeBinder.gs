// <copyright file="PInvokeBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Runtime.InteropServices

/// Helpers for validating and extracting P/Invoke metadata from a function
/// declaration. Recognises both the classic `@DllImport` shape
/// (ADR-0086 / issue #727) and the modern `@LibraryImport`
/// source-generator-flavored shape (ADR-0092 / issue #758). Also owns the
/// per-parameter `@MarshalAs(UnmanagedType.…)` validation pass
/// (ADR-0096 / issue #762).
internal shared class PInvokeBinder {
    /// When [`function`](paramref) carries an `@DllImport` or
    /// `@LibraryImport` annotation, validates the shape and produces
    /// a (cref:PInvokeMetadata) attached to the symbol. Reports
    /// GS0322–GS0329 (DllImport) and GS0342–GS0344 (LibraryImport) on any
    /// malformed input.
    /// @param function The function symbol being declared.
    /// @param syntax The originating function declaration syntax.
    /// @param diagnostics The diagnostics bag for this binder.
    /// @returns `true` when the function is a P/Invoke (with or without errors); `false` when no recognised
    /// P/Invoke attribute is present.
    internal func TryAttachPInvokeMetadata(
        function FunctionSymbol,
        syntax FunctionDeclarationSyntax,
        diagnostics DiagnosticBag
    ) bool {
        let dllImport BoundAttribute? = KnownAttributes.FindDllImport(function.Attributes)
        let libraryImport BoundAttribute? = KnownAttributes.FindLibraryImport(function.Attributes)
        if dllImport == nil && libraryImport == nil {
            return false
        }
        let identifierLocation = syntax.Identifier.Location
        // ADR-0092 / issue #758: the two attribute shapes are mutually exclusive.
        if dllImport != nil && libraryImport != nil {
            diagnostics.ReportPInvokeMixedDllAndLibraryImport(identifierLocation, function.Name)
        }
        let isLibraryImport = libraryImport != nil && dllImport == nil
        let attribute = if isLibraryImport {
            libraryImport
        } else {
            (dllImport ?? libraryImport)
        }
        let attributeName = if isLibraryImport {
            "LibraryImport"
        } else {
            "DllImport"
        }
        // Validate function shape: no body, no instance/static-receiver,
        // no async, no generic, no extension, no ref-return. These rules
        // mirror ADR-0086 §1 / ADR-0092 §1 — the v1 surface area is identical
        // across the two attribute shapes.
        if syntax.Body != nil {
            diagnostics.ReportPInvokeMustNotHaveBody(syntax.Body.Location, function.Name)
        }
        if function.IsAsync {
            diagnostics.ReportDllImportInvalidFunctionShape(
                identifierLocation,
                attributeName,
                function.Name,
                "async functions are not supported"
            )
        }
        if function.IsGeneric {
            diagnostics.ReportDllImportInvalidFunctionShape(
                identifierLocation,
                attributeName,
                function.Name,
                "generic functions are not supported"
            )
        }
        if function.IsExtension {
            diagnostics.ReportDllImportInvalidFunctionShape(
                identifierLocation,
                attributeName,
                function.Name,
                "extension functions are not supported"
            )
        }
        if function.IsInstanceMethod {
            diagnostics.ReportDllImportInvalidFunctionShape(
                identifierLocation,
                attributeName,
                function.Name,
                "instance methods are not supported"
            )
        }
        // ADR-0086 / issue #1203: a P/Invoke declared inside a class's
        // `shared { }` block (function.IsStatic) is the canonical G# spelling
        // of a C# `static extern [DllImport]` member. The CLR represents every
        // P/Invoke as a static method, so a `shared`-block extern is precisely
        // the supported shape — it is no longer rejected here.
        if function.ReturnRefKind != RefKind.None {
            diagnostics.ReportDllImportInvalidFunctionShape(
                identifierLocation,
                attributeName,
                function.Name,
                "ref-returning functions are not supported"
            )
        }
        // ADR-0094 / issue #760: parameter ref-kinds (`ref`/`out`/`in`) are now
        // supported on P/Invoke declarations. The pointee type must be
        // byref-marshalling-compatible (blittable primitive or a blittable
        // struct). Validation runs inside the per-parameter loop below so
        // GS0352 anchors to the offending type clause.
        // Validate parameter types against the supported marshalling table.
        // Use the parameter-syntax type-clause location for diagnostics so
        // squiggles land on the offending type, not the function name.
        let parameterSyntaxes = syntax.Parameters
        var hasStringParameter = false
        let blittableDetector = BlittableDetector()
        for var i = 0; i < function.Parameters.Length; i++ {
            let parameter = function.Parameters[i]
            if parameter.Type == TypeSymbol.String {
                hasStringParameter = true
            }
            var typeLocation = identifierLocation
            if i < parameterSyntaxes.Count && parameterSyntaxes[i].Type is {} typeClause {
                typeLocation = typeClause.Location
            }
            // ADR-0096 / issue #762: extract and validate the optional
            // `@MarshalAs(UnmanagedType.…)` override before the per-shape
            // checks below. The marshal-as metadata never relaxes the
            // shape rules (`ref string` is still rejected by the byref
            // path), it only overrides how a supported parameter type
            // is marshalled at the unmanaged boundary.
            TryAttachMarshalAsMetadata(parameter, i, function, isLibraryImport, parameterSyntaxes, diagnostics)
            // ADR-0094 / issue #760: a ref/out/in parameter passes the
            // declared type by managed pointer; the runtime marshals it as
            // `T*` for the unmanaged callee, so the pointee must be
            // blittable. Struct pointees route through the existing GS0349
            // path; everything else (string / object / nullable / etc.)
            // routes through the new GS0352 diagnostic with a tailored
            // message. ParameterSymbol keeps the pointee type in `Type`
            // (the RefKind on the symbol is what makes the parameter a
            // byref); we re-form the ByRefTypeSymbol here so the rule
            // lives in a single helper.
            if parameter.RefKind != RefKind.None {
                ValidateByRefPInvokeParameter(
                    parameter,
                    ByRefTypeSymbol.Get(parameter.Type),
                    typeLocation,
                    blittableDetector,
                    diagnostics
                )
                continue
            }
            // ADR-0095 / issue #761: delegate-typed parameters must carry
            // the `@UnmanagedFunctionPointer` attribute on the delegate
            // declaration. The CLR keeps the delegate alive for the duration
            // of the call, so the caller is responsible for rooting the
            // delegate beyond the call site (typically by keeping the
            // assigned local in scope or in a field). FunctionPointerType
            // parameters are accepted directly — they are raw `IntPtr` /
            // `nint`-sized values in the metadata blob (FNPTR).
            if parameter.Type is DelegateTypeSymbol delegateParam {
                if KnownAttributes.FindUnmanagedFunctionPointer(delegateParam.Attributes) == nil {
                    diagnostics.ReportPInvokeDelegateMissingUnmanagedFunctionPointer(
                        typeLocation,
                        parameter.Name,
                        delegateParam.Name
                    )
                }
                continue
            }
            if parameter.Type is FunctionPointerTypeSymbol {
                continue
            }
            // ADR-0086 §2 / issue #1208: SafeHandle (and derived types such as
            // SafeFileHandle, SafeWaitHandle) marshal as managed handle
            // wrappers — the CLR marshaller performs the handle ref-count /
            // lifetime bookkeeping automatically. Accept them as a by-value
            // parameter; this guard takes precedence over the struct / class
            // and generic unsupported-type rejections below.
            if IsSafeHandleType(parameter.Type) {
                continue
            }
            // ADR-0093 §3 / §4: struct values and (layout-annotated) class
            // references are validated separately so the binder can issue
            // the tailored GS0349 "not blittable" message rather than the
            // generic GS0323. Pointers to structs (`*S`) likewise route
            // through the blittable check.
            if IsStructMarshallingType(parameter.Type) {
                if !blittableDetector.IsBlittable(parameter.Type) {
                    diagnostics.ReportPInvokeNonBlittableType(typeLocation, parameter.Type.Name)
                }
                continue
            }
            if IsSupportedMarshallingType(parameter.Type) {
                continue
            }
            diagnostics.ReportPInvokeUnsupportedMarshallingType(typeLocation, parameter.Type?.Name ?? "?")
        }
        let returnIsString = function.Type == TypeSymbol.String
        if function.Type != TypeSymbol.Void {
            let returnLocation = syntax.Type?.Location ?? identifierLocation
            // ADR-0095 / issue #761: a delegate return is rejected because
            // the v1 runtime cannot synthesize a managed wrapper for an
            // arbitrary native function pointer without knowing its
            // ownership / lifetime contract. The caller should declare the
            // return as `unmanaged[CC] (...) -> R` or `nint` and use
            // `Marshal.GetDelegateForFunctionPointer` manually.
            if IsSafeHandleType(function.Type) {
                // ADR-0086 §2 / issue #1208: SafeHandle return — the CLR
                // marshaller constructs the managed wrapper and assumes
                // ownership of the native handle. This guard precedes the
                // class-return / unsupported-type rejections so an imported
                // BCL handle type (e.g. SafeFileHandle) is never misclassified.

            } else if function.Type is DelegateTypeSymbol returnDelegate {
                diagnostics.ReportPInvokeDelegateReturnNotSupported(returnLocation, returnDelegate.Name)
            } else if function.Type is FunctionPointerTypeSymbol {
                // FNPTR return is accepted directly.

            } else if IsStructMarshallingType(function.Type) {
                if !function.Type.IsValueType {
                    // ADR-0093 §4 — classes are not supported as P/Invoke
                    // return values; the user must declare a struct or
                    // return `nint` for opaque handles.
                    diagnostics.ReportPInvokeClassReturnNotSupported(returnLocation, function.Type.Name)
                } else if !blittableDetector.IsBlittable(function.Type) {
                    diagnostics.ReportPInvokeNonBlittableType(returnLocation, function.Type.Name)
                }
            } else if !IsSupportedMarshallingType(function.Type) {
                diagnostics.ReportPInvokeUnsupportedMarshallingType(returnLocation, function.Type?.Name ?? "?")
            }
        }
        // ADR-0092 §2/§4 — a `string` return is supported: the emitted outer
        // stub materializes the managed string from the inner P/Invoke's raw
        // native pointer via `Marshal.PtrToStringUTF8`/`PtrToStringUni`. The
        // returned native buffer is treated as non-owning (the native side
        // owns it, e.g. `getenv`), so no free is emitted for the return. An
        // explicit `StringMarshalling` is still required: `returnIsString`
        // feeds `hasStringSurface` below, so GS0344 fires for a string-return
        // signature without `Utf8`/`Utf16`.
        // Extract metadata from the attribute arguments.
        let metadata PInvokeMetadata? = if isLibraryImport {
            ExtractLibraryImportMetadata(
                Invariant.Required(
                    libraryImport,
                    "a library import has a resolved LibraryImport attribute",
                    expression: "libraryImport"
                ),
                function,
                hasStringParameter || returnIsString,
                diagnostics
            )
        } else {
            ExtractDllImportMetadata(
                Invariant.Required(
                    dllImport,
                    "a DLL import has a resolved DllImport attribute",
                    expression: "dllImport"
                ),
                syntax,
                function,
                diagnostics
            )
        }
        if metadata != nil {
            function.PInvokeMetadata = metadata
        }
        return true
    }

    /// Returns `true` when [`type`](paramref) is in the v1
    /// supported P/Invoke marshalling set (ADR-0086 §2).
    /// @param type The bound parameter or return type.
    /// @returns `true` when supported.
    internal func IsSupportedMarshallingType(type TypeSymbol?) bool {
        if type == nil || type == TypeSymbol.Error {
            // Already reported as a separate diagnostic; don't double-fire.
            return true
        }
        if IsSupportedPrimitive(type) {
            return true
        }
        if type == TypeSymbol.String {
            return true
        }
        if IsSafeHandleType(type) {
            return true
        }
        if type is ByRefTypeSymbol byRef {
            // ADR-0094 / issue #760: byref pointees must be blittable. The
            // call site (PInvokeBinder loop) already routes byref parameters
            // through ValidateByRefPInvokeParameter for a tailored
            // diagnostic; this fallback applies when classification is
            // requested from an ad hoc context. Restrict to the strict
            // blittable-primitive set so `ref bool` / `ref char` do not
            // sneak through.
            return IsBlittablePrimitive(byRef.PointeeType) ||
                (
                IsStructMarshallingType(byRef.PointeeType) &&
                    byRef
                    .PointeeType
                    .IsValueType &&
                    BlittableDetector().IsBlittable(byRef.PointeeType)
            )
        }
        // ADR-0122 / issue #1014: an unmanaged raw pointer `*T` (CLR
        // ELEMENT_TYPE_PTR) marshals as a native pointer when its pointee is a
        // blittable primitive (or another pointer). This is the plain-`*T`
        // P/Invoke parameter path (e.g. `void* pBuffer`, `int* pRead`).
        // ADR-0122 §3 / issue #1033: a true `*void` (C# `void*`, the canonical
        // Win32 opaque-buffer parameter) likewise marshals as a native pointer.
        if type is PointerTypeSymbol pointer {
            // ADR-0122 §4 / issue #1034: a pointer to a blittable user/value
            // struct (`*Point`) marshals as a native pointer (ELEMENT_TYPE_PTR
            // over the struct's TypeDef/TypeRef). Pointee legality is already
            // gated at type-binding time (GS0398), so any surviving struct
            // pointee here is a legal blittable value struct.
            return TypeSymbol.IsVoidPointer(type) ||
                IsSupportedPrimitive(pointer.PointeeType) ||
                pointer.PointeeType is PointerTypeSymbol ||
                BlittableDetector.IsBlittableValueStructPointee(pointer.PointeeType)
        }
        if IsStructMarshallingType(type) {
            return BlittableDetector().IsBlittable(type)
        }
        if type is SliceTypeSymbol slice {
            return IsSupportedPrimitive(slice.ElementType)
        }
        return false
    }

    private func IsSupportedPrimitive(type TypeSymbol) bool {
        return type == TypeSymbol.Bool ||
            type == TypeSymbol.Char ||
            type == TypeSymbol.Int8 ||
            type == TypeSymbol.UInt8 ||
            type == TypeSymbol.Int16 ||
            type == TypeSymbol.UInt16 ||
            type == TypeSymbol.Int32 ||
            type == TypeSymbol.UInt32 ||
            type == TypeSymbol.Int64 ||
            type == TypeSymbol.UInt64 ||
            type == TypeSymbol.NInt ||
            type == TypeSymbol.NUInt ||
            type == TypeSymbol.Float32 ||
            type == TypeSymbol.Float64
    }

    /// ADR-0094 / issue #760: the strict blittable-primitive set permitted
    /// as a byref pointee on a P/Invoke parameter. Excludes `bool`
    /// and `char` because their unmanaged representation depends on
    /// the surrounding `CharSet` / `MarshalAs` annotation, which
    /// v1 does not surface for byref slots — accepting them silently would
    /// produce inconsistent bit-widths across platforms.
    private func IsBlittablePrimitive(type TypeSymbol) bool {
        return type == TypeSymbol.Int8 ||
            type == TypeSymbol.UInt8 ||
            type == TypeSymbol.Int16 ||
            type == TypeSymbol.UInt16 ||
            type == TypeSymbol.Int32 ||
            type == TypeSymbol.UInt32 ||
            type == TypeSymbol.Int64 ||
            type == TypeSymbol.UInt64 ||
            type == TypeSymbol.NInt ||
            type == TypeSymbol.NUInt ||
            type == TypeSymbol.Float32 ||
            type == TypeSymbol.Float64
    }

    /// ADR-0094 / issue #760: validates a single P/Invoke parameter whose
    /// ref-kind is `ref`, `out`, or `in`. The pointee type
    /// must be one of:
    /// - A blittable primitive (`int8…int64`, `uint8…uint64`, `nint`, `nuint`, `float32`, `float64`).
    /// - A user struct whose blittability is established by (cref:BlittableDetector) (issued GS0349
    /// otherwise).
    /// A `bool` pointee is also accepted when an explicit
    /// `@MarshalAs(UnmanagedType.Bool|I1|U1)` defines its native width.
    /// Every other pointee — including an unannotated `bool`,
    /// `char`, `string`, `object`, `decimal`, slices,
    /// sequences, and nullable types — is rejected with the new GS0352
    /// diagnostic. `ref string` is the
    /// canonical user mistake the diagnostic message coaches against
    /// (recommend an explicit `nint` + Marshal.PtrToStringUTF8 round
    /// trip instead).
    private func ValidateByRefPInvokeParameter(
        parameter ParameterSymbol,
        byRef ByRefTypeSymbol,
        typeLocation TextLocation,
        blittableDetector BlittableDetector,
        diagnostics DiagnosticBag
    ) {
        let pointee TypeSymbol? = byRef.PointeeType
        if pointee == nil || pointee == TypeSymbol.Error {
            return
        }
        if IsBlittablePrimitive(pointee) {
            return
        }
        // Issue #2554: bool itself is deliberately still non-blittable. An
        // explicit descriptor makes the runtime marshal through a temporary
        // of the requested ABI width, so ref/out/in bool is safe only for the
        // three scalar forms supported by the CLR marshaller.
        if pointee == TypeSymbol.Bool &&
            (parameter.MarshalAsMetadata?.UnmanagedType is UnmanagedType.Bool or UnmanagedType.I1 or UnmanagedType.U1) {
            return
        }
        if IsStructMarshallingType(pointee) && pointee.IsValueType {
            if !blittableDetector.IsBlittable(pointee) {
                diagnostics.ReportPInvokeNonBlittableType(typeLocation, pointee.Name)
            }
            return
        }
        diagnostics.ReportPInvokeNonBlittableByRefPointee(typeLocation, parameter.Name, pointee.Name)
    }

    /// Recognizes source aggregates and imported value structs before the shared blittability check.
    /// @param type The signature type.
    /// @returns Whether the type uses aggregate marshalling.
    private func IsStructMarshallingType(type TypeSymbol) bool {
        // CLR aggregate marshalling does not support generic types, even when their fields are blittable.
        if type.ClrType?.IsGenericType == true || !type.ConstructedTypeArguments.IsDefaultOrEmpty {
            return false
        }
        if type is StructSymbol source {
            return source
                .TypeParameters
                .IsDefaultOrEmpty &&
                source
                .TypeArguments
                .IsDefaultOrEmpty &&
                StructSymbol
                .CollectEnclosingTypeParameters(source).IsDefaultOrEmpty
        }
        return BlittableDetector.IsValueStruct(type)
    }

    /// ADR-0086 §2 / issue #1208: returns `true` when
    /// [`type`](paramref) is
    /// `System.Runtime.InteropServices.SafeHandle` or any type deriving
    /// from it (e.g. `Microsoft.Win32.SafeHandles.SafeFileHandle`,
    /// `Microsoft.Win32.SafeHandles.SafeWaitHandle`). `SafeHandle` is
    /// a managed reference type that the CLR marshaller special-cases for
    /// P/Invoke: it performs the handle ref-count / lifetime management
    /// automatically and accepts the type as both a parameter and a return
    /// value. `SafeHandle` is neither blittable nor a pointer, so it must
    /// bypass the struct / pointer marshalling checks. Detection walks the CLR
    /// base-type chain on the symbol's (cref:TypeSymbol.ClrType) and
    /// compares the full name, so it works for imported BCL handle types loaded
    /// through a `MetadataLoadContext`. A (cref:NullableTypeSymbol)
    /// wrapper is unwrapped first so `SafeFileHandle?` is still recognised.
    /// Only `SafeHandle` and its subclasses are accepted — arbitrary
    /// reference types are not broadened in.
    /// @param type The bound parameter or return type.
    /// @returns `true` when the type is or derives from `SafeHandle`.
    internal func IsSafeHandleType(type TypeSymbol?) bool {
        if type == nil {
            return false
        }
        let unwrapped = if type is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            type
        }
        let clrType = unwrapped?.ClrType
        for var current Type? = clrType; current != nil; current = current!!.BaseType {
            if current.FullName == "System.Runtime.InteropServices.SafeHandle" {
                return true
            }
        }
        return false
    }

    private func ExtractDllImportMetadata(
        attribute BoundAttribute,
        syntax FunctionDeclarationSyntax,
        function FunctionSymbol,
        diagnostics DiagnosticBag
    ) PInvokeMetadata? {
        // 1) Required positional library name.
        var libraryName string? = nil
        if attribute.GetConstructorArgument(0, "dllName")?.Value is string s && !string.IsNullOrEmpty(s) {
            libraryName = s
        }
        if libraryName == nil {
            diagnostics.ReportDllImportMissingLibraryName(attribute.Syntax.Location)
            // Continue extraction so we can still surface other errors,
            // but return null so the symbol is not flagged as a valid P/Invoke.
            return nil
        }
        // 2) Named arguments.
        var entryPoint = function.Name
        var charSet = CharSet.Ansi
        var setLastError = false
        var callingConvention = CallingConvention.Winapi
        var exactSpelling bool? = nil
        var preserveSig = true
        var bestFitMapping bool? = nil
        var throwOnUnmappableChar bool? = nil
        for named in attribute.NamedArguments {
            let argSyntax = FindNamedArgSyntax(attribute.Syntax, named.Name) ?? attribute.Syntax
            switch named.Name {
                case "EntryPoint" {
                    if named.Value is string entryString && !string.IsNullOrEmpty(entryString) {
                        entryPoint = entryString
                    } else {
                        diagnostics.ReportDllImportInvalidEntryPoint(argSyntax.Location)
                    }
                }
                case "CharSet" {
                    if named.Value is {} value && KnownAttributes.TryConvertAttributeEnum[CharSet](value, out var cs) {
                        charSet = cs
                    } else {
                        diagnostics.ReportDllImportInvalidCharSet(
                            argSyntax.Location,
                            named.Value?.ToString() ?? "<null>"
                        )
                    }
                }
                case "SetLastError" {
                    if named.Value is bool sle {
                        setLastError = sle
                    }
                }
                case "CallingConvention" {
                    if named.Value is {} callingConventionValue &&
                        KnownAttributes.TryConvertAttributeEnum[CallingConvention](callingConventionValue, out var cc) {
                        callingConvention = cc
                    } else {
                        diagnostics.ReportDllImportInvalidCallingConvention(
                            argSyntax.Location,
                            named.Value?.ToString() ?? "<null>"
                        )
                    }
                }
                case "ExactSpelling" {
                    if named.Value is bool es {
                        exactSpelling = es
                    }
                }
                case "PreserveSig" {
                    if named.Value is bool ps {
                        preserveSig = ps
                    }
                }
                case "BestFitMapping" {
                    if named.Value is bool bfm {
                        bestFitMapping = bfm
                    }
                }
                case "ThrowOnUnmappableChar" {
                    if named.Value is bool tum {
                        throwOnUnmappableChar = tum
                    }
                }
                default { }
            }
        }
        // ExactSpelling default follows the CLR rule: Auto => true, else false.
        let resolvedExactSpelling = exactSpelling ?? (charSet == CharSet.Auto)
        return PInvokeMetadata(
            libraryName,
            entryPoint,
            charSet,
            setLastError,
            callingConvention,
            resolvedExactSpelling,
            preserveSig,
            bestFitMapping,
            throwOnUnmappableChar
        )
    }

    /// Extracts the resolved metadata for an `@LibraryImport` attribute
    /// (ADR-0092 / issue #758). `@LibraryImport` exposes a deliberately
    /// smaller surface than `@DllImport`: only `LibraryName`
    /// (positional), `EntryPoint`, `SetLastError`,
    /// `StringMarshalling`, and `StringMarshallingCustomType`.
    /// The remaining knobs (CharSet, CallingConvention, PreserveSig,
    /// BestFitMapping, ThrowOnUnmappableChar) are not part of the attribute
    /// — calling-convention overrides live on a separate
    /// `@UnmanagedCallConv` attribute, which v1 does not support.
    private func ExtractLibraryImportMetadata(
        attribute BoundAttribute,
        function FunctionSymbol,
        hasStringSurface bool,
        diagnostics DiagnosticBag
    ) PInvokeMetadata? {
        // 1) Required positional library name.
        var libraryName string? = nil
        if attribute.GetConstructorArgument(0, "libraryName")?.Value is string s && !string.IsNullOrEmpty(s) {
            libraryName = s
        }
        if libraryName == nil {
            diagnostics.ReportDllImportMissingLibraryName(attribute.Syntax.Location)
            return nil
        }
        // 2) Named arguments. Defaults match LibraryImportAttribute itself:
        //    EntryPoint defaults to the function name, StringMarshalling
        //    defaults to Custom (which fails GS0344 for string-bearing
        //    signatures because no explicit encoding was given).
        var entryPoint = function.Name
        var setLastError = false
        var stringMarshalling = StringMarshalling.Custom
        for named in attribute.NamedArguments {
            let argSyntax = FindNamedArgSyntax(attribute.Syntax, named.Name) ?? attribute.Syntax
            switch named.Name {
                case "EntryPoint" {
                    if named.Value is string entryString && !string.IsNullOrEmpty(entryString) {
                        entryPoint = entryString
                    } else {
                        diagnostics.ReportDllImportInvalidEntryPoint(argSyntax.Location)
                    }
                }
                case "SetLastError" {
                    if named.Value is bool sle {
                        setLastError = sle
                    }
                }
                case "StringMarshalling" {
                    if named.Value is {} value && KnownAttributes.TryConvertAttributeEnum[StringMarshalling](
                        value,
                        out var sm
                    ) {
                        stringMarshalling = sm
                    } else {
                        diagnostics.ReportLibraryImportInvalidStringMarshalling(
                            argSyntax.Location,
                            named.Value?.ToString() ?? "<null>"
                        )
                    }
                }
                case "StringMarshallingCustomType" { }
                default { }
            }
        }
        // ADR-0092 §3 — a string-bearing signature requires an explicit
        // StringMarshalling value of Utf8 or Utf16. Custom is reserved for
        // a future ADR; Custom + a string parameter is an error today.
        if hasStringSurface &&
            stringMarshalling != StringMarshalling.Utf8 &&
            stringMarshalling != StringMarshalling
            .Utf16 {
            diagnostics.ReportLibraryImportRequiresStringMarshalling(
                Invariant
                    .Required(
                    function.Declaration,
                    "a LibraryImport function must retain its declaration",
                    expression: "function.Declaration"
                )
                    .Identifier
                    .Location,
                function.Name
            )
        }
        return PInvokeMetadata(
            libraryName,
            entryPoint,
            CharSet.None,
            setLastError,
            CallingConvention.Winapi,
            exactSpelling: true,
            preserveSig: true,
            bestFitMapping: nil,
            throwOnUnmappableChar: nil,
            isLibraryImport: true,
            stringMarshalling: stringMarshalling
        )
    }

    private func FindNamedArgSyntax(annotation AnnotationSyntax?, name string?) SyntaxNode? {
        if annotation?.Arguments == nil {
            return nil
        }
        for arg in annotation!!.Arguments {
            if arg is NamedArgumentExpressionSyntax named && named.NameToken.ValueText == name {
                return named
            }
        }
        return nil
    }

    /// ADR-0096 / issue #762: the v1 supported (cref:UnmanagedType)
    /// values. Everything else (custom marshallers, `IUnknown`,
    /// `FunctionPtr`, …) is rejected with GS0357 so users do not
    /// accidentally encode an unsupported descriptor into the
    /// `FieldMarshal` blob.
    private let SupportedUnmanagedTypes HashSet[UnmanagedType] = HashSet[UnmanagedType]{
        UnmanagedType.LPStr,
        UnmanagedType.LPWStr,
        UnmanagedType.LPUTF8Str,
        UnmanagedType.BStr,
        UnmanagedType.LPArray,
        UnmanagedType.SafeArray,
        UnmanagedType.I1,
        UnmanagedType.U1,
        UnmanagedType.I2,
        UnmanagedType.U2,
        UnmanagedType.I4,
        UnmanagedType.U4,
        UnmanagedType.I8,
        UnmanagedType.U8,
        UnmanagedType.Bool,
        UnmanagedType.VariantBool,
        UnmanagedType.SysInt,
        UnmanagedType.SysUInt,
        UnmanagedType.Struct,
        UnmanagedType.ByValTStr,
        UnmanagedType.ByValArray
    }

    /// ADR-0096 / issue #762: extracts a `@MarshalAs(UnmanagedType.…)`
    /// annotation from [`parameter`](paramref), validates it
    /// against the parameter's G# type, and attaches the resolved
    /// (cref:MarshalAsMetadata) on success. Reports GS0357
    /// (unsupported (cref:UnmanagedType)), GS0358 (type
    /// incompatibility), GS0359 (missing required knob), and GS0360
    /// (rejected on `@LibraryImport` string surface).
    /// @param parameter The parameter symbol being validated.
    /// @param parameterIndex Its zero-based ordinal in the function's parameter list.
    /// @param function The enclosing function symbol.
    /// @param isLibraryImport Whether the enclosing function is a `@LibraryImport` declaration.
    /// @param parameterSyntaxes The parameter syntaxes; supplies the annotation location for diagnostics.
    /// @param diagnostics The diagnostics bag for this binder.
    private func TryAttachMarshalAsMetadata(
        parameter ParameterSymbol,
        parameterIndex int32,
        function FunctionSymbol,
        isLibraryImport bool,
        parameterSyntaxes GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ParameterSyntax],
        diagnostics DiagnosticBag
    ) {
        let attr BoundAttribute? = KnownAttributes.FindMarshalAs(parameter.Attributes)
        if attr == nil {
            return
        }
        let annotationLocation = attr
            .Syntax
            ?.Location ??
            (
            if parameterIndex < parameterSyntaxes.Count {
                parameterSyntaxes[parameterIndex].Location
            } else {
                Invariant
                    .Required(
                    function.Declaration,
                    "a MarshalAs parameter must retain its declaration",
                    expression: "function.Declaration"
                )
                    .Identifier
                    .Location
            }
        )
        // ADR-0096 §3 — @MarshalAs on a string parameter under
        // @LibraryImport collides with the function-wide
        // StringMarshalling knob, which is the canonical per-call lever.
        // Reject with GS0360 rather than silently honour one or the other.
        if isLibraryImport && parameter.Type == TypeSymbol.String {
            diagnostics.ReportMarshalAsRejected(
                annotationLocation,
                parameter.Name,
                "@LibraryImport string parameters take their encoding from the function-wide StringMarshalling knob; use @LibraryImport(StringMarshalling: StringMarshalling.Utf8) (or Utf16) instead"
            )
            return
        }
        // 1) Required positional UnmanagedType.
        var unmanagedType UnmanagedType
        let unmanagedTypeArgument = attr.GetConstructorArgument(0, "unmanagedType")
        if unmanagedTypeArgument?.Value is not{} positionalValue ||
            !KnownAttributes
            .TryConvertAttributeEnum[UnmanagedType](positionalValue, out unmanagedType) {
            diagnostics.ReportMarshalAsUnsupportedUnmanagedType(
                annotationLocation,
                unmanagedTypeArgument?.Value?.ToString() ?? "<missing>"
            )
            return
        }
        if !SupportedUnmanagedTypes.Contains(unmanagedType) {
            diagnostics.ReportMarshalAsUnsupportedUnmanagedType(annotationLocation, unmanagedType.ToString())
            return
        }
        // 2) Named arguments.
        var arraySubType UnmanagedType? = nil
        var safeArraySubType VarEnum? = nil
        var sizeConst int32? = nil
        var sizeParamIndex int32? = nil
        for named in attr.NamedArguments {
            switch named.Name {
                case "ArraySubType" {
                    if named.Value is {} arraySubTypeValue && KnownAttributes.TryConvertAttributeEnum[UnmanagedType](
                        arraySubTypeValue,
                        out var ast
                    ) {
                        arraySubType = ast
                    }
                }
                case "SafeArraySubType" {
                    if named.Value is {} safeArraySubTypeValue && KnownAttributes.TryConvertAttributeEnum[VarEnum](
                        safeArraySubTypeValue,
                        out var sast
                    ) {
                        safeArraySubType = sast
                    }
                }
                case "SizeConst" {
                    if TryReadInt32(named.Value, out var sc) && sc >= 0 {
                        sizeConst = sc
                    }
                }
                case "SizeParamIndex" {
                    if TryReadInt32(named.Value, out var spi) && spi >= 0 {
                        sizeParamIndex = spi
                    }
                }
                default { }
            }
        }
        // 3) Per-UnmanagedType compatibility check against the
        // parameter's G# type. The byref case is handled by stripping
        // the ref-kind: a `@MarshalAs(...)` on `ref int32` validates
        // against `int32` (the pointee), since the marshalling rule
        // applies to the pointed-at unmanaged form.
        let effectiveType = parameter.Type
        if !IsCompatibleMarshalAs(unmanagedType, effectiveType) {
            diagnostics.ReportMarshalAsIncompatibleType(
                annotationLocation,
                parameter.Name,
                effectiveType?.Name ?? "?",
                unmanagedType.ToString()
            )
            return
        }
        // 4) Required-knob checks for the size-bearing forms.
        if unmanagedType == UnmanagedType.ByValTStr && !(sizeConst != nil) {
            diagnostics.ReportMarshalAsMissingRequiredArgument(
                annotationLocation,
                parameter.Name,
                unmanagedType.ToString(),
                "SizeConst"
            )
            return
        }
        if unmanagedType == UnmanagedType.ByValArray && !(sizeConst != nil) {
            diagnostics.ReportMarshalAsMissingRequiredArgument(
                annotationLocation,
                parameter.Name,
                unmanagedType.ToString(),
                "SizeConst"
            )
            return
        }
        if unmanagedType == UnmanagedType.LPArray && !(sizeConst != nil) && !(sizeParamIndex != nil) {
            diagnostics.ReportMarshalAsMissingRequiredArgument(
                annotationLocation,
                parameter.Name,
                unmanagedType.ToString(),
                "SizeConst or SizeParamIndex"
            )
            return
        }
        parameter.SetMarshalAsMetadata(
            MarshalAsMetadata(unmanagedType, arraySubType, safeArraySubType, sizeConst, sizeParamIndex)
        )
    }

    /// ADR-0096 / issue #762: the per-UnmanagedType compatibility
    /// table. Returns `true` when [`unmanagedType`](paramref)
    /// is a valid override for a parameter of [`paramType`](paramref).
    /// The rules are deliberately strict so misuse surfaces at compile
    /// time rather than at runtime through a `TypeLoadException`
    /// or a silently corrupted blob.
    private func IsCompatibleMarshalAs(unmanagedType UnmanagedType, paramType TypeSymbol?) bool {
        if paramType == nil || paramType == TypeSymbol.Error {
            return true // already reported as a separate diagnostic

        }
        switch unmanagedType {
            case UnmanagedType.LPStr,
            UnmanagedType.LPWStr,
            UnmanagedType.LPUTF8Str,
            UnmanagedType.BStr,
            UnmanagedType.ByValTStr {
                return paramType == TypeSymbol.String
            }
            case UnmanagedType.Bool, UnmanagedType.VariantBool {
                return paramType == TypeSymbol.Bool
            }
            case UnmanagedType.I1,
            UnmanagedType.U1,
            UnmanagedType.I2,
            UnmanagedType.U2,
            UnmanagedType.I4,
            UnmanagedType.U4,
            UnmanagedType.I8,
            UnmanagedType
                .U8 {
                // Accepted on bool (the canonical "C function takes int
                // but G# parameter is bool" case) and on any integer
                // primitive. Width mismatches are the user's
                // responsibility — the runtime will reinterpret.
                return paramType == TypeSymbol.Bool ||
                    IsIntegerOrNativeInteger(paramType) ||
                    paramType == TypeSymbol.Char
            }
            case UnmanagedType.SysInt, UnmanagedType.SysUInt {
                return IsIntegerOrNativeInteger(paramType)
            }
            case UnmanagedType.Struct {
                return IsStructMarshallingType(paramType)
            }
            case UnmanagedType.LPArray, UnmanagedType.SafeArray, UnmanagedType.ByValArray {
                return paramType is SliceTypeSymbol
            }
            default {
                return false
            }
        }
    }

    private func IsIntegerOrNativeInteger(t TypeSymbol) bool {
        return t == TypeSymbol.Int8 ||
            t == TypeSymbol.UInt8 ||
            t == TypeSymbol.Int16 ||
            t == TypeSymbol.UInt16 ||
            t == TypeSymbol.Int32 ||
            t == TypeSymbol.UInt32 ||
            t == TypeSymbol.Int64 ||
            t == TypeSymbol.UInt64 ||
            t == TypeSymbol.NInt ||
            t == TypeSymbol.NUInt
    }

    private func TryReadInt32(value object?, out result int32) bool {
        result = 0
        if value is int32 i {
            result = i
            return true
        }
        try {
            result = Convert.ToInt32(value)
            return true
        } catch (Exception) {
            return false
        }
    }

    /// Issue #4370: reports GS0326 when an INSTANCE method of a class or
    /// struct carries `@DllImport` or `@LibraryImport`. The CLR
    /// represents every P/Invoke as a static method (C# requires
    /// `static` too), so the G# spelling is a member of the type's
    /// `shared { }` block.
    /// @param method The instance method, with its attributes bound.
    /// @param syntax The originating function declaration.
    /// @param diagnostics The diagnostics bag for this binder.
    /// @returns `true` when the method carries a P/Invoke attribute (and was reported).
    internal func ReportPInvokeOnInstanceMethod(
        method FunctionSymbol,
        syntax FunctionDeclarationSyntax,
        diagnostics DiagnosticBag
    ) bool {
        let isDllImport = KnownAttributes.FindDllImport(method.Attributes) != nil
        if !isDllImport && KnownAttributes.FindLibraryImport(method.Attributes) == nil {
            return false
        }
        diagnostics.ReportDllImportInvalidFunctionShape(
            syntax.Identifier.Location,
            if isDllImport {
                "DllImport"
            } else {
                "LibraryImport"
            },
            method.Name,
            "instance methods are not supported; P/Invoke methods are static, so declare it inside the type's 'shared { }' block"
        )
        return true
    }

    /// Issue #4370: reports GS0326 when a `shared`-block P/Invoke
    /// ([`function`](paramref), already confirmed a P/Invoke) belongs to
    /// a generic type or a type nested in one. The CLR refuses to load a
    /// P/Invoke method whose declaring type is generic (csc reports CS7042
    /// for the same shape), so this is a compile-time error rather than a
    /// TypeLoadException at first call.
    /// @param function The `shared`-block P/Invoke method.
    /// @param owner The declaring class or struct.
    /// @param syntax The originating function declaration.
    /// @param diagnostics The diagnostics bag for this binder.
    internal func ReportPInvokeInGenericType(
        function FunctionSymbol,
        owner StructSymbol,
        syntax FunctionDeclarationSyntax,
        diagnostics DiagnosticBag
    ) {
        if owner.TypeParameters.IsDefaultOrEmpty && StructSymbol.CollectEnclosingTypeParameters(owner)
            .IsDefaultOrEmpty {
            return
        }
        diagnostics.ReportDllImportInvalidFunctionShape(
            syntax.Identifier.Location,
            if KnownAttributes.FindDllImport(function.Attributes) != nil {
                "DllImport"
            } else {
                "LibraryImport"
            },
            function.Name,
            "members of generic types are not supported"
        )
    }

    /// ADR-0096 / issue #762: walks the parameter symbols of a
    /// non-P/Invoke function and reports GS0360 for every parameter
    /// that carries a `@MarshalAs(...)` annotation. Called from
    /// (cref:DeclarationBinder) after a function declaration has
    /// been confirmed to lack an `@DllImport` / `@LibraryImport`.
    /// @param syntax The originating function declaration.
    /// @param diagnostics The diagnostics bag for this binder.
    internal func ReportMarshalAsOnNonPInvokeFunction(syntax FunctionDeclarationSyntax, diagnostics DiagnosticBag) {
        if syntax?.Parameters == nil {
            return
        }
        for ps in syntax.Parameters {
            if ps.Annotations.IsDefaultOrEmpty {
                continue
            }
            for ann in ps.Annotations {
                if ann.NameSegments.IsDefaultOrEmpty {
                    continue
                }
                let lastSegment = ann.NameSegments[ann.NameSegments.Length - 1].Text
                if lastSegment == "MarshalAs" || lastSegment == "MarshalAsAttribute" {
                    // ADR-0185: a P/Invoke declaration's parameters come from
                    // Parser.Members.cs's ParseParameter, never from a
                    // destructured arrow-lambda parameter — Identifier is
                    // always set here.
                    diagnostics.ReportMarshalAsRejected(
                        ann.Location,
                        ps.Identifier!!.ValueText,
                        "the enclosing function is not a P/Invoke declaration (`@DllImport` or `@LibraryImport`)"
                    )
                }
            }
        }
    }
}
