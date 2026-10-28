// <copyright file="DeclarationBinder.cs" company="GSharp">
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

/// Extracted from (cref:Binder) in PR-B-8. Owns every per-declaration-kind
/// binder: type aliases, named delegates, enums, structs (including the large
/// `BindStructDeclarationBody` driver and its interface-implementation
/// verification pass), interfaces, free / member / extension functions,
/// constructors (`init`) plus the `: base(...)` initializer
/// resolver, the two symbol-construction `BindVariableDeclaration`
/// overloads, generic-parameter binding (`BindTypeParameterList`), the
/// declaration-side attribute binder (`BindAttributes`/`BindAttribute`),
/// and the queue of pending struct→interface implementation checks. The
/// expression binder and most type-name resolution remain on
/// (cref:Binder) and are invoked via the delegate callbacks supplied to
/// the constructor; the same is true for `BindBlockStatement`-driven
/// body binding (which happens later, in `BindProgram`, not here).
internal partial class DeclarationBinder {
    private let binderCtx BinderContext
    private let conversions ConversionClassifier
    private let bindExpression DeclarationBinder_BindExpressionDelegate
    private let bindTypeClause(TypeClauseSyntax) -> TypeSymbol?
    private let bindReturnTypeClause(TypeClauseSyntax?, bool) -> TypeSymbol?
    private let bindTypeOfExpression DeclarationBinder_BindTypeOfExpressionDelegate
    private let bindArrayCreationExpression DeclarationBinder_BindArrayCreationExpressionDelegate
    private let bindInterpolatedStringAsFormattable DeclarationBinder_BindInterpolatedStringAsFormattableDelegate?
    private let resolveAccessibility(SyntaxToken?) -> Accessibility
    private let lookupType(string) -> TypeSymbol?
    private let getEffectiveArgumentClrTypeForOverloadResolution(TypeSymbol) -> Type?
    private let isAsyncIteratorReturnType(TypeSymbol) -> bool
    private let isAsyncSequenceReturnType(TypeSymbol) -> bool
    private let isPrimitiveTypeName(string) -> bool
    private let refKindToString(RefKind) -> string
    private let getCurrentFunction() -> FunctionSymbol?
    private let setCurrentFunction(FunctionSymbol?) -> void
    private let selectBestConstructor(
        ImmutableArray[ConstructorSymbol],
        StructSymbol,
        ImmutableArray[BoundExpression]
    ) -> ConstructorSymbol?
    private let pendingInterfaceImplementationChecks List[(Syntax StructDeclarationSyntax, Symbol StructSymbol)] = List[
        (StructDeclarationSyntax, StructSymbol)
    ]()

    // Issue #987: classes whose abstract-member contract must be verified after
    // every type body is bound (a concrete class must override all inherited
    // abstract methods). Deferred because a base class' methods may not be bound
    // yet when a derived class declaration is processed.
    private let pendingAbstractImplementationChecks List[(Syntax StructDeclarationSyntax, Symbol StructSymbol)] = List[
        (StructDeclarationSyntax, StructSymbol)
    ]()

    // Issue #1085: base-constructor-initializer (`: base(...)`) argument binding
    // is deferred until every declared type's explicit constructors have been
    // populated. The argument expressions may construct OTHER user types (e.g.
    // `: base(H(1))`), and resolving such a constructor call requires the
    // referenced type's ExplicitConstructor(s) to already exist. Because type
    // bodies are bound one file at a time, a base-initializer in a file processed
    // before the constructed type's file would otherwise resolve against an
    // empty (not-yet-populated) constructor shell and wrongly report GS0144.
    // Method bodies already see fully-populated constructors because they are
    // bound in a later phase; deferring base-initializer argument binding to a
    // post-pass gives it the same guarantee, regardless of source-file order.
    private let pendingBaseInitializerBindings List[() -> void] = List[() -> void]()

    // Issue #1194: field-initializer binding is deferred until after all
    // top-level functions are declared in Binder.BindGlobalScope, so a field
    // initializer can resolve an unqualified call to a free function or a
    // sibling static method/const. Each entry re-establishes the captured
    // scope and the enclosing type's static-member scope before binding.
    private let pendingFieldInitializerBindings List[() -> void] = List[() -> void]()

