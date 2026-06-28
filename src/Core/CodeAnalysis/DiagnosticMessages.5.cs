// <copyright file="DiagnosticMessages.5.cs" company="GSharp">
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
    /// Reports GS0322 when <c>@DllImport</c> is applied without a non-empty
    /// string library name as the first positional argument (ADR-0086 §3 / issue #727).
    /// </summary>
    /// <param name="location">The annotation location.</param>
    public void ReportDllImportMissingLibraryName(TextLocation location)
    {
        Report(location, "GS0322", "'@DllImport' requires a non-empty string library name as the first positional argument (ADR-0086).");
    }

    /// <summary>
    /// Reports GS0323 when a P/Invoke parameter or return type is not in the
    /// supported marshalling table (ADR-0086 §2 / issue #727).
    /// </summary>
    /// <param name="location">The offending type-clause location.</param>
    /// <param name="typeName">The display name of the unsupported type.</param>
    public void ReportPInvokeUnsupportedMarshallingType(TextLocation location, string typeName)
    {
        Report(location, "GS0323", $"Type '{typeName}' is not supported for P/Invoke marshalling in v1; see ADR-0086 §2 for the supported set.");
    }

    /// <summary>
    /// Reports GS0324 when a function carries <c>@DllImport</c> but also has a
    /// managed body (ADR-0086 §1 / issue #727). P/Invoke stubs must use a
    /// <c>;</c> body marker.
    /// </summary>
    /// <param name="location">The body-block location.</param>
    /// <param name="functionName">The declared function name.</param>
    public void ReportPInvokeMustNotHaveBody(TextLocation location, string functionName)
    {
        Report(location, "GS0324", $"P/Invoke function '{functionName}' must not have a body; replace the '{{ ... }}' block with ';' (ADR-0086).");
    }

    /// <summary>
    /// Reports GS0325 when a function uses a <c>;</c> body marker but is not
    /// annotated with <c>@DllImport</c> (ADR-0086 §1 / issue #727). A
    /// semicolon-only body is reserved for P/Invoke declarations.
    /// </summary>
    /// <param name="location">The function-identifier location.</param>
    /// <param name="functionName">The declared function name.</param>
    public void ReportSemicolonBodyRequiresDllImport(TextLocation location, string functionName)
    {
        Report(location, "GS0325", $"Function '{functionName}' has no body; only '@DllImport'-annotated functions may use a ';' body marker (ADR-0086).");
    }

    /// <summary>
    /// Reports GS0326 when <c>@DllImport</c> is applied to a function shape
    /// that v1 P/Invoke does not support — instance method, async, generic,
    /// extension function, ref-returning function (ADR-0086 §1).
    /// </summary>
    /// <param name="location">The function-identifier location.</param>
    /// <param name="functionName">The declared function name.</param>
    /// <param name="reason">A short reason for the rejection.</param>
    public void ReportDllImportInvalidFunctionShape(TextLocation location, string functionName, string reason)
    {
        Report(location, "GS0326", $"'@DllImport' is not valid on '{functionName}': {reason} (ADR-0086).");
    }

    /// <summary>
    /// Reports GS0327 when a <c>CharSet:</c> argument to <c>@DllImport</c> is
    /// not a valid <see cref="System.Runtime.InteropServices.CharSet"/> member
    /// value (ADR-0086 §3).
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="value">The supplied raw value (display string).</param>
    public void ReportDllImportInvalidCharSet(TextLocation location, string value)
    {
        Report(location, "GS0327", $"CharSet value '{value}' is not a valid 'CharSet' member (expected 'None', 'Ansi', 'Unicode', or 'Auto'). See ADR-0086.");
    }

    /// <summary>
    /// Reports GS0328 when a <c>CallingConvention:</c> argument to
    /// <c>@DllImport</c> is not a valid
    /// <see cref="System.Runtime.InteropServices.CallingConvention"/> member
    /// value (ADR-0086 §3).
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="value">The supplied raw value (display string).</param>
    public void ReportDllImportInvalidCallingConvention(TextLocation location, string value)
    {
        Report(location, "GS0328", $"CallingConvention value '{value}' is not a valid 'CallingConvention' member (expected 'Winapi', 'Cdecl', 'StdCall', 'ThisCall', or 'FastCall'). See ADR-0086.");
    }

    /// <summary>
    /// Reports GS0329 when the <c>EntryPoint:</c> argument to
    /// <c>@DllImport</c> is not a non-empty string literal (ADR-0086 §3).
    /// </summary>
    /// <param name="location">The argument location.</param>
    public void ReportDllImportInvalidEntryPoint(TextLocation location)
    {
        Report(location, "GS0329", "'@DllImport.EntryPoint' must be a non-empty string literal (ADR-0086).");
    }

    /// <summary>
    /// ADR-0092 / issue #758: GS0342 — a function carries both
    /// <c>@DllImport</c> and <c>@LibraryImport</c>. The two P/Invoke
    /// attribute shapes are mutually exclusive on the same declaration.
    /// </summary>
    /// <param name="location">The location of the offending function identifier.</param>
    /// <param name="functionName">The function name.</param>
    public void ReportPInvokeMixedDllAndLibraryImport(TextLocation location, string functionName)
    {
        Report(
            location,
            "GS0342",
            $"Function '{functionName}' carries both '@DllImport' and '@LibraryImport'; the two P/Invoke attribute shapes are mutually exclusive — choose one (ADR-0092).");
    }

    /// <summary>
    /// ADR-0092 / issue #758: GS0343 — a <c>StringMarshalling:</c> argument
    /// to <c>@LibraryImport</c> is not a valid
    /// <see cref="System.Runtime.InteropServices.StringMarshalling"/> member
    /// value (<c>Utf8</c>, <c>Utf16</c>, or <c>Custom</c>).
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="value">The supplied raw value (display string).</param>
    public void ReportLibraryImportInvalidStringMarshalling(TextLocation location, string value)
    {
        Report(
            location,
            "GS0343",
            $"StringMarshalling value '{value}' is not a valid 'StringMarshalling' member (expected 'Utf8', 'Utf16', or 'Custom'). See ADR-0092.");
    }

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
    {
        Report(
            location,
            "GS0344",
            $"'@LibraryImport' function '{functionName}' uses a 'string' parameter or return type but does not specify 'StringMarshalling'; pass 'StringMarshalling: StringMarshalling.Utf8' (or 'Utf16') (ADR-0092).");
    }

    /// <summary>
    /// ADR-0092 / issue #758: GS0345 — an <c>@LibraryImport</c> function
    /// returns a <c>string</c>, which the v1 stub generator cannot
    /// safely free. Use a non-string return (e.g. <c>nint</c>) and call
    /// the appropriate <c>Marshal.PtrToString</c> helper at the call
    /// site instead.
    /// </summary>
    /// <param name="location">The location of the offending return-type clause.</param>
    /// <param name="functionName">The function name.</param>
    public void ReportLibraryImportStringReturnNotSupported(TextLocation location, string functionName)
    {
        Report(
            location,
            "GS0345",
            $"'@LibraryImport' function '{functionName}' returns 'string'; the v1 stub generator does not yet support string return marshalling — return 'nint' and use 'Marshal.PtrToStringUTF8' at the call site (ADR-0092).");
    }

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
    {
        Report(
            location,
            "GS0346",
            $"'@StructLayout(LayoutKind.{value})' is not supported; use 'LayoutKind.Sequential' or 'LayoutKind.Explicit' (ADR-0093).");
    }

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
    {
        Report(
            location,
            "GS0347",
            $"Field '{fieldName}' of explicit-layout type '{typeName}' must declare an '@FieldOffset(N)' (ADR-0093).");
    }

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
    {
        Report(
            location,
            "GS0348",
            $"'@FieldOffset' on field '{fieldName}' of type '{typeName}' is only valid when the declaring type is declared with '@StructLayout(LayoutKind.Explicit)' (ADR-0093).");
    }

    /// <summary>
    /// ADR-0093 / issue #759: GS0349 — a struct or class type used in a
    /// P/Invoke parameter or return position is not blittable. The user
    /// must add <c>@StructLayout(LayoutKind.Sequential)</c> (or
    /// <c>Explicit</c>) and ensure every field has a blittable type.
    /// </summary>
    /// <param name="location">The offending type-clause location.</param>
    /// <param name="typeName">The display name of the offending type.</param>
    public void ReportPInvokeNonBlittableType(TextLocation location, string typeName)
    {
        Report(
            location,
            "GS0349",
            $"Type '{typeName}' is not blittable and cannot appear in a P/Invoke signature in v1; declare it with '@StructLayout(LayoutKind.Sequential)' (or 'Explicit') and ensure every field has a blittable type (ADR-0093).");
    }

    /// <summary>
    /// ADR-0093 / issue #759: GS0350 — the integer argument of
    /// <c>@FieldOffset(N)</c> is not a non-negative <c>int32</c> constant.
    /// </summary>
    /// <param name="location">The argument location.</param>
    /// <param name="value">The supplied raw value (display string).</param>
    public void ReportFieldOffsetInvalidValue(TextLocation location, string value)
    {
        Report(
            location,
            "GS0350",
            $"'@FieldOffset' requires a non-negative 'int32' constant; got '{value}' (ADR-0093).");
    }

    /// <summary>
    /// ADR-0093 / issue #759: GS0351 — a class type is used as the return
    /// type of a P/Invoke function. v1 supports class types only as
    /// parameters (passed by reference); the return-value ownership /
    /// allocation contract is deferred to a future ADR.
    /// </summary>
    /// <param name="location">The return-type clause location.</param>
    /// <param name="typeName">The class display name.</param>
    public void ReportPInvokeClassReturnNotSupported(TextLocation location, string typeName)
    {
        Report(
            location,
            "GS0351",
            $"Class type '{typeName}' is not supported as a P/Invoke return value; only struct values (or 'nint' for opaque handles) are permitted (ADR-0093).");
    }

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
    {
        Report(
            location,
            "GS0352",
            $"'ref'/'out'/'in' parameter '{parameterName}' requires a blittable pointee; '{pointeeTypeName}' is not blittable. Use a blittable primitive (e.g. 'int32', 'int64', 'nint'), or a struct annotated with '@StructLayout(LayoutKind.Sequential)' (ADR-0094).");
    }

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
    {
        Report(
            location,
            "GS0353",
            $"Delegate-typed P/Invoke parameter '{parameterName}' of type '{delegateTypeName}' requires the delegate declaration to be annotated with '@UnmanagedFunctionPointer(CallingConvention.Cdecl)' (or a matching calling convention). Without that attribute the runtime cannot produce a stable function-pointer thunk (ADR-0095).");
    }

    /// <summary>
    /// ADR-0095 / issue #761: GS0354 — the calling convention named in a
    /// raw function-pointer type clause (<c>unmanaged[CC] (...) -&gt; R</c>)
    /// is not one of the supported values. The recognised conventions are
    /// <c>Cdecl</c>, <c>Stdcall</c>, <c>Thiscall</c>, <c>Fastcall</c>.
    /// </summary>
    /// <param name="location">The offending calling-convention identifier location.</param>
    /// <param name="name">The unrecognised identifier.</param>
    public void ReportFunctionPointerUnknownCallingConvention(TextLocation location, string name)
    {
        Report(
            location,
            "GS0354",
            $"Unknown calling convention '{name}' on an 'unmanaged' function-pointer type clause. Use one of: Cdecl, Stdcall, Thiscall, Fastcall (ADR-0095).");
    }

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
    {
        Report(
            location,
            "GS0355",
            $"Returning a managed delegate '{delegateTypeName}' from a P/Invoke declaration is not supported. Declare the return as 'unmanaged[CC] (...) -> R' (a raw function pointer) or 'nint' and wrap manually with 'Marshal.GetDelegateForFunctionPointer' (ADR-0095).");
    }

    /// <summary>
    /// ADR-0095 / issue #761: GS0356 — a raw function-pointer type clause
    /// is missing its required calling-convention slot. The syntax is
    /// <c>unmanaged[CC] (T1, T2, ...) -&gt; R</c>; the <c>[CC]</c> bracket
    /// list is mandatory and the convention must be one of <c>Cdecl</c>,
    /// <c>Stdcall</c>, <c>Thiscall</c>, <c>Fastcall</c>.
    /// </summary>
    /// <param name="location">The offending location (typically the <c>unmanaged</c> keyword).</param>
    public void ReportFunctionPointerMissingCallingConvention(TextLocation location)
    {
        Report(
            location,
            "GS0356",
            "Raw function-pointer type clause is missing its calling-convention slot. Expected 'unmanaged[Cdecl|Stdcall|Thiscall|Fastcall] (...) -> R' (ADR-0095).");
    }

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
    {
        Report(
            location,
            "GS0357",
            $"'@MarshalAs' UnmanagedType '{value}' is not in the v1 supported set. Use one of: LPStr, LPWStr, LPUTF8Str, BStr, LPArray, SafeArray, I1, U1, I2, U2, I4, U4, I8, U8, Bool, VariantBool, SysInt, SysUInt, Struct, ByValTStr, ByValArray (ADR-0096).");
    }

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
    {
        Report(
            location,
            "GS0358",
            $"'@MarshalAs(UnmanagedType.{unmanagedType})' is not valid on parameter '{parameterName}' of type '{parameterType}'. See ADR-0096 §3 for the parameter-type ↔ UnmanagedType compatibility table.");
    }

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
    {
        Report(
            location,
            "GS0359",
            $"'@MarshalAs(UnmanagedType.{unmanagedType})' on parameter '{parameterName}' requires the '{missingArgument}' named argument (ADR-0096 §3).");
    }

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
    {
        Report(
            location,
            "GS0360",
            $"'@MarshalAs' on parameter '{parameterName}' is not supported: {reason} (ADR-0096 §3).");
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
    {
        Report(
            location,
            "GS0362",
            "Bare 'default' has no target type in this context. Write 'default(T)' with an explicit type clause, or use the bare form in a target-typed position (let/var initializer with explicit type, 'return' when the return type is known, an argument to a typed parameter, or a branch of '?:' typed by the sibling branch).",
            DiagnosticSeverity.Error);
    }

    /// <summary>
    /// Reports GS0363 — ADR-0101 / issue #799: the C# <c>params</c> keyword is
    /// not part of the G# parameter grammar. The canonical G# spelling for a
    /// variadic parameter is <c>name ...T</c> (where <c>T</c> is the element
    /// type — inside the body the parameter has type <c>[]T</c>).
    /// </summary>
    /// <param name="location">The location of the rejected <c>params</c> keyword.</param>
    public void ReportParamsKeywordNotSupported(TextLocation location)
    {
        Report(
            location,
            "GS0363",
            "The C# 'params' keyword is not supported in G#. Use the canonical variadic spelling 'name ...T' (Go-style); inside the function body the parameter has type '[]T'.",
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
    /// Reports GS0366 — ADR-0104 / issue #805: the legacy Go-flavored
    /// <c>map[K]V</c> type-clause spelling has been removed in v0.2. Maps
    /// are now spelled <c>map[K,V]</c> with both type arguments inside the
    /// brackets.
    /// </summary>
    /// <param name="location">The source location spanning the offending
    /// <c>map[K]V</c> shape (from <c>map</c> through the value type).</param>
    /// <param name="keyTypeText">The source text of the key type clause.</param>
    /// <param name="valueTypeText">The source text of the value type clause.</param>
    public void ReportLegacyMapTypeClauseSyntax(TextLocation location, string keyTypeText, string valueTypeText)
    {
        Report(
            location,
            "GS0366",
            $"The 'map[K]V' type-clause spelling has been removed; use 'map[{keyTypeText},{valueTypeText}]' instead (ADR-0104).",
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
    {
        Report(
            location,
            "GS0333",
            $"Type parameter '{typeParameterName}' has no constraint that declares a static-virtual member '{memberName}' (ADR-0089).",
            DiagnosticSeverity.Error);
    }

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
    {
        Report(
            location,
            "GS0334",
            $"Cannot access private interface member '{interfaceName}.{methodName}' from outside the interface declaration (ADR-0090).",
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
    {
        Report(
            location,
            "GS0338",
            $"'base[{interfaceName}]' is not valid here: enclosing type '{enclosingTypeName}' does not implement interface '{interfaceName}' (ADR-0091). Use 'base[IFoo]' only inside an instance member of a type that lists 'IFoo' in its base-type list.",
            DiagnosticSeverity.Error);
    }
}
