// <copyright file="DeclarationBinder.Interfaces.cs" company="GSharp">
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
    internal InterfaceSymbol DeclareInterfaceSymbol(InterfaceDeclarationSyntax syntax, PackageSymbol package, TypeSymbol containingType = null)
    {
        var name = syntax.Identifier.Text;
        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var interfaceSymbol = new InterfaceSymbol(name, accessibility, syntax, package.Name);
        Binder.AttachDocumentation(interfaceSymbol, syntax);

        // Issue #1080: set the enclosing type BEFORE registering the name so the
        // scope can scope name-uniqueness to the enclosing type.
        if (containingType != null)
        {
            interfaceSymbol.SetContainingType(containingType);
        }

        interfaceSymbol.SetAttributes(BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "an interface declaration",
            System.AttributeTargets.Interface));

        // Issue #2519: publish bare type parameters with the interface shell
        // and resolve their constraints only when members are bound, after all
        // same-compilation aggregate shells exist. This is the interface
        // counterpart of the aggregate-shell lifecycle and preserves CRTP
        // because the interface's own shell is visible by then.
        var typeParameters = CreateTypeParameterSymbols(syntax.TypeParameterList);
        if (!typeParameters.IsDefaultOrEmpty)
        {
            interfaceSymbol.SetTypeParameters(typeParameters);
        }

        if (!scope.TryDeclareTypeAlias(name, interfaceSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return null;
        }

        return interfaceSymbol;
    }

    private void BindInterfaceDeclaration(InterfaceDeclarationSyntax syntax, PackageSymbol package)
    {
        var declared = DeclareInterfaceSymbol(syntax, package);
        if (declared != null)
        {
            BindInterfaceMembers(syntax, declared, package);
        }
    }

    internal void BindInterfaceMembers(InterfaceDeclarationSyntax syntax, InterfaceSymbol interfaceSymbol, PackageSymbol package)
    {
        // Phase 4.3c: push the interface's type parameters so that method
        // signatures can reference them.
        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        if (!interfaceSymbol.TypeParameters.IsDefaultOrEmpty)
        {
            binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
            foreach (var tp in interfaceSymbol.TypeParameters)
            {
                binderCtx.CurrentTypeParameters[tp.Name] = tp;
            }
        }

        try
        {
            ResolveTypeParameterConstraints(syntax.TypeParameterList, interfaceSymbol.TypeParameters);
            BindInterfaceMembersCore(syntax, interfaceSymbol, package);
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

    /// <summary>
    /// Issue #1006: binds the base-interface clause of an interface declaration
    /// (<c>interface B : A</c>). Each entry must resolve to an interface — a
    /// user <see cref="InterfaceSymbol"/> or an imported CLR interface — or a
    /// GS0391 diagnostic fires. Resolved bases are recorded on the
    /// <see cref="InterfaceSymbol"/> so member lookup and emit can surface and
    /// re-emit them.
    /// </summary>
    private void BindInterfaceBaseInterfaces(InterfaceDeclarationSyntax syntax, InterfaceSymbol interfaceSymbol)
    {
        if (!syntax.HasBaseInterfaces || syntax.BaseTypeClauses.Count == 0)
        {
            return;
        }

        var name = syntax.Identifier.Text;
        var baseInterfaces = ImmutableArray.CreateBuilder<InterfaceSymbol>();
        var baseClrInterfaces = ImmutableArray.CreateBuilder<TypeSymbol>();
        for (var i = 0; i < syntax.BaseTypeClauses.Count; i++)
        {
            var baseTypeSyntax = syntax.BaseTypeClauses[i];
            var baseName = GetBaseClauseTypeDisplayName(baseTypeSyntax);
            var baseLocation = baseTypeSyntax.Identifier?.Location ?? syntax.Identifier.Location;

            var resolved = bindTypeClause(baseTypeSyntax);
            if (resolved == null || resolved == TypeSymbol.Error)
            {
                continue;
            }

            if (resolved is InterfaceSymbol iface)
            {
                // Issue #1006: reject direct self-inheritance (`interface A : A`).
                if (iface == interfaceSymbol || iface.Definition == interfaceSymbol)
                {
                    Diagnostics.ReportInterfaceCannotHaveClassBase(baseLocation, name, baseName);
                    continue;
                }

                if (iface.IsGenericDefinition)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(baseLocation, baseName, iface.TypeParameters.Length, 0);
                    continue;
                }

                baseInterfaces.Add(iface);
                continue;
            }

            // An imported CLR interface (e.g. `: System.IDisposable`) is a valid
            // base interface too.
            if (resolved.ClrType != null && resolved.ClrType.IsInterface)
            {
                baseClrInterfaces.Add(resolved);
                continue;
            }

            // Anything else (a user class/struct or a CLR class) is illegal —
            // only interfaces may appear in an interface's base list.
            Diagnostics.ReportInterfaceCannotHaveClassBase(baseLocation, name, baseName);
        }

        if (baseInterfaces.Count > 0)
        {
            interfaceSymbol.SetBaseInterfaces(baseInterfaces.ToImmutable());
        }

        if (baseClrInterfaces.Count > 0)
        {
            interfaceSymbol.SetBaseClrInterfaces(baseClrInterfaces.ToImmutable());
        }
    }

    private void BindInterfaceMembersCore(InterfaceDeclarationSyntax syntax, InterfaceSymbol interfaceSymbol, PackageSymbol package)
    {
        BindInterfaceBaseInterfaces(syntax, interfaceSymbol);

        var seenNames = new HashSet<string>();
        BindInterfaceMethods(syntax, interfaceSymbol, package, seenNames);
        BindInterfaceProperties(syntax, interfaceSymbol, package, seenNames);
        BindInterfaceEvents(syntax, interfaceSymbol, package, seenNames);
        BindInterfaceStaticFields(syntax, interfaceSymbol, seenNames);
        VerifyInterfaceMemberVariance(syntax, interfaceSymbol);
    }

    private void BindInterfaceMethods(
        InterfaceDeclarationSyntax syntax,
        InterfaceSymbol interfaceSymbol,
        PackageSymbol package,
        HashSet<string> seenNames)
    {
        var methodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        var staticMethodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        var privateMethodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        var staticPrivateMethodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        foreach (var methodSyntax in syntax.Methods)
        {
            var methodName = methodSyntax.Identifier.Text;

            // ADR-0089 / issue #755: detect a `static` modifier early — the
            // method is a static-virtual interface member. Static methods do
            // not receive a `this` parameter, are not added to the dispatch
            // table for instance calls, and live on a separate
            // <c>InterfaceSymbol.StaticMethods</c> bucket. Both abstract and
            // default-bodied forms are accepted; the binder uses the same
            // body-vs-no-body discriminator as ADR-0085 to distinguish them.
            var isStaticInterfaceMethod = methodSyntax.HasStaticModifier;

            // ADR-0090 / issue #756: detect a `private` accessibility modifier
            // on the interface method. Private helpers route into the
            // separate <see cref="InterfaceSymbol.PrivateMethods"/> bucket
            // (or <see cref="InterfaceSymbol.StaticPrivateMethods"/> when
            // also <c>static</c>) so the public <c>Methods</c> contract used
            // by implementer-verification is unaffected. The CLR shape is
            // <c>MethodAttributes.Private | HideBySig</c> (plus
            // <c>Static</c> when combined with ADR-0089). The helper is
            // non-virtual; implementers cannot see it (GS0336 fires when an
            // implementer declares a same-signature method on a type that
            // implements the owning interface).
            var isPrivateInterfaceMethod = methodSyntax.AccessibilityModifier != null
                && string.Equals(methodSyntax.AccessibilityModifier.Text, "private", System.StringComparison.Ordinal);

            // Issue #1007 / ADR-0020: an interface method may declare its own
            // generic type-parameter list (`func M[T](...) T`). Bind it first
            // and seed it into the binding scope — merged with any enclosing
            // interface type parameters — so the method's parameter types and
            // return type (and, for default-bodied methods, the body) can
            // reference `T`. The seeding is unwound at the end of each
            // iteration so one method's type parameters never leak into the
            // next or the surrounding interface, mirroring the class-method
            // path.
            var methodTypeParameters = BindTypeParameterList(methodSyntax.TypeParameterList);
            var enclosingTypeParameters = binderCtx.CurrentTypeParameters;
            if (!methodTypeParameters.IsDefaultOrEmpty)
            {
                binderCtx.CurrentTypeParameters = enclosingTypeParameters == null
                    ? new Dictionary<string, TypeParameterSymbol>()
                    : new Dictionary<string, TypeParameterSymbol>(enclosingTypeParameters);
                foreach (var tp in methodTypeParameters)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }
            }

            try
            {
            // ADR-0122 / issue #1036: an `unsafe func` interface method binds its
            // signature (params + return) in an unsafe context too, mirroring the
            // class/struct member path. No-op for a non-`unsafe` method.
            using var sigUnsafeContext = binderCtx.PushUnsafeContext(methodSyntax.IsUnsafe);

            // ADR-0063: overloads are allowed on interfaces; the post-bind signature
            // check below detects duplicate signatures. Name collision with a
            // property/event member of the same name is still rejected (handled later
            // via seenNames when properties/events are added).
            var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
            var seenParameterNames = new HashSet<string>();
            foreach (var parameterSyntax in methodSyntax.Parameters)
            {
                var parameterName = parameterSyntax.Identifier.Text;
                var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error;

                // ADR-0101 follow-up / issue #812: variadic parameters are now
                // accepted on interface methods. For abstract members the
                // variadic flag travels through the dispatch table; for ADR-0085
                // default-bodied members the body sees the parameter as `[]T`,
                // and the emitter stamps [ParamArrayAttribute] on the MethodDef
                // (interface method emit shares the same path as class methods).
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
                    asyncOrIteratorKind: methodSyntax.IsAsync ? "async" : null);

                // Issue #1262: `_` is the discard identifier — repeated `_` parameters are
                // permitted on named functions/methods. Each `_` occupies a positional slot
                // but is not added to the body scope, so non-`_` duplicates still error.
                if (parameterName != "_" && !seenParameterNames.Add(parameterName))
                {
                    Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                }
                else
                {
                    var ifaceMethodParam = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
                    conversions.BindAndAttachParameterDefaultValue(parameterSyntax, ifaceMethodParam);
                    BindAndAttachParameterAttributes(parameterSyntax, ifaceMethodParam);
                    parameters.Add(ifaceMethodParam);
                }
            }

            ValidateVariadicParameterShape(methodSyntax.Parameters);

            var returnType = bindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void;
            returnType = NormalizeAsyncDeclaredReturnType(returnType, methodSyntax.IsAsync, out var returnTypeIsValueTask);
            var methodReturnRefKind = ValidateReturnRefKind(methodSyntax, returnType);

            // ADR-0085 / issue #726: an interface method whose declaration
            // carries a body is a default-interface method. We set the
            // receiver type to the owning InterfaceSymbol so the body
            // binder gives the method a `this` parameter and the call
            // binder routes virtual dispatch through the interface. An
            // abstract interface method still gets the same receiver
            // (`this` typed as the interface) so call-binder paths that
            // resolve interface dispatch work uniformly — emit then drops
            // the body when the declaration has none.
            //
            // ADR-0089: static-virtual interface members are not instance
            // methods — they have no `this`. Construct a top-level-style
            // FunctionSymbol with `IsStatic = true` and `StaticOwnerType`
            // set to the owning InterfaceSymbol.
            //
            // ADR-0090: private helpers get the same shape — the receiver
            // type is the InterfaceSymbol (so sibling default bodies on the
            // same interface dispatch correctly), but Accessibility is set
            // to Private so the emit pipeline produces the
            // MethodAttributes.Private flag.
            var methodAccessibility = isPrivateInterfaceMethod ? Accessibility.Private : Accessibility.Public;
            var methodSymbol = new FunctionSymbol(
                methodName,
                parameters.ToImmutable(),
                returnType,
                methodSyntax,
                package,
                methodAccessibility,
                receiverType: isStaticInterfaceMethod ? null : (TypeSymbol)interfaceSymbol);
            methodSymbol.ReturnRefKind = methodReturnRefKind;

            // Bodyless interface declarations describe an async-iterator ABI.
            // Default bodies are executable and follow ordinary function
            // classification so an eager delegation body is not discarded.
            methodSymbol.IsAsync = methodSyntax.IsAsync
                || (isAsyncIteratorReturnType(returnType)
                    && (methodSyntax.HasSemicolonBody || IteratorDetection.ContainsYield(methodSyntax.Body)));
            methodSymbol.AsyncReturnsValueTask = returnTypeIsValueTask;
            methodSymbol.IsUnsafe = methodSyntax.IsUnsafe;
            methodSymbol.TypeParameters = methodTypeParameters;
            if (isStaticInterfaceMethod)
            {
                methodSymbol.IsStatic = true;
                methodSymbol.StaticOwnerType = interfaceSymbol;
            }

            Binder.AttachDocumentation(methodSymbol, methodSyntax);

            // Issue #2129: bind @annotations on an interface method signature
            // so they emit as CustomAttribute rows on the interface MethodDef,
            // mirroring the class-method path.
            if (!methodSyntax.Annotations.IsDefaultOrEmpty)
            {
                methodSymbol.SetAttributes(BindAttributes(
                    methodSyntax.Annotations,
                    AttributeTargetKind.Method,
                    Binder.FunctionDeclarationAllowedTargets,
                    "a method declaration",
                    System.AttributeTargets.Method));
            }

            // ADR-0085: reject `open` / `override` modifiers on interface
            // members — these are tracked as deferred follow-ups (GS0321).
            // The parser does not currently accept them on interface method
            // signatures, but the FunctionDeclarationSyntax can carry them
            // in principle via the constructor overload; defensively
            // diagnose here so a future parser relaxation surfaces with a
            // clear message. ADR-0089 reverses the rejection of `static` —
            // it is now accepted. ADR-0090 reverses the rejection of
            // `private` — it is now accepted (and routed into the private
            // helpers bucket).
            if (methodSyntax.OpenModifier != null)
            {
                Diagnostics.ReportInterfaceMethodModifierDeferred(methodSyntax.OpenModifier.Location, "open", methodName);
            }

            if (methodSyntax.OverrideModifier != null)
            {
                Diagnostics.ReportInterfaceMethodModifierDeferred(methodSyntax.OverrideModifier.Location, "override", methodName);
            }

            // ADR-0090 / issue #756: a `private` interface method must
            // carry a body. The helper is part of the interface's own
            // implementation — no implementer can supply it.
            if (isPrivateInterfaceMethod && methodSyntax.Body == null)
            {
                Diagnostics.ReportPrivateInterfaceMemberRequiresBody(methodSyntax.Identifier.Location, methodName);
            }

            // ADR-0063 §11: detect duplicate-signature overloads on the interface.
            ImmutableArray<FunctionSymbol>.Builder targetBuilder;
            if (isPrivateInterfaceMethod)
            {
                targetBuilder = isStaticInterfaceMethod ? staticPrivateMethodsBuilder : privateMethodsBuilder;
            }
            else
            {
                targetBuilder = isStaticInterfaceMethod ? staticMethodsBuilder : methodsBuilder;
            }

            var hasDupSig = false;
            foreach (var existingMethod in targetBuilder)
            {
                if (BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol))
                {
                    Diagnostics.ReportDuplicateOverloadSignature(
                        methodSyntax.Identifier.Location,
                        methodName,
                        Binder.FormatOverloadSignature(methodSymbol));
                    hasDupSig = true;
                    break;
                }
            }

            if (!hasDupSig)
            {
                seenNames.Add(methodName);
                targetBuilder.Add(methodSymbol);
            }
            }
            finally
            {
                binderCtx.CurrentTypeParameters = enclosingTypeParameters;
            }
        }

        interfaceSymbol.SetMethods(methodsBuilder.ToImmutable());
        interfaceSymbol.SetStaticMethods(staticMethodsBuilder.ToImmutable());
        interfaceSymbol.SetPrivateMethods(privateMethodsBuilder.ToImmutable());
        interfaceSymbol.SetStaticPrivateMethods(staticPrivateMethodsBuilder.ToImmutable());
    }

    private void BindInterfaceProperties(
        InterfaceDeclarationSyntax syntax,
        InterfaceSymbol interfaceSymbol,
        PackageSymbol package,
        HashSet<string> seenNames)
    {
        // ADR-0051: bind interface property declarations.
        if (!syntax.Properties.IsDefaultOrEmpty)
        {
            var propertiesBuilder = ImmutableArray.CreateBuilder<PropertySymbol>();
            foreach (var propSyntax in syntax.Properties)
            {
                // ADR-0149 (issue #944 follow-up): an interface indexer
                // (`prop this[i int32] T`) is bound exactly like a
                // struct/class indexer (ADR-0118) — CLR name "Item", carrying
                // an index-parameter list — instead of being rejected. This
                // lets an interface both declare an ordinary indexer
                // contract of its own AND be the target of an explicit-
                // interface indexer implementation
                // (`prop (IFoo) this[...] T`).
                var isIndexer = propSyntax.IsIndexer;
                var indexerParameters = ImmutableArray<ParameterSymbol>.Empty;
                if (isIndexer)
                {
                    if (propSyntax.Parameters.Count == 0)
                    {
                        Diagnostics.ReportIndexerRequiresParameter(propSyntax.ThisKeyword.Location);
                        continue;
                    }

                    var indexerParamBuilder = ImmutableArray.CreateBuilder<ParameterSymbol>();
                    var seenIndexParamNames = new HashSet<string>();
                    foreach (var indexParamSyntax in propSyntax.Parameters)
                    {
                        var indexParamName = indexParamSyntax.Identifier.Text;
                        var indexParamType = bindTypeClause(indexParamSyntax.Type) ?? TypeSymbol.Error;
                        if (!seenIndexParamNames.Add(indexParamName))
                        {
                            Diagnostics.ReportParameterAlreadyDeclared(indexParamSyntax.Location, indexParamName);
                        }

                        var indexerParam = new ParameterSymbol(indexParamName, indexParamType, declaringSyntax: indexParamSyntax.Identifier);

                        // Issue #1913: indexer parameters can carry `@Attr`
                        // annotations same as any other parameter list.
                        BindAndAttachParameterAttributes(indexParamSyntax, indexerParam);
                        indexerParamBuilder.Add(indexerParam);
                    }

                    indexerParameters = indexerParamBuilder.ToImmutable();
                }

                var propName = isIndexer ? "Item" : propSyntax.Identifier.Text;
                if (!seenNames.Add(propName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName);
                    continue;
                }

                var propType = bindTypeClause(propSyntax.Type);
                if (propType == null)
                {
                    continue;
                }

                bool hasGetter = true;
                bool hasSetter = false;
                bool isInitOnly = false;

                if (propSyntax.OpenBraceToken != null)
                {
                    hasGetter = propSyntax.Accessors.Any(a => a.IsGetter);
                    var hasSet = propSyntax.Accessors.Any(a => a.IsSetter);
                    var hasInit = propSyntax.Accessors.Any(a => a.IsInit);

                    // Issue #946: a property may declare a `set` or an `init`
                    // accessor, but not both.
                    if (hasSet && hasInit)
                    {
                        var initAccessor = propSyntax.Accessors.First(a => a.IsInit);
                        Diagnostics.ReportPropertyHasBothSetAndInit(initAccessor.AccessorKeyword.Location, propName);
                    }

                    hasSetter = hasSet || hasInit;
                    isInitOnly = !hasSet && hasInit;
                    if (!hasGetter && !hasSetter)
                    {
                        hasGetter = true;
                        hasSetter = true;
                    }
                }
                else
                {
                    // Bare: prop Name Type in interface = get + set
                    hasSetter = true;
                }

                var isStaticInterfaceProperty = propSyntax.HasStaticModifier;

                var propSymbol = new PropertySymbol(
                    propName,
                    propType,
                    Accessibility.Public,
                    hasGetter,
                    hasSetter,
                    isAutoProperty: false,
                    isVirtual: false,
                    isOverride: false,
                    isStatic: isStaticInterfaceProperty,
                    declaration: propSyntax,
                    isInitOnly: isInitOnly)
                {
                    IsIndexer = isIndexer,
                    Parameters = indexerParameters,
                };

                // ADR-0089 / issue #1019: a static-virtual interface property is
                // modelled as get/set accessor *methods* that are static-virtual
                // slots (IsStatic + StaticOwnerType = the interface), reusing the
                // static-virtual method machinery for emit, MethodImpl pairing,
                // and `T.Prop` constrained dispatch. A bodied accessor is a
                // *default* static slot; a body-less accessor is an *abstract*
                // slot the implementer must provide.
                //
                // Issue #2293: an ordinary (non-static) instance interface
                // property is given the exact same accessor-symbol treatment —
                // mirroring how default-interface *methods* already work
                // (ADR-0085 / issue #726). A bodied accessor (arrow `->` or
                // block) is a default instance slot (non-abstract, dispatched
                // through the interface, no override required from
                // implementers); a body-less accessor is still an abstract
                // slot the implementer must provide. Only the receiver type
                // (`null` + Static for the static-virtual case vs. the owning
                // InterfaceSymbol for the instance case) and the Static flag
                // differ between the two.
                {
                    var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetterOrInit);
                    TypeSymbol accessorReceiverType = isStaticInterfaceProperty ? null : interfaceSymbol;

                    if (hasGetter)
                    {
                        var getterSymbol = new FunctionSymbol(
                            $"get_{propName}",
                            isIndexer ? indexerParameters : ImmutableArray<ParameterSymbol>.Empty,
                            propType,
                            declaration: null,
                            package,
                            Accessibility.Public,
                            receiverType: accessorReceiverType);
                        if (isStaticInterfaceProperty)
                        {
                            getterSymbol.IsStatic = true;
                            getterSymbol.StaticOwnerType = interfaceSymbol;
                        }

                        getterSymbol.IsSpecialName = true;
                        if (getAccessor?.Body != null)
                        {
                            // Issue #1030 / #2293: a default-bodied interface
                            // property accessor (static-virtual or instance)
                            // is a non-abstract Virtual slot emitting a real
                            // method body. The body is bound in the Binder's
                            // interface accessor-body pass and registered in
                            // functionBodies keyed by this getter symbol.
                            getterSymbol.IsAbstract = false;
                            propSymbol.GetterBodySyntax = getAccessor.Body;
                        }
                        else
                        {
                            getterSymbol.IsAbstract = true;
                        }

                        propSymbol.GetterSymbol = getterSymbol;
                    }

                    if (hasSetter)
                    {
                        var setterParam = new ParameterSymbol("value", propType);
                        var setterParameters = isIndexer
                            ? indexerParameters.Add(setterParam)
                            : ImmutableArray.Create(setterParam);
                        var setterSymbol = new FunctionSymbol(
                            $"set_{propName}",
                            setterParameters,
                            TypeSymbol.Void,
                            declaration: null,
                            package,
                            Accessibility.Public,
                            receiverType: accessorReceiverType);
                        if (isStaticInterfaceProperty)
                        {
                            setterSymbol.IsStatic = true;
                            setterSymbol.StaticOwnerType = interfaceSymbol;
                        }

                        setterSymbol.IsSpecialName = true;
                        setterSymbol.IsInitOnlySetter = isInitOnly;
                        if (setAccessor?.Body != null)
                        {
                            // Issue #1030 / #2293: default-bodied interface
                            // property setter — a non-abstract default slot
                            // with a real method body.
                            setterSymbol.IsAbstract = false;
                            propSymbol.SetterBodySyntax = setAccessor.Body;
                        }
                        else
                        {
                            setterSymbol.IsAbstract = true;
                        }

                        propSymbol.SetterSymbol = setterSymbol;
                    }
                }

                Binder.AttachDocumentation(propSymbol, propSyntax);

                // Issue #2129: bind @annotations on an interface property so
                // they emit as real CustomAttribute rows on the interface
                // PropertyDef, mirroring the class-property path.
                if (!propSyntax.Annotations.IsDefaultOrEmpty)
                {
                    propSymbol.SetAttributes(BindAttributes(
                        propSyntax.Annotations,
                        AttributeTargetKind.Property,
                        Binder.PropertyDeclarationAllowedTargets,
                        "a property declaration",
                        System.AttributeTargets.Property));
                }

                propertiesBuilder.Add(propSymbol);
            }

            interfaceSymbol.SetProperties(propertiesBuilder.ToImmutable());
        }
    }

    private void BindInterfaceEvents(
        InterfaceDeclarationSyntax syntax,
        InterfaceSymbol interfaceSymbol,
        PackageSymbol package,
        HashSet<string> seenNames)
    {
        // ADR-0052: bind interface event declarations.
        if (!syntax.Events.IsDefaultOrEmpty)
        {
            var eventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>();
            foreach (var eventSyntax in syntax.Events)
            {
                var eventName = eventSyntax.Identifier.Text;
                if (!seenNames.Add(eventName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName);
                    continue;
                }

                var handlerType = bindTypeClause(eventSyntax.Type);
                if (handlerType == null)
                {
                    continue;
                }

                handlerType = MemberLookup.CanonicalizeWellKnownEventHandler(handlerType);

                var eventSymbol = new EventSymbol(
                    eventName,
                    handlerType,
                    Accessibility.Public,
                    isFieldLike: false,
                    isVirtual: false,
                    isOverride: false,
                    declaration: eventSyntax);

                // ADR-0149: an abstract interface event still needs its own
                // add/remove FunctionSymbol slots — mirroring the getter/
                // setter symbols created for interface properties immediately
                // above — so PlanInterfaceMethods has something to register a
                // MethodDef row against, giving EmitExplicitInterfaceEventMethodImpls
                // a token to target. Interface events do not yet support a
                // default (bodied) accessor, so both are always abstract.
                var addMethodSymbol = new FunctionSymbol(
                    $"add_{eventName}",
                    ImmutableArray.Create(new ParameterSymbol("value", handlerType)),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    Accessibility.Public,
                    receiverType: interfaceSymbol) { IsSpecialName = true, IsAbstract = true };
                var removeMethodSymbol = new FunctionSymbol(
                    $"remove_{eventName}",
                    ImmutableArray.Create(new ParameterSymbol("value", handlerType)),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    Accessibility.Public,
                    receiverType: interfaceSymbol) { IsSpecialName = true, IsAbstract = true };
                eventSymbol.AddMethodSymbol = addMethodSymbol;
                eventSymbol.RemoveMethodSymbol = removeMethodSymbol;

                Binder.AttachDocumentation(eventSymbol, eventSyntax);

                // Issue #2129: bind @annotations on an interface event so they
                // emit as CustomAttribute rows on the interface EventDef,
                // mirroring the class-event path.
                if (!eventSyntax.Annotations.IsDefaultOrEmpty)
                {
                    eventSymbol.SetAttributes(BindAttributes(
                        eventSyntax.Annotations,
                        AttributeTargetKind.Event,
                        Binder.EventDeclarationAllowedTargets,
                        "an event declaration",
                        System.AttributeTargets.Event));
                }

                eventsBuilder.Add(eventSymbol);
            }

            interfaceSymbol.SetEvents(eventsBuilder.ToImmutable());
        }
    }

    private void BindInterfaceStaticFields(
        InterfaceDeclarationSyntax syntax,
        InterfaceSymbol interfaceSymbol,
        HashSet<string> seenNames)
    {
        // ADR-0089 / issue #1030: bind interface static *state* — `var` / `let`
        // / `const` fields declared inside the interface `shared { … }` block.
        // CLR interfaces may own static fields; these become `Static` FieldDef
        // rows on the interface TypeDef (const → `literal` + `Constant` row).
        if (!syntax.StaticFields.IsDefaultOrEmpty)
        {
            // ADR-0089 / issue #1030: interface static state is supported on
            // both non-generic and generic interfaces. For a generic interface
            // the FieldDef rows live on the interface TypeDef and access sites
            // reference them through a TypeSpec for the closed construction, so
            // each construction (`IBox[int32]` vs `IBox[string]`) owns
            // independent storage — matching CLR static-field semantics.
            {
                var staticFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
                var constFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
                var initializersBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
                foreach (var fieldSyntax in syntax.StaticFields)
                {
                    var fieldName = fieldSyntax.Identifier.Text;
                    if (!seenNames.Add(fieldName))
                    {
                        Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName);
                        continue;
                    }

                    var fieldType = bindTypeClause(fieldSyntax.Type);
                    if (fieldType == null)
                    {
                        continue;
                    }

                    if (TypeSymbol.IsByRefLike(fieldType))
                    {
                        Diagnostics.ReportByRefLikeEscape(fieldSyntax.Identifier.Location, fieldType, $"be used as the type of field '{fieldName}'");
                        continue;
                    }

                    if (fieldType is ByRefTypeSymbol byRefFieldType)
                    {
                        Diagnostics.ReportPointerTypeCannotBeFieldType(fieldSyntax.Identifier.Location, byRefFieldType.Name);
                        continue;
                    }

                    var fieldAccessibility = resolveAccessibility(fieldSyntax.AccessibilityModifier);

                    // const → compile-time literal field (reads inlined).
                    if (fieldSyntax.IsConst)
                    {
                        var constField = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: true, isStatic: true, isConst: true);
                        Binder.AttachDocumentation(constField, fieldSyntax);

                        if (fieldSyntax.Initializer == null)
                        {
                            Diagnostics.ReportConstFieldRequiresInitializer(fieldSyntax.Identifier.Location, fieldName);
                        }
                        else
                        {
                            var boundConst = bindExpression(fieldSyntax.Initializer);
                            var convertedConst = conversions.BindConversion(fieldSyntax.Initializer.Location, boundConst, fieldType);
                            if (TryFoldConstantFieldValue(convertedConst, fieldType, out var constValue))
                            {
                                constField.SetConstantValue(constValue);
                            }
                            else if (boundConst is not BoundErrorExpression && convertedConst is not BoundErrorExpression)
                            {
                                Diagnostics.ReportConstFieldInitializerNotConstant(fieldSyntax.Initializer.Location, fieldName);
                            }
                        }

                        constFieldsBuilder.Add(constField);
                        continue;
                    }

                    var fieldSymbol = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: fieldSyntax.IsReadOnly, isStatic: true);
                    Binder.AttachDocumentation(fieldSymbol, fieldSyntax);

                    if (fieldSyntax.Initializer != null)
                    {
                        var boundInit = bindExpression(fieldSyntax.Initializer);
                        var convertedInit = conversions.BindConversion(fieldSyntax.Initializer.Location, boundInit, fieldType);
                        initializersBuilder[fieldSymbol] = convertedInit;
                    }

                    staticFieldsBuilder.Add(fieldSymbol);
                }

                interfaceSymbol.SetStaticFields(staticFieldsBuilder.ToImmutable());
                if (constFieldsBuilder.Count > 0)
                {
                    interfaceSymbol.SetConstFields(constFieldsBuilder.ToImmutable());
                }

                if (initializersBuilder.Count > 0)
                {
                    interfaceSymbol.SetStaticFieldInitializers(initializersBuilder.ToImmutable());
                }
            }
        }
    }

    private void VerifyInterfaceMemberVariance(InterfaceDeclarationSyntax syntax, InterfaceSymbol interfaceSymbol)
    {
        // Phase 4.3c / ADR-0021: variance position checking. Walk each method's
        // parameter types (contravariant position) and return type (covariant
        // position). An `out T` may only appear in covariant position; an
        // `in T` may only appear in contravariant position. ADR-0089: walk
        // both instance and static-virtual method buckets — variance applies
        // to both because the type parameter still flows through the
        // signature when the interface is constructed. ADR-0090: walk private
        // helper buckets too — variance rules apply regardless of accessibility.
        if (!interfaceSymbol.TypeParameters.IsDefaultOrEmpty)
        {
            var instanceIdx = 0;
            var staticIdx = 0;
            var privateInstanceIdx = 0;
            var privateStaticIdx = 0;
            foreach (var methodSyntax in syntax.Methods)
            {
                var isPrivate = methodSyntax.AccessibilityModifier != null
                    && string.Equals(methodSyntax.AccessibilityModifier.Text, "private", System.StringComparison.Ordinal);
                FunctionSymbol m;
                if (methodSyntax.HasStaticModifier)
                {
                    if (isPrivate)
                    {
                        if (privateStaticIdx >= interfaceSymbol.StaticPrivateMethods.Length)
                        {
                            continue;
                        }

                        m = interfaceSymbol.StaticPrivateMethods[privateStaticIdx++];
                    }
                    else
                    {
                        if (staticIdx >= interfaceSymbol.StaticMethods.Length)
                        {
                            continue;
                        }

                        m = interfaceSymbol.StaticMethods[staticIdx++];
                    }
                }
                else
                {
                    if (isPrivate)
                    {
                        if (privateInstanceIdx >= interfaceSymbol.PrivateMethods.Length)
                        {
                            continue;
                        }

                        m = interfaceSymbol.PrivateMethods[privateInstanceIdx++];
                    }
                    else
                    {
                        if (instanceIdx >= interfaceSymbol.Methods.Length)
                        {
                            continue;
                        }

                        m = interfaceSymbol.Methods[instanceIdx++];
                    }
                }

                CheckVariancePosition(m.Type, isOutput: true, methodSyntax.Type?.Location ?? methodSyntax.Identifier.Location);
                for (var p = 0; p < m.Parameters.Length; p++)
                {
                    var paramSyntax = methodSyntax.Parameters[p];
                    CheckVariancePosition(m.Parameters[p].Type, isOutput: false, paramSyntax.Type?.Location ?? paramSyntax.Location);
                }
            }
        }
    }

    private void CheckVariancePosition(TypeSymbol type, bool isOutput, TextLocation location)
    {
        if (type is TypeParameterSymbol tp)
        {
            if (tp.Variance == TypeParameterVariance.Out && !isOutput)
            {
                Diagnostics.ReportTypeParameterVariancePositionViolation(location, tp.Name, "out", "input");
            }
            else if (tp.Variance == TypeParameterVariance.In && isOutput)
            {
                Diagnostics.ReportTypeParameterVariancePositionViolation(location, tp.Name, "in", "output");
            }

            return;
        }

        if (type is SliceTypeSymbol s)
        {
            CheckVariancePosition(s.ElementType, isOutput, location);
            return;
        }

        if (type is ArrayTypeSymbol a)
        {
            CheckVariancePosition(a.ElementType, isOutput, location);
            return;
        }

        if (type is NullableTypeSymbol n)
        {
            CheckVariancePosition(n.UnderlyingType, isOutput, location);
            return;
        }
    }

    // Issue #1913: member-declared functions (instance/shared methods on a
    // struct/class, interface method declarations, constructors) each parse
    // their own per-parameter annotation list but — unlike free/package-level
    // functions (see the dedicated loop in BindFunctionDeclaration below) —
    // never bound or attached it to the resulting ParameterSymbol, so the
    // attribute silently never reached the emitter. Shared here so every
    // parameter-binding call site gets the same `@Attr` → ParameterSymbol
    // wiring the emitter already expects (AttributeTargetKind.Param).
    private void BindAndAttachParameterAttributes(ParameterSyntax parameterSyntax, ParameterSymbol parameterSymbol)
    {
        if (parameterSyntax.Annotations.IsDefaultOrEmpty)
        {
            return;
        }

        var paramAttrs = BindAttributes(
            parameterSyntax.Annotations,
            AttributeTargetKind.Param,
            Binder.ParameterAllowedTargets,
            "a parameter declaration",
            System.AttributeTargets.Parameter);

        if (!paramAttrs.IsDefaultOrEmpty)
        {
            parameterSymbol.SetAttributes(paramAttrs);
        }
    }
}
