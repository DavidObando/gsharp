// <copyright file="DeclarationBinder.Functions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
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

/// <summary>
/// Extracted from <see cref="Binder"/> in PR-B-8. Owns every per-declaration-kind
/// binder: type aliases, named delegates, enums, structs (including the large
/// <c>BindStructDeclarationBody</c> driver and its interface-implementation
/// verification pass), interfaces, free / member / extension functions,
/// constructors (<c>init</c>) plus the <c>: base(...)</c> initializer
/// resolver, the two symbol-construction <c>BindVariableDeclaration</c>
/// overloads, generic-parameter binding (<c>BindTypeParameterList</c>), the
/// declaration-side attribute binder (<c>BindAttributes</c>/<c>BindAttribute</c>),
/// and the queue of pending struct→interface implementation checks. The
/// expression binder and most type-name resolution remain on
/// <see cref="Binder"/> and are invoked via the delegate callbacks supplied to
/// the constructor; the same is true for <c>BindBlockStatement</c>-driven
/// body binding (which happens later, in <c>BindProgram</c>, not here).
/// </summary>

internal sealed partial class DeclarationBinder
{


    /// <summary>
    /// ADR-0059 / issue #255: binds a <c>type Name = delegate func(...)</c>
    /// declaration into a <see cref="DelegateTypeSymbol"/> registered with the
    /// current scope. Unlike a plain type alias, a named delegate produces a
    /// real CLR TypeDef at emit time.
    /// </summary>
    internal void BindDelegateDeclaration(DelegateDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;

        // Reject shadowing of primitive type names — same rule as struct/enum.
        if (isPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return;
        }

        // ADR-0059 v1 limitation: generic delegate declarations are accepted
        // syntactically but rejected by the binder (the emitter does not yet
        // thread GenericParam rows through delegate TypeDefs). Surface a clear
        // diagnostic so users know it's a deliberate not-yet-supported case.
        if (syntax.TypeParameterList != null)
        {
            Diagnostics.ReportGenericDelegateNotSupported(syntax.Identifier.Location, name);
            return;
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);

        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        var seenParameterNames = new HashSet<string>();
        for (var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++)
        {
            var parameterSyntax = syntax.Parameters[pIndex];
            var parameterName = parameterSyntax.Identifier.Text;
            var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error;
            if (!seenParameterNames.Add(parameterName))
            {
                Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                continue;
            }

            // ADR-0101 follow-up / issue #812: variadic parameters are now
            // accepted on delegate declarations. The Invoke signature carries
            // a `[]T` slice, and the emitter stamps [ParamArrayAttribute] on
            // the trailing parameter so C# / F# / VB consumers see the
            // delegate as a normal `params T[]` delegate.
            var isVariadic = parameterSyntax.IsVariadic;
            if (isVariadic && parameterType != TypeSymbol.Error)
            {
                parameterType = SliceTypeSymbol.Get(parameterType);
            }

            var delegateParam = new ParameterSymbol(
                parameterName,
                parameterType,
                isVariadic,
                declaringSyntax: parameterSyntax.Identifier,
                refKind: conversions.BindAndValidateParameterRefKind(parameterSyntax, parameterName, parameterType, isVariadic, asyncOrIteratorKind: null));

            // ADR-0063 §5: delegate declarations can declare default-valued
            // parameters; the value is recorded on the parameter symbol for
            // call-site default substitution.
            conversions.BindAndAttachParameterDefaultValue(parameterSyntax, delegateParam);
            parameters.Add(delegateParam);
        }

        // ADR-0101 follow-up / issue #812: `...T` must be the last parameter
        // and at most one variadic parameter per delegate signature.
        ValidateVariadicParameterShape(syntax.Parameters);

        var returnType = syntax.ReturnType != null ? bindTypeClause(syntax.ReturnType) : TypeSymbol.Void;
        if (returnType == null)
        {
            returnType = TypeSymbol.Void;
        }

        // ADR-0047: annotations on a delegate declaration default to the Type
        // target. ADR-0095 / issue #761: the effective AttributeUsage target
        // is `Delegate` (not `Class`) so attributes whose AttributeUsage is
        // restricted to delegates — most importantly
        // `[UnmanagedFunctionPointer]` — bind without GS0276.
        var delegateAttributes = BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "a delegate declaration",
            System.AttributeTargets.Delegate);

