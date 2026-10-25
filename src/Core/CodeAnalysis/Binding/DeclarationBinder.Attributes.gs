// <copyright file="DeclarationBinder.Attributes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import System.Globalization

internal partial class DeclarationBinder {
    private let reportedUnscopedRefDiagnostics HashSet[AnnotationSyntax] = HashSet[AnnotationSyntax]()

    /// ADR-0184 / issue #376: validates that `@UnscopedRef` sits on a shape
    /// where it means something — a non-`shared` instance member declared
    /// in a struct body or on an interface — and reports GS0590 otherwise.
    /// Silent when the attribute is absent.
    /// @param function The member to validate.
    private func ValidateUnscopedRefPlacement(function FunctionSymbol) {
        let annotation BoundAttribute? = FindUnscopedRefAttribute(function.Attributes)
        if annotation == nil {
            return
        }
        let reason string? = DescribeUnscopedRefRejection(function)
        if reason != nil {
            reportedUnscopedRefDiagnostics.Add(annotation.Syntax)
            Diagnostics.ReportUnscopedRefInvalidTarget(annotation.Syntax.Location, reason)
            return
        }
        if function.OverriddenMethod is {} overriddenMethod {
            ValidateUnscopedRefContract(
                function,
                RequiresUnscopedRefContract(overriddenMethod, function),
                overriddenMethod.HasUnscopedRef,
                "overridden member '${overriddenMethod.Name}'"
            )
        } else if function.ExternalOverriddenMethod is {} externalOverriddenMethod {
            ValidateUnscopedRefContract(
                function,
                RequiresUnscopedRefContract(externalOverriddenMethod, function),
                RefCapabilities.HasUnscopedRef(externalOverriddenMethod),
                "overridden member '${externalOverriddenMethod.DeclaringType?.Name}.${externalOverriddenMethod.Name}'"
            )
        }
    }

    /// ADR-0184 / issue #376: the property/indexer spelling of
    /// (cref:ValidateUnscopedRefPlacement(FunctionSymbol)). G# spells
    /// the annotation on the property, never on an individual accessor, so the
    /// property's own shape is what gets validated.
    /// @param property The property or indexer to validate.
    /// @param owner The declaring type.
    private func ValidateUnscopedRefPlacement(property PropertySymbol, owner TypeSymbol?) {
        let annotation BoundAttribute? = FindUnscopedRefAttribute(property.Attributes)
        if annotation == nil {
            return
        }
        let reason string? = if property.IsStatic {
            "requires an instance member; a 'shared' (static) member has no receiver to un-scope"
        } else {
            (
                if owner is InterfaceSymbol {
                    default(string?)
                } else {
                    (
                        if !(owner is StructSymbol && owner.IsClass == false) {
                            "requires a struct instance member; a class receiver is a reference that already outlives the call"
                        } else {
                            default(string?)
                        }
                    )
                }
            )
        }
        if reason != nil {
            reportedUnscopedRefDiagnostics.Add(annotation.Syntax)
            Diagnostics.ReportUnscopedRefInvalidTarget(annotation.Syntax.Location, reason)
            return
        }
        if property.OverriddenProperty is {} overriddenProperty {
            ValidateUnscopedRefPropertyContract(
                property,
                overriddenProperty,
                owner,
                "overridden property '${overriddenProperty.Name}'"
            )
        } else if property.ExternalOverriddenGetter != nil || property.ExternalOverriddenSetter != nil {
            ValidateUnscopedRefPropertyContract(
                property,
                property.ExternalOverriddenGetter,
                property.ExternalOverriddenSetter,
                owner,
                "overridden property '${property.ExternalOverrideContainingType?.Name}.${property.Name}'"
            )
        }
        // ADR-0184 §8: the annotation is spelled once, on the property, and
        // pushed down to the accessors — which are built with `declaration:
        // null` and never get an attribute list of their own, so they cannot
        // answer for themselves. Matches C#, which accepts `[UnscopedRef]` on
        // the property or either accessor; imported lookup reads all three
        // metadata placements.
        property.GetterSymbol?.MarkUnscopedRef()
        property.SetterSymbol?.MarkUnscopedRef()
    }

    /// Issue #4292: enforces C#'s CS9102-compatible one-way slot rule.
    /// An implementation may remove `@UnscopedRef`, but may not add it
    /// to an interface slot that does not advertise it. Override compatibility
    /// is checked only for signatures where C# performs scoped ref-safety
    /// validation.
    private func ValidateUnscopedRefContract(
        implementation FunctionSymbol,
        enforceContract bool,
        slotHasUnscopedRef bool,
        slotDescription string
    ) -> ValidateUnscopedRefContract(
        FindUnscopedRefAttribute(implementation.Attributes),
        enforceContract,
        slotHasUnscopedRef,
        slotDescription
    )

    private func ValidateUnscopedRefContract(
        implementationAttribute BoundAttribute?,
        enforceContract bool,
        slotHasUnscopedRef bool,
        slotDescription string
    ) {
        if implementationAttribute != nil &&
            enforceContract &&
            !slotHasUnscopedRef &&
            reportedUnscopedRefDiagnostics
            .Add(implementationAttribute.Syntax) {
            Diagnostics.ReportUnscopedRefInvalidTarget(
                implementationAttribute.Syntax.Location,
                "cannot be applied because $slotDescription does not have @UnscopedRef"
            )
        }
    }