    // Issue #4183: default-parameter-value expressions (`func M(x T = expr)`,
    // including on primary/explicit constructors and static methods) are
    // deferred for the SAME forward-reference reason field/const initializers
    // were deferred above (#1070/#1194): ConversionClassifier.
    // BindAndAttachParameterDefaultValue used to run eagerly, inline, during
    // Binder.BindGlobalScope's single per-struct declaration-body pass. When a
    // default value referenced a SIBLING type's static member (e.g.
    // `x int32 = B.Value`) and that sibling type had not yet had its own body
    // (in particular its `shared` block) bound, the reference failed to
    // resolve — not because the member doesn't exist, but because it hadn't
    // been bound onto the symbol yet — giving a misleading diagnostic purely
    // as a function of unrelated declaration order. Each entry re-establishes
    // the captured scope, package, syntax tree, and type-parameter context
    // before binding (see DeferParameterDefaultValueBinding).
    //
    // Ordering constraint: this MUST drain before BindPendingBaseInitializers
    // (Binder.cs), because DeclarationBinder.Constructors.cs reads
    // ParameterSymbol.HasExplicitDefaultValue while resolving a `: base(...)`
    // initializer against a base constructor's optional trailing parameters —
    // draining after would make that resolution see HasExplicitDefaultValue
    // == false for a parameter whose default hasn't been bound yet.
    private let pendingParameterDefaultValueBindings List[() -> void] = List[() -> void]()

    // Issue #4481: property overrides whose type differs from the base
    // property's. Whether the difference is a covariant narrowing depends on
    // the override type's base class, and that type may be bound after the
    // overriding class (types are ordered base-first, not by the types their
    // members mention), so the decision waits until every type body is bound.
    private let pendingCovariantPropertyOverrideChecks List[() -> void] = List[() -> void]()

    // Issue #3896: const initializers a type's own #1193 fixpoint could not
    // fold, because the const they reference belongs to a type bound later.
    // BindPendingFieldInitializers retries these across the whole compilation
    // once every type's initializers are bound, and reports GS0376 for whatever
    // still cannot fold.
    private let pendingCrossTypeConstFolds List[
        (Field FieldSymbol, Bound BoundExpression, Location TextLocation)
    ] = List[(Field FieldSymbol, Bound BoundExpression, Location TextLocation)]()

    // Issue #1069: nested struct/class and interface type-name shells declared in
    // phase 1 (DeclareNestedTypeShells) so a sibling member signature can
    // forward-reference a nested type by name. The recorded shells are reused in
    // phase 2 (BindNestedTypeBodies) to bind the bodies without re-declaring the
    // type alias. Nested enums are fully bound during the shell phase (their
    // members reference no user types) and so are not tracked here.
    private let nestedStructShells Dictionary[StructDeclarationSyntax, StructSymbol] = Dictionary[
        StructDeclarationSyntax,
        StructSymbol
    ]()

    private let nestedInterfaceShells Dictionary[InterfaceDeclarationSyntax, InterfaceSymbol] = Dictionary[
        InterfaceDeclarationSyntax,
        InterfaceSymbol
    ]()

