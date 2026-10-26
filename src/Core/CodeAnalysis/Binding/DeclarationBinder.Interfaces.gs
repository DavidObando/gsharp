// <copyright file="DeclarationBinder.Interfaces.cs" company="GSharp">
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
import System.Linq
import System.Reflection

internal partial class DeclarationBinder {
    internal func DeclareInterfaceSymbol(
        syntax InterfaceDeclarationSyntax,
        $package PackageSymbol,
        containingType TypeSymbol? = nil
    ) InterfaceSymbol? {
        let name = syntax.Identifier.ValueText
        let accessibility = resolveAccessibility(syntax.AccessibilityModifier)
        let interfaceSymbol = InterfaceSymbol(name, accessibility, syntax, $package.Name)
        Binder.AttachDocumentation(interfaceSymbol, syntax)
        // Issue #1080: set the enclosing type BEFORE registering the name so the
        // scope can scope name-uniqueness to the enclosing type.
        if containingType != nil {
            interfaceSymbol.SetContainingType(containingType)
        }
        interfaceSymbol.SetAttributes(
            BindAttributes(
                syntax.Annotations,
                AttributeTargetKind.Type,
                Binder.TypeDeclarationAllowedTargets,
                "an interface declaration",
                AttributeTargets.Interface
            )
        )
        // Issue #2519: publish bare type parameters with the interface shell
        // and resolve their constraints only when members are bound, after all
        // same-compilation aggregate shells exist. This is the interface
        // counterpart of the aggregate-shell lifecycle and preserves CRTP
        // because the interface's own shell is visible by then.
        let typeParameters = CreateTypeParameterSymbols(syntax.TypeParameterList)
        if !typeParameters.IsDefaultOrEmpty {
            interfaceSymbol.SetTypeParameters(typeParameters)
        }
        if !$scope.TryDeclareTypeAlias(name, interfaceSymbol) {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name)
            return nil
        }
        return interfaceSymbol
    }

    private func BindInterfaceDeclaration(syntax InterfaceDeclarationSyntax, $package PackageSymbol) {
        let declared InterfaceSymbol? = DeclareInterfaceSymbol(syntax, $package)
        if declared != nil {
            BindInterfaceMembers(syntax, declared, $package)
        }
    }

    internal func BindInterfaceMembers(
        syntax InterfaceDeclarationSyntax,
        interfaceSymbol InterfaceSymbol,
        $package PackageSymbol
    ) {
        if syntax.IsProtocol {
            if interfaceSymbol.ContainingType != nil ||
                syntax.TypeParameterList != nil ||
                syntax.HasBaseInterfaces ||
                !syntax
                .Properties
                .IsDefaultOrEmpty ||
                !syntax
                .Events
                .IsDefaultOrEmpty ||
                !syntax
                .StaticFields
                .IsDefaultOrEmpty {
                Diagnostics.ReportNativeProtocol(
                    syntax.Identifier.Location,
                    "only nongeneric protocols with synchronous by-value method slots are supported"
                )
            }
            for method in syntax.Methods {
                if method.TypeParameterList != nil ||
                    method.Body != nil ||
                    method.HasStaticModifier ||
                    method.AccessibilityModifier != nil ||
                    method.IsAsync ||
                    method.ReturnRefModifier != nil ||
                    method
                    .Parameters
                    .Any((parameter ParameterSyntax) -> parameter.RefKindModifier != nil) {
                    Diagnostics.ReportNativeProtocol(
                        method.Identifier.Location,
                        "protocol slots must be public synchronous nongeneric by-value signatures without bodies"
                    )
                }
            }
        }
        // Phase 4.3c: push the interface's type parameters so that method
        // signatures can reference them.
        let previousTypeParameters = binderCtx.CurrentTypeParameters
        if !interfaceSymbol.TypeParameters.IsDefaultOrEmpty {
            this.binderCtx.CurrentTypeParameters = Dictionary[string, TypeParameterSymbol]()
            for tp in interfaceSymbol.TypeParameters {
                binderCtx.CurrentTypeParameters!![tp.Name] = tp
            }
        }
        try {
            ResolvePartialTypeParameterConstraints(
                syntax.TypeParameterList,
                syntax.PartialTypeParameterLists,
                interfaceSymbol.TypeParameters,
                interfaceSymbol.Name,
                syntax.PartialPartLocations
            )
            BindInterfaceMembersCore(syntax, interfaceSymbol, $package)
            if syntax.IsProtocol {
                for method in interfaceSymbol.Methods {
                    NativeProtocolSafety.ValidateSignature(method, Diagnostics)
                    NativeProtocolSafety.ValidateProtocolSlotType(method.Type, syntax.Location, Diagnostics)
                    for parameter in method.Parameters {
                        NativeProtocolSafety.ValidateProtocolSlotType(parameter.Type, syntax.Location, Diagnostics)
                    }
                }
            }
        } finally {
            this.binderCtx.CurrentTypeParameters = previousTypeParameters
        }
    }

    /// Issue #1006: binds the base-interface clause of an interface declaration
    /// (`interface B : A`). Each entry must resolve to an interface — a
    /// user (cref:InterfaceSymbol) or an imported CLR interface — or a
    /// GS0391 diagnostic fires. Resolved bases are recorded on the
    /// (cref:InterfaceSymbol) so member lookup and emit can surface and
    /// re-emit them.
    private func BindInterfaceBaseInterfaces(syntax InterfaceDeclarationSyntax, interfaceSymbol InterfaceSymbol) {
        if !syntax.HasBaseInterfaces || syntax.BaseTypeClauses.Count == 0 {
            return
        }
        let name = syntax.Identifier.ValueText
        let baseInterfaces = ImmutableArray.CreateBuilder[InterfaceSymbol]()
        let baseClrInterfaces = ImmutableArray.CreateBuilder[TypeSymbol]()
        for var i = 0; i < syntax.BaseTypeClauses.Count; i++ {
            let baseTypeSyntax = syntax.BaseTypeClauses[i]
            let baseName = GetBaseClauseTypeDisplayName(baseTypeSyntax)
            let baseLocation = baseTypeSyntax.Identifier?.Location ?? syntax.Identifier.Location
            let resolved TypeSymbol? = bindTypeClause(baseTypeSyntax)
            if resolved == nil || resolved == TypeSymbol.Error {
                continue
            }
            if NativeProtocolOperations.GetProtocol(resolved) != nil {
                Diagnostics.ReportNativeProtocol(
                    baseLocation,
                    "nominal interface inheritance cannot include a native protocol"
                )
                continue
            }
            if resolved is InterfaceSymbol iface {
                // Issue #1006: reject direct self-inheritance (`interface A : A`).
                if iface == interfaceSymbol || iface.Definition == interfaceSymbol {
                    Diagnostics.ReportInterfaceCannotHaveClassBase(baseLocation, name, baseName)
                    continue
                }
                if iface.IsGenericDefinition {
                    Diagnostics.ReportWrongTypeArgumentCount(baseLocation, baseName, iface.TypeParameters.Length, 0)
                    continue
                }
                baseInterfaces.Add(iface)
                continue
            }
            // An imported CLR interface (e.g. `: System.IDisposable`) is a valid
            // base interface too.
            if resolved.ClrType != nil && resolved.ClrType.IsInterface {
                baseClrInterfaces.Add(resolved)
                continue
            }
            // Anything else (a user class/struct or a CLR class) is illegal —
            // only interfaces may appear in an interface's base list.
            Diagnostics.ReportInterfaceCannotHaveClassBase(baseLocation, name, baseName)
        }
        if baseInterfaces.Count > 0 {
            interfaceSymbol.SetBaseInterfaces(baseInterfaces.ToImmutable())
        }
        if baseClrInterfaces.Count > 0 {
            interfaceSymbol.SetBaseClrInterfaces(baseClrInterfaces.ToImmutable())
        }
    }

    private func BindInterfaceMembersCore(
        syntax InterfaceDeclarationSyntax,
        interfaceSymbol InterfaceSymbol,
        $package PackageSymbol
    ) {
        BindInterfaceBaseInterfaces(syntax, interfaceSymbol)
        let seenNames = HashSet[string]()
        BindInterfaceMethods(syntax, interfaceSymbol, $package, seenNames)
        BindInterfaceProperties(syntax, interfaceSymbol, $package, seenNames)
        BindInterfaceEvents(syntax, interfaceSymbol, $package, seenNames)
        BindInterfaceStaticFields(syntax, interfaceSymbol, seenNames)
        VerifyInterfaceMemberVariance(syntax, interfaceSymbol)
    }

    private func BindInterfaceMethods(
        syntax InterfaceDeclarationSyntax,
        interfaceSymbol InterfaceSymbol,
        $package PackageSymbol,
        seenNames HashSet[string]
    ) {
        let methodsBuilder = ImmutableArray.CreateBuilder[FunctionSymbol]()
        let staticMethodsBuilder = ImmutableArray.CreateBuilder[FunctionSymbol]()
        let privateMethodsBuilder = ImmutableArray.CreateBuilder[FunctionSymbol]()
        let staticPrivateMethodsBuilder = ImmutableArray.CreateBuilder[FunctionSymbol]()
        for methodSyntax in syntax.Methods {
            let methodName = methodSyntax.Identifier.ValueText
            // ADR-0089 / issue #755: detect a `static` modifier early — the
            // method is a static-virtual interface member. Static methods do
            // not receive a `this` parameter, are not added to the dispatch
            // table for instance calls, and live on a separate
            // <c>InterfaceSymbol.StaticMethods</c> bucket. Both abstract and
            // default-bodied forms are accepted; the binder uses the same
            // body-vs-no-body discriminator as ADR-0085 to distinguish them.
            let isStaticInterfaceMethod = methodSyntax.HasStaticModifier
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
            let isPrivateInterfaceMethod = methodSyntax.AccessibilityModifier != nil && string.Equals(
                methodSyntax.AccessibilityModifier.Text,
                "private",
                StringComparison.Ordinal
            )
            // Issue #1007 / ADR-0020: an interface method may declare its own
            // generic type-parameter list (`func M[T](...) T`). Bind it first
            // and seed it into the binding scope — merged with any enclosing
            // interface type parameters — so the method's parameter types and
            // return type (and, for default-bodied methods, the body) can
            // reference `T`. The seeding is unwound at the end of each
            // iteration so one method's type parameters never leak into the
            // next or the surrounding interface, mirroring the class-method
            // path.
            let methodTypeParameters = BindTypeParameterList(methodSyntax.TypeParameterList)
            let enclosingTypeParameters Dictionary[string, TypeParameterSymbol]? = binderCtx.CurrentTypeParameters
            if !methodTypeParameters.IsDefaultOrEmpty {
                this.binderCtx.CurrentTypeParameters = if enclosingTypeParameters == nil {
                    Dictionary[string, TypeParameterSymbol]()
                } else {
                    Dictionary[string, TypeParameterSymbol](enclosingTypeParameters)
                }
                for tp in methodTypeParameters {
                    binderCtx.CurrentTypeParameters!![tp.Name] = tp
                }
            }
            try {
                // ADR-0122 / issue #1036: an `unsafe func` interface method binds its
                // signature (params + return) in an unsafe context too, mirroring the
                // class/struct member path. No-op for a non-`unsafe` method.
                using let sigUnsafeContext = binderCtx.PushUnsafeContext(methodSyntax.IsUnsafe)
                // ADR-0063: overloads are allowed on interfaces; the post-bind signature
                // check below detects duplicate signatures. Name collision with a
                // property/event member of the same name is still rejected (handled later
                // via seenNames when properties/events are added).
                let parameters = ImmutableArray.CreateBuilder[ParameterSymbol]()
                let seenParameterNames = HashSet[string]()
                for parameterSyntax in methodSyntax.Parameters {
                    // ADR-0185: an interface method's parameters never come from
                    // the destructured arrow-lambda path.
                    let parameterName = parameterSyntax.Identifier!!.ValueText
                    var parameterType = if parameterSyntax.Type is {} parameterTypeSyntax {
                        bindTypeClause(parameterTypeSyntax) ?? TypeSymbol.Error
                    } else {
                        TypeSymbol.Error
                    }
                    // ADR-0101 follow-up / issue #812: variadic parameters are now
                    // accepted on interface methods. For abstract members the
                    // variadic flag travels through the dispatch table; for ADR-0085
                    // default-bodied members the body sees the parameter as `[]T`,
                    // and the emitter stamps [ParamArrayAttribute] on the MethodDef
                    // (interface method emit shares the same path as class methods).
                    let isVariadic = parameterSyntax.IsVariadic
                    if isVariadic && parameterType != TypeSymbol.Error {
                        parameterType = VariadicCarriers.ResolveDeclaredParameterType(parameterType)
                    }
                    let parameterRefKind = conversions.BindAndValidateParameterRefKind(
                        parameterSyntax,
                        parameterName,
                        parameterType,
                        isVariadic,
                        asyncOrIteratorKind: if methodSyntax.IsAsync {
                            "async"
                        } else {
                            (
                                if methodSyntax.IsSuspend {
                                    "suspend"
                                } else {
                                    default(string?)
                                }
                            )
                        }
                    )
                    // Issue #1262: `_` is the discard identifier — repeated `_` parameters are
                    // permitted on named functions/methods. Each `_` occupies a positional slot
                    // but is not added to the body scope, so non-`_` duplicates still error.
                    if parameterName != "_" && !seenParameterNames.Add(parameterName) {
                        Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName)
                    } else {
                        let ifaceMethodParam = ParameterSymbol(
                            parameterName,
                            parameterType,
                            isVariadic,
                            declaringSyntax: parameterSyntax.Identifier,
                            isScoped: parameterSyntax.IsScoped,
                            refKind: parameterRefKind
                        )
                        conversions.BindAndAttachParameterDefaultValue(parameterSyntax, ifaceMethodParam)
                        BindAndAttachParameterAttributes(parameterSyntax, ifaceMethodParam)
                        parameters.Add(ifaceMethodParam)
                    }
                }
                ValidateVariadicParameterShape(methodSyntax.Parameters)
                var returnType = bindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void
                let methodIsAsyncVoid = IsExplicitAsyncVoid(methodSyntax, returnType)
                returnType = NormalizeAsyncDeclaredReturnType(
                    returnType,
                    methodSyntax.IsAsync,
                    out var returnTypeIsValueTask
                )
                let methodReturnRefKind = ValidateReturnRefKind(methodSyntax, returnType)
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
                let methodAccessibility = if isPrivateInterfaceMethod {
                    Accessibility.Private
                } else {
                    Accessibility.Public
                }
                let methodSymbol = FunctionSymbol(
                    methodName,
                    parameters.ToImmutable(),
                    returnType,
                    methodSyntax,
                    $package,
                    methodAccessibility,
                    receiverType: if isStaticInterfaceMethod {
                        default(TypeSymbol?)
                    } else {
                        cast[TypeSymbol](interfaceSymbol)
                    }
                )
                methodSymbol.ReturnRefKind = methodReturnRefKind
                // Bodyless interface declarations describe an async-iterator ABI.
                // Default bodies are executable and follow ordinary function
                // classification so an eager delegation body is not discarded.
                methodSymbol.IsAsync = methodSyntax.IsAsync ||
                    (
                    isAsyncIteratorReturnType(returnType) &&
                        (
                        methodSyntax.HasSemicolonBody ||
                            (methodSyntax.Body is {} body && IteratorDetection.ContainsYield(body))
                    )
                )
                methodSymbol.IsAsyncVoid = methodIsAsyncVoid
                methodSymbol.SuspendingKind = if methodSyntax.IsSuspend {
                    SuspendingKind.Declared
                } else {
                    SuspendingKind.None
                }
                methodSymbol.AsyncReturnsValueTask = returnTypeIsValueTask || methodSyntax.IsSuspend
                methodSymbol.IsUnsafe = binderCtx.InUnsafeContext
                methodSymbol.TypeParameters = methodTypeParameters
                if isStaticInterfaceMethod {
                    methodSymbol.IsStatic = true
                    methodSymbol.StaticOwnerType = interfaceSymbol
                }
                Binder.AttachDocumentation(methodSymbol, methodSyntax)
                // Issue #2129: bind @annotations on an interface method signature
                // so they emit as CustomAttribute rows on the interface MethodDef,
                // mirroring the class-method path.
                if !methodSyntax.Annotations.IsDefaultOrEmpty {
                    methodSymbol.SetAttributes(
                        BindAttributes(
                            methodSyntax.Annotations,
                            AttributeTargetKind.Method,
                            Binder.FunctionDeclarationAllowedTargets,
                            "a method declaration",
                            AttributeTargets.Method
                        )
                    )
                    ValidateUnscopedRefPlacement(methodSymbol)
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
                if methodSyntax.OpenModifier != nil {
                    Diagnostics.ReportInterfaceMethodModifierDeferred(
                        methodSyntax.OpenModifier.Location,
                        "open",
                        methodName
                    )
                }
                if methodSyntax.OverrideModifier != nil {
                    Diagnostics.ReportInterfaceMethodModifierDeferred(
                        methodSyntax.OverrideModifier.Location,
                        "override",
                        methodName
                    )
                }
                // ADR-0090 / issue #756: a `private` interface method must
                // carry a body. The helper is part of the interface's own
                // implementation — no implementer can supply it.
                if isPrivateInterfaceMethod && methodSyntax.Body == nil {
                    Diagnostics.ReportPrivateInterfaceMemberRequiresBody(methodSyntax.Identifier.Location, methodName)
                }
                // ADR-0063 §11: detect duplicate-signature overloads on the interface.
                var targetBuilder ImmutableArray[FunctionSymbol].Builder
                if isPrivateInterfaceMethod {
                    targetBuilder = if isStaticInterfaceMethod {
                        staticPrivateMethodsBuilder
                    } else {
                        privateMethodsBuilder
                    }
                } else {
                    targetBuilder = if isStaticInterfaceMethod {
                        staticMethodsBuilder
                    } else {
                        methodsBuilder
                    }
                }
                var hasDupSig = false
                for existingMethod in targetBuilder {
                    if BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol) {
                        Diagnostics.ReportDuplicateOverloadSignature(
                            methodSyntax.Identifier.Location,
                            methodName,
                            Binder.FormatOverloadSignature(methodSymbol)
                        )
                        hasDupSig = true
                        break
                    }
                }
                if !hasDupSig {
                    seenNames.Add(methodName)
                    targetBuilder.Add(methodSymbol)
                }
            } finally {
                this.binderCtx.CurrentTypeParameters = enclosingTypeParameters
            }
        }
        interfaceSymbol.SetMethods(methodsBuilder.ToImmutable())
        interfaceSymbol.SetStaticMethods(staticMethodsBuilder.ToImmutable())
        interfaceSymbol.SetPrivateMethods(privateMethodsBuilder.ToImmutable())
        interfaceSymbol.SetStaticPrivateMethods(staticPrivateMethodsBuilder.ToImmutable())
    }

    private func BindInterfaceProperties(
        syntax InterfaceDeclarationSyntax,
        interfaceSymbol InterfaceSymbol,
        $package PackageSymbol,
        seenNames HashSet[string]
    ) {
        // ADR-0051: bind interface property declarations.
        if !syntax.Properties.IsDefaultOrEmpty {
            let propertiesBuilder = ImmutableArray.CreateBuilder[PropertySymbol]()
            // ADR-0187 / issue #4350: interface indexers overload by
            // index-parameter signature, like struct and class indexers.
            let declaredIndexerSignatures = List[ImmutableArray[ParameterSymbol]]()
            for propSyntax in syntax.Properties {
                // ADR-0149 (issue #944 follow-up): an interface indexer
                // (`prop this[i int32] T`) is bound exactly like a
                // struct/class indexer (ADR-0118) — CLR name "Item", carrying
                // an index-parameter list — instead of being rejected. This
                // lets an interface both declare an ordinary indexer
                // contract of its own AND be the target of an explicit-
                // interface indexer implementation
                // (`prop (IFoo) this[...] T`).
                let isIndexer = propSyntax.IsIndexer
                var indexerParameters = ImmutableArray[ParameterSymbol].Empty
                if isIndexer {
                    if propSyntax.Parameters.Count == 0 {
                        Diagnostics.ReportIndexerRequiresParameter(
                            propSyntax.ThisKeyword?.Location ?? propSyntax.Identifier.Location
                        )
                        continue
                    }
                    let indexerParamBuilder = ImmutableArray.CreateBuilder[ParameterSymbol]()
                    let seenIndexParamNames = HashSet[string]()
                    for indexParamSyntax in propSyntax.Parameters {
                        // ADR-0185: an indexer's parameters never come from
                        // the destructured arrow-lambda path.
                        let indexParamName = indexParamSyntax.Identifier!!.ValueText
                        let indexParamType = if indexParamSyntax.Type is {} indexParamTypeSyntax {
                            bindTypeClause(indexParamTypeSyntax) ?? TypeSymbol.Error
                        } else {
                            TypeSymbol.Error
                        }
                        if !seenIndexParamNames.Add(indexParamName) {
                            Diagnostics.ReportParameterAlreadyDeclared(indexParamSyntax.Location, indexParamName)
                        }
                        let indexerParam = ParameterSymbol(
                            indexParamName,
                            indexParamType,
                            declaringSyntax: indexParamSyntax.Identifier
                        )
                        // Issue #1913: indexer parameters can carry `@Attr`
                        // annotations same as any other parameter list.
                        BindAndAttachParameterAttributes(indexParamSyntax, indexerParam)
                        conversions.BindAndAttachParameterDefaultValue(indexParamSyntax, indexerParam)
                        indexerParamBuilder.Add(indexerParam)
                    }
                    indexerParameters = indexerParamBuilder.ToImmutable()
                }
                let propName = if isIndexer {
                    "Item"
                } else {
                    propSyntax.Identifier.ValueText
                }
                let isIndexerOverload = isIndexer &&
                    declaredIndexerSignatures.Count > 0 &&
                    !declaredIndexerSignatures
                    .Any(
                    (declared ImmutableArray[ParameterSymbol]) -> HaveSameIndexerSignature(declared, indexerParameters)
                )
                if !seenNames.Add(propName) && !isIndexerOverload {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName)
                    continue
                }
                if isIndexer {
                    declaredIndexerSignatures.Add(indexerParameters)
                }
                let propType TypeSymbol? = if propSyntax.Type is {} propTypeSyntax {
                    bindTypeClause(propTypeSyntax)
                } else {
                    default(TypeSymbol?)
                }
                if propType == nil {
                    continue
                }
                var hasGetter = true
                var hasSetter = false
                var isInitOnly = false
                if propSyntax.OpenBraceToken != nil {
                    hasGetter = propSyntax.Accessors.Any((a PropertyAccessorSyntax) -> a.IsGetter)
                    let hasSet = propSyntax.Accessors.Any((a PropertyAccessorSyntax) -> a.IsSetter)
                    let hasInit = propSyntax.Accessors.Any((a PropertyAccessorSyntax) -> a.IsInit)
                    // Issue #946: a property may declare a `set` or an `init`
                    // accessor, but not both.
                    if hasSet && hasInit {
                        let initAccessor = propSyntax.Accessors.First((a PropertyAccessorSyntax) -> a.IsInit)
                        Diagnostics.ReportPropertyHasBothSetAndInit(initAccessor.AccessorKeyword.Location, propName)
                    }
                    hasSetter = hasSet || hasInit
                    isInitOnly = !hasSet && hasInit
                    if !hasGetter && !hasSetter {
                        hasGetter = true
                        hasSetter = true
                    }
                } else {
                    // Bare: prop Name Type in interface = get + set
                    hasSetter = true
                }
                // Issue #3879 (ADR-0060 amendment): a `ref`-returning property or
                // indexer is a CONCRETE-member form only. An interface member is
                // a slot, not storage — the requirement `prop P ref int32 { get }`
                // names nothing to alias, and G# has no ref-kind matching for
                // property slots the way GS0255 has one for method slots, so an
                // implementor could satisfy a `ref` requirement with a
                // copy-returning property and nothing would catch it. A DEFAULT
                // (bodied) interface accessor is rejected on the same grounds:
                // an override of it would be unchecked. Reported here rather
                // than silently dropped, because the silent drop is exactly the
                // copy-returning behaviour change #3839 called out.
                if propSyntax.IsRefReturn {
                    Diagnostics.ReportRefPropertyRequiresComputedGetter(
                        propSyntax.ReturnRefModifier?.Location ?? propSyntax.Identifier.Location,
                        propName
                    )
                }
                let isStaticInterfaceProperty = propSyntax.HasStaticModifier
                if isStaticInterfaceProperty && isInitOnly {
                    let initAccessor = propSyntax.Accessors.First((a PropertyAccessorSyntax) -> a.IsInit)
                    Diagnostics.ReportInitAccessorOnStaticProperty(initAccessor.AccessorKeyword.Location, propName)
                }
                let propSymbol = PropertySymbol(
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
                    isInitOnly: isInitOnly
                ){IsIndexer = isIndexer, Parameters = indexerParameters}
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
                    let getAccessor = propSyntax.Accessors.FirstOrDefault((a PropertyAccessorSyntax) -> a.IsGetter)
                    let setAccessor = propSyntax.Accessors.FirstOrDefault(
                        (a PropertyAccessorSyntax) -> a.IsSetterOrInit
                    )
                    let accessorReceiverType TypeSymbol? = if isStaticInterfaceProperty {
                        default(InterfaceSymbol?)
                    } else {
                        interfaceSymbol
                    }
                    if hasGetter {
                        let getterSymbol = FunctionSymbol(
                            "get_$propName",
                            if isIndexer {
                                indexerParameters
                            } else {
                                ImmutableArray[ParameterSymbol].Empty
                            },
                            propType,
                            declaration: nil,
                            $package,
                            Accessibility.Public,
                            receiverType: accessorReceiverType
                        )
                        if isStaticInterfaceProperty {
                            getterSymbol.IsStatic = true
                            getterSymbol.StaticOwnerType = interfaceSymbol
                        }
                        getterSymbol.IsSpecialName = true
                        getterSymbol.IsUnsafe = binderCtx.InUnsafeContext
                        if getAccessor?.Body != nil {
                            // Issue #1030 / #2293: a default-bodied interface
                            // property accessor (static-virtual or instance)
                            // is a non-abstract Virtual slot emitting a real
                            // method body. The body is bound in the Binder's
                            // interface accessor-body pass and registered in
                            // functionBodies keyed by this getter symbol.
                            getterSymbol.IsAbstract = false
                            propSymbol.GetterBodySyntax = getAccessor.Body
                        } else {
                            getterSymbol.IsAbstract = true
                        }
                        propSymbol.GetterSymbol = getterSymbol
                    }
                    if hasSetter {
                        let setterParam = ParameterSymbol("value", propType)
                        let setterParameters = if isIndexer {
                            indexerParameters.Add(setterParam)
                        } else {
                            ImmutableArray.Create(setterParam)
                        }
                        let setterSymbol = FunctionSymbol(
                            "set_$propName",
                            setterParameters,
                            TypeSymbol.Void,
                            declaration: nil,
                            $package,
                            Accessibility.Public,
                            receiverType: accessorReceiverType
                        )
                        if isStaticInterfaceProperty {
                            setterSymbol.IsStatic = true
                            setterSymbol.StaticOwnerType = interfaceSymbol
                        }
                        setterSymbol.IsSpecialName = true
                        setterSymbol.IsUnsafe = binderCtx.InUnsafeContext
                        setterSymbol.IsInitOnlySetter = isInitOnly
                        if setAccessor?.Body != nil {
                            // Issue #1030 / #2293: default-bodied interface
                            // property setter — a non-abstract default slot
                            // with a real method body.
                            setterSymbol.IsAbstract = false
                            propSymbol.SetterBodySyntax = setAccessor.Body
                        } else {
                            setterSymbol.IsAbstract = true
                        }
                        propSymbol.SetterSymbol = setterSymbol
                    }
                }
                Binder.AttachDocumentation(propSymbol, propSyntax)
                // Issue #2129: bind @annotations on an interface property so
                // they emit as real CustomAttribute rows on the interface
                // PropertyDef, mirroring the class-property path.
                if !propSyntax.Annotations.IsDefaultOrEmpty {
                    propSymbol.SetAttributes(
                        BindAttributes(
                            propSyntax.Annotations,
                            AttributeTargetKind.Property,
                            Binder.PropertyDeclarationAllowedTargets,
                            "a property declaration",
                            AttributeTargets.Property
                        )
                    )
                    ValidateUnscopedRefPlacement(propSymbol, interfaceSymbol)
                }
                propertiesBuilder.Add(propSymbol)
            }
            interfaceSymbol.SetProperties(propertiesBuilder.ToImmutable())
        }
    }

    private func BindInterfaceEvents(
        syntax InterfaceDeclarationSyntax,
        interfaceSymbol InterfaceSymbol,
        $package PackageSymbol,
        seenNames HashSet[string]
    ) {
        // ADR-0052: bind interface event declarations.
        if !syntax.Events.IsDefaultOrEmpty {
            let eventsBuilder = ImmutableArray.CreateBuilder[EventSymbol]()
            for eventSyntax in syntax.Events {
                let eventName = eventSyntax.Identifier.ValueText
                if !seenNames.Add(eventName) {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName)
                    continue
                }
                var handlerType TypeSymbol? = if eventSyntax.Type is {} eventTypeSyntax {
                    bindTypeClause(eventTypeSyntax)
                } else {
                    default(TypeSymbol?)
                }
                if handlerType == nil {
                    continue
                }
                handlerType = MemberLookup.CanonicalizeWellKnownEventHandler(handlerType)
                let eventSymbol = EventSymbol(
                    eventName,
                    handlerType,
                    Accessibility.Public,
                    isFieldLike: false,
                    isVirtual: false,
                    isOverride: false,
                    declaration: eventSyntax
                )
                // ADR-0149: an abstract interface event still needs its own
                // add/remove FunctionSymbol slots — mirroring the getter/
                // setter symbols created for interface properties immediately
                // above — so PlanInterfaceMethods has something to register a
                // MethodDef row against, giving EmitExplicitInterfaceEventMethodImpls
                // a token to target. Interface events do not yet support a
                // default (bodied) accessor, so both are always abstract.
                let addMethodSymbol = FunctionSymbol(
                    "add_$eventName",
                    ImmutableArray.Create(ParameterSymbol("value", handlerType)),
                    TypeSymbol.Void,
                    declaration: nil,
                    $package,
                    Accessibility.Public,
                    receiverType: interfaceSymbol
                ){IsSpecialName = true, IsAbstract = true, IsUnsafe = binderCtx.InUnsafeContext}
                let removeMethodSymbol = FunctionSymbol(
                    "remove_$eventName",
                    ImmutableArray.Create(ParameterSymbol("value", handlerType)),
                    TypeSymbol.Void,
                    declaration: nil,
                    $package,
                    Accessibility.Public,
                    receiverType: interfaceSymbol
                ){IsSpecialName = true, IsAbstract = true, IsUnsafe = binderCtx.InUnsafeContext}
                eventSymbol.AddMethodSymbol = addMethodSymbol
                eventSymbol.RemoveMethodSymbol = removeMethodSymbol
                Binder.AttachDocumentation(eventSymbol, eventSyntax)
                // Issue #2129: bind @annotations on an interface event so they
                // emit as CustomAttribute rows on the interface EventDef,
                // mirroring the class-event path.
                if !eventSyntax.Annotations.IsDefaultOrEmpty {
                    eventSymbol.SetAttributes(
                        BindAttributes(
                            eventSyntax.Annotations,
                            AttributeTargetKind.Event,
                            Binder.EventDeclarationAllowedTargets,
                            "an event declaration",
                            AttributeTargets.Event
                        )
                    )
                }
                eventsBuilder.Add(eventSymbol)
            }
            interfaceSymbol.SetEvents(eventsBuilder.ToImmutable())
        }
    }

    private func BindInterfaceStaticFields(
        syntax InterfaceDeclarationSyntax,
        interfaceSymbol InterfaceSymbol,
        seenNames HashSet[string]
    ) {
        // ADR-0089 / issue #1030: bind interface static *state* — `var` / `let`
        // / `const` fields declared inside the interface `shared { … }` block.
        // CLR interfaces may own static fields; these become `Static` FieldDef
        // rows on the interface TypeDef (const → `literal` + `Constant` row).
        if !syntax.StaticFields.IsDefaultOrEmpty {
            // ADR-0089 / issue #1030: interface static state is supported on
            // both non-generic and generic interfaces. For a generic interface
            // the FieldDef rows live on the interface TypeDef and access sites
            // reference them through a TypeSpec for the closed construction, so
            // each construction (`IBox[int32]` vs `IBox[string]`) owns
            // independent storage — matching CLR static-field semantics.
            let previousFunction = getCurrentFunction()
            // Issue #3096: identify this bind as an interface .cctor context
            // so native spread lowering keeps its loop directly in the
            // stack-empty initializer instead of synthesizing a helper method
            // that an interface cannot own in this path.
            let initializerContext = FunctionSymbol(
                "<field-initializer>",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Void
            ){
                IsUnsafe = binderCtx.InUnsafeContext,
                IsStatic = true,
                IsStaticInitializer = true,
                StaticOwnerType = interfaceSymbol
            }
            setCurrentFunction(initializerContext)
            try {
                let staticFieldsBuilder = ImmutableArray.CreateBuilder[FieldSymbol]()
                let constFieldsBuilder = ImmutableArray.CreateBuilder[FieldSymbol]()
                let initializersBuilder = ImmutableDictionary.CreateBuilder[FieldSymbol, BoundExpression]()
                for fieldSyntax in syntax.StaticFields {
                    let fieldName = fieldSyntax.Identifier.ValueText
                    if !seenNames.Add(fieldName) {
                        Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName)
                        continue
                    }
                    let fieldType TypeSymbol? = bindTypeClause(fieldSyntax.Type)
                    if fieldType == nil {
                        continue
                    }
                    if TypeSymbol.IsByRefLike(fieldType) {
                        Diagnostics.ReportByRefLikeEscape(
                            fieldSyntax.Identifier.Location,
                            fieldType,
                            "be used as the type of field '$fieldName'"
                        )
                        continue
                    }
                    if fieldType is ByRefTypeSymbol byRefFieldType {
                        Diagnostics.ReportPointerTypeCannotBeFieldType(
                            fieldSyntax.Identifier.Location,
                            byRefFieldType.Name
                        )
                        continue
                    }
                    let fieldAccessibility = resolveAccessibility(fieldSyntax.AccessibilityModifier)
                    // const → compile-time literal field (reads inlined).
                    if fieldSyntax.IsConst {
                        if fieldType == TypeSymbol.NInt || fieldType == TypeSymbol.NUInt {
                            Diagnostics.ReportConstNativeIntegerNotSupported(
                                fieldSyntax.Identifier.Location,
                                fieldName,
                                fieldType.Name
                            )
                            continue
                        }
                        let constField = FieldSymbol(
                            fieldName,
                            fieldType,
                            fieldAccessibility,
                            isReadOnly: true,
                            isStatic: true,
                            isConst: true,
                            declaration: fieldSyntax
                        )
                        Binder.AttachDocumentation(constField, fieldSyntax)
                        if fieldSyntax.Initializer == nil {
                            Diagnostics.ReportConstFieldRequiresInitializer(fieldSyntax.Identifier.Location, fieldName)
                        } else {
                            let boundConst = if fieldSyntax.Initializer is BlockExpressionSyntax {
                                conversions.BindConversion(fieldSyntax.Initializer, fieldType)
                            } else {
                                bindExpression(fieldSyntax.Initializer)
                            }
                            let convertedConst = if fieldSyntax.Initializer is BlockExpressionSyntax {
                                boundConst
                            } else {
                                conversions.BindConversion(fieldSyntax.Initializer!!.Location, boundConst, fieldType)
                            }
                            if ConstantExpressionEvaluator.TryFindNativeInteger(convertedConst, out var nativeType) {
                                Diagnostics.ReportConstNativeIntegerNotSupported(
                                    fieldSyntax.Identifier.Location,
                                    fieldName,
                                    Invariant.Required(
                                        nativeType,
                                        "a detected native integer has a type",
                                        expression: "nativeType"
                                    )
                                        .Name
                                )
                            } else if ConstantExpressionEvaluator.TryFold(
                                convertedConst,
                                fieldType,
                                out var constValue
                            ) {
                                constField.SetConstantValue(constValue)
                            } else if !(boundConst is BoundErrorExpression) &&
                                !(convertedConst is BoundErrorExpression) {
                                Diagnostics.ReportConstFieldInitializerNotConstant(
                                    fieldSyntax.Initializer!!.Location,
                                    fieldName
                                )
                            }
                        }
                        constFieldsBuilder.Add(constField)
                        continue
                    }
                    let fieldSymbol = FieldSymbol(
                        fieldName,
                        fieldType,
                        fieldAccessibility,
                        isReadOnly: fieldSyntax.IsReadOnly,
                        isStatic: true,
                        declaration: fieldSyntax
                    )
                    Binder.AttachDocumentation(fieldSymbol, fieldSyntax)
                    if fieldSyntax.Initializer != nil {
                        let boundInit = if fieldSyntax.Initializer is BlockExpressionSyntax {
                            conversions.BindConversion(fieldSyntax.Initializer, fieldType)
                        } else {
                            bindExpression(fieldSyntax.Initializer)
                        }
                        let convertedInit = if fieldSyntax.Initializer is BlockExpressionSyntax {
                            boundInit
                        } else {
                            conversions.BindConversion(fieldSyntax.Initializer!!.Location, boundInit, fieldType)
                        }
                        initializersBuilder[fieldSymbol] = convertedInit
                    }
                    staticFieldsBuilder.Add(fieldSymbol)
                }
                interfaceSymbol.SetStaticFields(staticFieldsBuilder.ToImmutable())
                if constFieldsBuilder.Count > 0 {
                    interfaceSymbol.SetConstFields(constFieldsBuilder.ToImmutable())
                }
                if initializersBuilder.Count > 0 {
                    interfaceSymbol.SetStaticFieldInitializers(initializersBuilder.ToImmutable())
                }
            } finally {
                setCurrentFunction(previousFunction)
            }
        }
    }

    private func VerifyInterfaceMemberVariance(syntax InterfaceDeclarationSyntax, interfaceSymbol InterfaceSymbol) {
        // Phase 4.3c / ADR-0021: variance position checking. Walk each method's
        // parameter types (contravariant position) and return type (covariant
        // position). An `out T` may only appear in covariant position; an
        // `in T` may only appear in contravariant position. ADR-0089: walk
        // both instance and static-virtual method buckets — variance applies
        // to both because the type parameter still flows through the
        // signature when the interface is constructed. ADR-0090: walk private
        // helper buckets too — variance rules apply regardless of accessibility.
        if !interfaceSymbol.TypeParameters.IsDefaultOrEmpty {
            var instanceIdx = 0
            var staticIdx = 0
            var privateInstanceIdx = 0
            var privateStaticIdx = 0
            for methodSyntax in syntax.Methods {
                let isPrivate = methodSyntax.AccessibilityModifier != nil && string.Equals(
                    methodSyntax.AccessibilityModifier.Text,
                    "private",
                    StringComparison.Ordinal
                )
                var m FunctionSymbol
                if methodSyntax.HasStaticModifier {
                    if isPrivate {
                        if privateStaticIdx >= interfaceSymbol.StaticPrivateMethods.Length {
                            continue
                        }
                        m = interfaceSymbol.StaticPrivateMethods[privateStaticIdx]
                        privateStaticIdx++
                    } else {
                        if staticIdx >= interfaceSymbol.StaticMethods.Length {
                            continue
                        }
                        m = interfaceSymbol.StaticMethods[staticIdx]
                        staticIdx++
                    }
                } else {
                    if isPrivate {
                        if privateInstanceIdx >= interfaceSymbol.PrivateMethods.Length {
                            continue
                        }
                        m = interfaceSymbol.PrivateMethods[privateInstanceIdx]
                        privateInstanceIdx++
                    } else {
                        if instanceIdx >= interfaceSymbol.Methods.Length {
                            continue
                        }
                        m = interfaceSymbol.Methods[instanceIdx]
                        instanceIdx++
                    }
                }
                CheckVariancePosition(
                    m.Type,
                    isOutput: true,
                    methodSyntax.Type?.Location ?? methodSyntax.Identifier.Location
                )
                for var p = 0; p < m.Parameters.Length; p++ {
                    let paramSyntax = methodSyntax.Parameters[p]
                    CheckVariancePosition(
                        m.Parameters[p].Type,
                        isOutput: false,
                        paramSyntax.Type?.Location ?? paramSyntax.Location
                    )
                }
            }
        }
    }

    private func CheckVariancePosition(type TypeSymbol, isOutput bool, location TextLocation) {
        if type is TypeParameterSymbol tp {
            if tp.Variance == TypeParameterVariance.Out && !isOutput {
                Diagnostics.ReportTypeParameterVariancePositionViolation(location, tp.Name, "out", "input")
            } else if tp.Variance == TypeParameterVariance.In && isOutput {
                Diagnostics.ReportTypeParameterVariancePositionViolation(location, tp.Name, "in", "output")
            }
            return
        }
        if type is SliceTypeSymbol s {
            CheckVariancePosition(s.ElementType, isOutput, location)
            return
        }
        if type is ArrayTypeSymbol a {
            CheckVariancePosition(a.ElementType, isOutput, location)
            return
        }
        if type is RectangularArrayTypeSymbol rectangular {
            CheckVariancePosition(rectangular.ElementType, isOutput, location)
            return
        }
        if type is NullableTypeSymbol n {
            CheckVariancePosition(n.UnderlyingType, isOutput, location)
            return
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
    // Issue #3082: data positional `@property:` annotations are excluded here
    // and bound to the synthesized property in BindStructProperties.
    private func BindAndAttachParameterAttributes(
        parameterSyntax ParameterSyntax,
        parameterSymbol ParameterSymbol,
        isDataPositionalMember bool = false
    ) {
        if parameterSyntax.Annotations.IsDefaultOrEmpty {
            return
        }
        let annotations = if isDataPositionalMember {
            parameterSyntax
                .Annotations
                .Where((annotation AnnotationSyntax) -> !HasAttributeTarget(annotation, AttributeTargetKind.Property))
                .ToImmutableArray()
        } else {
            parameterSyntax.Annotations
        }
        let paramAttrs = BindAttributes(
            annotations,
            AttributeTargetKind.Param,
            Binder.ParameterAllowedTargets,
            "a parameter declaration",
            AttributeTargets.Parameter
        )
        if !paramAttrs.IsDefaultOrEmpty {
            parameterSymbol.SetAttributes(paramAttrs)
            ValidateUnscopedRefParameter(parameterSymbol)
        }
    }

    private func BindDataPositionalPropertyAttributes(parameterSyntax ParameterSyntax) ImmutableArray[BoundAttribute] {
        let annotations = parameterSyntax
            .Annotations
            .Where((annotation AnnotationSyntax) -> HasAttributeTarget(annotation, AttributeTargetKind.Property))
            .ToImmutableArray()
        return BindAttributes(
            annotations,
            AttributeTargetKind.Property,
            Binder.PropertyDeclarationAllowedTargets,
            "a data positional property",
            AttributeTargets.Property
        )
    }

    shared {
        private func HasAttributeTarget(
            annotation AnnotationSyntax,
            target AttributeTargetKind
        ) bool -> annotation.Target != nil &&
            TryParseTargetKind(annotation.Target.KindIdentifier.ValueText, out var parsedTarget) &&
            parsedTarget == target
    }
}
