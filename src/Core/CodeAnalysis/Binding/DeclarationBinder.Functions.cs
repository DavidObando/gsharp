// <copyright file="DeclarationBinder.Functions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class DeclarationBinder
{
    internal void BindFunctionDeclaration(FunctionDeclarationSyntax syntax, PackageSymbol package)
    {
        // ADR-0122 / issue #1014: an `unsafe func` is bound entirely within an
        // unsafe context so its parameter / return types may be unmanaged raw
        // pointers (`*T` → CLR ELEMENT_TYPE_PTR).
        using var unsafeContext = binderCtx.PushUnsafeContext(syntax.IsUnsafe);

        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();

        var seenParameterNames = new HashSet<string>();

        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        var ownerTypeParameters = GetGenericOperatorOwnerTypeParameters(syntax, package);
        if (!ownerTypeParameters.IsDefaultOrEmpty)
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters == null
                ? new Dictionary<string, TypeParameterSymbol>()
                : new Dictionary<string, TypeParameterSymbol>(previousTypeParameters);
            foreach (var tp in ownerTypeParameters)
            {
                binderCtx.CurrentTypeParameters[tp.Name] = tp;
            }
        }

        try
        {
            // Phase 4.1 / ADR-0020: bind generic type parameters first so that
            // BindTypeClause can find them when binding parameter / return types.
            // Issue #2402: an open-self operator declaration (`Box[T]`) uses the
            // owner's type parameters, published above, rather than declaring a
            // generic operator method.
            var typeParameters = BindTypeParameterList(syntax.TypeParameterList);
            if (!typeParameters.IsDefaultOrEmpty)
            {
                var functionTypeParameterScope = binderCtx.CurrentTypeParameters == null
                    ? new Dictionary<string, TypeParameterSymbol>()
                    : new Dictionary<string, TypeParameterSymbol>(binderCtx.CurrentTypeParameters);
                foreach (var tp in typeParameters)
                {
                    functionTypeParameterScope[tp.Name] = tp;
                }

                binderCtx.CurrentTypeParameters = functionTypeParameterScope;
            }

            BindFunctionDeclarationCore(syntax, package, typeParameters, parameters, seenParameterNames);
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

    private ImmutableArray<TypeParameterSymbol> GetGenericOperatorOwnerTypeParameters(
        FunctionDeclarationSyntax syntax,
        PackageSymbol package)
    {
        if (syntax.IsExtension && syntax.Identifier.Text.StartsWith("op_", StringComparison.Ordinal))
        {
            return TryGetOpenSelfTypeParameters(syntax.Receiver.Type, package);
        }

        if (syntax.IsConversionOperator)
        {
            if (syntax.Parameters.Count > 0)
            {
                var sourceOwner = TryGetOpenSelfTypeParameters(syntax.Parameters[0].Type, package);
                if (!sourceOwner.IsDefaultOrEmpty)
                {
                    return sourceOwner;
                }
            }

            return TryGetOpenSelfTypeParameters(syntax.Type, package);
        }

        return ImmutableArray<TypeParameterSymbol>.Empty;
    }

    private ImmutableArray<TypeParameterSymbol> TryGetOpenSelfTypeParameters(
        TypeClauseSyntax syntax,
        PackageSymbol package)
    {
        if (syntax == null
            || syntax.HasQualifier
            || !syntax.HasTypeArguments
            || syntax.IsArray
            || syntax.IsNullable
            || !scope.TryLookupTypeAlias(syntax.Identifier.Text, syntax.TypeArguments.Count, out var candidate)
            || candidate is not StructSymbol candidateStruct)
        {
            return ImmutableArray<TypeParameterSymbol>.Empty;
        }

        var owner = candidateStruct.Definition ?? candidateStruct;
        if (package == null
            || !owner.IsGenericDefinition
            || owner.TypeParameters.Length != syntax.TypeArguments.Count
            || !string.Equals(owner.PackageName, package.Name, StringComparison.Ordinal))
        {
            return ImmutableArray<TypeParameterSymbol>.Empty;
        }

        for (var i = 0; i < owner.TypeParameters.Length; i++)
        {
            var argument = syntax.TypeArguments[i];
            if (argument.Identifier == null
                || argument.HasQualifier
                || argument.HasTypeArguments
                || argument.IsArray
                || argument.IsNullable
                || argument.IsTuple
                || argument.IsFunction
                || argument.IsMap
                || argument.IsChannel
                || argument.IsPointer
                || argument.IsSequence
                || argument.Identifier.Text != owner.TypeParameters[i].Name)
            {
                return ImmutableArray<TypeParameterSymbol>.Empty;
            }
        }

        return owner.TypeParameters;
    }

    private void BindFunctionDeclarationCore(
        FunctionDeclarationSyntax syntax,
        PackageSymbol package,
        ImmutableArray<TypeParameterSymbol> typeParameters,
        ImmutableArray<ParameterSymbol>.Builder parameters,
        HashSet<string> seenParameterNames)
    {
        var receiverBinding = BindFunctionReceiver(syntax, package, parameters, seenParameterNames);
        if (!receiverBinding.Succeeded)
        {
            return;
        }

        var receiverType = receiverBinding.ReceiverType;
        var explicitReceiverParameter = receiverBinding.ExplicitReceiverParameter;
        var methodReceiverStruct = receiverBinding.MethodReceiverStruct;
        var parameterSymbolBySyntax = BindFunctionParameters(syntax, parameters, seenParameterNames);
        var returnBinding = BindFunctionReturn(syntax, parameterSymbolBySyntax);
        var type = returnBinding.ReturnType;
        var typeIsValueTask = returnBinding.TypeIsValueTask;
        var returnRefKind = returnBinding.ReturnRefKind;
        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var functionAttributes = BindFunctionAttributes(syntax, type);
        BindFunctionParameterAttributes(syntax, parameterSymbolBySyntax, type);

        FunctionSymbol function;

        // Issue #1017: a user-defined conversion operator
        // `func operator implicit (x T) U { … }` (or `explicit`) is modelled
        // as a static `op_Implicit` / `op_Explicit` special-name method on
        // the owning user type. It takes exactly one parameter (the source
        // operand) and its return type is the conversion target; at least
        // one of source/target must be a same-package user type.
        if (syntax.IsConversionOperator)
        {
            BindConversionOperatorDeclaration(syntax, parameters.ToImmutable(), type, accessibility, package, functionAttributes);
            return;
        }

        if (methodReceiverStruct != null)
        {
            var methodName = syntax.Identifier.Text;

            // ADR-0079 / issue #719: warn when a receiver-clause method
            // targets a same-package ("owned") struct or class. The
            // canonical form for owned-type instance methods is the
            // in-body declaration; the receiver-clause form is reserved
            // for non-owned types (imported CLR or referenced-package
            // types). Operators are exempt because they have no in-body
            // counterpart — the parser synthesises an `op_*`-prefixed
            // identifier for `func (a T) operator …`.
            if (!methodName.StartsWith("op_", StringComparison.Ordinal))
            {
                Diagnostics.ReportReceiverClauseOnOwnedType(
                    syntax.Receiver.Type.Location,
                    methodReceiverStruct.Name,
                    methodName);
            }

            if (methodReceiverStruct.IsInline && IsInlineSynthesizedMemberName(methodName))
            {
                Diagnostics.ReportInlineStructSynthesizedMemberConflict(syntax.Identifier.Location, methodReceiverStruct.Name, methodName);
                return;
            }

            // Issue #2361: same ToString exception as the in-body form
            // above — a compatible shape falls through as an ordinary
            // receiver-clause method (suppressing the synthesized
            // ToString); an incompatible one gets the more specific
            // GS0487 instead of the blanket GS0232.
            if (methodReceiverStruct.IsData && IsDataStructSynthesizedMemberName(methodName) && !IsUserOverridableDataMemberName(methodName))
            {
                Diagnostics.ReportDataStructSynthesizedMemberConflict(syntax.Identifier.Location, methodReceiverStruct.Name, methodReceiverStruct.IsClass, methodName);
                return;
            }

            if (methodReceiverStruct.IsData && methodName == "ToString"
                && !IsCompatibleDataToStringOverride(syntax.Parameters.Count, type, returnRefKind, syntax.IsAsync, syntax.IsUnsafe, typeParameters, accessibility))
            {
                Diagnostics.ReportIncompatibleDataToStringOverride(syntax.Identifier.Location, methodReceiverStruct.Name, methodReceiverStruct.IsClass);
                return;
            }

            if (methodReceiverStruct.TryGetField(methodName, out _))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, methodName);
                return;
            }

            // Issue #2377: a receiver-clause binary/unary operator
            // (`func (a T) operator +(b T) T { … }`) is syntax sugar over
            // a CLR operator — it must be emitted as the canonical static,
            // public, SpecialName `op_*` method with NO hidden instance
            // receiver, exactly like a hand-authored C# `public static T
            // operator +(T a, T b)`. The receiver clause is preserved as
            // syntax only: `a` still binds as an ordinary named parameter
            // (Parameters[0], already added above), so the body sees the
            // same identifiers as before, but the symbol itself is static
            // — reusing the exact shape `BindConversionOperatorDeclaration`
            // already uses for `op_Implicit`/`op_Explicit` above, and the
            // shape non-owned-receiver ("extension") operators already got
            // via `FunctionSymbol.IsExtension` — so it round-trips through
            // the SAME generic static-method emission path (no operator-
            // specific emitter logic needed) and is discoverable by CLR
            // consumers and by gsc's own ClrOperatorResolution (Stream C)
            // reflection fallback after import.
            if (methodName.StartsWith("op_", StringComparison.Ordinal))
            {
                function = new FunctionSymbol(
                    methodName,
                    parameters.ToImmutable(),
                    type,
                    syntax,
                    package,
                    accessibility,
                    receiverType: (TypeSymbol)null);
                function.TypeParameters = typeParameters;
                function.IsUnsafe = syntax.IsUnsafe;
                function.ReturnRefKind = returnRefKind;
                function.IsStatic = true;
                function.StaticOwnerType = methodReceiverStruct;
                function.IsSpecialName = true;
                Binder.AttachDocumentation(function, syntax);
                function.SetAttributes(functionAttributes);
                ValidateInlineDataNilArguments(functionAttributes, function.Parameters);

                // Duplicate-signature detection against existing static
                // methods on the receiver (operators live in the static
                // method bucket, not the instance one).
                foreach (var existingStatic in methodReceiverStruct.StaticMethods)
                {
                    if (BoundScope.FunctionSignaturesEqual(existingStatic, function))
                    {
                        Diagnostics.ReportDuplicateOverloadSignature(
                            syntax.Identifier.Location,
                            methodName,
                            Binder.FormatOverloadSignature(function));
                        return;
                    }
                }

                methodReceiverStruct.AddStaticMethods(ImmutableArray.Create(function));
                PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(syntax, Diagnostics);
                return;
            }

            function = new FunctionSymbol(
                methodName,
                parameters.ToImmutable(),
                type,
                syntax,
                package,
                accessibility,
                methodReceiverStruct,
                explicitReceiverParameter);
            function.TypeParameters = typeParameters;
            function.IsAsync = syntax.IsAsync || isAsyncIteratorReturnType(type);
            function.AsyncReturnsValueTask = typeIsValueTask;
            function.IsUnsafe = syntax.IsUnsafe;
            function.ReturnRefKind = returnRefKind;
            Binder.AttachDocumentation(function, syntax);
            function.SetAttributes(functionAttributes);
            ValidateInlineDataNilArguments(functionAttributes, function.Parameters);

            // ADR-0063 §11: detect duplicate-signature against existing methods on the receiver.
            foreach (var existingMethod in methodReceiverStruct.Methods)
            {
                if (BoundScope.FunctionSignaturesEqual(existingMethod, function))
                {
                    Diagnostics.ReportDuplicateOverloadSignature(
                        syntax.Identifier.Location,
                        methodName,
                        Binder.FormatOverloadSignature(function));
                    return;
                }
            }

            methodReceiverStruct.AddMethods(ImmutableArray.Create(function));

            // ADR-0096 / issue #762: a receiver-clause method is
            // never a P/Invoke (GS0326 would also fire for the
            // shape), so any `@MarshalAs` on a parameter is rejected
            // with GS0360 to make the misuse explicit.
            PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(syntax, Diagnostics);
            return;
        }

        function = new FunctionSymbol(syntax.Identifier.Text, parameters.ToImmutable(), type, syntax, package, accessibility);
        function.TypeParameters = typeParameters;
        function.IsAsync = syntax.IsAsync || isAsyncIteratorReturnType(type);
        function.AsyncReturnsValueTask = typeIsValueTask;
        function.IsUnsafe = syntax.IsUnsafe;
        function.ReturnRefKind = returnRefKind;
        Binder.AttachDocumentation(function, syntax);
        function.SetAttributes(functionAttributes);
        ValidateInlineDataNilArguments(functionAttributes, function.Parameters);

        // ADR-0086 / issue #727: when @DllImport is present and well-formed,
        // attach the resolved PInvokeMetadata so the emitter wires the
        // ImplMap row and the body-binder skips body binding. If the user
        // wrote `;` but no @DllImport, surface GS0325.
        var isPInvoke = PInvokeBinder.TryAttachPInvokeMetadata(function, syntax, Diagnostics);
        if (!isPInvoke && syntax.HasSemicolonBody)
        {
            Diagnostics.ReportSemicolonBodyRequiresDllImport(syntax.Identifier.Location, function.Name);
        }

        // ADR-0096 / issue #762: `@MarshalAs` on a non-P/Invoke
        // parameter has no CLR-defined meaning (it is a pseudo-custom
        // attribute encoded into a FieldMarshal table row, but the
        // managed-call ABI does not consult that row). Report GS0360
        // so the misuse is not silently elided.
        if (!isPInvoke)
        {
            PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(syntax, Diagnostics);
        }

        if (syntax.IsExtension)
        {
            function.IsExtension = true;
            function.ExtensionReceiverType = receiverType;

            // Issue #1188: extension functions overload like ordinary
            // methods and free functions. A collision now means a genuine
            // duplicate signature (same receiver type, name, and callable
            // parameters) — report it as a duplicate-overload-signature
            // error to match the method/free-function path rather than a
            // generic redeclaration.
            if (function.Declaration.Identifier.Text != null && !scope.TryDeclareExtensionFunction(function))
            {
                Diagnostics.ReportDuplicateOverloadSignature(syntax.Identifier.Location, function.Name, Binder.FormatOverloadSignature(function));
            }

            return;
        }

        if (function.Declaration.Identifier.Text != null && !scope.TryDeclareFunction(function))
        {
            // ADR-0063 §11: if the collision is with another callable of
            // the same name, it is a duplicate-signature error rather
            // than a generic redeclaration.
            var existingOverloads = scope.TryLookupFunctions(function.Name);
            var duplicateSig = false;
            foreach (var existing in existingOverloads)
            {
                if (BoundScope.FunctionSignaturesEqual(existing, function))
                {
                    duplicateSig = true;
                    break;
                }
            }

            if (duplicateSig)
            {
                Diagnostics.ReportDuplicateOverloadSignature(syntax.Identifier.Location, function.Name, Binder.FormatOverloadSignature(function));
            }
            else
            {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, function.Name);
            }
        }
    }

    private readonly record struct FunctionReceiverBindingResult(
        TypeSymbol ReceiverType,
        ParameterSymbol ExplicitReceiverParameter,
        StructSymbol MethodReceiverStruct,
        bool Succeeded);

    private readonly record struct FunctionReturnBindingResult(
        TypeSymbol ReturnType,
        bool TypeIsValueTask,
        RefKind ReturnRefKind);

    private FunctionReceiverBindingResult BindFunctionReceiver(
        FunctionDeclarationSyntax syntax,
        PackageSymbol package,
        ImmutableArray<ParameterSymbol>.Builder parameters,
        HashSet<string> seenParameterNames)
    {
        // Phase 3.B.6 / ADR-0019 and Phase 6.4 / ADR-0024: receiver
        // clauses become parameters[0]. Same-package struct/class receivers
        // are methods; all other valid receivers remain extension functions.
        TypeSymbol receiverType = null;
        ParameterSymbol explicitReceiverParameter = null;
        StructSymbol methodReceiverStruct = null;
        if (syntax.IsExtension)
        {
            var recvName = syntax.Receiver.Identifier.Text;
            receiverType = bindTypeClause(syntax.Receiver.Type);
            if (receiverType == null)
            {
                receiverType = TypeSymbol.Error;
            }

            explicitReceiverParameter = new ParameterSymbol(recvName, receiverType, declaringSyntax: syntax.Receiver);
            seenParameterNames.Add(recvName);
            parameters.Add(explicitReceiverParameter);

            if (receiverType is StructSymbol receiverStruct && string.Equals(receiverStruct.PackageName, package.Name, StringComparison.Ordinal))
            {
                methodReceiverStruct = receiverStruct.Definition ?? receiverStruct;
            }
            else if (IsSamePackageNonAggregateReceiver(syntax.Receiver.Type, receiverType, package))
            {
                Diagnostics.ReportMethodReceiverMustBeStructOrClass(syntax.Receiver.Type.Location, receiverType.Name);
                return new FunctionReceiverBindingResult(receiverType, explicitReceiverParameter, methodReceiverStruct, false);
            }
        }

        return new FunctionReceiverBindingResult(receiverType, explicitReceiverParameter, methodReceiverStruct, true);
    }

    private ParameterSymbol[] BindFunctionParameters(
        FunctionDeclarationSyntax syntax,
        ImmutableArray<ParameterSymbol>.Builder parameters,
        HashSet<string> seenParameterNames)
    {
        // Tracks the bound ParameterSymbol corresponding to each parameter
        // syntax position (null for duplicates) so per-parameter annotations
        // can be attached to the right symbol below.
        var parameterSymbolBySyntax = new ParameterSymbol[syntax.Parameters.Count];
        for (var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++)
        {
            var parameterSyntax = syntax.Parameters[pIndex];
            var parameterName = parameterSyntax.Identifier.Text;
            var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error;

            // Issue #1262: `_` is the discard identifier — repeated `_` parameters are
            // permitted on named functions/methods. Each `_` occupies a positional slot
            // but is not added to the body scope, so non-`_` duplicates still error.
            if (parameterName != "_" && !seenParameterNames.Add(parameterName))
            {
                Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
            }
            else
            {
                // Phase 4.8: a `...T` parameter has type `[]T` for the body
                // and must be the last parameter. Auto-packing of trailing
                // arguments happens at the call site.
                var isVariadic = parameterSyntax.IsVariadic;
                if (isVariadic && parameterType != TypeSymbol.Error)
                {
                    parameterType = SliceTypeSymbol.Get(parameterType);
                }

                var parameterRefKind = conversions.BindAndValidateParameterRefKind(
                    parameterSyntax,
                    parameterName,
                    parameterType,
                    isVariadic,
                    syntax.IsAsync ? "async" : null);

                var parameter = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
                conversions.BindAndAttachParameterDefaultValue(parameterSyntax, parameter);
                parameters.Add(parameter);
                parameterSymbolBySyntax[pIndex] = parameter;
            }
        }

        // Phase 4.8: validate `...T` appears only on the last syntactic parameter.
        // ADR-0101 / issue #799: also flag the (rare) case where more than one
        // parameter is variadic — the second and later occurrences get GS0364
        // in addition to the "must-be-last" diagnostic on the earlier one(s).
        ValidateVariadicParameterShape(syntax.Parameters);
        return parameterSymbolBySyntax;
    }

    private FunctionReturnBindingResult BindFunctionReturn(
        FunctionDeclarationSyntax syntax,
        ParameterSymbol[] parameterSymbolBySyntax)
    {
        // ADR-0041: bind the return type with async-aware alias resolution.
        var type = bindReturnTypeClause(syntax.Type, syntax.IsAsync) ?? TypeSymbol.Void;

        // ADR-0146 (Kotlin visibility narrowing follow-up): infer/narrow the
        // return type when the (omitted-type) body is `-> object { ... }`.
        type = InferAnonymousClassLiteralReturnType(syntax, type, resolveAccessibility(syntax.AccessibilityModifier));

        // Issue #1918: unwrap an explicit `Task[T]` / `ValueTask[T]` async
        // return-type annotation to its awaited result, remembering which
        // wrapper was requested.
        type = NormalizeAsyncDeclaredReturnType(type, syntax.IsAsync, out var typeIsValueTask);

        // Issue #490 (ADR-0060 follow-up): a `ref` return modifier on the declaration
        // is only valid when an explicit return-type clause is present, the function is
        // not async, and the return is not a sequence/async-sequence (the state-machine
        // rewriter cannot hoist a managed pointer into a field — same constraint as
        // ref-kind parameters per ADR-0058 §4).
        var returnRefKind = ValidateReturnRefKind(syntax, type);

        // ADR-0060 §10: post-bind check — if this is a sequence/async-sequence
        // function, ref-kind parameters are forbidden. (The async-only check
        // is handled earlier in the parameter loop.)
        var isSequenceReturn = type is SequenceTypeSymbol || type is AsyncSequenceTypeSymbol;
        if (isSequenceReturn)
        {
            for (var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++)
            {
                var pSym = parameterSymbolBySyntax[pIndex];
                if (pSym != null && pSym.RefKind != RefKind.None)
                {
                    var label = syntax.IsAsync ? "async sequence" : "sequence";
                    Diagnostics.ReportRefKindOnAsyncOrIterator(syntax.Parameters[pIndex].Location, pSym.Name, label);
                }
            }
        }

        return new FunctionReturnBindingResult(type, typeIsValueTask, returnRefKind);
    }

    private ImmutableArray<BoundAttribute> BindFunctionAttributes(
        FunctionDeclarationSyntax syntax,
        TypeSymbol type)
    {
        // Issue #141 / ADR-0047: resolve annotation lead-ins for this
        // declaration. We do this once per function regardless of whether
        // it is an extension, a method, or a free function — diagnostics
        // and the resulting bound-attribute list are identical.
        var functionAttributes = BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Method,
            Binder.FunctionDeclarationAllowedTargets,
            "a function declaration",
            System.AttributeTargets.Method);

        // Issue #176 / ADR-0047 §6: a function marked `@Conditional`
        // must return void. The CLR rule (matching C# CS0578) is that
        // conditional-method calls may be elided at the call site, which
        // is incompatible with a non-void result feeding the surrounding
        // expression. The attribute is still attached to the function
        // symbol so downstream tools see the user's intent and so the
        // call site still elides; the diagnostic is per-declaration.
        if (KnownAttributes.HasConditional(functionAttributes) && type != TypeSymbol.Void)
        {
            Diagnostics.ReportConditionalMethodMustReturnVoid(syntax.Identifier.Location, syntax.Identifier.Text);
        }

        return functionAttributes;
    }

    private void BindFunctionParameterAttributes(
        FunctionDeclarationSyntax syntax,
        ParameterSymbol[] parameterSymbolBySyntax,
        TypeSymbol type)
    {
        // Per-parameter annotations: each ParameterSyntax owns its own
        // annotation list; the default target is `param`. Issue #170 /
        // ADR-0047 §3: the bound list is stored on the ParameterSymbol so
        // the emitter can emit a `CustomAttribute` row keyed to the
        // corresponding `Parameter` metadata handle.
        for (var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++)
        {
            var parameterSyntax = syntax.Parameters[pIndex];
            var paramAttrs = BindAttributes(
                parameterSyntax.Annotations,
                AttributeTargetKind.Param,
                Binder.ParameterAllowedTargets,
                "a parameter declaration",
                System.AttributeTargets.Parameter);

            var parameterSymbol = parameterSymbolBySyntax[pIndex];
            if (parameterSymbol != null && !paramAttrs.IsDefaultOrEmpty)
            {
                parameterSymbol.SetAttributes(paramAttrs);

                // Issue #180 / ADR-0040: validate @EnumeratorCancellation.
                // The attribute marks the cancellation-token parameter that
                // the async-sequence rewriter threads through, so it is
                // only meaningful when (a) the parameter's type is
                // System.Threading.CancellationToken and (b) the enclosing
                // function returns IAsyncEnumerable[T] (an `async sequence`).
                // Diagnostics are reported per offending attribute; the
                // attribute is still attached so downstream tooling can
                // observe the user's intent.
                var ecAttr = KnownAttributes.FindEnumeratorCancellation(paramAttrs);
                if (ecAttr != null)
                {
                    if (parameterSymbol.Type?.ClrType.IsSameAs(typeof(System.Threading.CancellationToken)) != true)
                    {
                        Diagnostics.ReportEnumeratorCancellationWrongType(
                            parameterSyntax.Location,
                            parameterSymbol.Name,
                            parameterSymbol.Type?.Name ?? "?");
                    }
                    else if (!isAsyncSequenceReturnType(type))
                    {
                        Diagnostics.ReportEnumeratorCancellationNotAsyncSequence(
                            parameterSyntax.Location,
                            parameterSymbol.Name);
                    }
                }
            }
        }
    }

    private static bool IsInlineSynthesizedMemberName(string methodName)
    {
        return methodName == "Equals" ||
            methodName == "GetHashCode" ||
            methodName == "ToString" ||
            methodName == "op_Equality" ||
            methodName == "op_Inequality" ||
            methodName == "Deconstruct";
    }

    /// <summary>
    /// Issue #1017: binds a user-defined conversion operator declaration
    /// (<c>func operator implicit (x T) U { … }</c> or the <c>explicit</c>
    /// variant) into a static <c>op_Implicit</c> / <c>op_Explicit</c>
    /// special-name method attached to the owning user type. Enforces the C#
    /// conversion-operator constraints: exactly one parameter; source and
    /// target differ; at least one of them is a same-package user type; and no
    /// duplicate conversion exists for the same source/target pair.
    /// </summary>
    /// <param name="syntax">The conversion-operator declaration syntax.</param>
    /// <param name="parameters">The already-bound parameter list.</param>
    /// <param name="returnType">The already-bound return (target) type.</param>
    /// <param name="accessibility">The declaration's resolved accessibility.</param>
    /// <param name="package">The owning package.</param>
    /// <param name="functionAttributes">Bound annotation attributes for the declaration.</param>
    private void BindConversionOperatorDeclaration(
        FunctionDeclarationSyntax syntax,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol returnType,
        Accessibility accessibility,
        PackageSymbol package,
        ImmutableArray<BoundAttribute> functionAttributes)
    {
        var isExplicit = syntax.ConversionIsExplicit;
        var opName = isExplicit ? "op_Explicit" : "op_Implicit";

        // A conversion operator has exactly one parameter — the source operand.
        if (parameters.Length != 1)
        {
            Diagnostics.ReportConversionOperatorRequiresSingleParameter(syntax.Identifier.Location, isExplicit);
            return;
        }

        var sourceType = parameters[0].Type;
        var targetType = returnType;

        if (sourceType == TypeSymbol.Error || targetType == TypeSymbol.Error)
        {
            return;
        }

        // The source operand may not be passed by ref/out/in.
        if (parameters[0].RefKind != RefKind.None)
        {
            Diagnostics.ReportConversionOperatorRequiresSingleParameter(syntax.Identifier.Location, isExplicit);
            return;
        }

        // A conversion from a type to itself is never user-definable.
        if (Conversion.Classify(sourceType, targetType).IsIdentity)
        {
            Diagnostics.ReportConversionOperatorMustInvolveEnclosingType(syntax.Identifier.Location);
            return;
        }

        // At least one of source/target must be a same-package user type that
        // owns (emits) the operator.
        var owner = TryGetSamePackageOwner(sourceType, package) ?? TryGetSamePackageOwner(targetType, package);
        if (owner == null)
        {
            Diagnostics.ReportConversionOperatorMustInvolveEnclosingType(syntax.Identifier.Location);
            return;
        }

        var function = new FunctionSymbol(
            opName,
            parameters,
            returnType,
            syntax,
            package,
            accessibility,
            receiverType: null);
        function.IsStatic = true;
        function.StaticOwnerType = owner;
        function.IsSpecialName = true;
        Binder.AttachDocumentation(function, syntax);
        if (!functionAttributes.IsDefaultOrEmpty)
        {
            function.SetAttributes(functionAttributes);
        }

        // Reject a duplicate conversion (same source/target pair), whether the
        // existing one is implicit or explicit — matching C# CS0557.
        foreach (var existing in owner.StaticMethods)
        {
            if (existing.Name != "op_Implicit" && existing.Name != "op_Explicit")
            {
                continue;
            }

            if (existing.Parameters.Length != 1)
            {
                continue;
            }

            if (Conversion.Classify(existing.Parameters[0].Type, sourceType).IsIdentity
                && Conversion.Classify(existing.Type, targetType).IsIdentity)
            {
                Diagnostics.ReportDuplicateConversionOperator(syntax.Identifier.Location, sourceType, targetType);
                return;
            }
        }

        owner.AddStaticMethods(ImmutableArray.Create(function));
    }

    /// <summary>
    /// Issue #1017: returns the same-package <see cref="StructSymbol"/> (struct
    /// or class) definition for <paramref name="type"/> when it is declared in
    /// <paramref name="package"/>, or <see langword="null"/> otherwise.
    /// </summary>
    /// <param name="type">The candidate owner type.</param>
    /// <param name="package">The owning package.</param>
    /// <returns>The owning struct definition, or <see langword="null"/>.</returns>
    private static StructSymbol TryGetSamePackageOwner(TypeSymbol type, PackageSymbol package)
    {
        if (type is StructSymbol structSymbol
            && package != null
            && string.Equals(structSymbol.PackageName, package.Name, StringComparison.Ordinal))
        {
            return structSymbol.Definition ?? structSymbol;
        }

        return null;
    }

    /// <summary>
    /// Issue #410 / ADR-0029: data structs synthesize the same six member
    /// names as inline structs (<c>Equals</c>, <c>GetHashCode</c>,
    /// <c>ToString</c>, <c>op_Equality</c>, <c>op_Inequality</c>,
    /// <c>Deconstruct</c>). User code may not hand-write any of them.
    /// Issue #2361: <c>ToString</c> is the one exception — see
    /// <see cref="IsUserOverridableDataMemberName"/> and
    /// <see cref="IsCompatibleDataToStringOverride"/>.
    /// </summary>
    private static bool IsDataStructSynthesizedMemberName(string methodName)
    {
        return IsInlineSynthesizedMemberName(methodName);
    }

    /// <summary>
    /// Issue #2361: names in the ADR-0029 synthesized-member set that MAY be
    /// hand-written on a data class/struct when the declared shape is
    /// compatible (see <see cref="IsCompatibleDataToStringOverride"/>),
    /// suppressing/replacing the synthesized member instead of being
    /// unconditionally rejected. Deliberately narrow today (only
    /// <c>ToString</c> — a record's display format is the one synthesized
    /// facet C# lets users override while keeping equality/hash/copy
    /// compiler-controlled), but factored as its own predicate (rather than
    /// inlining a literal string compare at each of the three call sites)
    /// so a future issue can widen the set without touching the call sites
    /// again.
    /// </summary>
    private static bool IsUserOverridableDataMemberName(string methodName)
    {
        return methodName == "ToString";
    }

    /// <summary>
    /// Issue #2361: a data class/struct's hand-written <c>ToString</c> is
    /// only allowed to suppress/replace the synthesized one when its shape
    /// exactly matches what <c>DataStructSynthesizer.EmitDataStructToString</c>
    /// would have emitted — <c>public string ToString()</c>: zero
    /// parameters, non-static (the caller only reaches this for the
    /// instance-method lists, so staticness is never in question here),
    /// non-generic, non-async, non-unsafe, returning <c>string</c> by value,
    /// with <c>public</c> accessibility (matching
    /// <c>DataStructSynthesizer.DataObjectOverrideAttributes</c>'s
    /// unconditional <c>MethodAttributes.Public</c>). Any other shape keeps
    /// the name collision but is reported as an incompatible override
    /// (GS0487) rather than silently accepted.
    /// </summary>
    private static bool IsCompatibleDataToStringOverride(
        int explicitParameterCount,
        TypeSymbol returnType,
        RefKind returnRefKind,
        bool isAsync,
        bool isUnsafe,
        ImmutableArray<TypeParameterSymbol> methodTypeParameters,
        Accessibility accessibility)
    {
        return explicitParameterCount == 0
            && returnType == TypeSymbol.String
            && returnRefKind == RefKind.None
            && !isAsync
            && !isUnsafe
            && methodTypeParameters.IsDefaultOrEmpty
            && accessibility == Accessibility.Public;
    }

    private bool IsSamePackageNonAggregateReceiver(TypeClauseSyntax receiverSyntax, TypeSymbol receiverType, PackageSymbol package)
    {
        if (receiverType is InterfaceSymbol iface)
        {
            return string.Equals(iface.PackageName, package.Name, StringComparison.Ordinal);
        }

        if (receiverType is EnumSymbol enumSymbol)
        {
            return string.Equals(enumSymbol.PackageName, package.Name, StringComparison.Ordinal);
        }

        var receiverName = receiverSyntax?.Identifier?.Text;
        return receiverName != null
            && !isPrimitiveTypeName(receiverName)
            && scope.TryLookupTypeAlias(receiverName, out var aliased)
            && ReferenceEquals(aliased, receiverType)
            && receiverType is not StructSymbol;
    }

    /// <summary>
    /// Binds a type-parameter list without constraint pre-publication. Made
    /// <c>internal</c> (issue #1886) so <see cref="LambdaBinder"/> can bind the
    /// <c>[T, U, ...]</c> list on a generic <c>let</c>-bound local function
    /// declaration (<c>let Name[T] = func (...) ... { ... }</c>) using the exact
    /// same routine as generic delegate/type declarations.
    /// </summary>
    /// <param name="syntax">The type-parameter list syntax.</param>
    /// <returns>The bound type-parameter symbols.</returns>
    internal ImmutableArray<TypeParameterSymbol> BindTypeParameterList(TypeParameterListSyntax syntax)
        => BindTypeParameterList(syntax, onBareSymbolsPublished: null);

    /// <summary>
    /// Binds a type-parameter list. The optional
    /// <paramref name="onBareSymbolsPublished"/> callback runs after the bare
    /// type-parameter symbols are created and published into the constraint
    /// scope but BEFORE any constraint clause is resolved. Issue #1056 uses this
    /// to register the declaring type's name shell (with its type parameters
    /// already attached) so a self-referential base-class constraint such as the
    /// CRTP-style <c>class Box[T Box[T]]</c> / <c>class Box[T Box]</c> resolves
    /// the type's own name while its constraints are being bound.
    /// </summary>
    /// <param name="syntax">The type-parameter list syntax.</param>
    /// <param name="onBareSymbolsPublished">Optional callback invoked with the bare type-parameter symbols between pass 1 (symbol creation) and pass 2 (constraint resolution).</param>
    /// <returns>The bound type-parameter symbols.</returns>
    private ImmutableArray<TypeParameterSymbol> BindTypeParameterList(
        TypeParameterListSyntax syntax,
        Action<ImmutableArray<TypeParameterSymbol>> onBareSymbolsPublished)
    {
        if (syntax == null)
        {
            onBareSymbolsPublished?.Invoke(ImmutableArray<TypeParameterSymbol>.Empty);
            return ImmutableArray<TypeParameterSymbol>.Empty;
        }

        var symbols = CreateTypeParameterSymbols(syntax);

        // Publish the bare symbols into the binder's type-parameter scope so the
        // constraint type clauses bound in pass 2 can see them. Enclosing type
        // parameters (e.g. for a generic method declared inside a generic type)
        // remain visible because we copy the previous map.
        onBareSymbolsPublished?.Invoke(symbols);
        ResolveTypeParameterConstraints(syntax, symbols);
        return symbols;
    }

    private ImmutableArray<TypeParameterSymbol> CreateTypeParameterSymbols(TypeParameterListSyntax syntax)
    {
        if (syntax == null)
        {
            return ImmutableArray<TypeParameterSymbol>.Empty;
        }

        var count = syntax.Parameters.Count;
        var symbols = ImmutableArray.CreateBuilder<TypeParameterSymbol>(count);
        var seen = new HashSet<string>();

        // Pass 1: create the bare type-parameter symbols (name, ordinal, variance)
        // so that a constraint clause appearing later in the list — or a
        // self-referential constraint such as `[T IComparable[T]]` (issue #943)
        // / `[T IAdd[T]]` (ADR-0089) — can resolve every in-flight type
        // parameter while binding the constraint type below.
        for (var i = 0; i < count; i++)
        {
            var p = syntax.Parameters[i];
            var name = p.Identifier.Text;
            if (!seen.Add(name))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(p.Identifier.Location, name);
            }

            var variance = TypeParameterVariance.None;
            if (p.VarianceModifier != null)
            {
                variance = p.VarianceModifier.Text == "in" ? TypeParameterVariance.In : TypeParameterVariance.Out;
            }

            symbols.Add(new TypeParameterSymbol(name, i, TypeParameterConstraint.Any, variance));
        }

        return symbols.MoveToImmutable();
    }

    private void ResolveTypeParameterConstraints(
        TypeParameterListSyntax syntax,
        ImmutableArray<TypeParameterSymbol> symbols)
    {
        if (syntax == null)
        {
            return;
        }

        var count = syntax.Parameters.Count;

        // Publish the bare symbols into the binder's type-parameter scope so the
        // constraint type clauses bound in pass 2 can see them. Enclosing type
        // parameters (e.g. for a generic method declared inside a generic type)
        // remain visible because we copy the previous map.
        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        var constraintScope = previousTypeParameters == null
            ? new Dictionary<string, TypeParameterSymbol>()
            : new Dictionary<string, TypeParameterSymbol>(previousTypeParameters);
        foreach (var s in symbols)
        {
            constraintScope[s.Name] = s;
        }

        binderCtx.CurrentTypeParameters = constraintScope;
        try
        {
            // Pass 2: resolve each constraint against the published scope.
            for (var i = 0; i < count; i++)
            {
                var p = syntax.Parameters[i];
                var symbol = symbols[i];
                var name = symbol.Name;

                if (p.Constraint != null)
                {
                    switch (p.Constraint.Text)
                    {
                        case "any":
                            symbol.Constraint = TypeParameterConstraint.Any;
                            break;
                        case "comparable":
                            symbol.Constraint = TypeParameterConstraint.Comparable;
                            break;
                        default:
                            ResolveInterfaceConstraint(p, symbol);
                            break;
                    }
                }

                // ADR-0097 / issue #775 (constraint keyword renamed to `init()`
                // by issue #997): consume the `class` / `struct` / `init()`
                // flag-style constraints. Disjoint combinations (`class struct`,
                // `struct init()`) are rejected as GS0361. The order is determined
                // by the syntax — combining class + init() is legal and produces
                // both CLR flag bits.
                var hasRefType = p.HasClassConstraint;
                var hasValueType = p.HasStructConstraint;
                var hasDefaultCtor = p.HasInitConstraint;
                var hasUnmanaged = p.HasUnmanagedConstraint;

                // Issue #1336: the `unmanaged` constraint subsumes `struct` —
                // an unmanaged type is necessarily a non-nullable value type —
                // so it implies the value-type (and therefore default-ctor)
                // CLR flag bits. Spelling both `unmanaged` and `struct` is
                // redundant; flag the explicit `struct`.
                if (hasUnmanaged && hasValueType)
                {
                    Diagnostics.ReportTypeParameterConstraintConflict(p.StructConstraintKeyword.Location, name, "unmanaged", "struct");
                    hasValueType = false;
                }

                // `unmanaged` is a value-type constraint and cannot be combined
                // with the reference-type (`class`) constraint.
                if (hasUnmanaged && hasRefType)
                {
                    Diagnostics.ReportTypeParameterConstraintConflict(p.ClassConstraintKeyword.Location, name, "class", "unmanaged");
                    hasUnmanaged = false;
                }

                if (hasRefType && hasValueType)
                {
                    Diagnostics.ReportTypeParameterConstraintConflict(p.StructConstraintKeyword.Location, name, "class", "struct");
                    hasValueType = false;
                }

                if (hasValueType && hasDefaultCtor)
                {
                    // `struct` already implies `init()` at the CLR level (ECMA-335 II.10.1.7);
                    // emitting both would be redundant and would force callers to
                    // remember an arbitrary order. Flag the explicit `init()`.
                    Diagnostics.ReportTypeParameterConstraintConflict(p.InitConstraintKeyword.Location, name, "struct", "init()");
                    hasDefaultCtor = false;
                }

                // Issue #1336: `unmanaged` likewise implies the default-ctor
                // flag (it is a value-type constraint); flag a redundant
                // explicit `init()`.
                if (hasUnmanaged && hasDefaultCtor)
                {
                    Diagnostics.ReportTypeParameterConstraintConflict(p.InitConstraintKeyword.Location, name, "unmanaged", "init()");
                    hasDefaultCtor = false;
                }

                // Issue #1336: project `unmanaged` onto the value-type CLR flag
                // bits. The dedicated modreq(UnmanagedType) GenericParamConstraint
                // is emitted by TypeDefEmitter from HasUnmanagedConstraint.
                symbol.HasReferenceTypeConstraint = hasRefType;
                symbol.HasValueTypeConstraint = hasValueType || hasUnmanaged;
                symbol.HasDefaultConstructorConstraint = hasDefaultCtor;
                symbol.HasUnmanagedConstraint = hasUnmanaged;
            }
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

    /// <summary>
    /// Resolves a non-keyword type-parameter constraint (anything other than
    /// <c>any</c> / <c>comparable</c>) as an interface bound and records it on
    /// <paramref name="symbol"/>.
    /// <para>
    /// Phase 4.2b / ADR-0020 originally accepted only a G#-declared sealed
    /// interface. ADR-0089 added constructed generic G# interfaces carrying
    /// static-virtual members (e.g. <c>[T IAdd[T]]</c>). Issue #943 generalised
    /// this to any imported CLR interface — generic or not. Issue #1052 removes
    /// the last restriction: ANY user-declared interface (sealed or not, generic
    /// or not, including the self-referential <c>[T IFace[T]]</c> shape) is a
    /// legal constraint, so the canonical C# <c>where T : IComparable&lt;T&gt;</c>
    /// shape binds, dispatches instance members, and emits verifiable IL. The
    /// constraint type clause is bound through the regular type binder, so a
    /// self-referential type argument (the type parameter appearing in its own
    /// constraint) resolves against the in-flight scope published by
    /// <see cref="BindTypeParameterList(TypeParameterListSyntax)"/>.
    /// </para>
    /// </summary>
    /// <param name="p">The type-parameter syntax carrying the constraint.</param>
    /// <param name="symbol">The bare type-parameter symbol to annotate.</param>
    private void ResolveInterfaceConstraint(TypeParameterSyntax p, TypeParameterSymbol symbol)
    {
        // A qualified (dotted) constraint name is captured whole by the parser
        // as a ready-made type clause; bind it directly. Otherwise reconstruct
        // the clause from the single-identifier constraint token plus its
        // optional generic-argument list (the `[T IAdd[T]]` shape).
        var constraintClause = p.ConstraintType ?? new TypeClauseSyntax(
            p.SyntaxTree,
            openBracketToken: null,
            lengthToken: null,
            closeBracketToken: null,
            identifier: p.Constraint,
            typeArgumentOpenBracketToken: p.ConstraintTypeArgumentOpenBracketToken,
            typeArguments: p.ConstraintTypeArguments,
            typeArgumentCloseBracketToken: p.ConstraintTypeArgumentCloseBracketToken,
            questionToken: null);

        var resolved = bindTypeClause(constraintClause);
        if (resolved == null || ReferenceEquals(resolved, TypeSymbol.Error))
        {
            // bindTypeClause already reported the failure (e.g. undefined type).
            return;
        }

        if (resolved is InterfaceSymbol iface)
        {
            // Issue #1052: ANY user-declared interface — sealed or not, generic
            // or not, including the self-referential `[T IFace[T]]` shape — is a
            // legal constraint, matching imported CLR interfaces and C#'s
            // `where T : IFoo`. The former `sealed`-only gate (Phase 4.2b /
            // ADR-0020) was a stale restriction; instance members still bind on
            // `T` via the constraint and a GenericParamConstraint metadata row is
            // emitted pointing at the interface TypeDef so the IL verifies.
            symbol.InterfaceConstraint = iface;
            return;
        }

        // Issue #943: an imported CLR interface (generic or not). Reference-set
        // interfaces are universally implementable, so no sealedness rule
        // applies; the GenericParamConstraint metadata row carries the bound.
        if (resolved.ClrType is { IsInterface: true })
        {
            symbol.ClrInterfaceConstraint = resolved;
            return;
        }

        // Issue #1056: a base-class (non-interface) constraint, mirroring C#'s
        // `where T : BaseClass`. The single legacy constraint slot structurally
        // enforces C#'s at-most-one-class rule. Accept a user-declared class
        // (a `StructSymbol` with `IsClass`, open or sealed, generic or not —
        // including the self-referential `[T Box]` / `[T Box[T]]` shapes) and an
        // imported reference-type class. Instance members declared on the base
        // class bind on values of `T` and a GenericParamConstraint metadata row
        // is emitted pointing at the class so the IL verifies. A value type
        // (struct/enum) is still rejected (C# forbids `where T : SomeStruct`).
        if (resolved is StructSymbol { IsClass: true })
        {
            symbol.ClassConstraint = resolved;
            return;
        }

        if (resolved.ClrType is { IsClass: true, IsValueType: false })
        {
            symbol.ClassConstraint = resolved;
            return;
        }

        // Resolved to something that is not a legal constraint (a struct, enum,
        // or other value type).
        Diagnostics.ReportConstraintNotInterface(p.Constraint.Location, resolved.Name);
    }

    /// <summary>
    /// Issue #1931: extends <paramref name="baseTypeArgSubst"/> (the enclosing
    /// class's base-type-argument substitution) with a positional mapping from
    /// a generic base/candidate method's OWN type parameters onto the new
    /// override's own type parameters, when both declare the same arity. A
    /// generic method's <c>T</c> is a distinct <see cref="TypeParameterSymbol"/>
    /// instance per declaration, so without this mapping <see cref="SignaturesMatch(FunctionSymbol, ImmutableArray{ParameterSymbol}, TypeSymbol, RefKind, IReadOnlyDictionary{TypeParameterSymbol, TypeSymbol})"/>
    /// never sees the base and override <c>T</c>s as equal — cascading into
    /// GS0185 (override mismatch), then GS0387/GS0386 (abstract member treated
    /// as unimplemented). Returns <paramref name="baseTypeArgSubst"/> unchanged
    /// when the arities do not match (mirrors <see cref="TryBuildMethodTypeParameterMap"/>,
    /// which instead returns <c>null</c>/no-match there because that caller is
    /// selecting the correct overload rather than only enriching an existing map).
    /// </summary>
    private static IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> WithMethodTypeParameterSubstitution(
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> baseTypeArgSubst,
        FunctionSymbol candidate,
        ImmutableArray<TypeParameterSymbol> overrideTypeParameters)
    {
        var baseTps = candidate.TypeParameters;
        var baseArity = baseTps.IsDefaultOrEmpty ? 0 : baseTps.Length;
        var overrideArity = overrideTypeParameters.IsDefaultOrEmpty ? 0 : overrideTypeParameters.Length;
        if (baseArity == 0 || baseArity != overrideArity)
        {
            return baseTypeArgSubst;
        }

        var map = baseTypeArgSubst == null
            ? new Dictionary<TypeParameterSymbol, TypeSymbol>()
            : new Dictionary<TypeParameterSymbol, TypeSymbol>(baseTypeArgSubst);
        for (var i = 0; i < baseArity; i++)
        {
            map[baseTps[i]] = overrideTypeParameters[i];
        }

        return map;
    }

    /// <summary>
    /// Issue #1055: builds the substitution mapping each base class's generic
    /// type parameters onto the concrete type arguments supplied where that base
    /// is inherited as a constructed generic. Walking the <see cref="StructSymbol.BaseClass"/>
    /// chain closest-first lets a deeper base's type arguments (which are expressed
    /// in terms of a shallower base's type parameters) resolve transitively, so a
    /// multi-level chain such as <c>Leaf : Mid[int32] : Base[T]</c> maps
    /// <c>Base.T -&gt; int32</c>. The resulting map is consumed by
    /// <see cref="SignaturesMatch(FunctionSymbol, ImmutableArray{ParameterSymbol}, TypeSymbol, RefKind, IReadOnlyDictionary{TypeParameterSymbol, TypeSymbol})"/>
    /// so an override whose concrete signature mentions the substituted types is
    /// matched against the base member's un-substituted (open) signature. Returns
    /// <c>null</c> when no constructed base contributes a substitution.
    /// </summary>
    private static IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> BuildBaseTypeArgumentSubstitution(StructSymbol derived)
    {
        Dictionary<TypeParameterSymbol, TypeSymbol> subst = null;
        for (var b = derived?.BaseClass; b != null; b = b.BaseClass)
        {
            if (b.Definition == null || b.TypeArguments.IsDefaultOrEmpty)
            {
                continue;
            }

            var defParams = b.Definition.TypeParameters;
            if (defParams.IsDefaultOrEmpty)
            {
                continue;
            }

            var count = System.Math.Min(defParams.Length, b.TypeArguments.Length);
            for (var i = 0; i < count; i++)
            {
                var arg = b.TypeArguments[i];

                // A deeper base's type argument may itself be a type parameter of
                // a shallower (already-processed) base; resolve it transitively so
                // the map always lands on the concrete type in the derived context.
                if (arg is TypeParameterSymbol tpArg && subst != null && subst.TryGetValue(tpArg, out var resolved))
                {
                    arg = resolved;
                }

                subst ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                subst[defParams[i]] = arg;
            }
        }

        return subst;
    }

    /// <summary>
    /// ADR-0146 (Kotlin visibility narrowing follow-up, issue #2243): when a
    /// function/method's return-type clause is omitted and its (parser-desugared)
    /// body is exactly <c>return &lt;anonymous-class-literal&gt;</c> — the
    /// <c>func F() -> object { ... }</c> shape recognized by
    /// <c>Parser.IsAnonymousClassLiteralStartAfterArrow</c> — the return type must
    /// be inferred from the literal instead of defaulting to <c>void</c>:
    /// <list type="bullet">
    /// <item>Local/private/internal declarations retain the actual synthesized
    /// anonymous type (full custom-member access), mirroring a <c>let</c>/<c>var</c>
    /// binding of the same literal.</item>
    /// <item>Public/protected declarations — a public API boundary — narrow the
    /// exposed type to the literal's declared supertype (<c>object : Type { ... }</c>)
    /// or, absent one, to the universal top type <c>object</c>
    /// (<see cref="TypeSymbol.Object"/>), exactly like Kotlin's anonymous-object
    /// visibility rule.</item>
    /// </list>
    /// Every other omitted-return-type declaration (any shape other than a bare
    /// arrow-returned anonymous-class literal) is left untouched and still
    /// resolves to <c>void</c>.
    /// </summary>
    private TypeSymbol InferAnonymousClassLiteralReturnType(FunctionDeclarationSyntax syntax, TypeSymbol declaredType, Accessibility accessibility)
    {
        if (syntax.Type != null || declaredType != TypeSymbol.Void)
        {
            // An explicit return-type clause already narrows for free: the
            // return statement's expression converts to that declared type, so
            // a caller only ever sees the declared type's members.
            return declaredType;
        }

        if (syntax.Body == null || syntax.Body.Statements.Length != 1
            || syntax.Body.Statements[0] is not ReturnStatementSyntax { Expression: AnonymousClassExpressionSyntax anon })
        {
            return declaredType;
        }

        var isPublicSurface = accessibility == Accessibility.Public || accessibility == Accessibility.Protected;

        if (isPublicSurface)
        {
            if (anon.HasBaseType)
            {
                var baseType = bindTypeClause(anon.BaseTypeClause);
                if (baseType != null && baseType != TypeSymbol.Error)
                {
                    return baseType;
                }
            }

            return TypeSymbol.Object;
        }

        // Local/private/internal: retain the actual synthesized anonymous type.
        // Only "rich" literals (base/interface clause, a method, or an event) are
        // resolvable here — their synthesized class is already published to
        // RichAnonymousClassMap by the ADR-0146 desugaring pre-pass that runs
        // before function/method declarations are bound (see
        // Binder.BindGlobalScope). A field-only literal's type is synthesized
        // lazily during body binding, so it is not yet known at this point in
        // the two-phase pipeline; such a shape falls back to `object` here — a
        // `let v = object { ... }` local binding (unaffected by this method)
        // still gets full access to a field-only shape.
        var isRich = anon.HasBaseType || anon.Members.Any(m => m is FunctionDeclarationSyntax || m is EventDeclarationSyntax);
        if (isRich && scope.GetRichAnonymousClassMap().TryGetValue(anon, out var richType) && richType != null)
        {
            return richType;
        }

        return TypeSymbol.Object;
    }

    private static bool SignaturesMatch(FunctionSymbol baseMethod, ImmutableArray<ParameterSymbol> derivedParams, TypeSymbol derivedReturnType)
        => SignaturesMatch(baseMethod, derivedParams, derivedReturnType, RefKind.None);

    private static bool SignaturesMatch(FunctionSymbol baseMethod, ImmutableArray<ParameterSymbol> derivedParams, TypeSymbol derivedReturnType, RefKind derivedReturnRefKind)
        => SignaturesMatch(baseMethod, derivedParams, derivedReturnType, derivedReturnRefKind, typeParamMap: null, derivedIsAsync: false);

    private static bool SignaturesMatch(
        FunctionSymbol baseMethod,
        ImmutableArray<ParameterSymbol> derivedParams,
        TypeSymbol derivedReturnType,
        RefKind derivedReturnRefKind,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap)
        => SignaturesMatch(baseMethod, derivedParams, derivedReturnType, derivedReturnRefKind, typeParamMap, derivedIsAsync: false);

    /// <summary>
    /// Issue #1007: signature matching for interface satisfaction / override
    /// resolution, with optional support for generic methods. When the base
    /// (interface) method and the derived (implementing) method are both
    /// generic with the same arity, <paramref name="typeParamMap"/> maps the
    /// base method's type-parameter symbols onto the derived method's so that
    /// the plain type-parameter references in the parameter / return types
    /// compare equal positionally (the interface's <c>T</c> carries a distinct
    /// <see cref="TypeParameterSymbol"/> instance from the class's <c>T</c>).
    /// </summary>
    private static bool SignaturesMatch(
        FunctionSymbol baseMethod,
        ImmutableArray<ParameterSymbol> derivedParams,
        TypeSymbol derivedReturnType,
        RefKind derivedReturnRefKind,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap,
        bool derivedIsAsync)
    {
        if (!ReturnTypesMatch(baseMethod, derivedReturnType, derivedIsAsync, typeParamMap))
        {
            return false;
        }

        // Issue #490: ref-returning methods must agree on the ref-return-ness with their
        // base or interface; otherwise the override is signature-incompatible.
        if (baseMethod.ReturnRefKind != derivedReturnRefKind)
        {
            return false;
        }

        var baseParams = GetCallableParameters(baseMethod);
        if (baseParams.Length != derivedParams.Length)
        {
            return false;
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (!TypeSignaturesEquivalent(baseParams[i].Type, derivedParams[i].Type, typeParamMap))
            {
                return false;
            }

            // ADR-0060 §9: two functions that differ only in a parameter's ref-kind
            // are *different signatures*. Required for CLR-faithful override / interface-
            // implementation matching.
            if (baseParams[i].RefKind != derivedParams[i].RefKind)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1918: an <c>async func</c> may spell its return-type clause as an
    /// explicit <c>Task</c> / <c>Task[T]</c> / <c>ValueTask</c> / <c>ValueTask[T]</c>
    /// wrapper instead of the bare awaited result <c>T</c> (the implicit-wrap
    /// form). When it does, the declared wrapper is unwrapped here so
    /// <see cref="FunctionSymbol.Type"/> always holds the awaited result — the
    /// same invariant the implicit form already established — and the caller
    /// records which wrapper was requested (<paramref name="isValueTask"/>) so
    /// the state machine / observable return type can be built to match.
    /// </summary>
    /// <param name="declaredType">The return-type clause as bound by <c>bindReturnTypeClause</c>.</param>
    /// <param name="isAsync">Whether the declaration carries the <c>async</c> modifier.</param>
    /// <param name="isValueTask">Set to <c>true</c> when the declared wrapper was <c>ValueTask</c> / <c>ValueTask[T]</c>.</param>
    /// <returns>The awaited result type when a wrapper was unwrapped; otherwise <paramref name="declaredType"/> unchanged.</returns>
    private static TypeSymbol NormalizeAsyncDeclaredReturnType(TypeSymbol declaredType, bool isAsync, out bool isValueTask)
    {
        isValueTask = false;
        if (!isAsync || declaredType == null)
        {
            return declaredType;
        }

        return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(declaredType, out var awaited, out isValueTask)
            ? awaited
            : declaredType;
    }

    /// <summary>
    /// Issue #1071: compares the base / interface method's declared return type
    /// against the derived (overriding / implementing) method's <em>effective</em>
    /// return type, normalizing for <c>async</c>. An <c>async func</c> with no
    /// annotation has effective return type <c>Task</c>; <c>async func ... T</c>
    /// has effective return type <c>Task[T]</c>. When exactly one of the two
    /// methods is async, the non-async side's declared <c>Task</c> / <c>Task[T]</c>
    /// is unwrapped to its awaited result and compared against the async side's
    /// declared (awaited) return type; otherwise the declared types are compared
    /// directly. Genuine return-type mismatches (e.g. an async <c>Task</c> method
    /// against a base declaring <c>Task[int32]</c>) are still rejected.
    /// </summary>
    private static bool ReturnTypesMatch(
        FunctionSymbol baseMethod,
        TypeSymbol derivedReturnType,
        bool derivedIsAsync,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap)
    {
        var baseIsAsync = baseMethod.IsAsync;
        if (baseIsAsync == derivedIsAsync)
        {
            return TypeSignaturesEquivalent(baseMethod.Type, derivedReturnType, typeParamMap);
        }

        if (derivedIsAsync)
        {
            // Derived is async (declared = awaited result); the base must declare
            // the matching Task / Task[T] wrapper.
            return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(baseMethod.Type, out var baseAwaited)
                && TypeSignaturesEquivalent(baseAwaited, derivedReturnType, typeParamMap);
        }

        // Base is async (declared = awaited result); the derived (non-async)
        // method must declare the matching Task / Task[T] wrapper.
        return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(derivedReturnType, out var derivedAwaited)
            && TypeSignaturesEquivalent(baseMethod.Type, derivedAwaited, typeParamMap);
    }

    /// <summary>
    /// Issue #1007: builds the positional map from a generic interface
    /// method's type-parameter symbols onto a candidate implementing method's
    /// type-parameter symbols. Returns <c>null</c> when the candidate is not a
    /// viable generic match (mismatched arity) so the caller treats it as no
    /// match; returns an empty map when neither method is generic.
    /// </summary>
    private static IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> TryBuildMethodTypeParameterMap(
        FunctionSymbol baseMethod,
        FunctionSymbol candidate)
    {
        var baseTps = baseMethod.TypeParameters;
        var candTps = candidate.TypeParameters;
        var baseArity = baseTps.IsDefaultOrEmpty ? 0 : baseTps.Length;
        var candArity = candTps.IsDefaultOrEmpty ? 0 : candTps.Length;
        if (baseArity != candArity)
        {
            return null;
        }

        if (baseArity == 0)
        {
            return System.Collections.Immutable.ImmutableDictionary<TypeParameterSymbol, TypeSymbol>.Empty;
        }

        var map = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        for (var i = 0; i < baseArity; i++)
        {
            map[baseTps[i]] = candTps[i];
        }

        return map;
    }

    /// <summary>
    /// ADR-0060 §9: when <see cref="SignaturesMatch(FunctionSymbol, ImmutableArray{ParameterSymbol}, TypeSymbol)"/> rejected an override / interface
    /// implementation, returns the index of the first parameter whose ref-kind disagrees
    /// (return type and pointee types all matching). Returns -1 when the disagreement is
    /// something other than a ref-kind mismatch (so the caller can fall back to the generic
    /// "signature mismatch" diagnostic).
    /// </summary>
    private static int FindRefKindMismatchIndex(FunctionSymbol baseMethod, ImmutableArray<ParameterSymbol> derivedParams, TypeSymbol derivedReturnType)
    {
        if (!TypeSignaturesEquivalent(baseMethod.Type, derivedReturnType))
        {
            return -1;
        }

        var baseParams = GetCallableParameters(baseMethod);
        if (baseParams.Length != derivedParams.Length)
        {
            return -1;
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (!TypeSignaturesEquivalent(baseParams[i].Type, derivedParams[i].Type))
            {
                return -1;
            }
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (baseParams[i].RefKind != derivedParams[i].RefKind)
            {
                return i;
            }
        }

        return -1;
    }

    /// <summary>
    /// ADR-0149: resolves and links a member declared with an explicit-
    /// interface qualifier clause (<c>func (IFoo) M(...)</c>) on
    /// <paramref name="structSymbol"/> against <paramref name="imethod"/>, an
    /// abstract member of <paramref name="iface"/>. Returns the linked method
    /// (setting its <see cref="FunctionSymbol.ExplicitInterfaceMember"/> the
    /// first time it is resolved) or <see langword="null"/> if no such method
    /// exists. Matching requires the candidate's
    /// <see cref="FunctionSymbol.ExplicitInterfaceClauseTarget"/> (already
    /// bound by <see cref="ResolveExplicitInterfaceClauses"/>) to be the SAME
    /// interface as <paramref name="iface"/>, the candidate's own (plain,
    /// unmangled) name to equal <paramref name="imethod"/>'s name, and the
    /// signatures to match exactly — mirroring #2010's original mangled-name
    /// matching rules, minus the string parsing.
    /// </summary>
    private static FunctionSymbol TryResolveExplicitInterfaceImplementation(StructSymbol structSymbol, InterfaceSymbol iface, FunctionSymbol imethod)
    {
        if (structSymbol.Methods.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var candidate in structSymbol.Methods)
        {
            if (ReferenceEquals(candidate.ExplicitInterfaceMember, imethod))
            {
                return candidate;
            }

            if (!candidate.HasExplicitInterfaceClause || candidate.ExplicitInterfaceMember != null)
            {
                continue;
            }

            if (candidate.ExplicitInterfaceClauseTarget == null ||
                !TypeSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) ||
                candidate.Name != imethod.Name)
            {
                continue;
            }

            var typeParamMap = TryBuildMethodTypeParameterMap(imethod, candidate);
            if (typeParamMap == null)
            {
                continue;
            }

            if (SignaturesMatch(imethod, GetCallableParameters(candidate), candidate.Type, candidate.ReturnRefKind, typeParamMap, candidate.IsAsync))
            {
                candidate.ExplicitInterfaceMember = imethod;
                return candidate;
            }
        }

        return null;
    }

    private static ImmutableArray<ParameterSymbol> GetCallableParameters(FunctionSymbol method)
        => method.ExplicitReceiverParameter == null ? method.Parameters : method.Parameters.RemoveAt(0);

    /// <summary>
    /// ADR-0149 (extending #2010/#2362's resolution to properties/indexers):
    /// resolves and links a property declared with an explicit-interface
    /// qualifier clause (<c>prop (IFoo) P T</c> / <c>prop (IFoo) this[...] T</c>)
    /// on <paramref name="structSymbol"/> against <paramref name="iprop"/>, an
    /// abstract property of <paramref name="iface"/>. Returns the linked
    /// property (setting its <see cref="PropertySymbol.ExplicitInterfaceMember"/>
    /// the first time it is resolved) or <see langword="null"/> if no such
    /// property exists. <paramref name="iprop"/> may come from
    /// <paramref name="iface"/>'s own definition OR (for a constructed
    /// generic interface, whose <see cref="InterfaceSymbol.Properties"/> are
    /// never substituted — see <see cref="InterfaceSymbol"/>) from
    /// <c>iface.Definition</c>; either way <paramref name="iface"/> itself
    /// supplies the type-argument substitution used to compare
    /// <paramref name="iprop"/>'s declared type against the candidate's own
    /// (concrete) type.
    /// </summary>
    private static PropertySymbol TryResolveExplicitInterfacePropertyImplementation(StructSymbol structSymbol, InterfaceSymbol iface, PropertySymbol iprop)
    {
        if (structSymbol.Properties.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var candidate in structSymbol.Properties)
        {
            if (ReferenceEquals(candidate.ExplicitInterfaceMember, iprop))
            {
                return candidate;
            }

            if (!candidate.HasExplicitInterfaceClause || candidate.ExplicitInterfaceMember != null)
            {
                continue;
            }

            if (candidate.ExplicitInterfaceClauseTarget == null ||
                !TypeSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) ||
                candidate.Name != iprop.Name)
            {
                continue;
            }

            // ADR-0149 (was issue #2362): an explicit property implementation
            // is its own distinct G# member — unlike #985's covariant-return
            // method bridge, there is no "same name, different return type"
            // slot-sharing concern here, so the concrete implementation's
            // type must equal the interface's declared type exactly (after
            // substituting the interface's own type parameters, for a
            // generic interface). The accessor SHAPE (get/set/init) must also
            // match exactly — valid C# never lets an explicit property
            // implementation declare an accessor the interface doesn't
            // require.
            if (iprop.HasGetter != candidate.HasGetter || iprop.HasSetter != candidate.HasSetter)
            {
                continue;
            }

            var typeParamMap = BuildInterfaceTypeParameterMap(iface);

            // ADR-0149 (issue #944 / #2362 follow-up): an INDEXER's plain
            // name is always "Item", so distinguishing which of possibly
            // several explicit indexer slots on the SAME implementer
            // matches THIS particular interface indexer member requires
            // comparing the index-parameter list too (types AND count) —
            // the exact same substitution rules as the element Type check
            // below. A no-op for an ordinary (non-indexer) property, whose
            // Parameters is always empty on both sides.
            if (iprop.Parameters.Length != candidate.Parameters.Length)
            {
                continue;
            }

            var parametersMatch = true;
            for (var i = 0; i < iprop.Parameters.Length; i++)
            {
                if (!TypeSignaturesEquivalent(iprop.Parameters[i].Type, candidate.Parameters[i].Type, typeParamMap))
                {
                    parametersMatch = false;
                    break;
                }
            }

            if (!parametersMatch)
            {
                continue;
            }

            if (!TypeSignaturesEquivalent(iprop.Type, candidate.Type, typeParamMap))
            {
                continue;
            }

            candidate.ExplicitInterfaceMember = iprop;
            return candidate;
        }

        return null;
    }

    /// <summary>
    /// ADR-0149: resolves and links an event declared with an explicit-
    /// interface qualifier clause (<c>event (IFoo) Changed T</c>) on
    /// <paramref name="structSymbol"/> against <paramref name="ievent"/>, an
    /// abstract event of <paramref name="iface"/>. Mirrors
    /// <see cref="TryResolveExplicitInterfacePropertyImplementation"/>
    /// exactly (matching on the clause's target interface identity, the
    /// candidate's own plain name, and the handler type after substituting
    /// the interface's own type parameters) — this is the FIRST time the
    /// #2010/#2362 explicit-implementation convention is generalized to
    /// events. Returns the linked event (setting its
    /// <see cref="EventSymbol.ExplicitInterfaceMember"/> the first time it
    /// is resolved) or <see langword="null"/> if no such event exists.
    /// </summary>
    private static EventSymbol TryResolveExplicitInterfaceEventImplementation(StructSymbol structSymbol, InterfaceSymbol iface, EventSymbol ievent)
    {
        if (structSymbol.Events.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var candidate in structSymbol.Events)
        {
            if (ReferenceEquals(candidate.ExplicitInterfaceMember, ievent))
            {
                return candidate;
            }

            if (!candidate.HasExplicitInterfaceClause || candidate.ExplicitInterfaceMember != null)
            {
                continue;
            }

            if (candidate.ExplicitInterfaceClauseTarget == null ||
                !TypeSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) ||
                candidate.Name != ievent.Name)
            {
                continue;
            }

            var typeParamMap = BuildInterfaceTypeParameterMap(iface);
            if (!TypeSignaturesEquivalent(ievent.Type, candidate.Type, typeParamMap))
            {
                continue;
            }

            candidate.ExplicitInterfaceMember = ievent;
            return candidate;
        }

        return null;
    }

    /// <summary>
    /// ADR-0149 follow-up (issue #2370, static explicit interface members):
    /// resolves and links a STATIC method declared with an explicit-
    /// interface qualifier clause (<c>func (IFoo) M(...)</c> inside a
    /// <c>shared { }</c> block) on <paramref name="structSymbol"/> against
    /// <paramref name="imethod"/>, a static-virtual method of
    /// <paramref name="iface"/> (ADR-0089 / issue #755). Mirrors
    /// <see cref="TryResolveExplicitInterfaceImplementation"/> exactly except
    /// it walks <see cref="StructSymbol.StaticMethods"/> and compares
    /// signatures with <see cref="StaticVirtualSignaturesMatch"/> (no
    /// implicit receiver parameter to strip). Returns the linked method
    /// (setting its <see cref="FunctionSymbol.ExplicitInterfaceMember"/> the
    /// first time it is resolved) or <see langword="null"/> if no such
    /// static method exists.
    /// </summary>
    private static FunctionSymbol TryResolveExplicitInterfaceStaticImplementation(StructSymbol structSymbol, InterfaceSymbol iface, FunctionSymbol imethod)
    {
        if (structSymbol.StaticMethods.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var candidate in structSymbol.StaticMethods)
        {
            if (ReferenceEquals(candidate.ExplicitInterfaceMember, imethod))
            {
                return candidate;
            }

            if (!candidate.HasExplicitInterfaceClause || candidate.ExplicitInterfaceMember != null)
            {
                continue;
            }

            if (candidate.ExplicitInterfaceClauseTarget == null ||
                !TypeSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) ||
                candidate.Name != imethod.Name)
            {
                continue;
            }

            if (!StaticVirtualSignaturesMatch(imethod, candidate))
            {
                continue;
            }

            candidate.ExplicitInterfaceMember = imethod;
            return candidate;
        }

        return null;
    }

    /// <summary>
    /// ADR-0149 follow-up (issue #2370, static explicit interface members):
    /// resolves and links a STATIC property declared with an explicit-
    /// interface qualifier clause (<c>prop (IFoo) P T</c> inside a
    /// <c>shared { }</c> block) on <paramref name="structSymbol"/> against
    /// <paramref name="iprop"/>, a static-virtual property of
    /// <paramref name="iface"/> (ADR-0089 / issue #1019). Mirrors
    /// <see cref="TryResolveExplicitInterfacePropertyImplementation"/>
    /// exactly except it walks <see cref="StructSymbol.StaticProperties"/>
    /// and never considers indexer parameters (a static indexer is not a
    /// legal C#/CLR member form at all — indexers always require an
    /// instance receiver — so <paramref name="iprop"/> is never an indexer
    /// here). Returns the linked property (setting its
    /// <see cref="PropertySymbol.ExplicitInterfaceMember"/> the first time it
    /// is resolved) or <see langword="null"/> if no such static property
    /// exists.
    /// </summary>
    private static PropertySymbol TryResolveExplicitInterfaceStaticPropertyImplementation(StructSymbol structSymbol, InterfaceSymbol iface, PropertySymbol iprop)
    {
        if (structSymbol.StaticProperties.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var candidate in structSymbol.StaticProperties)
        {
            if (ReferenceEquals(candidate.ExplicitInterfaceMember, iprop))
            {
                return candidate;
            }

            if (!candidate.HasExplicitInterfaceClause || candidate.ExplicitInterfaceMember != null)
            {
                continue;
            }

            if (candidate.ExplicitInterfaceClauseTarget == null ||
                !TypeSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) ||
                candidate.Name != iprop.Name)
            {
                continue;
            }

            if (iprop.HasGetter != candidate.HasGetter || iprop.HasSetter != candidate.HasSetter)
            {
                continue;
            }

            var typeParamMap = BuildInterfaceTypeParameterMap(iface);
            if (!TypeSignaturesEquivalent(iprop.Type, candidate.Type, typeParamMap))
            {
                continue;
            }

            candidate.ExplicitInterfaceMember = iprop;
            return candidate;
        }

        return null;
    }

    /// <summary>
    /// Issue #2362: builds the substitution map from a constructed generic
    /// interface's OWN type parameters (declared on <c>iface.Definition</c>)
    /// to <paramref name="iface"/>'s type arguments, for comparing an
    /// interface property's declared (open) type against an implementer's
    /// concrete type via <see cref="TypeSignaturesEquivalent(TypeSymbol, TypeSymbol, IReadOnlyDictionary{TypeParameterSymbol, TypeSymbol})"/>.
    /// Returns <see langword="null"/> for a non-generic interface (or the
    /// open definition itself), matching that method's "no substitution"
    /// convention.
    /// </summary>
    private static IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> BuildInterfaceTypeParameterMap(InterfaceSymbol iface)
    {
        var def = iface.Definition;
        if (def == null || ReferenceEquals(def, iface) || def.TypeParameters.IsDefaultOrEmpty)
        {
            return null;
        }

        var map = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        for (var i = 0; i < def.TypeParameters.Length && i < iface.TypeArguments.Length; i++)
        {
            map[def.TypeParameters[i]] = iface.TypeArguments[i];
        }

        return map;
    }

    /// <summary>
    /// ADR-0149: resolves every explicit-interface qualifier clause
    /// (<see cref="FunctionDeclarationSyntax.ExplicitInterfaceType"/> /
    /// <see cref="PropertyDeclarationSyntax.ExplicitInterfaceType"/>) declared
    /// on each pending struct/class's own methods and properties, binding the
    /// clause's type reference (via the shared <see cref="bindTypeClause"/>
    /// delegate, with the struct's own type parameters temporarily
    /// re-established in scope — mirroring the same re-establishment
    /// <see cref="BindPendingFieldInitializers"/> already performs for a
    /// similarly deferred pass) to the MATCHING <see cref="InterfaceSymbol"/>
    /// instance already recorded in <see cref="StructSymbol.Interfaces"/>.
    /// Matching against the recorded instance (rather than trusting the
    /// freshly bound one directly) keeps the later
    /// <see cref="TryResolveExplicitInterfaceImplementation"/> /
    /// <see cref="TryResolveExplicitInterfacePropertyImplementation"/>
    /// comparisons sound even though constructed generic interfaces are not
    /// interned (see <see cref="TypeSignaturesEquivalent(TypeSymbol, TypeSymbol)"/>).
    /// Must run BEFORE <see cref="VerifyInterfaceImplementations"/> so that
    /// pass can rely on <see cref="FunctionSymbol.ExplicitInterfaceClauseTarget"/> /
    /// <see cref="PropertySymbol.ExplicitInterfaceClauseTarget"/> already
    /// being populated. Reports GS0492 (clause type is not an interface) and
    /// GS0493 (interface not implemented by the containing type) directly;
    /// GS0494 (no matching member) and GS0495 (duplicate target) are reported
    /// by <see cref="VerifyInterfaceImplementations"/>, which already has the
    /// full per-interface-member matching context needed to detect them.
    /// </summary>
    internal void ResolveExplicitInterfaceClauses()
    {
        foreach (var (syntax, structSymbol) in pendingInterfaceImplementationChecks)
        {
            if ((structSymbol.Methods.IsDefaultOrEmpty || !HasAnyExplicitInterfaceClause(structSymbol.Methods)) &&
                (structSymbol.Properties.IsDefaultOrEmpty || !HasAnyExplicitInterfaceClause(structSymbol.Properties)) &&
                (structSymbol.Events.IsDefaultOrEmpty || !HasAnyExplicitInterfaceClause(structSymbol.Events)) &&
                (structSymbol.StaticMethods.IsDefaultOrEmpty || !HasAnyExplicitInterfaceClause(structSymbol.StaticMethods)) &&
                (structSymbol.StaticProperties.IsDefaultOrEmpty || !HasAnyExplicitInterfaceClause(structSymbol.StaticProperties)))
            {
                continue;
            }

            var savedTypeParameters = binderCtx.CurrentTypeParameters;
            var savedPackage = scope.SetCurrentDeclaringPackage(structSymbol.PackageName);
            var savedTree = scope.SetCurrentReferencingSyntaxTree(syntax.SyntaxTree);
            if (!structSymbol.TypeParameters.IsDefaultOrEmpty)
            {
                binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                foreach (var tp in structSymbol.TypeParameters)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }
            }

            try
            {
                if (!structSymbol.Methods.IsDefaultOrEmpty)
                {
                    foreach (var method in structSymbol.Methods)
                    {
                        if (method.HasExplicitInterfaceClause && method.ExplicitInterfaceClauseTarget == null)
                        {
                            var target = ResolveExplicitInterfaceClauseTarget(structSymbol, method.Declaration.ExplicitInterfaceType, method.Name);
                            if (target != null)
                            {
                                method.ExplicitInterfaceClauseTarget = target;
                            }
                        }
                    }
                }

                if (!structSymbol.Properties.IsDefaultOrEmpty)
                {
                    foreach (var prop in structSymbol.Properties)
                    {
                        if (prop.HasExplicitInterfaceClause && prop.ExplicitInterfaceClauseTarget == null)
                        {
                            var target = ResolveExplicitInterfaceClauseTarget(structSymbol, prop.Declaration.ExplicitInterfaceType, prop.Name);
                            if (target != null)
                            {
                                prop.ExplicitInterfaceClauseTarget = target;

                                // A computed property's getter/setter are
                                // emitted as their OWN FunctionSymbol (see
                                // MemberDefEmitter.EmitPropertyAccessorBody's
                                // emitFunction branch), whose own Declaration
                                // is a PropertyAccessorSyntax with no clause
                                // of its own — so FunctionSymbol.HasExplicitInterfaceClause
                                // (Declaration-derived) is never true for it.
                                // Propagate the resolved target directly onto
                                // ExplicitInterfaceClauseTarget (a plain
                                // settable property, not Declaration-derived)
                                // so ReflectionMetadataEmitter.EmitFunction's
                                // metadata-name synthesis (keyed off
                                // ExplicitInterfaceClauseTarget != null, not
                                // HasExplicitInterfaceClause) also picks up
                                // the accessor's collision-free name.
                                if (prop.GetterSymbol != null)
                                {
                                    prop.GetterSymbol.ExplicitInterfaceClauseTarget = target;
                                }

                                if (prop.SetterSymbol != null)
                                {
                                    prop.SetterSymbol.ExplicitInterfaceClauseTarget = target;
                                }
                            }
                        }
                    }
                }

                // ADR-0149: generalizes the method/property resolution above
                // to events for the first time (issue #2362's original scope
                // grows to cover the third explicit-implementable member
                // kind — indexers, the fourth, reuse the property path above
                // since an indexer IS a PropertySymbol with IsIndexer=true).
                if (!structSymbol.Events.IsDefaultOrEmpty)
                {
                    foreach (var evt in structSymbol.Events)
                    {
                        if (evt.HasExplicitInterfaceClause && evt.ExplicitInterfaceClauseTarget == null)
                        {
                            var target = ResolveExplicitInterfaceClauseTarget(structSymbol, evt.Declaration.ExplicitInterfaceType, evt.Name);
                            if (target != null)
                            {
                                evt.ExplicitInterfaceClauseTarget = target;

                                // A custom (non-field-like) event's add/remove/
                                // raise accessors are their OWN FunctionSymbol
                                // (see MemberDefEmitter's EmitFunction branch
                                // for a bound AddMethodSymbol/RemoveMethodSymbol/
                                // RaiseMethodSymbol), whose own Declaration has
                                // no clause of its own — mirrors the property
                                // getter/setter propagation immediately above.
                                if (evt.AddMethodSymbol != null)
                                {
                                    evt.AddMethodSymbol.ExplicitInterfaceClauseTarget = target;
                                }

                                if (evt.RemoveMethodSymbol != null)
                                {
                                    evt.RemoveMethodSymbol.ExplicitInterfaceClauseTarget = target;
                                }

                                if (evt.RaiseMethodSymbol != null)
                                {
                                    evt.RaiseMethodSymbol.ExplicitInterfaceClauseTarget = target;
                                }
                            }
                        }
                    }
                }

                // ADR-0149 follow-up (issue #2370): generalizes the clause-
                // target resolution above to STATIC methods/properties —
                // ADR-0089's static-virtual interface member support
                // (methods #755, properties #1019) predates the explicit-
                // interface qualifier clause and never consulted it; a
                // `func (IFoo) M(...)` / `prop (IFoo) P T` inside a
                // `shared { }` block already PARSES today (the parser reuses
                // the same routines for shared-block members) but was
                // previously silently ignored by the binder/emitter. There
                // is no static indexer or static event form in C#/the CLR
                // (indexers always require an instance receiver; interfaces
                // cannot declare `static abstract`/`static virtual` events),
                // so only methods and properties need this generalization.
                if (!structSymbol.StaticMethods.IsDefaultOrEmpty)
                {
                    foreach (var method in structSymbol.StaticMethods)
                    {
                        if (method.HasExplicitInterfaceClause && method.ExplicitInterfaceClauseTarget == null)
                        {
                            var target = ResolveExplicitInterfaceClauseTarget(structSymbol, method.Declaration.ExplicitInterfaceType, method.Name);
                            if (target != null)
                            {
                                method.ExplicitInterfaceClauseTarget = target;
                            }
                        }
                    }
                }

                if (!structSymbol.StaticProperties.IsDefaultOrEmpty)
                {
                    foreach (var prop in structSymbol.StaticProperties)
                    {
                        if (prop.HasExplicitInterfaceClause && prop.ExplicitInterfaceClauseTarget == null)
                        {
                            var target = ResolveExplicitInterfaceClauseTarget(structSymbol, prop.Declaration.ExplicitInterfaceType, prop.Name);
                            if (target != null)
                            {
                                prop.ExplicitInterfaceClauseTarget = target;

                                // Mirrors the instance-property getter/setter
                                // propagation above: a computed static
                                // property's accessors are their own
                                // FunctionSymbol with no clause of their own.
                                if (prop.GetterSymbol != null)
                                {
                                    prop.GetterSymbol.ExplicitInterfaceClauseTarget = target;
                                }

                                if (prop.SetterSymbol != null)
                                {
                                    prop.SetterSymbol.ExplicitInterfaceClauseTarget = target;
                                }
                            }
                        }
                    }
                }
            }
            finally
            {
                binderCtx.CurrentTypeParameters = savedTypeParameters;
                scope.SetCurrentDeclaringPackage(savedPackage);
                scope.SetCurrentReferencingSyntaxTree(savedTree);
            }
        }
    }

    private static bool HasAnyExplicitInterfaceClause(ImmutableArray<FunctionSymbol> methods)
    {
        foreach (var m in methods)
        {
            if (m.HasExplicitInterfaceClause)
            {
                return true;
            }
        }

        return false;
    }

    private static bool HasAnyExplicitInterfaceClause(ImmutableArray<PropertySymbol> properties)
    {
        foreach (var p in properties)
        {
            if (p.HasExplicitInterfaceClause)
            {
                return true;
            }
        }

        return false;
    }

    private static bool HasAnyExplicitInterfaceClause(ImmutableArray<EventSymbol> events)
    {
        foreach (var e in events)
        {
            if (e.HasExplicitInterfaceClause)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0149: binds an explicit-interface qualifier clause's type
    /// reference and validates it names an interface implemented by
    /// <paramref name="structSymbol"/>, returning the MATCHING entry from
    /// <see cref="StructSymbol.Interfaces"/> (not the freshly bound instance —
    /// see <see cref="ResolveExplicitInterfaceClauses"/>). Reports GS0492 when
    /// the clause type is not an interface, or GS0493 when it is an interface
    /// the containing type does not implement; returns <see langword="null"/>
    /// in either case (the caller leaves <c>ExplicitInterfaceClauseTarget</c>
    /// unset, so the member is treated as unresolved but does not crash
    /// downstream — <see cref="VerifyInterfaceImplementations"/>'s trailing
    /// unresolved-clause sweep does not re-report a second diagnostic for it).
    /// </summary>
    private InterfaceSymbol ResolveExplicitInterfaceClauseTarget(StructSymbol structSymbol, TypeClauseSyntax clauseTypeSyntax, string memberName)
    {
        var boundType = bindTypeClause(clauseTypeSyntax);
        if (boundType is not InterfaceSymbol clauseIface)
        {
            if (boundType != null && boundType != TypeSymbol.Error)
            {
                Diagnostics.ReportExplicitInterfaceClauseTypeNotInterface(clauseTypeSyntax.Location, boundType.Name, memberName);
            }

            return null;
        }

        if (!structSymbol.Interfaces.IsDefaultOrEmpty)
        {
            foreach (var candidateIface in structSymbol.Interfaces)
            {
                if (TypeSignaturesEquivalent(candidateIface, clauseIface))
                {
                    return candidateIface;
                }
            }
        }

        Diagnostics.ReportExplicitInterfaceClauseNotImplemented(clauseTypeSyntax.Location, structSymbol.Name, clauseIface.Name, memberName);
        return null;
    }

    /// <summary>
    /// Issue #974: structural equivalence used by override / interface-
    /// implementation signature matching. Constructed generic types are not
    /// interned (<see cref="ImportedTypeSymbol.GetConstructed"/> and
    /// <see cref="InterfaceSymbol.Construct"/> can yield fresh instances), so a
    /// raw reference comparison wrongly rejects, for example, the class method
    /// <c>func Iter() IEnumerator[T]</c> against the interface requirement
    /// <c>ISeq[T].Iter() IEnumerator[T]</c> once the interface's type
    /// parameters have been substituted with the implementing type's
    /// arguments. Reference identity is honoured first (covering plain type
    /// parameters, primitives and cached imported types); constructed generics
    /// are then compared by definition and ordered type arguments, recursing
    /// through slice / array / nullable wrappers. The comparison stays strict —
    /// distinct type arguments (e.g. <c>IEnumerator[int32]</c> vs
    /// <c>IEnumerator[T]</c>) are not equated — so genuinely mismatched
    /// signatures are still rejected with GS0187.
    /// </summary>
    internal static bool TypeSignaturesEquivalent(TypeSymbol a, TypeSymbol b)
        => TypeSignaturesEquivalent(a, b, typeParamMap: null);

    private static bool TypeSignaturesEquivalent(
        TypeSymbol a,
        TypeSymbol b,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap)
    {
        // Issue #1007: substitute a generic interface method's type parameter
        // with the implementing method's positionally-corresponding type
        // parameter before comparing, so `T_iface` and `T_class` match.
        if (typeParamMap != null && a is TypeParameterSymbol tpa && typeParamMap.TryGetValue(tpa, out var mappedA))
        {
            a = mappedA;
        }

        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a == null || b == null)
        {
            return false;
        }

        if (a is StructSymbol sa && b is StructSymbol sb)
        {
            return ReferenceEquals(sa.Definition, sb.Definition)
                && TypeArgumentsEquivalent(sa.TypeArguments, sb.TypeArguments, typeParamMap);
        }

        if (a is InterfaceSymbol ia && b is InterfaceSymbol ib)
        {
            return ReferenceEquals(ia.Definition, ib.Definition)
                && TypeArgumentsEquivalent(ia.TypeArguments, ib.TypeArguments, typeParamMap);
        }

        // Issue #2340 follow-up: a named delegate constructed over a
        // *method-level* generic parameter (e.g. an interface method
        // `func Make[T](seed T) Getter[T]`) is never covered by the
        // StructSymbol/InterfaceSymbol branches above, and — unlike the
        // interface-level generic case — is not fixed by substituting the
        // interface's own type arguments, because the delegate's type
        // argument here is the *method's* type parameter, which is only
        // resolved through `typeParamMap` (built per call by
        // TryBuildMethodTypeParameterMap). Without this branch,
        // `Getter[T_interfaceMethod]` and `Getter[T_implMethod]` are two
        // distinct DelegateTypeSymbol.Construct cache entries (different
        // TypeParameterSymbol instances as their sole type argument) that
        // fail the top-level ReferenceEquals check and then fall through to
        // the ClrType fallback below, which does not apply the
        // method-type-parameter map and wrongly rejects a genuinely matching
        // signature with GS0187. Recurses through TypeArgumentsEquivalent
        // exactly like the StructSymbol/InterfaceSymbol branches so the
        // typeParamMap substitution applies to each type argument.
        if (a is DelegateTypeSymbol dta && b is DelegateTypeSymbol dtb)
        {
            // Unlike StructSymbol/InterfaceSymbol (whose `Definition` self-
            // references on the open definition), DelegateTypeSymbol.Definition
            // is only set on constructed instances (issue #1503) and stays
            // `null` on the open definition / non-generic delegates — so it
            // must be normalized to itself before comparing, or two distinct
            // non-generic (or open-definition) delegate types would both
            // report `Definition == null` and wrongly compare as equivalent.
            var defA = dta.Definition ?? dta;
            var defB = dtb.Definition ?? dtb;
            return ReferenceEquals(defA, defB)
                && TypeArgumentsEquivalent(dta.TypeArguments, dtb.TypeArguments, typeParamMap);
        }

        if (a is ImportedTypeSymbol pa && b is ImportedTypeSymbol pb)
        {
            // Constructed imported generics carrying symbolic arguments (e.g.
            // `IEnumerator[T]`) are compared by open definition and ordered
            // arguments so an unbound type parameter compares by identity
            // rather than by its erased `object` CLR projection.
            if (pa.OpenDefinition != null
                && pb.OpenDefinition != null
                && pa.OpenDefinition == pb.OpenDefinition
                && TypeArgumentsEquivalent(pa.TypeArguments, pb.TypeArguments, typeParamMap))
            {
                return true;
            }

            // Otherwise (one or both sides expressed as a plain closed CLR
            // type, e.g. a fully concrete `IEnumerator[int32]`) fall back to a
            // closed-type comparison. This is only sound when neither side
            // carries an unbound type parameter, whose CLR shape is erased to
            // `object` and would otherwise equate distinct constructions.
            if (!TypeSymbol.ContainsTypeParameter(pa) && !TypeSymbol.ContainsTypeParameter(pb))
            {
                return pa.ClrType != null
                    && pb.ClrType != null
                    && ClrTypeUtilities.AreSame(pa.ClrType, pb.ClrType);
            }

            return false;
        }

        if (a is SliceTypeSymbol sla && b is SliceTypeSymbol slb)
        {
            return TypeSignaturesEquivalent(sla.ElementType, slb.ElementType, typeParamMap);
        }

        if (a is ArrayTypeSymbol ara && b is ArrayTypeSymbol arb)
        {
            return ara.Length == arb.Length
                && TypeSignaturesEquivalent(ara.ElementType, arb.ElementType, typeParamMap);
        }

        if (a is NullableTypeSymbol na && b is NullableTypeSymbol nb)
        {
            return TypeSignaturesEquivalent(na.UnderlyingType, nb.UnderlyingType, typeParamMap);
        }

        // Leaf fallback for non-generic types that are not reference-interned
        // (e.g. a primitive supplied as a concrete type argument such as the
        // `int32` in `ISeq[int32]`). Type parameters keep an absent ClrType so
        // distinct parameters are never wrongly equated here.
        return a.ClrType != null && b.ClrType != null && a.ClrType == b.ClrType;
    }

    private static bool TypeArgumentsEquivalent(ImmutableArray<TypeSymbol> a, ImmutableArray<TypeSymbol> b)
        => TypeArgumentsEquivalent(a, b, typeParamMap: null);

    private static bool TypeArgumentsEquivalent(
        ImmutableArray<TypeSymbol> a,
        ImmutableArray<TypeSymbol> b,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap)
    {
        if (a.IsDefaultOrEmpty && b.IsDefaultOrEmpty)
        {
            return true;
        }

        if (a.IsDefaultOrEmpty || b.IsDefaultOrEmpty || a.Length != b.Length)
        {
            return false;
        }

        for (var i = 0; i < a.Length; i++)
        {
            if (!TypeSignaturesEquivalent(a[i], b[i], typeParamMap))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): validates a function's optional <c>ref</c> return modifier
    /// against the declared return type and async/iterator constraints, reporting diagnostics
    /// for invalid combinations. Returns <see cref="RefKind.Ref"/> when the function should be
    /// modeled as ref-returning, <see cref="RefKind.None"/> otherwise.
    /// </summary>
    /// <summary>
    /// ADR-0101 / issue #799 + #812 — shared validation for variadic
    /// (<c>...T</c>) parameters on any declaration kind (top-level
    /// function, class instance method, class static method, interface
    /// method, constructor, delegate, lambda). Reports
    /// <c>GS0145</c> ("variadic parameter must be the last parameter")
    /// for every variadic parameter that is not the last syntactic
    /// parameter, and <c>GS0364</c> ("a signature may declare at most
    /// one variadic parameter") for any second-or-later occurrence.
    /// The caller is responsible for wrapping the parameter's element
    /// type in a <see cref="SliceTypeSymbol"/> and setting
    /// <see cref="ParameterSymbol.IsVariadic"/>.
    /// </summary>
    private void ValidateVariadicParameterShape(SeparatedSyntaxList<ParameterSyntax> parameters)
    {
        var firstVariadicSeen = false;
        for (var i = 0; i < parameters.Count; i++)
        {
            if (!parameters[i].IsVariadic)
            {
                continue;
            }

            if (firstVariadicSeen)
            {
                Diagnostics.ReportMultipleVariadicParameters(parameters[i].Location, parameters[i].Identifier.Text);
            }

            firstVariadicSeen = true;
            if (i < parameters.Count - 1)
            {
                Diagnostics.ReportVariadicParameterMustBeLast(parameters[i].Location, parameters[i].Identifier.Text);
            }
        }
    }

    private RefKind ValidateReturnRefKind(FunctionDeclarationSyntax syntax, TypeSymbol returnType)
    {
        if (!syntax.IsRefReturn)
        {
            return RefKind.None;
        }

        if (syntax.Type == null)
        {
            Diagnostics.ReportRefReturnRequiresReturnType(syntax.ReturnRefModifier.Location);
            return RefKind.None;
        }

        if (syntax.IsAsync)
        {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(syntax.ReturnRefModifier.Location, "async");
            return RefKind.None;
        }

        if (returnType is SequenceTypeSymbol)
        {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(syntax.ReturnRefModifier.Location, "sequence");
            return RefKind.None;
        }

        if (returnType is AsyncSequenceTypeSymbol)
        {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(syntax.ReturnRefModifier.Location, "async sequence");
            return RefKind.None;
        }

        if (returnType is ByRefTypeSymbol)
        {
            Diagnostics.ReportRefReturnOfByRefType(syntax.ReturnRefModifier.Location);
            return RefKind.None;
        }

        return RefKind.Ref;
    }

    internal VariableSymbol BindVariableDeclaration(SyntaxToken identifier, bool isReadOnly, TypeSymbol type)
    {
        return BindVariableDeclaration(identifier, isReadOnly, type, Accessibility.Public);
    }

    internal VariableSymbol BindVariableDeclaration(SyntaxToken identifier, bool isReadOnly, TypeSymbol type, Accessibility accessibility)
    {
        var name = identifier.Text ?? "?";
        var declare = !identifier.IsMissing;

        // ADR-0066 D1: variables declared inside top-level statements live on
        // `BoundGlobalScope.Variables` as `GlobalVariableSymbol`s even though
        // the enclosing synthesized `<Main>$` is a non-null function (so that
        // `return` / `await` validation works). Treat the synthesized entry
        // point as a top-level context for variable-creation purposes only.
        var inTopLevelContext = function == null || function.IsTopLevelEntryPoint;
        var variable = inTopLevelContext
                            ? (VariableSymbol)new GlobalVariableSymbol(name, isReadOnly, type, accessibility, declaringSyntax: identifier)
                            : new LocalVariableSymbol(name, isReadOnly, type, declaringSyntax: identifier);

        if (declare && !scope.TryDeclareVariable(variable))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, name);
        }

        return variable;
    }
}