    init(
        binderCtx BinderContext,
        conversions ConversionClassifier,
        bindExpression DeclarationBinder_BindExpressionDelegate,
        bindTypeClause(TypeClauseSyntax) -> TypeSymbol?,
        bindReturnTypeClause(TypeClauseSyntax?, bool) -> TypeSymbol?,
        bindTypeOfExpression DeclarationBinder_BindTypeOfExpressionDelegate,
        bindArrayCreationExpression DeclarationBinder_BindArrayCreationExpressionDelegate,
        resolveAccessibility(SyntaxToken?) -> Accessibility,
        lookupType(string) -> TypeSymbol?,
        getEffectiveArgumentClrTypeForOverloadResolution(TypeSymbol) -> Type?,
        isAsyncIteratorReturnType(TypeSymbol) -> bool,
        isAsyncSequenceReturnType(TypeSymbol) -> bool,
        isPrimitiveTypeName(string) -> bool,
        refKindToString(RefKind) -> string,
        getCurrentFunction() -> FunctionSymbol?,
        setCurrentFunction(FunctionSymbol?) -> void,
        selectBestConstructor(
            ImmutableArray[ConstructorSymbol],
            StructSymbol,
            ImmutableArray[BoundExpression]
        ) -> ConstructorSymbol?,
        bindInterpolatedStringAsFormattable DeclarationBinder_BindInterpolatedStringAsFormattableDelegate? = nil
    ) {
        this.binderCtx = binderCtx ?? throw ArgumentNullException("binderCtx")
        this.conversions = conversions ?? throw ArgumentNullException("conversions")
        ArgumentNullException.ThrowIfNull(bindExpression, paramName: "bindExpression")
        this.bindExpression = (syntax ExpressionSyntax) -> {
            // Issue #3336: merged partial expressions retain the declaring part's tree.
            let bindingScope = this.$scope
            let previousTree = bindingScope.SetCurrentReferencingSyntaxTree(syntax.SyntaxTree)
            try {
                return bindExpression(syntax)
            } finally {
                bindingScope.SetCurrentReferencingSyntaxTree(previousTree)
            }
        }
        this.bindTypeClause = bindTypeClause ?? throw ArgumentNullException("bindTypeClause")
        this.bindReturnTypeClause = bindReturnTypeClause ?? throw ArgumentNullException("bindReturnTypeClause")
        this.bindTypeOfExpression = bindTypeOfExpression ?? throw ArgumentNullException("bindTypeOfExpression")
        this.bindArrayCreationExpression = bindArrayCreationExpression ??
            throw ArgumentNullException("bindArrayCreationExpression")
        this.bindInterpolatedStringAsFormattable = bindInterpolatedStringAsFormattable
        this.resolveAccessibility = resolveAccessibility ?? throw ArgumentNullException("resolveAccessibility")
        this.lookupType = lookupType ?? throw ArgumentNullException("lookupType")
        this.getEffectiveArgumentClrTypeForOverloadResolution = getEffectiveArgumentClrTypeForOverloadResolution ??
            throw ArgumentNullException("getEffectiveArgumentClrTypeForOverloadResolution")
        this.isAsyncIteratorReturnType = isAsyncIteratorReturnType ??
            throw ArgumentNullException("isAsyncIteratorReturnType")
        this.isAsyncSequenceReturnType = isAsyncSequenceReturnType ??
            throw ArgumentNullException("isAsyncSequenceReturnType")
        this.isPrimitiveTypeName = isPrimitiveTypeName ?? throw ArgumentNullException("isPrimitiveTypeName")
        this.refKindToString = refKindToString ?? throw ArgumentNullException("refKindToString")
        this.getCurrentFunction = getCurrentFunction ?? throw ArgumentNullException("getCurrentFunction")
        this.setCurrentFunction = setCurrentFunction ?? throw ArgumentNullException("setCurrentFunction")
        this.selectBestConstructor = selectBestConstructor ?? throw ArgumentNullException("selectBestConstructor")
    }

    private prop Diagnostics DiagnosticBag -> binderCtx.Diagnostics

    private prop $scope BoundScope {
        get -> binderCtx.RootScope
        set -> this.binderCtx.RootScope = value
    }

    private prop function FunctionSymbol? -> getCurrentFunction()