        var delegateSymbol = new DelegateTypeSymbol(
            name,
            package.Name,
            accessibility,
            parameters.ToImmutable(),
            returnType,
            syntax);
        delegateSymbol.SetAttributes(delegateAttributes);
        Binder.AttachDocumentation(delegateSymbol, syntax);

        if (!scope.TryDeclareTypeAlias(name, delegateSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }
    }

    internal void VerifyAbstractMethodImplementations()
    {
        foreach (var (syntax, structSymbol) in pendingAbstractImplementationChecks)
        {
            // An `open` class is permitted to remain abstract — it need not
            // override inherited abstract members.
            if (structSymbol.IsOpen)
            {
                continue;
            }

            foreach (var abstractMethod in structSymbol.GetUnimplementedAbstractMethods())
            {
                // Skip abstract methods declared directly on this class — those
                // are reported via GS0388 (abstract member in a non-open class).
                // GS0387 is reserved for abstract members *inherited* from a base
                // class and left unimplemented by a concrete subclass.
                if (ReferenceEquals(abstractMethod.ReceiverType, structSymbol))
                {
                    continue;
                }

                Diagnostics.ReportAbstractMemberNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    abstractMethod.ReceiverType?.Name ?? structSymbol.Name,
                    abstractMethod.Name);
            }
        }
    }

    private static string FormatClrMethodSignature(System.Reflection.MethodInfo method)
    {
        var ps = method.GetParameters();
        if (ps.Length == 0)
        {
            return method.Name;
        }

        var names = new string[ps.Length];
        for (var i = 0; i < ps.Length; i++)
        {
            names[i] = ps[i].ParameterType.Name;
        }

        return $"{method.Name}({string.Join(", ", names)})";
    }

    internal void BindFunctionDeclaration(FunctionDeclarationSyntax syntax, PackageSymbol package)
    {
        // ADR-0122 / issue #1014: an `unsafe func` is bound entirely within an
        // unsafe context so its parameter / return types may be unmanaged raw
        // pointers (`*T` → CLR ELEMENT_TYPE_PTR).
        using var unsafeContext = binderCtx.PushUnsafeContext(syntax.IsUnsafe);

        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();

        var seenParameterNames = new HashSet<string>();

        // Phase 4.1 / ADR-0020: bind generic type parameters first so that
        // BindTypeClause can find them when binding parameter / return types.
        var typeParameters = BindTypeParameterList(syntax.TypeParameterList);
        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        if (!typeParameters.IsDefaultOrEmpty)
        {
            binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
            foreach (var tp in typeParameters)
            {
                binderCtx.CurrentTypeParameters[tp.Name] = tp;
            }
        }

        try
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
                    return;
                }
            }

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

            // ADR-0041: bind the return type with async-aware alias resolution.
            var type = bindReturnTypeClause(syntax.Type, syntax.IsAsync) ?? TypeSymbol.Void;

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

            var accessibility = resolveAccessibility(syntax.AccessibilityModifier);

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

                if (methodReceiverStruct.IsData && IsDataStructSynthesizedMemberName(methodName))
                {
                    Diagnostics.ReportDataStructSynthesizedMemberConflict(syntax.Identifier.Location, methodReceiverStruct.Name, methodName);
                    return;
                }

                if (methodReceiverStruct.TryGetField(methodName, out _))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, methodName);
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
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

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

        var count = syntax.Parameters.Count;
        var symbols = new TypeParameterSymbol[count];
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

            symbols[i] = new TypeParameterSymbol(name, i, TypeParameterConstraint.Any, variance);
        }

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

        // Issue #1056: let the caller register the declaring type's name shell
        // (with these bare type parameters attached) before constraints resolve,
        // so a self-referential base-class constraint resolves the type's own
        // name and arity.
        onBareSymbolsPublished?.Invoke(ImmutableArray.Create(symbols));

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

                symbol.HasReferenceTypeConstraint = hasRefType;
                symbol.HasValueTypeConstraint = hasValueType;
                symbol.HasDefaultConstructorConstraint = hasDefaultCtor;
            }
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }

        return ImmutableArray.Create(symbols);
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
}