    private func ValidateUnscopedRefPropertyContract(
        implementation PropertySymbol,
        slot PropertySymbol,
        implementationReceiver TypeSymbol?,
        slotDescription string,
        typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]? = nil,
        enforceInterfaceContract bool = false
    ) {
        let annotation = FindUnscopedRefAttribute(implementation.Attributes)
        ValidateUnscopedRefAccessorContract(
            annotation,
            slot,
            implementation,
            implementationReceiver,
            isSetter: false,
            slotDescription + " getter",
            typeParameterMap,
            enforceInterfaceContract
        )
        ValidateUnscopedRefAccessorContract(
            annotation,
            slot,
            implementation,
            implementationReceiver,
            isSetter: true,
            slotDescription + " setter",
            typeParameterMap,
            enforceInterfaceContract
        )
    }

    private func ValidateUnscopedRefPropertyContract(
        implementation PropertySymbol,
        slotGetter MethodInfo?,
        slotSetter MethodInfo?,
        implementationReceiver TypeSymbol?,
        slotDescription string,
        enforceInterfaceContract bool = false
    ) {
        let annotation = FindUnscopedRefAttribute(implementation.Attributes)
        ValidateUnscopedRefAccessorContract(
            annotation,
            slotGetter,
            implementation,
            implementationReceiver,
            isSetter: false,
            slotDescription + " getter",
            enforceInterfaceContract
        )
        ValidateUnscopedRefAccessorContract(
            annotation,
            slotSetter,
            implementation,
            implementationReceiver,
            isSetter: true,
            slotDescription + " setter",
            enforceInterfaceContract
        )
    }

    private func ValidateUnscopedRefAccessorContract(
        implementationAttribute BoundAttribute?,
        slot PropertySymbol,
        implementation PropertySymbol,
        implementationReceiver TypeSymbol?,
        isSetter bool,
        slotDescription string,
        typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]?,
        enforceInterfaceContract bool
    ) {
        var implementationReceiver = implementationReceiver
        let slotHasAccessor = if isSetter {
            slot.HasSetter
        } else {
            slot.HasGetter
        }
        let implementationHasAccessor = if isSetter {
            implementation.HasSetter
        } else {
            implementation.HasGetter
        }
        if !slotHasAccessor || !implementationHasAccessor {
            return
        }
        let slotAccessor = if isSetter {
            slot.SetterSymbol
        } else {
            slot.GetterSymbol
        }
        let implementationAccessor = if isSetter {
            implementation.SetterSymbol
        } else {
            implementation.GetterSymbol
        }
        implementationReceiver = implementationAccessor?.ReceiverType ?? implementationReceiver
        let contractIsRelevant = RequiresUnscopedRefPropertyContract(
            slot,
            if implementation.IsStatic {
                default(TypeSymbol?)
            } else {
                implementationReceiver
            },
            isSetter,
            typeParameterMap
        )
        ValidateUnscopedRefContract(
            implementationAttribute,
            enforceInterfaceContract || contractIsRelevant,
            slotAccessor?.HasUnscopedRef == true || KnownAttributes.HasUnscopedRef(slot.Attributes),
            slotDescription
        )
    }

    private func ValidateUnscopedRefAccessorContract(
        implementationAttribute BoundAttribute?,
        slot MethodInfo?,
        implementation PropertySymbol,
        implementationReceiver TypeSymbol?,
        isSetter bool,
        slotDescription string,
        enforceInterfaceContract bool
    ) {
        if slot == nil ||
            !(
            if isSetter {
                implementation.HasSetter
            } else {
                implementation.HasGetter
            }
        ) {
            return
        }
        let implementationAccessor = if isSetter {
            implementation.SetterSymbol
        } else {
            implementation.GetterSymbol
        }
        let contractIsRelevant = enforceInterfaceContract ||
            RequiresUnscopedRefContract(
            slot,
            if isSetter {
                TypeSymbol.Void
            } else {
                implementation.Type
            },
            GetPropertyAccessorParameters(implementation, isSetter),
            if implementation.IsStatic {
                default(TypeSymbol?)
            } else {
                implementationAccessor?.ReceiverType ?? implementationReceiver
            }
        )
        ValidateUnscopedRefContract(
            implementationAttribute,
            contractIsRelevant,
            RefCapabilities.HasUnscopedRef(slot),
            slotDescription
        )
    }

    private func ValidateUnscopedRefParameter(parameter ParameterSymbol) {
        let annotation BoundAttribute? = FindUnscopedRefAttribute(parameter.Attributes)
        if annotation == nil {
            return
        }
        parameter.MarkUnscopedRef()
        let reason string? = GetUnscopedRefParameterRejection(parameter)
        if reason != nil && reportedUnscopedRefDiagnostics.Add(annotation.Syntax) {
            Diagnostics.ReportUnscopedRefInvalidTarget(annotation.Syntax.Location, reason)
        }
    }

    /// Resolves a list of (cref:AnnotationSyntax) nodes against the
    /// declaring scope and returns the bound attribute list per ADR-0047.
    /// @param annotations Annotations from the declaration's syntax node.
    /// @param defaultTarget Default target inferred from the declaration position.
    /// @param allowedTargets Target kinds permitted at this declaration position.
    /// @param positionDescription Human-readable position for diagnostics.
    /// @param defaultSystemTarget CLR-side (cref:System.AttributeTargets)
    /// value used when validating `[AttributeUsage(ValidOn)]` for the
    /// `Type` kind, which is ambiguous in source.
    /// @returns The resolved attribute list (skipping unresolved entries).
    internal func BindAttributes(
        annotations ImmutableArray[AnnotationSyntax],
        defaultTarget AttributeTargetKind,
        allowedTargets ImmutableHashSet[AttributeTargetKind],
        positionDescription string,
        defaultSystemTarget AttributeTargets
    ) ImmutableArray[BoundAttribute] {
        if annotations.IsDefaultOrEmpty {
            return ImmutableArray[BoundAttribute].Empty
        }
        let builder = ImmutableArray.CreateBuilder[BoundAttribute](annotations.Length)
        // Track applications per (attribute-type identity, effective target)
        // so we can fire GS0210 when AllowMultiple = false. We key on the
        // resolved TypeSymbol (reference identity is sufficient — each
        // attribute class has a single Symbol instance).
        let applications = Dictionary[(Type TypeSymbol, Target AttributeTargetKind), int32]()
        for annotation in annotations {
            // Phase 4 of #141 / ADR-0047 §5: the `@Attribute` marker on a
            // class declaration is sugar — it does NOT participate in the
            // emitted CustomAttribute table. The struct binder consumes it
            // separately via HasAttributeSugarMarker.
            if defaultTarget == AttributeTargetKind.Type && IsAttributeSugarMarker(annotation) {
                continue
            }
            // ADR-0186 §9: `@Oblivious` / `@NullabilityEnabled` are
            // compiler-intrinsic, like `@SuppressDiagnostic`: no CLR attribute
            // type, no metadata of their own. `ObliviousScope` reads them
            // straight from the syntax tree when a type clause inside them is
            // bound; here they are only validated and consumed. Intercepted
            // at the list level rather than in BindAttribute because the
            // "both on one declaration" check needs the siblings.
            if ObliviousScope.IsScopeAnnotation(annotation) {
                ObliviousScope.Validate(annotation, annotations, Diagnostics)
                continue
            }
            // Issue #3336: merged partial annotations retain the declaring part's tree.
            let bindingScope = $scope
            let previousTree = bindingScope.SetCurrentReferencingSyntaxTree(annotation.SyntaxTree)
            try {
                let bound BoundAttribute? = BindAttribute(
                    annotation,
                    defaultTarget,
                    allowedTargets,
                    positionDescription,
                    defaultSystemTarget
                )
                if bound != nil {
                    let key = (bound.AttributeType, bound.Target)
                    if applications.TryGetValue(key, out var count) {
                        KnownAttributes.GetAttributeUsage(bound.AttributeType, out _, out var allowMultiple)
                        if !allowMultiple {
                            Diagnostics.ReportAttributeUsageDuplicate(
                                GetAnnotationNameLocation(annotation),
                                annotation.GetNameText()
                            )
                        }
                        applications[key] = count + 1
                    } else {
                        applications[key] = 1
                    }
                    builder.Add(bound)
                }
            } finally {
                bindingScope.SetCurrentReferencingSyntaxTree(previousTree)
            }
        }
        return builder.ToImmutable()
    }

    private func BindAttribute(
        annotation AnnotationSyntax,
        defaultTarget AttributeTargetKind,
        allowedTargets ImmutableHashSet[AttributeTargetKind],
        positionDescription string,
        defaultSystemTarget AttributeTargets
    ) BoundAttribute? {
        // 0) ADR-0175 (#3820/#3824): `@SuppressDiagnostic("ID", …)` is
        // compiler-intrinsic. It has no CLR attribute type — so a compilation
        // needs no extra assembly reference to write one — and it produces no
        // metadata; the analyzer driver reads it straight from the syntax tree.
        // Validate its arguments here and consume it.
        if DiagnosticSuppressionMap.IsSuppressDiagnostic(annotation) {
            ValidateSuppressDiagnostic(annotation, Diagnostics)
            return nil
        }
        // Issue #4234: `@ExtensionOwner(typeof(T))` is likewise compiler-
        // intrinsic — cs2gs synthesizes it on a lifted top-level extension
        // function to say which migrated C# static class originally
        // declared it, so the emitter can host the MethodDef on that
        // class's TypeDef instead of the package's `<Program>` (matching
        // the native assembly's metadata shape for reflection/analyzer
        // owner-identity checks). It has no CLR attribute type and produces
        // no metadata of its own; DeclarationBinder.Functions.cs resolves
        // and consumes the `typeof` argument directly from the syntax.
        if IsExtensionOwnerAnnotation(annotation) {
            return nil
        }
        // 1) Resolve target — parser already filtered to canonical kinds; if
        // the user wrote an unrecognised one a GS0197 was already reported,
        // but we still need to map a parsed-but-unknown string back to a
        // sentinel. The closed set keys off ADR-0047 §2.
        var targetKind = defaultTarget
        if annotation.Target != nil {
            if TryParseTargetKind(annotation.Target.KindIdentifier.ValueText, out var parsedTarget) {
                targetKind = parsedTarget
            } else {
                // Already reported by the parser; treat as default and continue.

            }
            if !allowedTargets.Contains(targetKind) {
                Diagnostics.ReportAttributeTargetInvalidForPosition(
                    annotation.Target!!.KindIdentifier.Location,
                    annotation.Target!!.KindIdentifier.ValueText,
                    positionDescription
                )
            }
        }
        // 2) Resolve attribute type (C#-style: `Foo` then `FooAttribute`).
        let nameText = annotation.GetNameText()
        var nameIsExact bool
        let attrType TypeSymbol? = if annotation.HasTypeArgumentList {
            this.ResolveGenericAttributeType(nameText, annotation, out nameIsExact)
        } else {
            ResolveAttributeType(nameText, annotation, out nameIsExact)
        }
        if attrType == nil {
            return nil
        }
        // 3) Validate it derives from System.Attribute.
        if !IsAttributeType(attrType) {
            let displayName = if nameIsExact {
                nameText
            } else {
                (nameText + "Attribute")
            }
            Diagnostics.ReportNotAnAttributeType(GetAnnotationNameLocation(annotation), displayName)
            return nil
        }
        // 3a) Reject user-written instances of attributes ADR-0047 §6
        // reserves for compiler synthesis (Extension, AsyncStateMachine,
        // CompilerGenerated, Nullable, NullableContext). Recognition is
        // type-identity based on the resolved CLR type so renaming or
        // shadowing the source-level name cannot bypass the rule.
        if (
            KnownAttributes.IsReservedForCompiler(attrType.ClrType) ||
                EmbeddedAttributeSource.IsSourceNullabilityAttribute(attrType)
        ) &&
            !EmbeddedAttributeSource
            .IsSyntheticTree(annotation.SyntaxTree) {
            Diagnostics.ReportAttributeReservedForCompiler(GetAnnotationNameLocation(annotation), nameText)
            return nil
        }
        // 3a.1) ADR-0086 / issue #727: the blanket rejection of @DllImport
        // (formerly GS0211, ADR-0047 §6) is removed. Well-formed P/Invoke
        // declarations bind normally here; the function-declaration binder
        // (BindFunctionDeclaration) then drives the P/Invoke pipeline:
        // validates the function shape (no body, no instance/async/generic),
        // extracts the @DllImport metadata into PInvokeMetadata, and reports
        // GS0322–GS0329 on any malformed input. The emitter picks up
        // function.PInvokeMetadata to write the ImplMap row.
        // 3b) Issue #177 / ADR-0047 §6: enforce [AttributeUsage(ValidOn)].
        // For the `Type` target the actual CLR target depends on the kind
        // of type being declared (class/struct/enum/interface), which the
        // caller passes via defaultSystemTarget. For all other targets the
        // effective CLR target is derived directly from targetKind, since
        // any use-site qualifier (`@return:` etc.) already narrows it.
        let effectiveSystemTarget = MapToSystemAttributeTargets(targetKind, defaultSystemTarget)
        KnownAttributes.GetAttributeUsage(attrType, out var validOn, out _)
        if (validOn & effectiveSystemTarget) == 0 {
            Diagnostics.ReportAttributeUsageInvalidTarget(
                GetAnnotationNameLocation(annotation),
                nameText,
                positionDescription,
                validOn
            )
            return nil
        }
        // 4) Bind arguments — positional + named — restricted to compile-time
        // constants. Named arguments come back from ParseArguments as
        // NamedArgumentExpressionSyntax wrappers.
        let positional = ImmutableArray.CreateBuilder[BoundAttributeArgument]()
        let named = ImmutableArray.CreateBuilder[BoundAttributeArgument]()
        var sawMemberAssignment = false
        if annotation.Arguments != nil {
            for argSyntax in annotation.Arguments {
                if argSyntax is NamedArgumentExpressionSyntax namedArg {
                    // Issue #1921 code review (GS0466): the emitter can only
                    // write named args against an already-emitted CLR type
                    // (it resolves the target member via reflection); a
                    // same-compilation user attribute has no ClrType yet, so
                    // reject named args on it here instead of silently
                    // dropping them at emit time.
                    let isMemberAssignment = namedArg.EqualsToken.Kind == SyntaxKind.EqualsToken
                    let isConstructorArgument = !isMemberAssignment &&
                        IsAttributeConstructorParameterName(attrType, namedArg.NameToken.ValueText)
                    if attrType is StructSymbol{ClrType: nil} userAttribute && !isConstructorArgument {
                        Diagnostics.ReportNamedArgumentsNotSupportedOnUserAttribute(
                            namedArg.NameToken.Location,
                            if nameIsExact {
                                nameText
                            } else {
                                (nameText + "Attribute")
                            },
                            namedArg.NameToken.ValueText
                        )
                        continue
                    }
                    if !TryBindAttributeArgument(namedArg.Expression, out var value, out var valueType) {
                        Diagnostics.ReportAttributeArgumentNotConstant(namedArg.Expression.Location)
                        continue
                    }
                    let argument = BoundAttributeArgument(
                        namedArg.NameToken.ValueText,
                        value,
                        valueType!!,
                        namedArg,
                        isMemberAssignment
                    )
                    if isConstructorArgument {
                        if sawMemberAssignment {
                            Diagnostics.ReportAttributeConstructorArgumentAfterMemberAssignment(
                                namedArg.NameToken.Location
                            )
                            continue
                        }
                        positional.Add(argument)
                    } else {
                        sawMemberAssignment = true
                        named.Add(argument)
                    }
                } else {
                    if sawMemberAssignment {
                        Diagnostics.ReportAttributeConstructorArgumentAfterMemberAssignment(argSyntax.Location)
                        continue
                    }
                    if !TryBindAttributeArgument(argSyntax, out var value, out var valueType) {
                        Diagnostics.ReportAttributeArgumentNotConstant(argSyntax.Location)
                        continue
                    }
                    positional.Add(BoundAttributeArgument(name: nil, value, valueType!!, argSyntax))
                }
            }
        }
        return BoundAttribute(annotation, attrType, targetKind, positional.ToImmutable(), named.ToImmutable())
    }

    // Issue #1913: resolves a C# 11-style generic attribute application
    // (`@Tag[int32]`) to its CLOSED attribute type. Mirrors
    // <see cref="ResolveAttributeType"/>'s exact-then-`Attribute`-suffixed
    // two-try lookup, but existence is probed via the silent, arity-aware
    // `scope.TryLookupTypeAlias` (no diagnostics on a miss) exactly the way
    // <see cref="TryResolveUserNestedTypeExpression"/> gates a speculative
    // generic-type probe elsewhere — so trying the exact name first and
    // falling back to the suffixed name never reports a spurious
    // "type not found" for the name that loses. Once the winning name is
    // picked, the real close-the-generic-type work is delegated to the SAME
    // `bindTypeClause` callback an ordinary generic type reference
    // (`List[int32]`) already goes through, by building a synthetic
    // `TypeClauseSyntax` out of the annotation's own tokens — no separate
    // generic-attribute-construction logic to maintain.
    private func ResolveGenericAttributeType(
        name string,
        annotation AnnotationSyntax,
        out nameIsExact bool
    ) TypeSymbol? {
        nameIsExact = true
        let nameLocation = GetAnnotationNameLocation(annotation)
        let arity = Invariant.Required(
            annotation.TypeArguments,
            "a generic attribute has a type-argument list",
            expression: "annotation.TypeArguments"
        )
            .Count
        var simpleName = name
        let dotIndex = if string.IsNullOrEmpty(name) {
            -1
        } else {
            name.LastIndexOf('.')
        }
        if dotIndex >= 0 {
            simpleName = name.Substring(dotIndex + 1)
        }
        var direct TypeSymbol? = nil
        if dotIndex < 0 {
            $scope.TryLookupTypeAlias(simpleName, arity, out direct)
        } else {
            direct = ResolveNestedAttributeName(name, arity)
        }
        var suffixed TypeSymbol? = nil
        var suffixedName string? = nil
        if !string.IsNullOrEmpty(simpleName) && !simpleName.EndsWith("Attribute", StringComparison.Ordinal) {
            suffixedName = if dotIndex >= 0 {
                string.Concat(name.Substring(0, dotIndex + 1), simpleName, "Attribute")
            } else {
                simpleName + "Attribute"
            }
            if dotIndex < 0 {
                $scope.TryLookupTypeAlias(suffixedName!!, arity, out suffixed)
            } else {
                suffixed = ResolveNestedAttributeName(suffixedName!!, arity)
            }
        }
        if IsAttributeType(direct) && IsAttributeType(suffixed) {
            Diagnostics.ReportAmbiguousAttributeName(nameLocation, name)
        }
        var resolvedLastSegment string
        if IsAttributeType(direct) {
            nameIsExact = true
            resolvedLastSegment = simpleName
        } else if suffixed != nil {
            nameIsExact = false
            resolvedLastSegment = simpleName + "Attribute"
        } else if direct != nil {
            nameIsExact = true
            resolvedLastSegment = simpleName
        } else if dotIndex < 0 {
            Diagnostics.ReportAttributeTypeNotFound(nameLocation, name)
            return nil
        } else {
            // Dotted/qualified generic attribute name (e.g.
            // `System.Foo<int>`): no local-scope suffix retry applies, so try
            // the exact spelling and let `bindTypeClause` report GS0113 if it
            // doesn't resolve.
            resolvedLastSegment = simpleName
        }
        let syntheticTypeClause = BuildSyntheticGenericAttributeTypeClause(annotation, resolvedLastSegment)
        return bindTypeClause(syntheticTypeClause)
    }

    private func ResolveAttributeType(name string, annotation AnnotationSyntax, out nameIsExact bool) TypeSymbol? {
        let nameLocation = GetAnnotationNameLocation(annotation)
        nameIsExact = true
        // Issue #1206: resolve the verbatim name and the C#-style
        // `<simple-name>Attribute` suffixed name. The suffix is appended to the
        // final simple-name segment only — for a qualified name `Ns.Foo` the
        // candidate is `Ns.FooAttribute`, never `Ns.FooAttribute` with a doubled
        // `Attribute`, and a name whose simple part already ends in `Attribute`
        // is not suffixed at all. Both the simple-identifier form (honoring
        // imports/aliases via LookupType) and the dotted/qualified form (resolved
        // by full name against the reference set, the same machinery used for
        // qualified type references such as `System.IntPtr`) are supported.
        let direct TypeSymbol? = ResolveAttributeName(name)
        var simpleName = name
        let dotIndex = if string.IsNullOrEmpty(name) {
            -1
        } else {
            name.LastIndexOf('.')
        }
        if dotIndex >= 0 {
            simpleName = name.Substring(dotIndex + 1)
        }
        var suffixed TypeSymbol? = nil
        if !string.IsNullOrEmpty(simpleName) && !simpleName.EndsWith("Attribute", StringComparison.Ordinal) {
            let suffixedName = if dotIndex >= 0 {
                string.Concat(name.Substring(0, dotIndex + 1), simpleName, "Attribute")
            } else {
                simpleName + "Attribute"
            }
            suffixed = ResolveAttributeName(suffixedName)
        }
        if direct != nil && IsAttributeType(direct) && suffixed != nil && IsAttributeType(suffixed) {
            Diagnostics.ReportAmbiguousAttributeName(nameLocation, name)
            return direct
        }
        // Issue #2261: C# attribute-name resolution (ECMA-334 §22.3) discards
        // an exact-name candidate that does not itself derive from
        // System.Attribute and falls back to the `Attribute`-suffixed
        // candidate instead of reporting it non-attribute — the two names can
        // legitimately coexist in the same assembly (e.g. CommunityToolkit.Mvvm
        // ships both the `RelayCommand` ICommand class and the
        // `RelayCommandAttribute` marker consumed by its source generator).
        // Only when the exact-name candidate genuinely derives from Attribute
        // do we prefer it outright.
        if direct != nil && IsAttributeType(direct) {
            nameIsExact = true
            return direct
        }
        if suffixed != nil {
            nameIsExact = false
            return suffixed
        }
        // Neither resolved candidate derives from System.Attribute (or only the
        // exact name resolved at all): keep the original "not an attribute
        // type" diagnostic shape by returning the exact-name candidate when it
        // exists.
        if direct != nil {
            nameIsExact = true
            return direct
        }
        Diagnostics.ReportAttributeTypeNotFound(nameLocation, name)
        return nil
    }

    // Issue #1206: resolves a (possibly dotted) attribute name to a TypeSymbol.
    // The simple-identifier form goes through LookupType so imports and aliases
    // are honored; the qualified/dotted form (e.g. `System.Obsolete`,
    // `System.Runtime.InteropServices.DllImport`) is resolved by full name
    // against the reference set — the same resolution used for qualified type
    // references elsewhere (e.g. `System.IntPtr`).
    private func ResolveAttributeName(name string) TypeSymbol? {
        if string.IsNullOrEmpty(name) {
            return nil
        }
        var resolved TypeSymbol? = lookupType(name)
        if resolved != nil {
            return resolved
        }
        if name.IndexOf('.') >= 0 {
            resolved = ResolveNestedAttributeName(name)
            if resolved != nil {
                return resolved
            }
            if $scope.References!!.TryResolveType(name, out var clrType) && clrType != nil {
                return TypeSymbol.FromClrTypeWithoutNullability(clrType, NullabilityFreeReason.ResolvedTypeName)
            }
        }
        return nil
    }

    private func ResolveNestedAttributeName(name string, preferredArity int32 = -1) TypeSymbol? {
        let segments = name.Split('.')
        if segments.Length < 2 {
            return nil
        }
        for var outerIndex = 0; outerIndex < segments.Length - 1; outerIndex++ {
            var current TypeSymbol? = lookupType(segments[outerIndex])
            if current == nil || !QualifierMatchesContainingNamespace(current, segments, outerIndex) {
                continue
            }
            var resolved = true
            for var i = outerIndex + 1; i < segments.Length; i++ {
                let arity = if i == segments.Length - 1 {
                    preferredArity
                } else {
                    -1
                }
                if $scope.TryLookupNestedTypeAlias(current, segments[i], arity, out var nested) {
                    current = nested
                    continue
                }
                if current is StructSymbol container && $scope.TryLookupNestedTypeAliasIncludingInherited(
                    container,
                    segments[i],
                    arity,
                    out nested,
                    out _
                ) {
                    current = nested
                    continue
                }
                let containingType Type? = current!!.ClrType
                var nestedClrType Type? = nil
                if containingType != nil && arity > 0 {
                    $scope.References!!.TryResolveNestedType(
                        containingType,
                        segments[i] + "`" + arity.ToString(),
                        out nestedClrType
                    )
                }
                if containingType == nil ||
                    (
                    nestedClrType == nil && !$scope.References!!.TryResolveNestedType(
                        containingType,
                        segments[i],
                        out nestedClrType
                    )
                ) {
                    resolved = false
                    break
                }
                current = TypeSymbol.FromClrTypeWithoutNullability(
                    nestedClrType,
                    NullabilityFreeReason.ResolvedTypeName
                )
            }
            if resolved {
                return current!!
            }
        }
        return nil
    }

    private func QualifierMatchesContainingNamespace(type TypeSymbol, segments[]string, typeIndex int32) bool {
        if typeIndex == 0 {
            return true
        }
        let containingNamespace string? = switch type {
            case structure is StructSymbol: structure.PackageName
            case enum_ is EnumSymbol: enum_.PackageName
            case interface_ is InterfaceSymbol: interface_.PackageName
            case delegate is DelegateTypeSymbol: delegate.PackageName
            default: type.ClrType?.Namespace
        }
        if containingNamespace == nil {
            return false
        }
        let qualifier = string.Join(".", segments, 0, typeIndex)
        if string.Equals(qualifier, containingNamespace, StringComparison.Ordinal) {
            return true
        }
        if !$scope.TryLookupImport(segments[0], out var import_) || !import_!!.IsAlias {
            return false
        }
        let expandedQualifier = if typeIndex == 1 {
            import_!!.Target
        } else {
            import_!!.Target + "." + string.Join(".", segments, 1, typeIndex - 1)
        }
        return string.Equals(expandedQualifier, containingNamespace, StringComparison.Ordinal)
    }

    private func IsAttributeType(typeSymbol TypeSymbol?) bool -> IsAttributeType(typeSymbol, HashSet[TypeSymbol]())

    private func IsAttributeType(typeSymbol TypeSymbol?, visited HashSet[TypeSymbol]) bool {
        if typeSymbol == nil || !visited.Add(typeSymbol) {
            return false
        }
        // Issue #1921: a same-compilation user class deriving from
        // System.Attribute (via either the `@Attribute` sugar or a plain
        // `: Attribute` / `: System.Attribute` base clause) has no CLR type
        // yet — it hasn't been emitted — so ClrType is null and the CLR
        // base-chain walk below can't see it. StructSymbol.DerivesFromSystemAttribute
        // walks the symbol-level BaseClass chain instead of relying on ClrType.
        if typeSymbol is StructSymbol structSym {
            if structSym.DerivesFromSystemAttribute() {
                return true
            }
            if structSym.Declaration != nil {
                for baseClause in structSym.Declaration!!.BaseTypeClauses {
                    if IsAttributeType(bindTypeClause(baseClause), visited) {
                        return true
                    }
                }
            }
            return false
        }
        let clr Type? = typeSymbol?.ClrType
        if clr == nil {
            return false
        }
        let attributeFullName = typeof(Attribute).FullName
        var t Type? = clr
        while t != nil {
            if t.FullName == attributeFullName {
                return true
            }
            t = t.BaseType
        }
        return false
    }

    /// Issue #4143 code review: a side-effect-free stand-in for
    /// `IsAttributeType`, safe to call DURING declaration
    /// binding (from `BindStructBaseAndInterfaces` /
    /// `BindConstructorDeclarations`), where a same-compilation base
    /// may not have had its own body bound yet.
    /// @remarks `IsAttributeType` falls back to `bindTypeClause`
    /// when a base's (cref:StructSymbol.DerivesFromSystemAttribute)
    /// flags are not yet set — correct for its own USE-site caller, which
    /// runs once every declaration already exists. Calling THAT fallback
    /// during declaration binding re-resolves a base clause that is either
    /// still being bound or belongs to an unrelated, non-attribute class,
    /// and for a GENERIC base (an open type parameter in scope elsewhere,
    /// not yet visible from here) it reported a spurious "Type '...' doesn't
    /// exist" — measured: regressed
    /// `Issue1244GenericAbstractOverrideBinderTests`.
    ///
    /// This walks the same shapes using only side-effect-free lookups:
    /// the already-computed (cref:StructSymbol.DerivesFromSystemAttribute)
    /// flags first, then — only when a same-compilation base is a SIMPLE
    /// (non-generic, unqualified) name — the `@Attribute` sugar marker
    /// or a literal `: Attribute` / `: System.Attribute` spelling
    /// on the base's own declaration syntax, and
    /// (cref:BoundScope.TryLookupTypeAlias(string, out TypeSymbol?))
    /// (silent on a miss, unlike `bindTypeClause`) to recurse one level
    /// further when the base names another same-compilation type.
    /// @param structSymbol The struct/class symbol to test.
    /// @param visited Cycle guard across the recursive walk.
    /// @returns `true` when the symbol is or derives from (cref:System.Attribute).
    private func DerivesFromSystemAttributeDuringDeclaration(
        structSymbol StructSymbol,
        visited HashSet[StructSymbol]? = nil
    ) bool {
        var visited = visited
        visited ??= HashSet[StructSymbol]()
        if !visited!!.Add(structSymbol) {
            return false
        }
        if structSymbol.DerivesFromSystemAttribute() {
            return true
        }
        if structSymbol.Declaration is not{} declaration {
            return false
        }
        if HasAttributeSugarMarker(declaration.Annotations) {
            return true
        }
        for baseClause in declaration.BaseTypeClauses {
            if baseClause.HasTypeArguments {
                // A generic base is either an in-scope type parameter (never
                // an attribute base) or a constructed generic (G# does not
                // support a same-compilation generic attribute base); either
                // way, resolving it needs the general binder, which is
                // exactly what must be avoided here.
                continue
            }
            let name = GetBaseClauseTypeDisplayName(baseClause)
            if (name is "Attribute" or "System.Attribute") {
                return true
            }
            if name.Contains('.', StringComparison.Ordinal) {
                // A qualified name needs full resolution to find; not worth
                // chasing for this narrow, order-of-declaration gap.
                continue
            }
            if $scope.TryLookupTypeAlias(name, out var resolved) &&
                resolved is StructSymbol baseStruct &&
                DerivesFromSystemAttributeDuringDeclaration(baseStruct, visited) {
                return true
            }
        }
        return false
    }

    /// Issue #4143 (C#'s CS0181): reports
    /// (cref:DiagnosticDescriptors.AttributeConstructorParameterInvalidType)
    /// for every parameter of an attribute class's constructor whose declared
    /// type is not a valid attribute parameter type
    /// ((cref:IsValidAttributeParameterType)). Called once for the
    /// primary constructor and once per explicit `init(...)` overload —
    /// each is a distinct constructor `csc` would check independently.
    /// @param parameters The constructor's parameters.
    /// @param fallbackLocation Used when a parameter has no declaring syntax of its own (not
    /// expected for a source-written parameter, but kept defensive rather
    /// than throwing).
    private func ValidateAttributeConstructorParameterTypes(
        parameters ImmutableArray[ParameterSymbol],
        fallbackLocation TextLocation
    ) {
        if parameters.IsDefaultOrEmpty {
            return
        }
        for parameter in parameters {
            // Code review (Copilot): an explicit `init(...)` parameter whose
            // type failed to resolve is bound as `TypeSymbol.Error` (see
            // `BindSingleConstructorDeclaration`) rather than dropped, so it
            // reaches here alongside the GS0113 (or similar) already
            // reported for the unresolved name. Reporting GS0585 too named
            // a misleading `type '?'` on top of the real diagnostic.
            if parameter.Type == nil || parameter.Type == TypeSymbol.Error {
                continue
            }
            if !IsValidAttributeParameterType(parameter.Type) {
                let location = parameter.DeclaringSyntax?.Location ?? fallbackLocation
                Diagnostics.ReportAttributeConstructorParameterInvalidType(
                    location,
                    parameter.Name,
                    parameter.Type.Name
                )
            }
        }
    }

    /// Tries to bind an attribute argument expression as a compile-time
    /// constant value of one of the shapes permitted by ECMA-335 II.23.3 /
    /// ADR-0047 §3: literal (numeric, char, string, bool, nil), a
    /// `typeof(T)` expression (carried as the resolved CLR
    /// (cref:Type)), or a single-dimensional array literal of any
    /// supported element shape. Returns `false` for any expression the
    /// emitter cannot serialise.
    /// @param syntax The argument expression.
    /// @param value The extracted compile-time value when the method returns `true`.
    /// @param type The static type carried by the argument when the method returns `true`.
    /// @returns `true` if the expression maps to a supported attribute constant; otherwise `false`.
    private func TryBindAttributeArgument(
        syntax ExpressionSyntax,
        out value object?,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool {
        value = nil
        type = nil
        switch syntax {
            case literal is LiteralExpressionSyntax {
                if bindExpression(literal) is BoundLiteralExpression bl {
                    value = bl.Value
                    type = bl.Type
                    return true
                }
                return false
            }
            case typeOfSyntax is TypeOfExpressionSyntax {
                if bindTypeOfExpression(typeOfSyntax) is BoundTypeOfExpression bt &&
                    bt.OperandType is {} operandType &&
                    (
                    operandType.ClrType != nil ||
                        (operandType is StructSymbol or InterfaceSymbol or EnumSymbol or DelegateTypeSymbol)
                ) &&
                    CanSerializeAttributeTypeOperand(operandType) {
                    // Issue #4073: a constructed generic over a same-compilation
                    // type ALWAYS has a non-null `ClrType` — the erased close is
                    // a real closed type — and that CLR type names the SURROGATE
                    // (`System.Int32` for a source enum, `System.Object` for a
                    // source class). Preferring it wrote
                    // `JsonStringEnumConverter<int32>` into the blob and
                    // reflection materialisation refused the instantiation. The
                    // symbolic type is the only thing that still knows what the
                    // author wrote, so hand THAT to the encoder whenever the CLR
                    // shape is not faithful. A fully imported argument
                    // (`Box[int32]`) is faithful and keeps the CLR path byte for
                    // byte, which is what the control rows pin.
                    value = if AttributeTypeArgumentIsErased(operandType) {
                        cast[object](operandType)
                    } else {
                        (
                            if operandType.ClrType is {} clrType {
                                cast[object](clrType)
                            } else {
                                cast[object](operandType)
                            }
                        )
                    }
                    type = bt.Type
                    return true
                }
                return false
            }
            case arraySyntax is ArrayCreationExpressionSyntax {
                return TryBindAttributeArrayArgument(arraySyntax, out value, out type)
            }
            case unarySyntax is UnaryExpressionSyntax {
                if bindExpression(unarySyntax) is {} boundUnary &&
                    boundUnary.Type is {} unaryType &&
                    ConstantExpressionEvaluator.TryEvaluate(boundUnary, out var foldedValue) &&
                    foldedValue != nil &&
                    IsSerialisableAttributeConstant(unaryType) {
                    value = foldedValue
                    type = unaryType
                    return true
                }
                return false
            }
            case binarySyntax is BinaryExpressionSyntax {
                if bindExpression(binarySyntax) is {} boundBinary &&
                    boundBinary.Type is {} binaryType &&
                    ConstantExpressionEvaluator.TryEvaluate(boundBinary, out var foldedBinary) &&
                    foldedBinary != nil &&
                    IsSerialisableAttributeConstant(binaryType) {
                    value = foldedBinary
                    type = binaryType
                    return true
                }
                return false
            }
        }
        // Issue #177: accept BoundLiteralExpression whose static type is an
        // enum (e.g. `AttributeTargets.Method`) — required by [AttributeUsage]
        // and other enum-valued attribute arguments. The emitter serialises
        // the underlying primitive per ECMA-335 II.23.3. Other expressions
        // that incidentally fold to a constant (e.g. `nameof(...)`) remain
        // out of scope here; they go through GS0202.
        let bound = bindExpression(syntax)
        if bound is {Type: {} constantType} &&
            (
            bound is BoundConversionExpression ||
                (
                (syntax is CallExpressionSyntax || syntax is AccessorExpressionSyntax) &&
                    constantType
                    .ClrType
                    ?.IsPrimitive == true
            )
        ) &&
            IsSerialisableAttributeConstant(constantType) &&
            ConstantExpressionEvaluator.TryEvaluate(bound, out var convertedValue) && convertedValue != nil {
            value = convertedValue
            type = constantType
            return true
        }
        // CLR literal fields already bind through ordinary qualified member lookup.
        // Accept their serialisable types, including string and its null constant.
        if bound is BoundLiteralExpression lit &&
            IsValidAttributeParameterType(lit.Type) &&
            (syntax is AccessorExpressionSyntax || IsEnumLikeType(lit.Type)) {
            value = lit.Value
            type = lit.Type
            return true
        }
        return false
    }

    private func TryBindAttributeArrayArgument(
        syntax ArrayCreationExpressionSyntax,
        out value object?,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool {
        value = nil
        type = nil
        if bindArrayCreationExpression(syntax) is not BoundArrayCreationExpression bound {
            return false
        }
        // Attribute arrays must be a serialisable SZARRAY (1-D) shape over an
        // otherwise-valid attribute parameter type per ECMA-335 II.23.3. Both
        // `[]T{...}` (slice) and `[N]T{...}` (array) qualify. Issue #4144:
        // this used to gate on `bound.Type.ClrType` being a non-null,
        // rank-1 array, which rejected a same-compilation enum element
        // (`[]Status{...}`) — its `ClrType` is null until the enum is
        // emitted, exactly like the SCALAR enum-parameter case #4097 already
        // had to look past. Check the SYMBOL shape instead, via the same
        // predicate #4143's declaration-time check uses, so both a
        // same-compilation and an imported enum element are recognised.
        let elementType TypeSymbol? = GetOneDimensionalArrayElementType(bound.Type)
        if elementType == nil || !IsScalarAttributeParameterType(elementType) {
            return false
        }
        var elements GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax]? = syntax.Elements
        if elements == nil {
            // Issue #4247: `[N]T` with NO initializer at all (not even empty
            // braces `{}`) parses as the runtime/zero-initialised allocation
            // form (issue #1272) — its length lives in
            // `ArrayCreationExpressionSyntax.LengthExpression`, not
            // `LengthToken`/`Elements` — so binding it produces a
            // `BoundArrayCreationExpression` with a length expression and NO
            // element list. This binder unconditionally rejected that shape
            // (GS0202) even for the constant, zero-length spelling `[0]Kind`,
            // although the explicit-empty-initializer spellings `[]Kind{}`
            // and `[0]Kind{}` (which DO populate `Elements`, just with zero
            // items) already worked. A `[0]T` allocation is exactly as
            // constant and serialisable as those — a zero-length SZARRAY —
            // so accept it once its length is confirmed to be the literal
            // constant `0`. Any other runtime length (a variable, or a
            // nonzero constant with no initializer to supply its elements)
            // still has no constant element list to serialize and correctly
            // falls through to GS0202 below.
            var lengthExpr = bound.LengthExpression
            while lengthExpr is BoundConversionExpression lengthConversion {
                lengthExpr = lengthConversion.Expression
            }
            if !(lengthExpr is BoundLiteralExpression && lengthExpr.Value is 0) {
                return false
            }
            elements = GSharp
                .Core
                .CodeAnalysis
                .Syntax
                .SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty)
        }
        // Array.CreateInstance / Convert.ChangeType demand RUNTIME types, but
        // when the compile carries a /r: reference set the element type may be
        // a MetadataLoadContext type (e.g. an imported enum in
        // `@Days([]DayOfWeek{...})`), which threw ArgumentException "Type must
        // be a type provided by the runtime" and aborted the compilation
        // (GS9998; GS9200 through gsgen — issue #3633). The array built here
        // is only a CONTAINER for the constant values — the custom-attribute
        // encoder writes the blob from the SIGNATURE's element type and reads
        // values via Array.GetValue — so a runtime-equivalent container
        // element type is exact.
        var containerElementType Type
        if elementType.ClrType is {} elementClrType {
            containerElementType = ResolveRuntimeContainerElementType(elementClrType)
        } else if IsEnumLikeType(elementType) {
            // Issue #4144: a same-compilation enum element has no `ClrType`
            // until it is emitted. Its underlying type is always `int32`
            // (the fact #4097's scalar fix established), so the container
            // can be built directly without touching `ClrType`.
            containerElementType = typeof(int32)
        } else {
            return false
        }
        // Issue #3684 (family F11): bind every element FIRST, because a
        // `typeof(T)` naming a type declared in THIS compilation has no CLR
        // `Type` yet — `TryBindAttributeArgument` hands back the `TypeSymbol`
        // placeholder instead (the same placeholder the SCALAR `typeof`
        // argument position has always carried, and which
        // `CustomAttributeEncoder.WriteCustomAttributeFixedArg` already
        // serialises). A `Type[]` container cannot hold that placeholder, so
        // `SetValue` threw and `@Property(Arbitrary: []Type{typeof(Local)})`
        // was rejected as non-constant. Widen the CONTAINER to `object[]` in
        // that case; the blob is written from the SIGNATURE's element type, so
        // the container's own element type never reaches metadata.
        let elementValues = [elements.Count]object?
        for var i = 0; i < elements.Count; i++ {
            if !TryBindAttributeArgument(elements[i], out var elementValue, out var valueType) {
                return false
            }
            elementValues[i] = if containerElementType.IsSameAs(typeof(object)) &&
                ShouldPreserveBoxedAttributeElementType(elementValue, valueType!!) {
                cast[object?](BoundAttributeArgument(nil, elementValue, valueType!!))
            } else {
                elementValue
            }
            if elementValue is TypeSymbol {
                containerElementType = typeof(object)
            }
        }
        let result = Array.CreateInstance(containerElementType, elements.Count)
        for var i = 0; i < elements.Count; i++ {
            try {
                result.SetValue(CoerceAttributeElement(elementValues[i], containerElementType), i)
            } catch {
                return false
            }
        }
        value = result
        type = Invariant.Required(
            bound.Type,
            "a bound attribute array has a resolved array type",
            expression: "bound.Type"
        )
        return true
    }

    /// Issue #660: for test-data attributes like xUnit's `@InlineData`,
    /// cross-validates nil (null) positional arguments against the owning
    /// method's parameter types. If a nil is supplied for a non-nullable
    /// parameter, reports GS0274.
    internal func ValidateInlineDataNilArguments(
        attributes ImmutableArray[BoundAttribute],
        parameters ImmutableArray[ParameterSymbol]
    ) {
        for attr in attributes {
            if attr == nil {
                continue
            }
            // Match the InlineDataAttribute by CLR type name (handles any xunit version).
            let clrType = attr.AttributeType?.ClrType
            if clrType?.FullName is not{} fullName || !fullName.EndsWith(
                "InlineDataAttribute",
                StringComparison.Ordinal
            ) {
                continue
            }
            let positional = attr.PositionalArguments
            let annotation AnnotationSyntax? = attr.Syntax
            if annotation == nil || positional.IsDefaultOrEmpty || parameters.IsDefaultOrEmpty {
                continue
            }
            // InlineData's positional arguments are expanded into the params
            // object[] — each positional arg[i] corresponds to method parameter[i].
            let argExpressions = annotation.Arguments
            for var i = 0; i < positional.Length && i < parameters.Length; i++ {
                if positional[i].Value == nil && positional[i].Type == TypeSymbol.Null {
                    let paramType TypeSymbol? = parameters[i].Type
                    if paramType != nil && !(paramType is NullableTypeSymbol) {
                        // Get the source location of the nil literal in the argument list.
                        let argLocation = if i < argExpressions.Count {
                            argExpressions[i].Location
                        } else {
                            annotation.Location
                        }
                        Diagnostics.ReportNilNotAssignableToNonNullableParameter(
                            argLocation,
                            parameters[i].Name,
                            paramType.Name
                        )
                    }
                }
            }
        }
    }

    shared {
        /// Phase 4 of #141 / ADR-0047 §5: returns true if any annotation in the
        /// list is the bare `@Attribute` sugar marker (single-segment name
        /// `Attribute`, no use-site target qualifier).
        /// @param annotations Annotations from the declaration's syntax node.
        /// @returns True if the marker is present.
        private func HasAttributeSugarMarker(annotations ImmutableArray[AnnotationSyntax]) bool {
            if annotations.IsDefaultOrEmpty {
                return false
            }
            for annotation in annotations {
                // ADR-0047 §5: the sugar marker is exactly `@Attribute` (no
                // use-site target qualifier; no arguments; single-segment name).
                if annotation.Target != nil {
                    continue
                }
                if annotation.NameSegments.Length != 1 {
                    continue
                }
                if annotation.NameSegments[0].Text == "Attribute" {
                    return true
                }
            }
            return false
        }

        internal func RequiresUnscopedRefPropertyContract(
            slot PropertySymbol,
            implementationReceiver TypeSymbol?,
            isSetter bool,
            typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]?
        ) bool {
            let slotAccessor FunctionSymbol? = if isSetter {
                slot.SetterSymbol
            } else {
                slot.GetterSymbol
            }
            var returnType = slotAccessor?.Type ??
                (
                if isSetter {
                    TypeSymbol.Void
                } else {
                    slot.Type
                }
            )
            var parameters = if slotAccessor == nil {
                GetPropertyAccessorParameters(slot, isSetter)
            } else {
                GetCallableParameters(slotAccessor)
            }
            if typeParameterMap != nil {
                returnType = StructSymbol.SubstituteTypeParameters(returnType, typeParameterMap)!!
                parameters = SubstituteParameterTypes(parameters, typeParameterMap)
            }
            return RequiresUnscopedRefContract(
                returnType,
                slotAccessor?.ReturnRefKind ??
                    (
                    if isSetter {
                        RefKind.None
                    } else {
                        slot.ReturnRefKind
                    }
                ),
                parameters,
                implementationReceiver
            )
        }

        private func SubstituteParameterTypes(
            parameters ImmutableArray[ParameterSymbol],
            typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]
        ) ImmutableArray[ParameterSymbol] {
            let substituted = ImmutableArray.CreateBuilder[ParameterSymbol](parameters.Length)
            for parameter in parameters {
                substituted.Add(
                    ParameterSymbol(
                        parameter,
                        StructSymbol.SubstituteTypeParameters(parameter.Type, typeParameterMap)!!
                    )
                )
            }
            return substituted.MoveToImmutable()
        }

        private func RequiresUnscopedRefContract(
            slot FunctionSymbol,
            implementation FunctionSymbol
        ) bool -> RequiresUnscopedRefContract(slot, implementation.ReceiverType)

        private func RequiresUnscopedRefContract(
            slot FunctionSymbol,
            implementationReceiver TypeSymbol?
        ) bool -> RequiresUnscopedRefContract(
            slot.Type,
            slot.ReturnRefKind,
            GetCallableParameters(slot),
            implementationReceiver
        )

        private func RequiresUnscopedRefContract(
            slot MethodInfo,
            implementation FunctionSymbol
        ) bool -> RequiresUnscopedRefContract(
            slot,
            implementation.Type,
            GetCallableParameters(implementation),
            implementation.ReceiverType
        )

        private func RequiresUnscopedRefContract(
            slot MethodInfo,
            implementationReturnType TypeSymbol,
            implementationParameters ImmutableArray[ParameterSymbol],
            implementationReceiver TypeSymbol?
        ) bool {
            let slotParameters = slot.GetParameters()
            let parameters = ImmutableArray.CreateBuilder[ParameterSymbol](slotParameters.Length)
            for var i = 0; i < slotParameters.Length && i < implementationParameters.Length; i++ {
                parameters.Add(
                    RefCapabilities.CreateParameterSymbol(slotParameters[i], implementationParameters[i].Type, "arg$i")
                )
            }
            return RequiresUnscopedRefContract(
                implementationReturnType,
                RefCapabilities.GetReturnRefKind(slot),
                parameters.ToImmutable(),
                implementationReceiver
            )
        }

        private func GetPropertyAccessorParameters(property PropertySymbol, isSetter bool) ImmutableArray[
            ParameterSymbol
        ] -> if isSetter {
            property.Parameters.Add(ParameterSymbol(property.SetterParameterName, property.Type))
        } else {
            property.Parameters
        }

        internal func RequiresUnscopedRefContract(
            returnType TypeSymbol,
            returnRefKind RefKind,
            parameters ImmutableArray[ParameterSymbol],
            implementationReceiver TypeSymbol?
        ) bool {
            if parameters.Any(
                (parameter ParameterSymbol) -> TypeSymbol.IsByRefLike(parameter.Type) &&
                    (
                    (
                        parameter.RefKind == RefKind.Ref &&
                            parameter.GetEffectiveRefScope() != ParameterRefScope.FunctionLocal
                    ) ||
                        (
                        parameter.RefKind == RefKind.Out &&
                            parameter.GetEffectiveRefScope() == ParameterRefScope.FunctionLocal
                    )
                )
            ) {
                return true
            }
            var requiredByReferenceParameters int32
            if (implementationReceiver != nil && TypeSymbol.IsByRefLike(implementationReceiver)) ||
                TypeSymbol.IsByRefLike(returnType) ||
                returnRefKind == RefKind.Ref ||
                returnRefKind == RefKind.RefReadOnly {
                requiredByReferenceParameters = 1
            } else if parameters.Any(
                (parameter ParameterSymbol) -> (parameter.RefKind is RefKind.Ref or RefKind.Out) &&
                    TypeSymbol.IsByRefLike(parameter.Type)
            ) {
                requiredByReferenceParameters = 2
            } else {
                return false
            }
            let byReferenceParameterCount = parameters.Count(
                (parameter ParameterSymbol) -> (
                    parameter.RefKind is RefKind.Ref or RefKind.In or RefKind.RefReadOnly or RefKind.Out
                )
            )
            return byReferenceParameterCount >= requiredByReferenceParameters || parameters.Any(
                (parameter ParameterSymbol) -> parameter.RefKind == RefKind.None && TypeSymbol.IsByRefLike(
                    parameter.Type
                )
            )
        }

        /// ADR-0184: returns the `@UnscopedRef` entry of a bound attribute list,
        /// or `null`. The bound node carries the annotation syntax, so
        /// it doubles as the diagnostic location.
        /// @param attributes The symbol's bound attribute list.
        /// @returns The matching bound attribute, or `null`.
        private func FindUnscopedRefAttribute(
            attributes ImmutableArray[BoundAttribute]
        ) BoundAttribute? -> if attributes.IsDefaultOrEmpty {
            default(BoundAttribute?)
        } else {
            attributes.FirstOrDefault((attribute BoundAttribute) -> KnownAttributes.IsUnscopedRef(attribute))
        }

        internal func GetUnscopedRefParameterRejection(
            parameter ParameterSymbol
        ) string? -> if parameter.RefKind == RefKind.None {
            "requires a 'ref', 'out', or 'in' parameter"
        } else {
            (
                if parameter.IsScoped {
                    "cannot be applied to a parameter with an explicit 'scoped' modifier"
                } else {
                    default(string?)
                }
            )
        }

        /// ADR-0184 / issue #376: the shape rules behind GS0590, as a phrase
        /// completing "'@UnscopedRef' <reason>.", or `null`
        /// when the placement is legal.
        /// @param function The member to classify.
        /// @returns The rejection phrase, or `null`.
        private func DescribeUnscopedRefRejection(function FunctionSymbol) string? {
            // NOTE: there is deliberately no constructor/`init` arm. A G#
            // constructor binds no annotations at all (DeclarationBinder.Constructors
            // never calls BindAttributes), and an `init` accessor — like every
            // property accessor — has no attribute list of its own, so neither shape
            // can reach this method carrying @UnscopedRef.
            if function.IsStatic {
                return "requires an instance member; a 'shared' (static) member has no receiver to un-scope"
            }
            // ADR-0182: a receiver clause always declares an EXTENSION, whose
            // receiver is an ordinary by-value parameter rather than a CLR `ref S`
            // `this`. Un-scoping it would hand out a reference into the extension's
            // own stack copy.
            // `IsExtension` is only stamped later in the declaration pass, and the
            // pure-extension shape is built with neither a ReceiverType nor an
            // ExplicitReceiverParameter, so the syntax-level receiver clause is the
            // marker that is already final here.
            if function
                .Declaration
                ?.Receiver != nil ||
                function.ExplicitReceiverParameter != nil ||
                function
                .IsExtension {
                return "cannot be applied to a receiver-clause function; ADR-0182 makes every receiver clause an extension, whose receiver is an ordinary by-value parameter"
            }
            if function.ContainingType is InterfaceSymbol {
                if function.Accessibility == Accessibility.Private {
                    return "requires a virtual interface instance member; a private interface helper has no implementation slot"
                }
                return nil
            }
            if function.ReceiverType is not(StructSymbol and {IsClass: false}) {
                return "requires a struct instance member; a class receiver is a reference that already outlives the call, and a free function has no receiver at all"
            }
            return nil
        }

        /// Phase 4 of #141 / ADR-0047 §5: returns true if [`annotation`](paramref)
        /// is the bare `@Attribute` sugar marker.
        /// @param annotation The annotation node to test.
        /// @returns True for the marker.
        private func IsAttributeSugarMarker(annotation AnnotationSyntax?) bool {
            if annotation == nil || annotation.Target != nil {
                return false
            }
            if annotation.NameSegments.Length != 1 {
                return false
            }
            return annotation.NameSegments[0].Text == "Attribute"
        }

        /// ADR-0175 (#3820/#3824): checks a `@SuppressDiagnostic` annotation's
        /// arguments. Every argument must be a constant string with the shape of a
        /// diagnostic ID; anything else is reported as GS9305 and contributes no
        /// suppression. A typo'd ID that silently suppresses nothing is exactly the
        /// failure mode this feature exists to close, so the shape is diagnosed
        /// even though the ID set itself cannot be validated (an analyzer that
        /// declares it may simply not be referenced by this project).
        /// @param annotation The annotation to check.
        /// @param diagnostics The bag to report into.
        internal func ValidateSuppressDiagnostic(annotation AnnotationSyntax, diagnostics DiagnosticBag) {
            // `Arguments` is a nullable reference on the syntax node: an annotation
            // written without a parenthesised list (`@SuppressDiagnostic`) has none,
            // which is itself a GS9305 — it names no ID.
            if annotation.Arguments == nil || annotation.Arguments.Count == 0 {
                diagnostics.ReportSuppressDiagnosticInvalidId(annotation.AtToken.Location, "<none>")
                return
            }
            for argument in annotation.Arguments {
                let text string? = if argument is LiteralExpressionSyntax literal {
                    literal.Value as string
                } else {
                    default(string?)
                }
                if !DiagnosticSuppressionMap.IsWellFormedId(text) {
                    diagnostics.ReportSuppressDiagnosticInvalidId(argument.Location, text ?? argument.ToString() ?? "?")
                }
            }
        }

        /// Issue #4234: returns `true` when [`annotation`](paramref)
        /// is the compiler-intrinsic `@ExtensionOwner`/`@ExtensionOwnerAttribute`
        /// lead-in, checked purely by name like `@SuppressDiagnostic` — it has no
        /// backing CLR attribute type to resolve against.
        /// @param annotation The annotation to check.
        /// @returns `true` when the annotation is `@ExtensionOwner`.
        internal func IsExtensionOwnerAnnotation(annotation AnnotationSyntax) bool {
            if annotation.HasTypeArgumentList {
                return false
            }
            let name = annotation.GetNameText()
            return string.Equals(name, "ExtensionOwner", StringComparison.Ordinal) || string.Equals(
                name,
                "ExtensionOwnerAttribute",
                StringComparison.Ordinal
            )
        }

        private func IsAttributeConstructorParameterName(attributeType TypeSymbol, name string) bool {
            if attributeType is StructSymbol{ClrType: nil} userAttribute {
                if userAttribute.HasPrimaryConstructor && userAttribute.PrimaryConstructorParameters.Any(
                    (parameter ParameterSymbol) -> parameter.Name == name
                ) {
                    return true
                }
                return userAttribute.EffectiveExplicitConstructors.Any(
                    (constructor ConstructorSymbol) -> constructor.Parameters.Any(
                        (parameter ParameterSymbol) -> parameter.Name == name
                    )
                )
            }
            if attributeType.ClrType is not{} clrType {
                return false
            }
            for constructor in clrType.GetConstructors(BindingFlags.Public | BindingFlags.Instance) {
                let parameters = constructor.GetParameters()
                let parameterNames = parameters.Select((parameter ParameterInfo) -> parameter.Name ?? string.Empty)
                    .ToArray()
                if parameters.Any(
                    (parameter ParameterInfo) -> parameter.Name == name || SyntaxFacts.GetEmittedIdentifier(
                        parameter.Name ?? string.Empty,
                        IdentifierNameContext.Parameter,
                        parameterNames
                    ) == name
                ) {
                    return true
                }
            }
            return false
        }

        // Issue #1913: builds the `TypeClauseSyntax` that `ResolveGenericAttributeType`
        // feeds to `bindTypeClause`, reusing the annotation's own name/type-argument
        // tokens verbatim (only the LAST segment's identifier may need renaming for
        // the `Attribute`-suffix retry — the suffix retry only ever fires for a
        // single-segment name, so no other segment ever needs renaming).
        private func BuildSyntheticGenericAttributeTypeClause(
            annotation AnnotationSyntax,
            lastSegmentText string
        ) TypeClauseSyntax {
            let segments = annotation.NameSegments
            let lastIndex = segments.Length - 1
            let lastSegmentToken = segments[lastIndex]
            let renamedLast = if lastSegmentToken.Text == lastSegmentText {
                lastSegmentToken
            } else {
                SyntaxToken(
                    annotation.SyntaxTree,
                    SyntaxKind.IdentifierToken,
                    lastSegmentToken.Position,
                    lastSegmentText,
                    nil
                )
            }
            let identifier = if lastIndex == 0 {
                renamedLast
            } else {
                segments[0]
            }
            let qualifierIdentifiers = if lastIndex == 0 {
                ImmutableArray[SyntaxToken].Empty
            } else {
                segments.RemoveAt(0).SetItem(lastIndex - 1, renamedLast)
            }
            return TypeClauseSyntax(
                annotation.SyntaxTree,
                openBracketToken: nil,
                lengthToken: nil,
                closeBracketToken: nil,
                identifier,
                annotation.DotTokens,
                qualifierIdentifiers,
                annotation.TypeArgumentOpenBracketToken,
                annotation.TypeArguments,
                annotation.TypeArgumentCloseBracketToken,
                questionToken: nil
            )
        }

        private func GetAnnotationNameLocation(annotation AnnotationSyntax) TextLocation {
            if !annotation.NameSegments.IsDefaultOrEmpty {
                let first = annotation.NameSegments[0]
                let last = annotation.NameSegments[annotation.NameSegments.Length - 1]
                let span = TextSpan.FromBounds(first.Span.Start, last.Span.End)
                return TextLocation(annotation.SyntaxTree.Text, span)
            }
            return annotation.Location
        }

        private func IsEnumLikeType(type TypeSymbol) bool {
            if type is EnumSymbol {
                return true
            }
            // Issue #2327: `type.ClrType` may be a
            // System.Reflection.Emit.TypeBuilderInstantiation whose `IsEnum`
            // throws NotSupportedException. Route through the shared safe
            // helper (generalizing the #1100/#2135 pattern established in
            // Conversion.IsEnumLikeType / IsInterfaceLikeType) rather than
            // probing `ClrType.IsEnum` directly.
            return type?.ClrType is {} clrType && clrType.IsEnumSafe()
        }

        // Issue #2831: the CLR custom-attribute blob (ECMA-335 II.23.3) can carry
        // only primitives, `string`, `System.Type` and enums, so a folded constant
        // is accepted as an attribute argument only when its static type is one of
        // those serialisable shapes.
        private func IsSerialisableAttributeConstant(type TypeSymbol) bool {
            if IsValidAttributeParameterType(type) {
                return true
            }
            // `decimal` folds via the same unary/binary constant evaluator as any
            // other numeric literal but — unlike the shapes above — is not
            // itself a valid attribute parameter/argument type (ECMA-335 II.23.3
            // has no ELEMENT_TYPE tag for it; `csc` reports CS0181 for a
            // `decimal`-typed attribute constructor parameter). This is a
            // pre-existing allowance kept as-is rather than folded into the
            // shared predicate below, which #4143/#4144 define against what
            // `csc`/ECMA-335 actually accept.
            let clr Type? = type?.ClrType
            return clr != nil && clr.IsSameAs(typeof(decimal))
        }

        /// Issue #4143 / #4144: returns `true` when [`type`](paramref)
        /// is a valid attribute parameter/argument type per ECMA-335 II.23.3 and
        /// C#'s CS0181 — a primitive, `string`, `System.Type`,
        /// `object`, an enum, or a 1-D array thereof. This is the SHARED
        /// predicate #4143's declaration-time check (GS0585) uses for a
        /// constructor parameter's declared type and GS0202's argument-binding
        /// path uses for a folded argument's type, rather than each spelling out
        /// the list independently.
        /// @param type The type to test.
        /// @returns `true` when the type is a valid attribute parameter/argument shape.
        internal func IsValidAttributeParameterType(type TypeSymbol?) bool {
            if GetOneDimensionalArrayElementType(type) is {} elementType {
                return IsScalarAttributeParameterType(elementType)
            }
            return IsScalarAttributeParameterType(type)
        }

        /// Returns [`type`](paramref)'s element type when it is a 1-D array
        /// shape ((cref:SliceTypeSymbol) or a fixed-length
        /// (cref:ArrayTypeSymbol)); `null` for a scalar
        /// type or a multi-dimensional (cref:RectangularArrayTypeSymbol)
        /// (ECMA-335 II.23.3 permits only a 1-D array as an attribute argument).
        private func GetOneDimensionalArrayElementType(type TypeSymbol?) TypeSymbol? -> switch type {
            case slice is SliceTypeSymbol: slice.ElementType
            case array is ArrayTypeSymbol: array.ElementType
            default: default(TypeSymbol?)
        }

        private func IsScalarAttributeParameterType(type TypeSymbol?) bool {
            if type == nil {
                return false
            }
            if IsEnumLikeType(type) {
                return true
            }
            let clr Type? = type.ClrType
            return clr != nil && !clr.IsSameAs(typeof(nint)) && !clr.IsSameAs(typeof(nuint)) &&
                (
                clr.IsPrimitive || clr.IsSameAs(typeof(string)) || clr.IsSameAs(typeof(Type)) || clr.IsSameAs(
                    typeof(object)
                )
            )
        }

        private func TryParseTargetKind(text string, out kind AttributeTargetKind) bool {
            switch text {
                case "field" {
                    kind = AttributeTargetKind.Field
                    return true
                }
                case "param" {
                    kind = AttributeTargetKind.Param
                    return true
                }
                case "return" {
                    kind = AttributeTargetKind.Return
                    return true
                }
                case "type" {
                    kind = AttributeTargetKind.Type
                    return true
                }
                case "method" {
                    kind = AttributeTargetKind.Method
                    return true
                }
                case "property" {
                    kind = AttributeTargetKind.Property
                    return true
                }
                case "event" {
                    kind = AttributeTargetKind.Event
                    return true
                }
                case "module" {
                    kind = AttributeTargetKind.Module
                    return true
                }
                case "assembly" {
                    kind = AttributeTargetKind.Assembly
                    return true
                }
                case "genericparam" {
                    kind = AttributeTargetKind.GenericParam
                    return true
                }
                default {
                    kind = AttributeTargetKind.Method
                    return false
                }
            }
        }

        /// Issue #177: maps a GSharp (cref:AttributeTargetKind) to the
        /// corresponding CLR (cref:System.AttributeTargets) flag used by
        /// (cref:System.AttributeUsageAttribute). The `Type` kind
        /// is intentionally ambiguous in GSharp (class/struct/enum/interface
        /// share a single source-level position), so the caller supplies the
        /// concrete CLR target via [`typePositionFallback`](paramref).
        private func MapToSystemAttributeTargets(
            kind AttributeTargetKind,
            typePositionFallback AttributeTargets
        ) AttributeTargets {
            switch kind {
                case AttributeTargetKind.Field {
                    return AttributeTargets.Field
                }
                case AttributeTargetKind.Param {
                    return AttributeTargets.Parameter
                }
                case AttributeTargetKind.Return {
                    return AttributeTargets.ReturnValue
                }
                case AttributeTargetKind.Method {
                    return AttributeTargets.Method
                }
                case AttributeTargetKind.Property {
                    return AttributeTargets.Property
                }
                case AttributeTargetKind.Event {
                    return AttributeTargets.Event
                }
                case AttributeTargetKind.Module {
                    return AttributeTargets.Module
                }
                case AttributeTargetKind.Assembly {
                    return AttributeTargets.Assembly
                }
                case AttributeTargetKind.GenericParam {
                    return AttributeTargets.GenericParameter
                }
                case AttributeTargetKind.Type {
                    return typePositionFallback
                }
                default {
                    return AttributeTargets.All
                }
            }
        }

        /// Issue #4073: returns `true` when a `typeof` operand's
        /// CLR (cref:Type) is the type-ERASED surrogate rather than the type
        /// the author named, so the custom-attribute blob must be written from the
        /// SYMBOL instead.
        /// @remarks The condition is exactly "a same-compilation type appears
        /// somewhere in this type" — at the top level (where `ClrType` is
        /// already `null` and the symbolic path was always taken) or
        /// at any structural position inside a constructed generic, a slice, an
        /// array or a nilable, where the surrogate hides behind a perfectly real
        /// closed `ClrType`.
        ///
        /// Deliberately NOT `RequiresSymbolicProjection`, which also
        /// answers `true` for a reference-nullable annotation
        /// (`typeof(Box[string?])`). That annotation is metadata over a type
        /// whose CLR shape is entirely faithful, and ECMA-335 II.23.3 has nowhere to
        /// put it; routing that shape onto the symbolic writer would change a
        /// correct blob for no gain.
        /// @param type The bound `typeof` operand.
        /// @returns `true` when the CLR projection is a surrogate.
        private func AttributeTypeArgumentIsErased(type TypeSymbol) bool -> type.ClrType == nil ||
            TypeSymbol.ContainsSameCompilationUserType(type)

        /// Issue #4095: returns `true` when a `typeof` operand
        /// names a type the custom-attribute blob can describe, so an operand whose
        /// identity still depends on an in-scope type parameter is rejected as a
        /// non-constant argument (`GS0202`) rather than approximated.
        /// @remarks Once the serializer writes the ENCLOSING argument vector of a
        /// nested type, an operand such as `Outer[T].Inner` inside a generic
        /// declaration would serialize the type parameter itself, and no such name
        /// resolves. Before #4095 the same operand silently took the CLR path and
        /// wrote the ERASED close, which is a different closed type from the one the
        /// source names — a wrong answer rather than a rejected one.
        ///
        /// An UNBOUND generic DEFINITION stays legal and is admitted before
        /// the type-parameter test runs: `typeof(Box[_])` and
        /// `typeof(Outer[_].Inner)` denote the open definition, which
        /// ECMA-335 II.23.3 describes and reflection reifies. Their type parameters
        /// are the definition's own, not an argument borrowed from an enclosing
        /// scope.
        ///
        /// Nothing else is filtered here. Every shape the serializer already
        /// described before #4095 — a slice, an array, a nilable, a construction
        /// over a same-compilation type — keeps the path it had, which is what the
        /// `Issue4073GenericAttributeTypeArgumentTests` rows pin.
        /// @param type The bound `typeof` operand.
        /// @returns `true` when the operand can be serialized.
        private func CanSerializeAttributeTypeOperand(type TypeSymbol) bool -> TypeSymbol.IsUnboundGenericDefinition(
            type
        ) ||
            !TypeSymbol.ContainsTypeParameter(type)

        private func ShouldPreserveBoxedAttributeElementType(value object?, type TypeSymbol) bool {
            if IsEnumLikeType(type) {
                return true
            }
            let arrayElementType TypeSymbol? = GetOneDimensionalArrayElementType(type)
            if arrayElementType == nil {
                return false
            }
            if IsEnumLikeType(arrayElementType) {
                return true
            }
            return value is Array array && array.GetType().GetElementType() is {} runtimeElementType &&
                arrayElementType.ClrType is {} declaredElementType &&
                !runtimeElementType.IsSameAs(ResolveRuntimeContainerElementType(declaredElementType))
        }

        /// Maps a possibly-MetadataLoadContext array element type onto the
        /// runtime type used for the constant-container array: MLC-loaded enums
        /// map to their (runtime) underlying integral, other MLC types map to
        /// their runtime twin by full name, and anything unmappable falls back to
        /// (cref:object) (always a valid container element).
        /// @param elementClrType The signature's array element type.
        /// @returns A runtime-provided element type for the container array.
        private func ResolveRuntimeContainerElementType(elementClrType Type) Type {
            if !elementClrType.Assembly.ReflectionOnly {
                return elementClrType
            }
            try {
                let lookupType = if elementClrType.IsEnum {
                    Enum.GetUnderlyingType(elementClrType)
                } else {
                    elementClrType
                }
                return Type.GetType(lookupType.FullName ?? string.Empty) ?? typeof(object)
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return typeof(object)
            }
        }

        private func CoerceAttributeElement(value object?, elementType Type) object? {
            if value == nil || elementType.IsInstanceOfType(value) {
                return value
            }
            if elementType.IsEnum {
                // Issue #4144: `value` is the enum's boxed UNDERLYING primitive
                // (the binder's enum-literal arm always stores that, never a
                // boxed enum instance — see `TryBindAttributeArgument`).
                // Converting it to the underlying type (as this used to do)
                // left a boxed `int`, and `Array.SetValue` refuses to store an
                // `int` into a real (non-reflection-only) enum-typed array
                // slot — "Object cannot be stored in an array of this type" —
                // which silently surfaced as GS0202 on a legal program.
                // `Enum.ToObject` produces the actual boxed enum instance the
                // array slot needs.
                return Enum.ToObject(elementType, value)
            }
            // Numeric / char widening between primitives (e.g. int → long).
            return Convert.ChangeType(value, elementType, CultureInfo.InvariantCulture)
        }
    }
}