    /// Binds a plain `type Name = Target` alias declaration.
    /// @param syntax The alias declaration syntax.
    /// @param package Issue #2342 follow-up: the package that declares this alias, giving it
    /// a stable declaring-package identity for top-level duplicate detection
    /// (see (cref:BoundScope.TryDeclareTypeAlias(string, TypeSymbol, string)))
    /// independent of whatever package (if any) the aliased target itself
    /// belongs to.
    internal func BindTypeAliasDeclaration(syntax TypeAliasDeclarationSyntax, $package PackageSymbol?) {
        let name = syntax.Identifier.ValueText
        // Reject shadowing of primitive type names.
        if isPrimitiveTypeName(name) {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name)
            return
        }
        let aliasedType TypeSymbol? = bindTypeClause(syntax.AliasedType)
        if aliasedType == nil {
            return
        }
        // Issue #141 / ADR-0047: type aliases accept annotations syntactically;
        // since the alias has no dedicated symbol of its own, the resolved
        // attribute list is reported for diagnostics and otherwise dropped
        // until v2 introduces a richer alias-symbol shape.
        BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "a type alias declaration",
            AttributeTargets.Class
        )
        if !$scope.TryDeclareTypeAlias(
            name,
            aliasedType,
            if $package == nil {
                default(string?)
            } else {
                $package.Name
            }
        ) {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name)
        }
    }

    /// ADR-0059 / issue #255: binds a `delegate Name(...) `;
    /// declaration into a (cref:DelegateTypeSymbol) registered with the
    /// current scope. Unlike a plain type alias, a named delegate produces a
    /// real CLR TypeDef at emit time.
    internal func DeclareDelegateSymbol(syntax DelegateDeclarationSyntax, $package PackageSymbol) DelegateTypeSymbol? {
        let name = syntax.Identifier.ValueText
        // Reject shadowing of primitive type names — same rule as struct/enum.
        if isPrimitiveTypeName(name) {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name)
            return nil
        }
        let delegateSymbol = DelegateTypeSymbol(
            name,
            $package.Name,
            resolveAccessibility(syntax.AccessibilityModifier),
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            syntax
        )
        let typeParameters = CreateTypeParameterSymbols(syntax.TypeParameterList)
        if !typeParameters.IsDefaultOrEmpty {
            delegateSymbol.SetTypeParameters(typeParameters)
        }
        Binder.AttachDocumentation(delegateSymbol, syntax)
        if !$scope.TryDeclareTypeAlias(name, delegateSymbol) {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name)
            return nil
        }
        return delegateSymbol
    }

    internal func BindDelegateDeclarationBody(syntax DelegateDeclarationSyntax, delegateSymbol DelegateTypeSymbol) {
        let previousTypeParameters Dictionary[string, TypeParameterSymbol]? = binderCtx.CurrentTypeParameters
        let typeParameters = delegateSymbol.TypeParameters
        if !typeParameters.IsDefaultOrEmpty {
            this.binderCtx.CurrentTypeParameters = if previousTypeParameters == nil {
                Dictionary[string, TypeParameterSymbol]()
            } else {
                Dictionary[string, TypeParameterSymbol](previousTypeParameters)
            }
            for tp in typeParameters {
                binderCtx.CurrentTypeParameters!![tp.Name] = tp
            }
        }
        try {
            ResolveTypeParameterConstraints(syntax.TypeParameterList, typeParameters)
            BindDelegateDeclarationBodyCore(syntax, delegateSymbol)
        } finally {
            this.binderCtx.CurrentTypeParameters = previousTypeParameters
        }
    }

    private func BindDelegateDeclarationBodyCore(syntax DelegateDeclarationSyntax, delegateSymbol DelegateTypeSymbol) {
        let parameters = ImmutableArray.CreateBuilder[ParameterSymbol]()
        let seenParameterNames = HashSet[string]()
        for var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++ {
            let parameterSyntax = syntax.Parameters[pIndex]
            // ADR-0185: this declaration's parameters never come from the
            // destructured arrow-lambda path.
            let parameterName = parameterSyntax.Identifier!!.ValueText
            var parameterType = if parameterSyntax.Type is {} parameterTypeSyntax {
                bindTypeClause(parameterTypeSyntax) ?? TypeSymbol.Error
            } else {
                TypeSymbol.Error
            }
            if !seenParameterNames.Add(parameterName) {
                Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName)
                continue
            }
            // ADR-0101 follow-up / issue #812: variadic parameters are now
            // accepted on delegate declarations. The Invoke signature carries
            // a `[]T` slice, and the emitter stamps [ParamArrayAttribute] on
            // the trailing parameter so C# / F# / VB consumers see the
            // delegate as a normal `params T[]` delegate.
            let isVariadic = parameterSyntax.IsVariadic
            if isVariadic && parameterType != TypeSymbol.Error {
                parameterType = VariadicCarriers.ResolveDeclaredParameterType(parameterType)
            }
            let delegateParam = ParameterSymbol(
                parameterName,
                parameterType,
                isVariadic,
                declaringSyntax: parameterSyntax.Identifier,
                refKind: conversions.BindAndValidateParameterRefKind(
                    parameterSyntax,
                    parameterName,
                    parameterType,
                    isVariadic,
                    asyncOrIteratorKind: nil
                )
            )
            // ADR-0063 §5: delegate declarations can declare default-valued
            // parameters; the value is recorded on the parameter symbol for
            // call-site default substitution.
            conversions.BindAndAttachParameterDefaultValue(parameterSyntax, delegateParam)
            // Issue #1913: delegate parameters can carry `@Attr` annotations
            // same as any other parameter list.
            BindAndAttachParameterAttributes(parameterSyntax, delegateParam)
            parameters.Add(delegateParam)
        }
        // ADR-0101 follow-up / issue #812: `...T` must be the last parameter
        // and at most one variadic parameter per delegate signature.
        ValidateVariadicParameterShape(syntax.Parameters)
        var returnType TypeSymbol? = if syntax.ReturnType != nil {
            bindTypeClause(syntax.ReturnType)
        } else {
            TypeSymbol.Void
        }
        if returnType == nil {
            returnType = TypeSymbol.Void
        }
        // ADR-0047: annotations on a delegate declaration default to the Type
        // target. ADR-0095 / issue #761: the effective AttributeUsage target
        // is `Delegate` (not `Class`) so attributes whose AttributeUsage is
        // restricted to delegates — most importantly
        // `[UnmanagedFunctionPointer]` — bind without GS0276.
        let delegateAttributes = BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "a delegate declaration",
            AttributeTargets.Delegate
        )
        delegateSymbol.SetSignature(parameters.ToImmutable(), returnType)
        delegateSymbol.SetAttributes(delegateAttributes)
    }

    internal func BindEnumDeclaration(
        syntax EnumDeclarationSyntax,
        $package PackageSymbol,
        containingType TypeSymbol? = nil
    ) EnumSymbol? {
        let name = syntax.Identifier.ValueText
        if isPrimitiveTypeName(name) {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name)
            return nil
        }
        let accessibility = resolveAccessibility(syntax.AccessibilityModifier)
        let enumSymbol = EnumSymbol(name, accessibility, $package.Name, syntax)
        // Issue #1080: set the enclosing type BEFORE registering the name so the
        // scope can scope name-uniqueness to the enclosing type (a nested type
        // must not collide with a same-named package-level or differently-nested
        // type).
        if containingType != nil {
            enumSymbol.SetContainingType(containingType)
        }
        Binder.AttachDocumentation(enumSymbol, syntax)
        enumSymbol.SetAttributes(
            BindAttributes(
                syntax.Annotations,
                AttributeTargetKind.Type,
                Binder.TypeDeclarationAllowedTargets,
                "an enum declaration",
                AttributeTargets.Enum
            )
        )
        let seenMemberNames = HashSet[string]()
        let declaredValues = Dictionary[string, int32]()
        let members = ImmutableArray.CreateBuilder[EnumMemberSymbol]()
        var nextValue = 0
        for memberSyntax in syntax.Members {
            let memberName = memberSyntax.Identifier.ValueText
            if !seenMemberNames.Add(memberName) {
                Diagnostics.ReportDuplicateEnumMember(memberSyntax.Identifier.Location, memberName, name)
                continue
            }
            var memberValue = nextValue
            if memberSyntax.HasExplicitValue {
                // Issue #1912: an explicit constant value (`Banana = 2`, `Unknown = -1`,
                // `ReadWrite = Read | Write`, or an alias `DefaultError = ServerError`)
                // overrides the auto-numbered default; later implicit members continue
                // counting up from it, matching C# §19.4.
                if memberSyntax.Value is {} explicitValue &&
                    TryFoldEnumMemberValue(explicitValue, declaredValues, out var folded) {
                    memberValue = folded
                } else {
                    Diagnostics.ReportEnumMemberValueNotConstant(
                        memberSyntax.Value?.Location ?? memberSyntax.Identifier.Location,
                        memberName,
                        name
                    )
                }
            }
            let memberSymbol = EnumMemberSymbol(memberName, enumSymbol, memberValue)
            declaredValues[memberName] = memberValue
            nextValue = memberValue + 1
            Binder.AttachDocumentation(memberSymbol, memberSyntax)
            // Issue #188 / ADR-0047 §3: bind any `@Foo` annotations attached
            // to the enum-member entry with default target `field` (enum
            // members are emitted as static literal fields on the enum type
            // per ECMA-335 §I.8.5.2), so #175 use-site diagnostics
            // (e.g. `@Obsolete`) fire on `Color.Red` references.
            if !memberSyntax.Annotations.IsDefaultOrEmpty {
                memberSymbol.SetAttributes(
                    BindAttributes(
                        memberSyntax.Annotations,
                        AttributeTargetKind.Field,
                        Binder.VariableDeclarationAllowedTargets,
                        "an enum member declaration",
                        AttributeTargets.Field
                    )
                )
            }
            members.Add(memberSymbol)
        }
        if members.Count == 0 {
            Diagnostics.ReportEmptyEnumDeclaration(syntax.Identifier.Location, name)
        }
        enumSymbol.SetMembers(members.ToImmutable())
        if !$scope.TryDeclareTypeAlias(name, enumSymbol) {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name)
        }
        return enumSymbol
    }

    /// Issue #973: declares and fully binds a struct/class in a single pass
    /// (phase 1 + phase 2). Used for nested type declarations, which are bound
    /// recursively from within their container's body rather than through the
    /// top-level two-phase loop.
    internal func BindStructDeclaration(syntax StructDeclarationSyntax, $package PackageSymbol) StructSymbol? {
        let structSymbol StructSymbol? = DeclareStructShell(syntax, $package)
        if structSymbol == nil {
            return nil
        }
        BindStructDeclarationBody(syntax, $package, structSymbol)
        return structSymbol
    }

    /// Issue #973: detects transitive base-class inheritance cycles among the
    /// supplied class symbols and reports a diagnostic for each one. Before the
    /// two-phase declaration split (#973) a base clause could only resolve a
    /// type declared earlier in source, so a mutual cycle such as
    /// `class B : C` / `class C : B` was implicitly rejected because
    /// the forward reference failed to resolve. Now that all type-name shells
    /// are declared before any base clause is bound — which is exactly what
    /// makes legitimate forward references work — the cycle resolves cleanly
    /// and must be caught here, after every base class is installed via
    /// (cref:StructSymbol.SetBaseClass). Each (cref:StructSymbol)
    /// has at most one user base class, so the base relation forms a functional
    /// graph; this walks every node's chain and, on finding a back-edge into the
    /// current path, reports the cycle and clears the offending base link so the
    /// later base-chain walks in (cref:StructSymbol) and the emitter do
    /// not loop forever. Direct self-inheritance (`class A : A`) never
    /// reaches here because it is rejected — and its base left unset — in the
    /// base-clause loop.
    internal func DetectClassInheritanceCycles(classSymbols IEnumerable[StructSymbol]) {
        let acyclic = HashSet[StructSymbol]()
        for start in classSymbols {
            if start.BaseClass == nil || acyclic.Contains(start) {
                continue
            }
            let path = List[StructSymbol]()
            let onPath = HashSet[StructSymbol]()
            var current StructSymbol? = start
            while current != nil {
                if onPath.Contains(current) {
                    let baseLocation = GetBaseClauseLocation(current)
                    Diagnostics.ReportClassInheritanceCycle(baseLocation, current.Name)
                    // Break the back-edge so subsequent base-chain walks (member
                    // lookup, the emitter, etc.) terminate. Binding already
                    // failed, so the program will not be emitted.
                    current.SetBaseClass(nil)
                    break
                }
                if acyclic.Contains(current) {
                    break
                }
                path.Add(current)
                onPath.Add(current)
                current = current.BaseClass
            }
            for node in path {
                acyclic.Add(node)
            }
        }
    }

    /// Issue #973 (phase 1): declares the struct/class type-name shell and
    /// registers it in scope BEFORE any member body is bound, so that field,
    /// parameter, and base-clause types may forward-reference a user type
    /// declared later in the same compilation (e.g. a `class` whose field
    /// type is a `struct` declared further down). The returned shell has
    /// empty (cref:StructSymbol.Fields) and
    /// (cref:StructSymbol.PrimaryConstructorParameters); those — along
    /// with the base clause and all members — are bound and installed later by
    /// (cref:BindStructDeclarationBody).
    internal func DeclareStructShell(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        containingType TypeSymbol? = nil
    ) StructSymbol? {
        let name = syntax.Identifier.ValueText
        if isPrimitiveTypeName(name) {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name)
            return nil
        }
        let accessibility = resolveAccessibility(syntax.AccessibilityModifier)
        // Issue #2519: publish the aggregate shell with bare type parameters,
        // but defer constraint resolution to BindStructDeclarationBody. The
        // global declaration pass creates every same-compilation type shell
        // before any body is bound, so a constraint may name a class declared
        // in a later file without depending on compile-item order. Resolving in
        // the body phase still preserves CRTP constraints because this shell is
        // already registered before its own constraints are resolved.
        let typeParameters = CreateTypeParameterSymbols(syntax.TypeParameterList)
        return CreateAndRegisterStructShell(syntax, $package, accessibility, name, typeParameters, containingType)
    }

    /// Issue #1056: constructs a struct/class type-name shell with the supplied
    /// type parameters and registers it in scope. Factored out of
    /// (cref:DeclareStructShell) so the registration can run between
    /// type-parameter creation and constraint resolution (enabling a
    /// self-referential base-class constraint to resolve the declaring type).
    private func CreateAndRegisterStructShell(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        accessibility Accessibility,
        name string,
        typeParameters ImmutableArray[TypeParameterSymbol],
        containingType TypeSymbol? = nil
    ) StructSymbol {
        // Issue #949 / #973: construct the struct symbol shell now and register
        // it in scope so that (a) the type may reference itself as a generic
        // type argument in its own base/interface clause, and (b) any other
        // user type may reference it by name regardless of declaration order.
        // Instance fields and primary-constructor parameters are bound and
        // installed later by BindStructDeclarationBody.
        let structSymbol = StructSymbol(
            name,
            ImmutableArray[FieldSymbol].Empty,
            accessibility,
            syntax,
            $package.Name,
            syntax.IsData,
            syntax.IsInline,
            syntax.IsClass,
            ImmutableArray[ParameterSymbol].Empty,
            isOpen: (syntax.IsOpen || syntax.IsAbstract) && syntax.IsClass,
            baseClass: nil
        )
        Binder.AttachDocumentation(structSymbol, syntax)
        if !typeParameters.IsDefaultOrEmpty {
            structSymbol.SetTypeParameters(typeParameters)
        }
        // Issue #1080: set the enclosing type BEFORE registering the name so the
        // scope can scope name-uniqueness to the enclosing type.
        if containingType != nil {
            structSymbol.SetContainingType(containingType)
        }
        if !$scope.TryDeclareTypeAlias(name, structSymbol) {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name)
        }
        return structSymbol
    }

    shared {
        /// Issue #1912: constant-folds an enum member's explicit value expression
        /// into an int32, without going through the general expression binder (an
        /// enum member value must be foldable at bind time, before the enum type
        /// itself is fully declared). Supports int literals, unary `+`/`-`/`^`
        /// (ones-complement), the binary operators `+ - | & ^ << >>`,
        /// parenthesized sub-expressions, and references to already-declared
        /// sibling members by bare name (the common C# alias idiom, e.g.
        /// `DefaultError = ServerError`).
        /// @param expression The member's `= expr` value expression.
        /// @param declaredValues The already-bound sibling members, by name.
        /// @param value The folded int32 value, when folding succeeds.
        /// @returns `true` if [`expression`](paramref) folded to a constant int32.
        private func TryFoldEnumMemberValue(
            expression ExpressionSyntax,
            declaredValues IReadOnlyDictionary[string, int32],
            out value int32
        ) bool {
            switch expression {
                case paren is ParenthesizedExpressionSyntax {
                    return TryFoldEnumMemberValue(paren.Expression, declaredValues, out value)
                }
                case literal is LiteralExpressionSyntax {
                    switch literal.Value {
                        case i is int32 {
                            value = i
                            return true
                        }
                        case l is int64 when l >= int64(int32.MinValue) && l <= int64(int32.MaxValue) {
                            value = int32(l)
                            return true
                        }
                        default {
                            value = 0
                            return false
                        }
                    }
                }
                case name is NameExpressionSyntax {
                    return declaredValues.TryGetValue(name.IdentifierToken.ValueText, out value)
                }
                case unary is UnaryExpressionSyntax {
                    // Issue #1912 follow-up: the lexer types a decimal literal one past
                    // int.MaxValue (e.g. 2147483648) as uint per the integer-literal type
                    // lattice, since it doesn't fit int. Negating that literal (int.MinValue,
                    // 1 << 31, etc.) is a common real value (sign-bit flags), so special-case
                    // a uint literal directly under unary minus and fold via long to avoid
                    // overflow.
                    if unary
                        .OperatorToken
                        .Kind == SyntaxKind.MinusToken &&
                        unary.Operand is LiteralExpressionSyntax{Value: uint32 negatedLiteral} &&
                        negatedLiteral <= uint32(int32.MaxValue) +
                        uint32(1) {
                        value = unchecked(int32(-int64(negatedLiteral)))
                        return true
                    }
                    if !TryFoldEnumMemberValue(unary.Operand, declaredValues, out var operandValue) {
                        value = 0
                        return false
                    }
                    switch unary.OperatorToken.Kind {
                        case SyntaxKind.PlusToken {
                            value = operandValue
                            return true
                        }
                        case SyntaxKind.MinusToken {
                            value = -operandValue
                            return true
                        }
                        case SyntaxKind.TildeToken {
                            value = ~operandValue
                            return true
                        }
                        default {
                            value = 0
                            return false
                        }
                    }
                }
                case binary is BinaryExpressionSyntax {
                    if !TryFoldEnumMemberValue(binary.Left, declaredValues, out var leftValue) ||
                        !TryFoldEnumMemberValue(binary.Right, declaredValues, out var rightValue) {
                        value = 0
                        return false
                    }
                    switch binary.OperatorToken.Kind {
                        case SyntaxKind.PlusToken {
                            value = leftValue + rightValue
                            return true
                        }
                        case SyntaxKind.MinusToken {
                            value = leftValue - rightValue
                            return true
                        }
                        case SyntaxKind.PipeToken {
                            value = leftValue | rightValue
                            return true
                        }
                        case SyntaxKind.AmpersandToken {
                            value = leftValue & rightValue
                            return true
                        }
                        case SyntaxKind.HatToken {
                            value = leftValue ^ rightValue
                            return true
                        }
                        case SyntaxKind.AmpersandHatToken {
                            value = leftValue & ~rightValue
                            return true
                        }
                        case SyntaxKind.ShiftLeftToken {
                            value = leftValue << rightValue
                            return true
                        }
                        case SyntaxKind.ShiftRightToken {
                            value = leftValue >> rightValue
                            return true
                        }
                        case SyntaxKind.UnsignedShiftRightToken {
                            value = unchecked(int32((uint32(leftValue) >> rightValue)))
                            return true
                        }
                        default {
                            value = 0
                            return false
                        }
                    }
                }
                default {
                    value = 0
                    return false
                }
            }
        }

        /// Issue #973: returns the text location of a class declaration's base-type
        /// clause (the first base/interface identifier), falling back to the type
        /// identifier when the base clause carries no usable location. Used to
        /// anchor inheritance-cycle diagnostics.
        private func GetBaseClauseLocation(classSymbol StructSymbol) TextLocation {
            let declaration StructDeclarationSyntax? = classSymbol.Declaration
            if declaration == nil {
                return default(TextLocation)
            }
            if declaration.BaseTypeClauses.Count > 0 {
                let location = declaration.BaseTypeClauses[0].Identifier?.Location
                if location != nil {
                    return location
                }
            }
            if declaration.BaseTypeIdentifier != nil {
                return declaration.BaseTypeIdentifier.Location
            }
            return declaration.Identifier.Location
        }
    }
}

/// Signature for the root `BindExpression(syntax)` entry point.
/// @param syntax The expression syntax to bind.
/// @returns The bound expression.
internal delegate DeclarationBinder_BindExpressionDelegate(syntax ExpressionSyntax) BoundExpression;

/// Signature for the `BindTypeOfExpression(syntax)` entry point.
/// @param syntax The `typeof` expression syntax.
/// @returns The bound type-of expression.
internal delegate DeclarationBinder_BindTypeOfExpressionDelegate(syntax TypeOfExpressionSyntax) BoundExpression;

/// Signature for the `BindArrayCreationExpression(syntax)` entry point.
/// @param syntax The array-creation syntax.
/// @returns The bound array-creation expression.
internal delegate DeclarationBinder_BindArrayCreationExpressionDelegate(
    syntax ArrayCreationExpressionSyntax
) BoundExpression;

/// Signature for the `BindReturnTypeClause(syntax, isAsync)` entry point.
/// @param syntax The return type clause syntax.
/// @param isAsync Whether the enclosing function is async.
/// @returns The bound type or `null`.
internal delegate DeclarationBinder_BindReturnTypeClauseDelegate(syntax TypeClauseSyntax?, isAsync bool) TypeSymbol?;

/// Issue #1812: signature for the
/// `BindInterpolatedStringAsFormattable(syntax, targetType)` entry
/// point, letting (cref:ResolveClrBaseConstructor) re-lower a
/// `: base($"...")` argument to `FormattableStringFactory.Create(...)`
/// once overload resolution has selected an IFormattable/FormattableString
/// parameter — mirroring what `RebindFormattableInterpolationArguments`
/// does for every other CLR-call path in `ExpressionBinder`.
/// @param syntax The interpolated-string syntax.
/// @param targetType The target type, or `null` for the FormattableString-factory form.
/// @returns The bound (re-lowered) expression.
internal delegate DeclarationBinder_BindInterpolatedStringAsFormattableDelegate(
    syntax InterpolatedStringExpressionSyntax,
    targetType TypeSymbol?
) BoundExpression;
