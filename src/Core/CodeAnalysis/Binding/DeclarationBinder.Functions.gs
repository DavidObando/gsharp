// <copyright file="DeclarationBinder.Functions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System.Threading

internal partial class DeclarationBinder {
    internal func BindFunctionDeclaration(syntax FunctionDeclarationSyntax, $package PackageSymbol) {
        // ADR-0122 / issue #1014: an `unsafe func` is bound entirely within an
        // unsafe context so its parameter / return types may be unmanaged raw
        // pointers (`*T` → CLR ELEMENT_TYPE_PTR).
        using let unsafeContext = binderCtx.PushUnsafeContext(syntax.IsUnsafe)
        let parameters = ImmutableArray.CreateBuilder[ParameterSymbol]()
        let seenParameterNames = HashSet[string]()
        let previousTypeParameters Dictionary[string, TypeParameterSymbol]? = binderCtx.CurrentTypeParameters
        let ownerTypeParameters = GetGenericOperatorOwnerTypeParameters(syntax, $package)
        if !ownerTypeParameters.IsDefaultOrEmpty {
            this.binderCtx.CurrentTypeParameters = if previousTypeParameters == nil {
                Dictionary[string, TypeParameterSymbol]()
            } else {
                Dictionary[string, TypeParameterSymbol](previousTypeParameters)
            }
            for tp in ownerTypeParameters {
                binderCtx.CurrentTypeParameters!![tp.Name] = tp
            }
        }
        try {
            // Phase 4.1 / ADR-0020: bind generic type parameters first so that
            // BindTypeClause can find them when binding parameter / return types.
            // Issue #2402: an open-self operator declaration (`Box[T]`) uses the
            // owner's type parameters, published above, rather than declaring a
            // generic operator method.
            let typeParameters = BindTypeParameterList(syntax.TypeParameterList)
            if !typeParameters.IsDefaultOrEmpty {
                let functionTypeParameterScope = if binderCtx.CurrentTypeParameters == nil {
                    Dictionary[string, TypeParameterSymbol]()
                } else {
                    Dictionary[string, TypeParameterSymbol](binderCtx.CurrentTypeParameters!!)
                }
                for tp in typeParameters {
                    functionTypeParameterScope[tp.Name] = tp
                }
                this.binderCtx.CurrentTypeParameters = functionTypeParameterScope
            }
            BindFunctionDeclarationCore(syntax, $package, typeParameters, parameters, seenParameterNames)
        } finally {
            this.binderCtx.CurrentTypeParameters = previousTypeParameters
        }
    }

    private func GetGenericOperatorOwnerTypeParameters(
        syntax FunctionDeclarationSyntax,
        $package PackageSymbol
    ) ImmutableArray[TypeParameterSymbol] {
        if syntax.IsExtension && syntax.Identifier.ValueText.StartsWith("op_", StringComparison.Ordinal) {
            return if syntax.Receiver is {Type: {} receiverType} {
                TryGetOpenSelfTypeParameters(receiverType, $package)
            } else {
                ImmutableArray[TypeParameterSymbol].Empty
            }
        }
        if syntax.IsConversionOperator {
            if syntax.Parameters.Count > 0 {
                let sourceOwner = TryGetOpenSelfTypeParameters(syntax.Parameters[0].Type, $package)
                if !sourceOwner.IsDefaultOrEmpty {
                    return sourceOwner
                }
            }
            return TryGetOpenSelfTypeParameters(syntax.Type, $package)
        }
        return ImmutableArray[TypeParameterSymbol].Empty
    }

    private func TryGetOpenSelfTypeParameters(syntax TypeClauseSyntax?, $package PackageSymbol?) ImmutableArray[
        TypeParameterSymbol
    ] {
        // ADR-0187 / issue #4350: a top-level `?` on the owner (`ManagedRef[T]?`,
        // C#'s `ManagedRef<T>?` operand of a reference-type operator) names
        // the same generic owner, so it opens the same type parameters.
        if syntax == nil ||
            syntax.HasQualifier ||
            !syntax.HasTypeArguments ||
            syntax.IsArray ||
            syntax.IsParenthesizedNullable ||
            syntax.Identifier == nil {
            return ImmutableArray[TypeParameterSymbol].Empty
        }
        let identifier SyntaxToken? = syntax.Identifier
        if identifier == nil || syntax.TypeArguments is not{} typeArguments || !$scope.TryLookupTypeAlias(
            identifier.ValueText,
            typeArguments.Count,
            out var candidate
        ) ||
            candidate is not StructSymbol candidateStruct {
            return ImmutableArray[TypeParameterSymbol].Empty
        }
        let owner = candidateStruct.Definition ?? candidateStruct
        if $package == nil ||
            !owner.IsGenericDefinition ||
            owner
            .TypeParameters
            .Length != syntax.TypeArguments!!.Count ||
            !string.Equals(owner.PackageName, $package.Name, StringComparison.Ordinal) {
            return ImmutableArray[TypeParameterSymbol].Empty
        }
        for var i = 0; i < owner.TypeParameters.Length; i++ {
            let argument = syntax.TypeArguments!![i]
            if argument.Identifier == nil ||
                argument.HasQualifier ||
                argument.HasTypeArguments ||
                argument.IsArray ||
                argument.IsNullable ||
                argument.IsParenthesizedNullable ||
                argument.IsTuple ||
                argument.IsFunction ||
                argument.IsMap ||
                argument.IsChannel ||
                argument.IsPointer ||
                argument.IsSequence ||
                argument
                .Identifier
                .ValueText != owner
                .TypeParameters[i]
                .Name {
                return ImmutableArray[TypeParameterSymbol].Empty
            }
        }
        return owner.TypeParameters
    }

    private func BindFunctionDeclarationCore(
        syntax FunctionDeclarationSyntax,
        $package PackageSymbol,
        typeParameters ImmutableArray[TypeParameterSymbol],
        parameters ImmutableArray[ParameterSymbol].Builder,
        seenParameterNames HashSet[string]
    ) {
        let receiverBinding = BindFunctionReceiver(syntax, $package, parameters, seenParameterNames)
        if !receiverBinding.Succeeded {
            return
        }
        let receiverType TypeSymbol? = receiverBinding.ReceiverType
        let explicitReceiverParameter = receiverBinding.ExplicitReceiverParameter
        let methodReceiverStruct StructSymbol? = receiverBinding.MethodReceiverStruct
        let parameterSymbolBySyntax = BindFunctionParameters(syntax, parameters, seenParameterNames)
        let returnBinding = BindFunctionReturn(syntax, parameterSymbolBySyntax)
        let type = returnBinding.ReturnType
        let typeIsValueTask = returnBinding.TypeIsValueTask
        let returnRefKind = returnBinding.ReturnRefKind
        let isAsyncVoid = returnBinding.IsAsyncVoid
        let accessibility = resolveAccessibility(syntax.AccessibilityModifier)
        let functionAttributes = BindFunctionAttributes(syntax, type)
        BindFunctionParameterAttributes(syntax, explicitReceiverParameter, parameterSymbolBySyntax, type)
        // G# follows C#: user-defined operators cannot be method-generic.
        // Generic containing types remain supported: their open owner
        // parameters come from GetGenericOperatorOwnerTypeParameters.
        if !typeParameters.IsDefaultOrEmpty &&
            (syntax.IsConversionOperator || syntax.Identifier.ValueText.StartsWith("op_", StringComparison.Ordinal)) {
            Diagnostics.ReportGenericOperatorNotSupported(
                syntax.TypeParameterList?.Location ?? syntax.Identifier.Location,
                syntax.Identifier.ValueText
            )
            return
        }
        var function FunctionSymbol
        // Issue #1017: a user-defined conversion operator
        // `func operator implicit (x T) U { … }` (or `explicit`) is modelled
        // as a static `op_Implicit` / `op_Explicit` special-name method on
        // the owning user type. It takes exactly one parameter (the source
        // operand) and its return type is the conversion target; at least
        // one of source/target must be a same-package user type.
        if syntax.IsConversionOperator {
            BindConversionOperatorDeclaration(
                syntax,
                parameters.ToImmutable(),
                type,
                accessibility,
                $package,
                functionAttributes
            )
            return
        }
        if methodReceiverStruct != nil {
            // ADR-0182: BindFunctionReceiver only ever populates
            // methodReceiverStruct for an owned-type operator now — an
            // ordinary receiver-clause method is always an extension (see
            // below, `syntax.IsExtension` branch) and has no in-body
            // counterpart to collide with, so there is nothing left to
            // steer here the way ADR-0079's retired GS0314 warning did.
            let methodName = syntax.Identifier.ValueText
            if methodReceiverStruct.IsInline && IsInlineSynthesizedMemberName(methodName) {
                Diagnostics.ReportInlineStructSynthesizedMemberConflict(
                    syntax.Identifier.Location,
                    methodReceiverStruct.Name,
                    methodName
                )
                return
            }
            // Issue #2361: same ToString exception as the in-body form
            // above — a compatible shape falls through as an ordinary
            // receiver-clause method (suppressing the synthesized
            // ToString); an incompatible one gets the more specific
            // GS0487 instead of the blanket GS0232.
            if methodReceiverStruct.IsData &&
                IsDataStructSynthesizedMemberName(methodName) &&
                !IsUserOverridableDataMemberName(methodName) {
                Diagnostics.ReportDataStructSynthesizedMemberConflict(
                    syntax.Identifier.Location,
                    methodReceiverStruct.Name,
                    methodReceiverStruct.IsClass,
                    methodName
                )
                return
            }
            if methodReceiverStruct.IsData &&
                methodName == "ToString" &&
                !IsCompatibleDataToStringOverride(
                syntax.Parameters.Count,
                type,
                returnRefKind,
                syntax.IsAsync,
                syntax.IsUnsafe,
                typeParameters,
                accessibility
            ) {
                Diagnostics.ReportIncompatibleDataToStringOverride(
                    syntax.Identifier.Location,
                    methodReceiverStruct.Name,
                    methodReceiverStruct.IsClass
                )
                return
            }
            if methodReceiverStruct.TryGetField(methodName, out _) {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, methodName)
                return
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
            // Issue #2834 / ADR-0035: a compound-assignment operator
            // (`operator +=` and siblings) is deliberately excluded from the
            // static `op_*` branch above. C# 14 defines it as an INSTANCE,
            // void-returning, single-parameter method that mutates the
            // receiver in place, so it must round-trip through the ordinary
            // instance-method path below — only `IsSpecialName` is added.
            if methodName.StartsWith("op_", StringComparison.Ordinal) && !OperatorNames.IsCompoundAssignmentName(
                methodName
            ) {
                function = FunctionSymbol(
                    methodName,
                    parameters.ToImmutable(),
                    type,
                    syntax,
                    $package,
                    accessibility,
                    receiverType: default(TypeSymbol?)
                )
                function.TypeParameters = typeParameters
                function.IsUnsafe = syntax.IsUnsafe
                function.ReturnRefKind = returnRefKind
                function.IsStatic = true
                function.StaticOwnerType = methodReceiverStruct
                function.IsSpecialName = true
                Binder.AttachDocumentation(function, syntax)
                function.SetAttributes(functionAttributes)
                ValidateInlineDataNilArguments(functionAttributes, function.Parameters)
                ValidateUnscopedRefPlacement(function)
                // Duplicate-signature detection against existing static
                // methods on the receiver (operators live in the static
                // method bucket, not the instance one).
                for existingStatic in methodReceiverStruct.StaticMethods {
                    if BoundScope.FunctionSignaturesEqual(existingStatic, function) {
                        Diagnostics.ReportDuplicateOverloadSignature(
                            syntax.Identifier.Location,
                            methodName,
                            Binder.FormatOverloadSignature(function)
                        )
                        return
                    }
                }
                methodReceiverStruct.AddStaticMethods(ImmutableArray.Create(function))
                PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(syntax, Diagnostics)
                return
            }
            function = FunctionSymbol(
                methodName,
                parameters.ToImmutable(),
                type,
                syntax,
                $package,
                accessibility,
                methodReceiverStruct,
                explicitReceiverParameter
            )
            function.TypeParameters = typeParameters
            function.IsAsync = syntax.IsAsync ||
                (
                isAsyncIteratorReturnType(type) && syntax.Body is {} functionBody && IteratorDetection.ContainsYield(
                    functionBody
                )
            )
            function.IsAsyncVoid = isAsyncVoid
            function.SuspendingKind = if syntax.IsSuspend {
                SuspendingKind.Declared
            } else {
                SuspendingKind.None
            }
            function.AsyncReturnsValueTask = typeIsValueTask || syntax.IsSuspend
            function.IsUnsafe = syntax.IsUnsafe
            function.ReturnRefKind = returnRefKind
            // Issue #2834: the receiver-clause compound-assignment operator
            // stays an ordinary instance method (see above) but must still
            // carry `specialname` so Roslyn and gsc both recognise it as an
            // operator rather than a callable method named `op_…`.
            if OperatorNames.IsCompoundAssignmentName(methodName) {
                function.IsSpecialName = true
                ValidateCompoundAssignmentOperatorShape(syntax, methodName, type, function.Parameters.Length - 1)
            }
            Binder.AttachDocumentation(function, syntax)
            function.SetAttributes(functionAttributes)
            ValidateInlineDataNilArguments(functionAttributes, function.Parameters)
            ValidateUnscopedRefPlacement(function)
            let methodCandidates = ExpandNullableSequenceIteratorSpecializations(function)
            // ADR-0063 §11: detect duplicate-signature against existing methods on the receiver.
            for candidate in methodCandidates {
                for existingMethod in methodReceiverStruct.Methods {
                    if BoundScope.FunctionSignaturesEqual(existingMethod, candidate) {
                        Diagnostics.ReportDuplicateOverloadSignature(
                            syntax.Identifier.Location,
                            methodName,
                            Binder.FormatOverloadSignature(candidate)
                        )
                        return
                    }
                }
            }
            methodReceiverStruct.AddMethods(methodCandidates)
            // ADR-0096 / issue #762: a receiver-clause method is
            // never a P/Invoke (GS0326 would also fire for the
            // shape), so any `@MarshalAs` on a parameter is rejected
            // with GS0360 to make the misuse explicit.
            PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(syntax, Diagnostics)
            return
        }
        function = FunctionSymbol(
            syntax.Identifier.ValueText,
            parameters.ToImmutable(),
            type,
            syntax,
            $package,
            accessibility
        )
        function.TypeParameters = typeParameters
        function.IsAsync = syntax.IsAsync ||
            (isAsyncIteratorReturnType(type) && syntax.Body is {} body && IteratorDetection.ContainsYield(body))
        function.IsAsyncVoid = isAsyncVoid
        function.SuspendingKind = if syntax.IsSuspend {
            SuspendingKind.Declared
        } else {
            SuspendingKind.None
        }
        function.AsyncReturnsValueTask = typeIsValueTask || syntax.IsSuspend
        function.IsUnsafe = syntax.IsUnsafe
        function.ReturnRefKind = returnRefKind
        Binder.AttachDocumentation(function, syntax)
        function.SetAttributes(functionAttributes)
        ValidateInlineDataNilArguments(functionAttributes, function.Parameters)
        // ADR-0184: `function.IsExtension` is set further below (the
        // `syntax.IsExtension` branch), so a receiver-clause function's
        // rejection leans on ExplicitReceiverParameter / ReceiverType instead —
        // both already final here.
        ValidateUnscopedRefPlacement(function)
        // ADR-0086 / issue #727: when @DllImport is present and well-formed,
        // attach the resolved PInvokeMetadata so the emitter wires the
        // ImplMap row and the body-binder skips body binding. If the user
        // wrote `;` but no @DllImport, surface GS0325.
        let isPInvoke = PInvokeBinder.TryAttachPInvokeMetadata(function, syntax, Diagnostics)
        if !isPInvoke && syntax.HasSemicolonBody {
            Diagnostics.ReportSemicolonBodyRequiresDllImport(syntax.Identifier.Location, function.Name)
        }
        // ADR-0096 / issue #762: `@MarshalAs` on a non-P/Invoke
        // parameter has no CLR-defined meaning (it is a pseudo-custom
        // attribute encoded into a FieldMarshal table row, but the
        // managed-call ABI does not consult that row). Report GS0360
        // so the misuse is not silently elided.
        if !isPInvoke {
            PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(syntax, Diagnostics)
        }
        let functions = ExpandNullableSequenceIteratorSpecializations(function)
        if syntax.IsExtension {
            // Issue #4234: cs2gs lifts a migrated C# static extension
            // class's methods to top-level G# extension functions (a
            // receiver-clause func only binds at top level), which drops
            // their CLR owner-type identity — the emitted MethodDef lands
            // on the package's `<Program>` instead of e.g.
            // `ChannelExtensions`, breaking reflection tests and analyzer
            // owner-specific recognition that key off the exact declaring
            // type. `@ExtensionOwner(typeof(T))` lets cs2gs say which
            // same-package class to host the method on instead;
            // resolve it once, up front, since it does not vary per
            // nullable-sequence-iterator specialization below.
            let explicitOwner StructSymbol? = TryResolveExtensionOwnerAnnotation(syntax, $package)
            let declaredOnOwner = if explicitOwner == nil {
                default(ImmutableArray[FunctionSymbol].Builder?)
            } else {
                ImmutableArray.CreateBuilder[FunctionSymbol]()
            }
            // Issue #1188: extension functions overload like ordinary
            // methods and free functions. A collision now means a genuine
            // duplicate signature (same receiver type, name, and callable
            // parameters) — report it as a duplicate-overload-signature
            // error to match the method/free-function path rather than a
            // generic redeclaration.
            for candidate in functions {
                candidate.IsExtension = true
                candidate.ExtensionReceiverType = Binder.SubstituteType(
                    receiverType ?? TypeSymbol.Error,
                    BuildTypeParameterSubstitution(function.TypeParameters, candidate.TypeParameters)
                )
                if candidate.Declaration is {Identifier: {IsMissing: false}} && !$scope.TryDeclareExtensionFunction(
                    candidate
                ) {
                    Diagnostics.ReportDuplicateOverloadSignature(
                        syntax.Identifier.Location,
                        candidate.Name,
                        Binder.FormatOverloadSignature(candidate)
                    )
                    continue
                }
                if explicitOwner != nil {
                    // ADR-0053's static-owner shape, reused as-is: the same
                    // `StaticOwnerType` + owner-registered-methods pairing
                    // that already routes a shared-block static method's
                    // MethodDef onto its declaring class's TypeDef (and, via
                    // the receiver-clause-operator path above, a top-level
                    // declaration's too) now does the same for an extension
                    // function that names its owner explicitly.
                    candidate.IsStatic = true
                    candidate.StaticOwnerType = explicitOwner
                    declaredOnOwner!!.Add(candidate)
                }
            }
            if declaredOnOwner != nil && declaredOnOwner.Count > 0 {
                explicitOwner!!.AddStaticMethods(declaredOnOwner.ToImmutable())
            }
            return
        }
        for candidate in functions {
            if candidate.Declaration?.Identifier.IsMissing != false || $scope.TryDeclareFunction(candidate) {
                continue
            }
            // ADR-0063 §11: if the collision is with another callable of
            // the same name, it is a duplicate-signature error rather
            // than a generic redeclaration.
            let existingOverloads = $scope.TryLookupFunctions(candidate.Name)
            var duplicateSig = false
            for existing in existingOverloads {
                if BoundScope.FunctionSignaturesEqual(existing, candidate) {
                    duplicateSig = true
                    break
                }
            }
            if duplicateSig {
                Diagnostics.ReportDuplicateOverloadSignature(
                    syntax.Identifier.Location,
                    candidate.Name,
                    Binder.FormatOverloadSignature(candidate)
                )
            } else {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, candidate.Name)
            }
        }
    }

    private func ExpandNullableSequenceIteratorSpecializations(function FunctionSymbol) ImmutableArray[FunctionSymbol] {
        if function.Declaration?.Body == nil {
            return ImmutableArray.Create(function)
        }
        if !IteratorDetection.ContainsYield(function.Declaration!!.Body!!) {
            return ImmutableArray.Create(function)
        }
        let elementType = switch function.Type {
            case sequence_ is SequenceTypeSymbol: sequence_.ElementType
            case sequence_ is AsyncSequenceTypeSymbol: sequence_.ElementType
            default: default(TypeSymbol?)
        }
        if !(elementType is NullableTypeSymbol{UnderlyingType: TypeParameterSymbol target}) ||
            target.HasValueTypeConstraint ||
            target.HasReferenceTypeConstraint ||
            target.ClassConstraint != nil {
            return ImmutableArray.Create(function)
        }
        let targetIndex = function.TypeParameters.IndexOf(target)
        if targetIndex < 0 {
            Diagnostics.ReportUnconstrainedNullableSequenceElement(
                function.Declaration!!
                    .Type
                    ?.SequenceElementType
                    ?.Location ??
                    function.Declaration!!
                    .Identifier
                    .Location,
                target.Name
            )
            return ImmutableArray.Create(function)
        }
        return ImmutableArray.Create(
            CreateNullableSequenceIteratorSpecialization(function, targetIndex, isValueType: false),
            CreateNullableSequenceIteratorSpecialization(function, targetIndex, isValueType: true)
        )
    }

    private func CreateNullableSequenceIteratorSpecialization(
        function FunctionSymbol,
        targetIndex int32,
        isValueType bool
    ) FunctionSymbol {
        let typeParameters = SynthesizedClosureReifier.CloneWithRemappedConstraints(function.TypeParameters)
        typeParameters[targetIndex].HasReferenceTypeConstraint = !isValueType
        typeParameters[targetIndex].HasValueTypeConstraint = isValueType
        let substitution = BuildTypeParameterSubstitution(function.TypeParameters, typeParameters)
        let parameters = ImmutableArray.CreateBuilder[ParameterSymbol](function.Parameters.Length)
        for parameter in function.Parameters {
            let clone = ParameterSymbol(
                parameter,
                Binder.SubstituteType(parameter.Type, substitution),
                parameter.DeclaringSyntax
            )
            if parameter.HasExplicitDefaultValue {
                clone.SetExplicitDefaultValue(parameter.ExplicitDefaultValue)
            } else if (parameter.DeclaringSyntax?.Parent is ParameterSyntax and {HasDefaultValue: true}) {
                // Issue #4192 (Copilot finding on #4183): a struct/class
                // method's own default-value expressions are bound lazily
                // (pendingParameterDefaultValueBindings), so `parameter`'s
                // default is still PENDING here — specialization runs during
                // the same per-struct declaration-body pass that registers
                // the deferred closure, well before
                // BindPendingParameterDefaultValues drains it. `parameter`
                // itself is discarded once specialization replaces the
                // original method with its clones (the caller `continue`s
                // past adding it), so the original's own deferred closure
                // would resolve a default value nobody reads. Queue a
                // follow-up copy from the original onto this clone; it is
                // appended to the SAME list after the original's own
                // deferred bind (registered earlier, in the parameter-
                // creation loop above this method's caller), so drain order
                // guarantees `parameter.HasExplicitDefaultValue` is already
                // true by the time this runs.
                //
                // `parameter.DeclaringSyntax` is set to the parameter's
                // IDENTIFIER token, not the enclosing `ParameterSyntax` (see
                // the ParameterSymbol construction sites in
                // DeclarationBinder.Structs.cs), so the default-value clause
                // is found via the token's parent, not the token itself.
                let originalParameter = parameter
                let clonedParameter = clone
                pendingParameterDefaultValueBindings.Add(
                    () -> {
                        if originalParameter.HasExplicitDefaultValue {
                            clonedParameter.SetExplicitDefaultValue(originalParameter.ExplicitDefaultValue)
                        }
                    }
                )
            }
            clone.SetAttributes(parameter.Attributes)
            parameters.Add(clone)
        }
        let specializedParameters = parameters.MoveToImmutable()
        var specializedExplicitReceiver ParameterSymbol? = nil
        if function.ExplicitReceiverParameter != nil {
            for var i = 0; i < function.Parameters.Length; i++ {
                if object.ReferenceEquals(function.Parameters[i], function.ExplicitReceiverParameter) {
                    specializedExplicitReceiver = specializedParameters[i]
                    break
                }
            }
        }
        let specializedReceiverType = if function.ReceiverType is {} receiverType {
            Binder.SubstituteType(receiverType, substitution)
        } else {
            default(TypeSymbol?)
        }
        let specialized = FunctionSymbol(
            function.Name,
            specializedParameters,
            Binder.SubstituteType(function.Type, substitution),
            function.Declaration,
            function.Package,
            function.Accessibility,
            specializedReceiverType,
            specializedExplicitReceiver,
            function.IsOpen,
            function.IsOverride
        )
        specialized.TypeParameters = typeParameters
        specialized.OverriddenMethod = function.OverriddenMethod
        specialized.ExternalOverriddenMethod = function.ExternalOverriddenMethod
        specialized.ExternalOverrideContainingType = if function.ExternalOverrideContainingType is {} externalOverrideContainingType {
            Binder.SubstituteType(externalOverrideContainingType, substitution)
        } else {
            default(TypeSymbol?)
        }
        specialized.IsAsync = function.IsAsync
        specialized.IsAsyncVoid = function.IsAsyncVoid
        specialized.SuspendingKind = function.SuspendingKind
        specialized.AsyncReturnsValueTask = function.AsyncReturnsValueTask
        specialized.IsUnsafe = function.IsUnsafe
        specialized.ReturnRefKind = function.ReturnRefKind
        specialized.IsStatic = function.IsStatic
        specialized.StaticOwnerType = if function.StaticOwnerType is {} staticOwnerType {
            Binder.SubstituteType(staticOwnerType, substitution)
        } else {
            default(TypeSymbol?)
        }
        specialized.IsSpecialName = function.IsSpecialName
        specialized.SetAttributes(function.Attributes)
        if function.GetDocumentation() is {} documentation {
            specialized.SetDocumentation(documentation)
        }
        specialized.NullableSequenceSpecialization = if isValueType {
            NullableSequenceSpecializationKind.ValueType
        } else {
            NullableSequenceSpecializationKind.ReferenceType
        }
        return specialized
    }

    private func BindIteratorReturnType(syntax FunctionDeclarationSyntax) TypeSymbol {
        let previous = binderCtx.UnconstrainedNullableSequenceElementReturn
        this
            .binderCtx
            .UnconstrainedNullableSequenceElementReturn = if syntax.Body != nil &&
            IteratorDetection.ContainsYield(syntax.Body) {
            syntax.Type
        } else {
            default(TypeClauseSyntax?)
        }
        try {
            return if syntax.Type is {} returnType {
                bindReturnTypeClause(returnType, syntax.IsAsync) ?? TypeSymbol.Void
            } else {
                TypeSymbol.Void
            }
        } finally {
            this.binderCtx.UnconstrainedNullableSequenceElementReturn = previous
        }
    }

    private data struct FunctionReceiverBindingResult(
        ReceiverType TypeSymbol?,
        ExplicitReceiverParameter ParameterSymbol?,
        MethodReceiverStruct StructSymbol?,
        Succeeded bool
    ) : IEquatable[FunctionReceiverBindingResult] { }

    private data struct FunctionReturnBindingResult(
        ReturnType TypeSymbol,
        TypeIsValueTask bool,
        ReturnRefKind RefKind,
        IsAsyncVoid bool
    ) : IEquatable[FunctionReturnBindingResult] { }

    /// Issue #2834: validates that a user-defined compound-assignment operator
    /// matches the C# 14 contract — an instance method with exactly one
    /// parameter and no return value, because it mutates its receiver in place
    /// instead of producing a new value.
    /// @param syntax The operator declaration.
    /// @param operatorName The metadata name, e.g. `op_AdditionAssignment`.
    /// @param returnType The bound return type.
    /// @param userParameterCount The parameter count excluding any receiver-clause parameter.
    private func ValidateCompoundAssignmentOperatorShape(
        syntax FunctionDeclarationSyntax,
        operatorName string,
        returnType TypeSymbol?,
        userParameterCount int32
    ) {
        if userParameterCount == 1 && (returnType == nil || returnType == TypeSymbol.Void) {
            return
        }
        Diagnostics.ReportInvalidCompoundAssignmentOperatorShape(syntax.Identifier.Location, operatorName)
    }

    private func BindFunctionReceiver(
        syntax FunctionDeclarationSyntax,
        $package PackageSymbol,
        parameters ImmutableArray[ParameterSymbol].Builder,
        seenParameterNames HashSet[string]
    ) FunctionReceiverBindingResult {
        // ADR-0182 / issue #4240: a receiver clause is unconditionally an
        // extension now, regardless of the receiver type's owning package
        // or aggregate kind. The one carve-out is operators (ADR-0035):
        // they have no in-body declaration form, so an operator on an owned
        // struct/class still attaches to that type — exactly the routing
        // ADR-0024 established, just no longer shared with ordinary
        // methods, which are in-body only.
        var receiverType TypeSymbol? = nil
        var explicitReceiverParameter ParameterSymbol? = nil
        var methodReceiverStruct StructSymbol? = nil
        if syntax.IsExtension {
            let receiverSyntax ParameterSyntax? = syntax.Receiver
            if receiverSyntax == nil {
                return FunctionReceiverBindingResult(TypeSymbol.Error, nil, nil, false)
            }
            // ADR-0185: a receiver clause is parsed via Parser.Members.cs's
            // ParseParameter, never the destructured arrow-lambda path.
            let recvName = receiverSyntax.Identifier!!.ValueText
            receiverType = if receiverSyntax.Type is {} receiverTypeSyntax {
                bindTypeClause(receiverTypeSyntax)
            } else {
                TypeSymbol.Error
            }
            if receiverType == nil {
                receiverType = TypeSymbol.Error
            }
            explicitReceiverParameter = ParameterSymbol(recvName, receiverType, declaringSyntax: receiverSyntax)
            seenParameterNames.Add(recvName)
            parameters.Add(explicitReceiverParameter)
            // ADR-0187 / issue #4350: a nullable receiver (`left Box[T]?`, the
            // C# `Box<T>?` operand of a reference-type operator) still names the
            // owning type, so the operator is a static member of that type
            // rather than of the package's `<Program>` holder.
            let isOperator = syntax.Identifier.ValueText.StartsWith("op_", StringComparison.Ordinal)
            let ownerType = if receiverType is NullableTypeSymbol nullableReceiver {
                nullableReceiver.UnderlyingType
            } else {
                receiverType
            }
            if isOperator && ownerType is StructSymbol receiverStruct && string.Equals(
                receiverStruct.PackageName,
                $package.Name,
                StringComparison.Ordinal
            ) {
                methodReceiverStruct = receiverStruct.Definition ?? receiverStruct
            }
        }
        return FunctionReceiverBindingResult(receiverType, explicitReceiverParameter, methodReceiverStruct, true)
    }

    private func BindFunctionParameters(
        syntax FunctionDeclarationSyntax,
        parameters ImmutableArray[ParameterSymbol].Builder,
        seenParameterNames HashSet[string]
    )[]ParameterSymbol {
        // Tracks the bound ParameterSymbol corresponding to each parameter
        // syntax position (null for duplicates) so per-parameter annotations
        // can be attached to the right symbol below.
        let parameterSymbolBySyntax = [syntax.Parameters.Count]ParameterSymbol
        for var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++ {
            let parameterSyntax = syntax.Parameters[pIndex]
            // ADR-0185: an ordinary function declaration's parameters never
            // come from the destructured arrow-lambda path.
            let parameterName = parameterSyntax.Identifier!!.ValueText
            var parameterType = if parameterSyntax.Type is {} parameterTypeSyntax {
                bindTypeClause(parameterTypeSyntax) ?? TypeSymbol.Error
            } else {
                TypeSymbol.Error
            }
            // Issue #1262: `_` is the discard identifier — repeated `_` parameters are
            // permitted on named functions/methods. Each `_` occupies a positional slot
            // but is not added to the body scope, so non-`_` duplicates still error.
            if parameterName != "_" && !seenParameterNames.Add(parameterName) {
                Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName)
            } else {
                // Phase 4.8: a `...T` parameter has type `[]T` for the body
                // and must be the last parameter. Auto-packing of trailing
                // arguments happens at the call site.
                let isVariadic = parameterSyntax.IsVariadic
                if isVariadic && parameterType != TypeSymbol.Error {
                    parameterType = VariadicCarriers.ResolveDeclaredParameterType(parameterType)
                }
                let parameterRefKind = conversions.BindAndValidateParameterRefKind(
                    parameterSyntax,
                    parameterName,
                    parameterType,
                    isVariadic,
                    if syntax.IsAsync {
                        "async"
                    } else {
                        (
                            if syntax.IsSuspend {
                                "suspend"
                            } else {
                                default(string?)
                            }
                        )
                    }
                )
                let parameter = ParameterSymbol(
                    parameterName,
                    parameterType,
                    isVariadic,
                    declaringSyntax: parameterSyntax.Identifier,
                    isScoped: parameterSyntax.IsScoped,
                    refKind: parameterRefKind
                )
                conversions.BindAndAttachParameterDefaultValue(parameterSyntax, parameter)
                parameters.Add(parameter)
                parameterSymbolBySyntax[pIndex] = parameter
            }
        }
        // Phase 4.8: validate `...T` appears only on the last syntactic parameter.
        // ADR-0101 / issue #799: also flag the (rare) case where more than one
        // parameter is variadic — the second and later occurrences get GS0364
        // in addition to the "must-be-last" diagnostic on the earlier one(s).
        ValidateVariadicParameterShape(syntax.Parameters)
        return parameterSymbolBySyntax
    }

    private func BindFunctionReturn(
        syntax FunctionDeclarationSyntax,
        parameterSymbolBySyntax[]ParameterSymbol
    ) FunctionReturnBindingResult {
        // ADR-0041: bind the return type with async-aware alias resolution.
        var type = BindIteratorReturnType(syntax)
        // ADR-0146 (Kotlin visibility narrowing follow-up): infer/narrow the
        // return type when the (omitted-type) body is `-> object { ... }`.
        type = InferAnonymousClassLiteralReturnType(syntax, type, resolveAccessibility(syntax.AccessibilityModifier))
        // Issue #1918: unwrap an explicit `Task[T]` / `ValueTask[T]` async
        // return-type annotation to its awaited result, remembering which
        // wrapper was requested.
        let isAsyncVoid = IsExplicitAsyncVoid(syntax, type)
        type = NormalizeAsyncDeclaredReturnType(type, syntax.IsAsync, out var typeIsValueTask)
        // Issue #490 (ADR-0060 follow-up): a `ref` return modifier on the declaration
        // is only valid when an explicit return-type clause is present, the function is
        // not async, and the return is not a sequence/async-sequence (the state-machine
        // rewriter cannot hoist a managed pointer into a field — same constraint as
        // ref-kind parameters per ADR-0058 §4).
        let returnRefKind = ValidateReturnRefKind(syntax, type)
        // ADR-0060 §10: post-bind check — if this is a sequence/async-sequence
        // function, ref-kind parameters are forbidden. (The async-only check
        // is handled earlier in the parameter loop.)
        let isSequenceReturn = type is SequenceTypeSymbol || type is AsyncSequenceTypeSymbol
        if isSequenceReturn {
            for var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++ {
                let pSym ParameterSymbol? = parameterSymbolBySyntax[pIndex]
                if pSym != nil && pSym.RefKind != RefKind.None {
                    let label = if syntax.IsAsync {
                        "async sequence"
                    } else {
                        "sequence"
                    }
                    Diagnostics.ReportRefKindOnAsyncOrIterator(syntax.Parameters[pIndex].Location, pSym.Name, label)
                }
            }
        }
        return FunctionReturnBindingResult(type, typeIsValueTask, returnRefKind, isAsyncVoid)
    }

    private func BindFunctionAttributes(syntax FunctionDeclarationSyntax, type TypeSymbol) ImmutableArray[
        BoundAttribute
    ] {
        // Issue #141 / ADR-0047: resolve annotation lead-ins for this
        // declaration. We do this once per function regardless of whether
        // it is an extension, a method, or a free function — diagnostics
        // and the resulting bound-attribute list are identical.
        let functionAttributes = BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Method,
            Binder.FunctionDeclarationAllowedTargets,
            "a function declaration",
            AttributeTargets.Method
        )
        // Issue #176 / ADR-0047 §6: a function marked `@Conditional`
        // must return void. The CLR rule (matching C# CS0578) is that
        // conditional-method calls may be elided at the call site, which
        // is incompatible with a non-void result feeding the surrounding
        // expression. The attribute is still attached to the function
        // symbol so downstream tools see the user's intent and so the
        // call site still elides; the diagnostic is per-declaration.
        if KnownAttributes.HasConditional(functionAttributes) && type != TypeSymbol.Void {
            Diagnostics.ReportConditionalMethodMustReturnVoid(syntax.Identifier.Location, syntax.Identifier.ValueText)
        }
        return functionAttributes
    }

    /// Issue #4234: resolves a top-level extension function's
    /// `@ExtensionOwner(typeof(T))` annotation, if present, to the
    /// same-package non-generic class symbol `T` it names.
    /// Returns `null` (reporting GS9306 for a malformed use) when no
    /// such annotation is present or it does not have the one shape this
    /// supports. (cref:BindAttribute) already strips the annotation
    /// out of `functionAttributes` before this runs, exactly like
    /// `@SuppressDiagnostic`.
    private func TryResolveExtensionOwnerAnnotation(
        syntax FunctionDeclarationSyntax,
        $package PackageSymbol
    ) StructSymbol? {
        var ownerAnnotation AnnotationSyntax? = nil
        for annotation in syntax.Annotations {
            if IsExtensionOwnerAnnotation(annotation) {
                ownerAnnotation = annotation
                break
            }
        }
        if ownerAnnotation == nil {
            return nil
        }
        if ownerAnnotation.Arguments is not{Count: 1} arguments ||
            arguments[0] is not TypeOfExpressionSyntax typeOfSyntax {
            Diagnostics.ReportExtensionOwnerInvalid(
                ownerAnnotation.AtToken.Location,
                "requires a single 'typeof(T)' argument naming the CLR owner type"
            )
            return nil
        }
        if !(bindTypeOfExpression(typeOfSyntax) is BoundTypeOfExpression{OperandType: StructSymbol ownerStruct}) ||
            !ownerStruct.IsClass ||
            !ownerStruct
            .TypeParameters
            .IsDefaultOrEmpty ||
            !string
            .Equals(ownerStruct.PackageName, $package.Name, StringComparison.Ordinal) {
            // A struct is rejected too: ECMA-334 §13.6.9 (and
            // MemberLookup.IsStaticClass on the importing side) requires an
            // extension method's container be a CLASS, so a value-type owner
            // could never satisfy the very C#-interop contract this
            // annotation exists to restore.
            Diagnostics.ReportExtensionOwnerInvalid(
                ownerAnnotation.AtToken.Location,
                "must name a non-generic class declared in this package"
            )
            return nil
        }
        return ownerStruct
    }

    private func BindFunctionParameterAttributes(
        syntax FunctionDeclarationSyntax,
        receiverParameter ParameterSymbol?,
        parameterSymbolBySyntax[]ParameterSymbol,
        type TypeSymbol
    ) {
        if syntax.Receiver != nil && receiverParameter != nil {
            BindFunctionParameterAttributes(syntax.Receiver, receiverParameter, type)
        }
        // Per-parameter annotations: each ParameterSyntax owns its own
        // annotation list; the default target is `param`. Issue #170 /
        // ADR-0047 §3: the bound list is stored on the ParameterSymbol so
        // the emitter can emit a `CustomAttribute` row keyed to the
        // corresponding `Parameter` metadata handle.
        for var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++ {
            let parameterSyntax = syntax.Parameters[pIndex]
            let parameterSymbol ParameterSymbol? = parameterSymbolBySyntax[pIndex]
            if parameterSymbol != nil {
                BindFunctionParameterAttributes(parameterSyntax, parameterSymbol, type)
            }
        }
    }

    private func BindFunctionParameterAttributes(
        parameterSyntax ParameterSyntax,
        parameterSymbol ParameterSymbol,
        functionReturnType TypeSymbol
    ) {
        let paramAttrs = BindAttributes(
            parameterSyntax.Annotations,
            AttributeTargetKind.Param,
            Binder.ParameterAllowedTargets,
            "a parameter declaration",
            AttributeTargets.Parameter
        )
        if paramAttrs.IsDefaultOrEmpty {
            return
        }
        parameterSymbol.SetAttributes(paramAttrs)
        ValidateUnscopedRefParameter(parameterSymbol)
        // Issue #180 / ADR-0040: validate @EnumeratorCancellation.
        // The attribute marks the cancellation-token parameter that
        // the async-sequence rewriter threads through, so it is only
        // meaningful when (a) the parameter's type is
        // System.Threading.CancellationToken and (b) the enclosing
        // function returns IAsyncEnumerable[T] (an `async sequence`).
        // Diagnostics are reported per offending attribute; the
        // attribute is still attached so downstream tooling can
        // observe the user's intent.
        let ecAttr BoundAttribute? = KnownAttributes.FindEnumeratorCancellation(paramAttrs)
        if ecAttr == nil {
            return
        }
        if parameterSymbol.Type?.ClrType.IsSameAs(typeof(CancellationToken)) != true {
            Diagnostics.ReportEnumeratorCancellationWrongType(
                parameterSyntax.Location,
                parameterSymbol.Name,
                parameterSymbol.Type?.Name ?? "?"
            )
        } else if !isAsyncSequenceReturnType(functionReturnType) {
            Diagnostics.ReportEnumeratorCancellationNotAsyncSequence(parameterSyntax.Location, parameterSymbol.Name)
        }
    }

    /// Issue #1017: binds a user-defined conversion operator declaration
    /// (`func operator implicit (x T) U { … }` or the `explicit`
    /// variant) into a static `op_Implicit` / `op_Explicit`
    /// special-name method attached to the owning user type. Enforces the C#
    /// conversion-operator constraints: exactly one parameter; source and
    /// target differ; at least one of them is a same-package user type; and no
    /// duplicate conversion exists for the same source/target pair.
    /// @param syntax The conversion-operator declaration syntax.
    /// @param parameters The already-bound parameter list.
    /// @param returnType The already-bound return (target) type.
    /// @param accessibility The declaration's resolved accessibility.
    /// @param package The owning package.
    /// @param functionAttributes Bound annotation attributes for the declaration.
    /// @param declaringType Issue #4350: the enclosing type of an in-body
    /// operator, which must be its source or target and always owns it (as in
    /// C#); `null` for the free-function form.
    private func BindConversionOperatorDeclaration(
        syntax FunctionDeclarationSyntax,
        parameters ImmutableArray[ParameterSymbol],
        returnType TypeSymbol,
        accessibility Accessibility,
        $package PackageSymbol,
        functionAttributes ImmutableArray[BoundAttribute],
        declaringType StructSymbol? = nil
    ) {
        let isExplicit = syntax.ConversionIsExplicit
        let opName = if isExplicit {
            "op_Explicit"
        } else {
            "op_Implicit"
        }
        // A conversion operator has exactly one parameter — the source operand.
        if parameters.Length != 1 {
            Diagnostics.ReportConversionOperatorRequiresSingleParameter(syntax.Identifier.Location, isExplicit)
            return
        }
        let sourceType = parameters[0].Type
        let targetType = returnType
        if sourceType == TypeSymbol.Error || targetType == TypeSymbol.Error {
            return
        }
        // The source operand may not be passed by ref/out/in.
        if parameters[0].RefKind != RefKind.None {
            Diagnostics.ReportConversionOperatorRequiresSingleParameter(syntax.Identifier.Location, isExplicit)
            return
        }
        // A conversion from a type to itself is never user-definable.
        if Conversion.Classify(sourceType, targetType).IsIdentity {
            Diagnostics.ReportConversionOperatorMustInvolveEnclosingType(syntax.Identifier.Location)
            return
        }
        // At least one of source/target must be a same-package user type that
        // owns (emits) the operator. Issue #4350: an in-body operator is owned
        // by its ENCLOSING type, exactly as in C#. Attaching it to the source
        // instead changed the declaring type in metadata, and when the source
        // type bound later its `shared` block replaced the static-method table
        // and dropped the operator from the assembly altogether.
        let declaringDefinition StructSymbol? = if declaringType == nil {
            default(StructSymbol?)
        } else {
            declaringType.Definition ?? declaringType
        }
        let sourceOwner StructSymbol? = TryGetSamePackageOwner(sourceType, $package)
        let targetOwner = TryGetSamePackageOwner(targetType, $package)
        let owner StructSymbol? = if declaringDefinition != nil {
            (
                if object.ReferenceEquals(sourceOwner, declaringDefinition) || object.ReferenceEquals(
                    targetOwner,
                    declaringDefinition
                ) {
                    declaringDefinition
                } else {
                    default(StructSymbol?)
                }
            )
        } else {
            sourceOwner ?? targetOwner
        }
        if owner == nil {
            Diagnostics.ReportConversionOperatorMustInvolveEnclosingType(syntax.Identifier.Location)
            return
        }
        let function = FunctionSymbol(
            opName,
            parameters,
            returnType,
            syntax,
            $package,
            accessibility,
            receiverType: default(TypeSymbol?)
        )
        function.IsStatic = true
        function.StaticOwnerType = owner
        function.IsSpecialName = true
        Binder.AttachDocumentation(function, syntax)
        if !functionAttributes.IsDefaultOrEmpty {
            function.SetAttributes(functionAttributes)
            ValidateUnscopedRefPlacement(function)
        }
        // Reject a duplicate conversion (same source/target pair), whether the
        // existing one is implicit or explicit — matching C# CS0557.
        for existing in owner.StaticMethods {
            if existing.Name != "op_Implicit" && existing.Name != "op_Explicit" {
                continue
            }
            if existing.Parameters.Length != 1 {
                continue
            }
            if Conversion.Classify(existing.Parameters[0].Type, sourceType).IsIdentity && Conversion.Classify(
                existing.Type,
                targetType
            )
                .IsIdentity {
                Diagnostics.ReportDuplicateConversionOperator(syntax.Identifier.Location, sourceType, targetType)
                return
            }
        }
        owner.AddStaticMethods(ImmutableArray.Create(function))
    }

    /// Binds a type-parameter list. Made `internal` (issue #1886) so
    /// (cref:LambdaBinder) can bind the `[T, U, ...]` list on a
    /// generic `let`-bound local function declaration
    /// (`let Name[T] = func (...) ... { ... }`) using the same routine as
    /// other generic callable declarations.
    /// @param syntax The type-parameter list syntax.
    /// @returns The bound type-parameter symbols.
    internal func BindTypeParameterList(syntax TypeParameterListSyntax?) ImmutableArray[TypeParameterSymbol] {
        if syntax == nil {
            return ImmutableArray[TypeParameterSymbol].Empty
        }
        let symbols = CreateTypeParameterSymbols(syntax)
        ResolveTypeParameterConstraints(syntax, symbols)
        return symbols
    }

    private func CreateTypeParameterSymbols(syntax TypeParameterListSyntax?) ImmutableArray[TypeParameterSymbol] {
        if syntax == nil {
            return ImmutableArray[TypeParameterSymbol].Empty
        }
        let count = syntax.Parameters.Count
        let symbols = ImmutableArray.CreateBuilder[TypeParameterSymbol](count)
        let seen = HashSet[string]()
        // Pass 1: create the bare type-parameter symbols (name, ordinal, variance)
        // so that a constraint clause appearing later in the list — or a
        // self-referential constraint such as `[T IComparable[T]]` (issue #943)
        // / `[T IAdd[T]]` (ADR-0089) — can resolve every in-flight type
        // parameter while binding the constraint type below.
        for var i = 0; i < count; i++ {
            let p = syntax.Parameters[i]
            let name = p.Identifier.ValueText
            if !seen.Add(name) {
                Diagnostics.ReportSymbolAlreadyDeclared(p.Identifier.Location, name)
            }
            var variance = TypeParameterVariance.None
            if p.VarianceModifier != nil {
                variance = if p.VarianceModifier.Text == "in" {
                    TypeParameterVariance.In
                } else {
                    TypeParameterVariance.Out
                }
            }
            symbols.Add(TypeParameterSymbol(name, i, TypeParameterConstraint.Any, variance))
        }
        return symbols.MoveToImmutable()
    }

    private func ResolveTypeParameterConstraints(
        syntax TypeParameterListSyntax?,
        symbols ImmutableArray[TypeParameterSymbol]
    ) {
        if syntax == nil {
            return
        }
        let count = syntax.Parameters.Count
        // Publish the bare symbols into the binder's type-parameter scope so the
        // constraint type clauses bound in pass 2 can see them. Enclosing type
        // parameters (e.g. for a generic method declared inside a generic type)
        // remain visible because we copy the previous map.
        let previousTypeParameters Dictionary[string, TypeParameterSymbol]? = binderCtx.CurrentTypeParameters
        let constraintScope = if previousTypeParameters == nil {
            Dictionary[string, TypeParameterSymbol]()
        } else {
            Dictionary[string, TypeParameterSymbol](previousTypeParameters)
        }
        for s in symbols {
            constraintScope[s.Name] = s
        }
        this.binderCtx.CurrentTypeParameters = constraintScope
        try {
            // Pass 2: resolve each constraint against the published scope.
            for var i = 0; i < count; i++ {
                let p = syntax.Parameters[i]
                let symbol = symbols[i]
                let name = symbol.Name
                if p.Constraint != nil {
                    switch p.Constraint.Text {
                        case "any" {
                            symbol.Constraint = TypeParameterConstraint.Any
                        }
                        case "comparable" {
                            symbol.Constraint = TypeParameterConstraint.Comparable
                        }
                        default {
                            ResolveInterfaceConstraint(p, symbol)
                        }
                    }
                }
                // ADR-0097 / issue #775 (constraint keyword renamed to `init()`
                // by issue #997): consume the `class` / `struct` / `init()`
                // flag-style constraints. Disjoint combinations (`class struct`,
                // `struct init()`) are rejected as GS0361. The order is determined
                // by the syntax — combining class + init() is legal and produces
                // both CLR flag bits.
                let hasRefType = p.HasClassConstraint
                var hasValueType = p.HasStructConstraint
                var hasDefaultCtor = p.HasInitConstraint
                var hasUnmanaged = p.HasUnmanagedConstraint
                // Issue #1336: the `unmanaged` constraint subsumes `struct` —
                // an unmanaged type is necessarily a non-nullable value type —
                // so it implies the value-type (and therefore default-ctor)
                // CLR flag bits. Spelling both `unmanaged` and `struct` is
                // redundant; flag the explicit `struct`.
                if hasUnmanaged && hasValueType {
                    Diagnostics.ReportTypeParameterConstraintConflict(
                        p.StructConstraintKeyword?.Location ?? p.Identifier.Location,
                        name,
                        "unmanaged",
                        "struct"
                    )
                    hasValueType = false
                }
                // `unmanaged` is a value-type constraint and cannot be combined
                // with the reference-type (`class`) constraint.
                if hasUnmanaged && hasRefType {
                    Diagnostics.ReportTypeParameterConstraintConflict(
                        p.ClassConstraintKeyword?.Location ?? p.Identifier.Location,
                        name,
                        "class",
                        "unmanaged"
                    )
                    hasUnmanaged = false
                }
                if hasRefType && hasValueType {
                    Diagnostics.ReportTypeParameterConstraintConflict(
                        p.StructConstraintKeyword?.Location ?? p.Identifier.Location,
                        name,
                        "class",
                        "struct"
                    )
                    hasValueType = false
                }
                if hasValueType && hasDefaultCtor {
                    // `struct` already implies `init()` at the CLR level (ECMA-335 II.10.1.7);
                    // emitting both would be redundant and would force callers to
                    // remember an arbitrary order. Flag the explicit `init()`.
                    Diagnostics.ReportTypeParameterConstraintConflict(
                        p.InitConstraintKeyword?.Location ?? p.Identifier.Location,
                        name,
                        "struct",
                        "init()"
                    )
                    hasDefaultCtor = false
                }
                // Issue #1336: `unmanaged` likewise implies the default-ctor
                // flag (it is a value-type constraint); flag a redundant
                // explicit `init()`.
                if hasUnmanaged && hasDefaultCtor {
                    Diagnostics.ReportTypeParameterConstraintConflict(
                        p.InitConstraintKeyword?.Location ?? p.Identifier.Location,
                        name,
                        "unmanaged",
                        "init()"
                    )
                    hasDefaultCtor = false
                }
                // Issue #1336: project `unmanaged` onto the value-type CLR flag
                // bits. The dedicated modreq(UnmanagedType) GenericParamConstraint
                // is emitted by TypeDefEmitter from HasUnmanagedConstraint.
                symbol.HasReferenceTypeConstraint = hasRefType
                symbol.HasValueTypeConstraint = hasValueType || hasUnmanaged
                symbol.HasDefaultConstructorConstraint = hasDefaultCtor
                symbol.HasUnmanagedConstraint = hasUnmanaged
            }
            // Issue #4043: a dependent bound can only be checked for cycles once
            // EVERY parameter in the list has been resolved — while parameter 0
            // is being bound, parameter 1's own bound is still empty, so
            // `[A B, B A]` is invisible from inside the loop above.
            ReportCircularConstraints(syntax, symbols)
        } finally {
            this.binderCtx.CurrentTypeParameters = previousTypeParameters
        }
    }

    /// Issue #4043: rejects a circular dependent-constraint chain
    /// (`[T T]`, `[A B, B A]`) with `GS0581`, mirroring C#'s
    /// `CS0454`. A cycle would emit a `GenericParamConstraint` the CLR
    /// refuses and would make every constraint walk that follows a
    /// (cref:TypeParameterSymbol.TypeParameterBound) chain non-terminating,
    /// so the offending bound is CLEARED as well as reported — binding continues
    /// against a parameter that simply has no dependent bound.
    /// @param syntax The type-parameter list, for diagnostic locations.
    /// @param symbols The resolved type-parameter symbols, in order.
    private func ReportCircularConstraints(
        syntax TypeParameterListSyntax,
        symbols ImmutableArray[TypeParameterSymbol]
    ) {
        for var i = 0; i < symbols.Length; i++ {
            let start = symbols[i]
            if start.TypeParameterBound == nil {
                continue
            }
            // Walk the chain from this parameter; a cycle is reported on the
            // parameter that starts it. A cycle NOT through `start` is reached
            // from whichever of its own members this loop visits, so bounding
            // the walk by the list length loses nothing — and a chain that
            // leaves this list (an enclosing type's parameter) is acyclic by
            // construction, because the enclosing list was fully resolved and
            // cycle-checked before this one began.
            var current = start
            for var steps = 0; steps <= symbols.Length && current.TypeParameterBound != nil; steps++ {
                let next = current.TypeParameterBound
                if object.ReferenceEquals(next, start) {
                    let location = if i < syntax.Parameters.Count {
                        syntax.Parameters[i].Constraint?.Location ?? syntax.Parameters[i].Identifier.Location
                    } else {
                        syntax.Location
                    }
                    // Name the pair the way C# does: the parameter the cycle is
                    // reported on and the one whose bound closes it. For the
                    // self-referential `[T T]` those coincide.
                    Diagnostics.ReportCircularConstraintDependency(location, start.Name, current.Name)
                    start.TypeParameterBound = nil
                    break
                }
                current = next!!
            }
        }
    }

    private func ResolvePartialTypeParameterConstraints(
        primarySyntax TypeParameterListSyntax?,
        matchingPartialLists ImmutableArray[TypeParameterListSyntax],
        symbols ImmutableArray[TypeParameterSymbol],
        typeName string,
        partialPartLocations ImmutableArray[TextLocation]
    ) {
        if matchingPartialLists.Length <= 1 {
            ResolveTypeParameterConstraints(primarySyntax, symbols)
            return
        }
        // Issues #4089/#4090: a constraint bound may itself be a G#-declared
        // generic type clause (`[T IGsBox[U]]`), which QUEUES a deferred
        // constraint check. These two loops are speculative — they bind each
        // partial part's header and roll the diagnostics back — so the queue
        // has to roll back with them, or a discarded candidate's check would
        // still be reported at flush time.
        let pendingConstraintChecks = binderCtx.RootScope.GetPendingUserGenericConstraintChecks()
        // Both speculative binds below roll back identically, so the rollback
        // lives in one place. Two copies of a predicate in one method is how
        // #4124 started.
        let RollbackSpeculativeBind = func (diagnosticCount int32, pendingCheckCount int32) {
            Diagnostics.TruncateTo(diagnosticCount)
            if pendingConstraintChecks.Count > pendingCheckCount {
                pendingConstraintChecks.RemoveRange(
                    pendingCheckCount,
                    pendingConstraintChecks.Count - pendingCheckCount
                )
            }
        }
        // Issue #3336: bind every matching header through its own file imports.
        let successfulBindings = List[
            (PartIndex int32, Syntax TypeParameterListSyntax, Symbols ImmutableArray[TypeParameterSymbol])
        ]()
        let diagnosticsByPart = List[ImmutableArray[Diagnostic]](matchingPartialLists.Length)
        for var partIndex = 0; partIndex < matchingPartialLists.Length; partIndex++ {
            let candidate = matchingPartialLists[partIndex]
            let diagnosticCount = Diagnostics.Count
            let pendingCheckCount = pendingConstraintChecks.Count
            let candidateSymbols = CreateTypeParameterSymbols(candidate)
            var candidateDiagnostics ImmutableArray[Diagnostic]
            try {
                ResolveTypeParameterConstraints(candidate, candidateSymbols)
                candidateDiagnostics = Diagnostics.Skip(diagnosticCount).ToImmutableArray()
            } finally {
                RollbackSpeculativeBind(diagnosticCount, pendingCheckCount)
            }
            diagnosticsByPart.Add(candidateDiagnostics)
            if !candidateDiagnostics.Any((diagnostic Diagnostic) -> diagnostic.IsError) {
                successfulBindings.Add((partIndex, candidate, candidateSymbols))
            }
        }
        if successfulBindings.Count == 0 {
            // Preserve primary-part recovery state, but surface each part's own
            // constraint diagnostics exactly once.
            let diagnosticCount = Diagnostics.Count
            let pendingCheckCount = pendingConstraintChecks.Count
            try {
                ResolveTypeParameterConstraints(primarySyntax, symbols)
            } finally {
                RollbackSpeculativeBind(diagnosticCount, pendingCheckCount)
            }
            for candidateDiagnostics in diagnosticsByPart {
                Diagnostics.AddRange(candidateDiagnostics)
            }
            return
        }
        let baseline = successfulBindings[0]
        for candidate in successfulBindings.Skip(1) {
            if !TypeParameterConstraintSignaturesEquivalent(baseline.Symbols, candidate.Symbols) {
                let location = if candidate.PartIndex < partialPartLocations.Length {
                    partialPartLocations[candidate.PartIndex]
                } else {
                    candidate.Syntax.Location
                }
                Diagnostics.ReportPartialTypeParameterMismatch(location, typeName)
            }
        }
        ResolveTypeParameterConstraints(baseline.Syntax, symbols)
    }

    /// Resolves a non-keyword type-parameter constraint (anything other than
    /// `any` / `comparable`) as an interface bound and records it on
    /// [`symbol`](paramref).
    ///
    /// Phase 4.2b / ADR-0020 originally accepted only a G#-declared sealed
    /// interface. ADR-0089 added constructed generic G# interfaces carrying
    /// static-virtual members (e.g. `[T IAdd[T]]`). Issue #943 generalised
    /// this to any imported CLR interface — generic or not. Issue #1052 removes
    /// the last restriction: ANY user-declared interface (sealed or not, generic
    /// or not, including the self-referential `[T IFace[T]]` shape) is a
    /// legal constraint, so the canonical C# `where T : IComparable<T>`
    /// shape binds, dispatches instance members, and emits verifiable IL. The
    /// constraint type clause is bound through the regular type binder, so a
    /// self-referential type argument (the type parameter appearing in its own
    /// constraint) resolves against the in-flight scope published by
    /// (cref:BindTypeParameterList(TypeParameterListSyntax)).
    /// @param p The type-parameter syntax carrying the constraint.
    /// @param symbol The bare type-parameter symbol to annotate.
    private func ResolveInterfaceConstraint(p TypeParameterSyntax, symbol TypeParameterSymbol) {
        // A qualified (dotted) constraint name is captured whole by the parser
        // as a ready-made type clause; bind it directly. Otherwise reconstruct
        // the clause from the single-identifier constraint token plus its
        // optional generic-argument list (the `[T IAdd[T]]` shape).
        let constraintClause = p.ConstraintType ??
            TypeClauseSyntax(
            p.SyntaxTree,
            openBracketToken: nil,
            lengthToken: nil,
            closeBracketToken: nil,
            identifier: p.Constraint ?? p.Identifier,
            typeArgumentOpenBracketToken: p.ConstraintTypeArgumentOpenBracketToken,
            typeArguments: p.ConstraintTypeArguments,
            typeArgumentCloseBracketToken: p.ConstraintTypeArgumentCloseBracketToken,
            questionToken: nil
        )
        let resolved TypeSymbol? = bindTypeClause(constraintClause)
        if resolved == nil || object.ReferenceEquals(resolved, TypeSymbol.Error) {
            // bindTypeClause already reported the failure (e.g. undefined type).
            return
        }
        if resolved is InterfaceSymbol iface {
            // Issue #1052: ANY user-declared interface — sealed or not, generic
            // or not, including the self-referential `[T IFace[T]]` shape — is a
            // legal constraint, matching imported CLR interfaces and C#'s
            // `where T : IFoo`. The former `sealed`-only gate (Phase 4.2b /
            // ADR-0020) was a stale restriction; instance members still bind on
            // `T` via the constraint and a GenericParamConstraint metadata row is
            // emitted pointing at the interface TypeDef so the IL verifies.
            symbol.InterfaceConstraint = iface
            return
        }
        // Issue #943: an imported CLR interface (generic or not). Reference-set
        // interfaces are universally implementable, so no sealedness rule
        // applies; the GenericParamConstraint metadata row carries the bound.
        if resolved.ClrType is {IsInterface: true} {
            symbol.ClrInterfaceConstraint = resolved
            return
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
        if resolved is StructSymbol && resolved.IsClass == true {
            symbol.ClassConstraint = resolved
            return
        }
        if resolved.ClrType is {IsClass: true, IsValueType: false} {
            symbol.ClassConstraint = resolved
            return
        }
        // Issue #4043: a DEPENDENT bound — another type parameter, mirroring
        // C#'s `where TDerived : TBase`. The constraint clause resolves against
        // the in-flight type-parameter scope published by
        // `ResolveTypeParameterConstraints`, which also carries the ENCLOSING
        // type's parameters, so both `[TBase, TDerived TBase]` (siblings) and
        // `class Box[T] { func Accept[U T](u U) }` (a method parameter bound to
        // its class's parameter) land here. The CLR already expresses this: a
        // `GenericParamConstraint` row may point at a TypeSpec naming another
        // `GenericParam`, which is exactly what Roslyn emits. Cycles
        // (`[T T]`, `[A B, B A]`) are rejected by `ReportCircularConstraints`
        // once the whole list is resolved — a per-parameter check cannot see
        // them, because a later parameter's bound is still empty here.
        if resolved is TypeParameterSymbol boundTypeParameter {
            symbol.TypeParameterBound = boundTypeParameter
            return
        }
        // Resolved to something that is not a legal constraint (a struct, enum,
        // or other value type).
        Diagnostics.ReportConstraintNotInterface(p.Constraint?.Location ?? p.Identifier.Location, resolved.Name)
    }

    /// ADR-0146 (Kotlin visibility narrowing follow-up, issue #2243): when a
    /// function/method's return-type clause is omitted and its (parser-desugared)
    /// body is exactly `return <anonymous-class-literal>` — the
    /// `func F() -> object { ... }` shape recognized by
    /// `Parser.IsAnonymousClassLiteralStartAfterArrow` — the return type must
    /// be inferred from the literal instead of defaulting to `void`:
    /// - Local/private/internal declarations retain the actual synthesized anonymous type (full
    /// custom-member access), mirroring a `let`/`var` binding of the same literal.
    /// - Public/protected declarations — a public API boundary — narrow the exposed type to the literal's
    /// declared supertype (`object : Type { ... }`) or, absent one, to the universal top type `object`
    /// ((cref:TypeSymbol.Object)), exactly like Kotlin's anonymous-object visibility rule.
    /// Every other omitted-return-type declaration (any shape other than a bare
    /// arrow-returned anonymous-class literal) is left untouched and still
    /// resolves to `void`.
    private func InferAnonymousClassLiteralReturnType(
        syntax FunctionDeclarationSyntax,
        declaredType TypeSymbol,
        accessibility Accessibility
    ) TypeSymbol {
        if syntax.Type != nil || declaredType != TypeSymbol.Void {
            // An explicit return-type clause already narrows for free: the
            // return statement's expression converts to that declared type, so
            // a caller only ever sees the declared type's members.
            return declaredType
        }
        if syntax.Body == nil ||
            syntax
            .Body
            .Statements
            .Length != 1 ||
            !(syntax.Body.Statements[0] is ReturnStatementSyntax{Expression: AnonymousClassExpressionSyntax anon}) {
            return declaredType
        }
        let isPublicSurface = accessibility == Accessibility.Public || accessibility == Accessibility.Protected
        if isPublicSurface {
            if anon.HasBaseType {
                let baseType TypeSymbol? = if anon.BaseTypeClause is {} baseTypeClause {
                    bindTypeClause(baseTypeClause)
                } else {
                    default(TypeSymbol?)
                }
                if baseType != nil && baseType != TypeSymbol.Error {
                    return baseType
                }
            }
            return TypeSymbol.Object
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
        let isRich = anon.HasBaseType || anon.Members.Any(
            (m SyntaxNode) -> m is FunctionDeclarationSyntax || m is EventDeclarationSyntax
        )
        if isRich && $scope.GetRichAnonymousClassMap().TryGetValue(anon, out var richType) && richType != nil {
            if richType.IsGenericDefinition && binderCtx.CurrentTypeParameters != nil {
                let typeArguments = richType
                    .TypeParameters
                    .Select(
                    (parameter TypeParameterSymbol) -> if binderCtx.CurrentTypeParameters!!.TryGetValue(
                        parameter.Name,
                        out var argument
                    ) {
                        cast[TypeSymbol](argument)
                    } else {
                        cast[TypeSymbol](parameter)
                    }
                )
                    .ToImmutableArray()
                if !typeArguments.Where(
                    (argument TypeSymbol, index int32) -> object.ReferenceEquals(
                        argument,
                        richType.TypeParameters[index]
                    )
                )
                    .Any() {
                    return StructSymbol.Construct(richType, typeArguments, $scope.References!!.MapClrTypeToReferences)!!
                }
            }
            return richType
        }
        return TypeSymbol.Object
    }

    /// ADR-0149: resolves every explicit-interface qualifier clause
    /// ((cref:FunctionDeclarationSyntax.ExplicitInterfaceType) /
    /// (cref:PropertyDeclarationSyntax.ExplicitInterfaceType)) declared
    /// on each pending struct/class's own methods and properties, binding the
    /// clause's type reference (via the shared (cref:bindTypeClause)
    /// delegate, with the struct's own type parameters temporarily
    /// re-established in scope — mirroring the same re-establishment
    /// (cref:BindPendingFieldInitializers) already performs for a
    /// similarly deferred pass) to the MATCHING (cref:InterfaceSymbol)
    /// instance already recorded in (cref:StructSymbol.Interfaces).
    /// Matching against the recorded instance (rather than trusting the
    /// freshly bound one directly) keeps the later
    /// (cref:TryResolveExplicitInterfaceImplementation) /
    /// (cref:TryResolveExplicitInterfacePropertyImplementation)
    /// comparisons sound even though constructed generic interfaces are not
    /// interned (see (cref:TypeSignaturesEquivalent(TypeSymbol, TypeSymbol))).
    /// Must run BEFORE (cref:VerifyInterfaceImplementations) so that
    /// pass can rely on (cref:FunctionSymbol.ExplicitInterfaceClauseTarget) /
    /// (cref:PropertySymbol.ExplicitInterfaceClauseTarget) already
    /// being populated. Reports GS0492 (clause type is not an interface) and
    /// GS0493 (interface not implemented by the containing type) directly;
    /// GS0494 (no matching member) and GS0495 (duplicate target) are reported
    /// by (cref:VerifyInterfaceImplementations), which already has the
    /// full per-interface-member matching context needed to detect them.
    internal func ResolveExplicitInterfaceClauses() {
        for (syntax, structSymbol) in pendingInterfaceImplementationChecks {
            if (structSymbol.Methods.IsDefaultOrEmpty || !HasAnyExplicitInterfaceClause(structSymbol.Methods)) &&
                (structSymbol.Properties.IsDefaultOrEmpty || !HasAnyExplicitInterfaceClause(structSymbol.Properties)) &&
                (structSymbol.Events.IsDefaultOrEmpty || !HasAnyExplicitInterfaceClause(structSymbol.Events)) &&
                (
                structSymbol
                    .StaticMethods
                    .IsDefaultOrEmpty ||
                    !HasAnyExplicitInterfaceClause(structSymbol.StaticMethods)
            ) &&
                (
                structSymbol
                    .StaticProperties
                    .IsDefaultOrEmpty ||
                    !HasAnyExplicitInterfaceClause(structSymbol.StaticProperties)
            ) {
                continue
            }
            let savedTypeParameters = binderCtx.CurrentTypeParameters
            let savedPackage = $scope.SetCurrentDeclaringPackage(structSymbol.PackageName)
            let savedTree = $scope.SetCurrentReferencingSyntaxTree(syntax.SyntaxTree)
            if !structSymbol.TypeParameters.IsDefaultOrEmpty {
                this.binderCtx.CurrentTypeParameters = Dictionary[string, TypeParameterSymbol]()
                for tp in structSymbol.TypeParameters {
                    binderCtx.CurrentTypeParameters!![tp.Name] = tp
                }
            }
            try {
                if !structSymbol.Methods.IsDefaultOrEmpty {
                    for method in structSymbol.Methods {
                        if method.HasExplicitInterfaceClause && method.ExplicitInterfaceClauseTarget == nil {
                            let target TypeSymbol? = ResolveExplicitInterfaceClauseTarget(
                                structSymbol,
                                method.Declaration?.ExplicitInterfaceType,
                                method.Name
                            )
                            if target != nil {
                                method.ExplicitInterfaceClauseTarget = target
                            }
                        }
                    }
                }
                if !structSymbol.Properties.IsDefaultOrEmpty {
                    for prop in structSymbol.Properties {
                        if prop.HasExplicitInterfaceClause && prop.ExplicitInterfaceClauseTarget == nil {
                            let target TypeSymbol? = ResolveExplicitInterfaceClauseTarget(
                                structSymbol,
                                prop.Declaration?.ExplicitInterfaceType,
                                prop.Name
                            )
                            if target != nil {
                                prop.ExplicitInterfaceClauseTarget = target
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
                                if prop.GetterSymbol != nil {
                                    prop.GetterSymbol!!.ExplicitInterfaceClauseTarget = target
                                }
                                if prop.SetterSymbol != nil {
                                    prop.SetterSymbol!!.ExplicitInterfaceClauseTarget = target
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
                if !structSymbol.Events.IsDefaultOrEmpty {
                    for evt in structSymbol.Events {
                        if evt.HasExplicitInterfaceClause && evt.ExplicitInterfaceClauseTarget == nil {
                            let target TypeSymbol? = ResolveExplicitInterfaceClauseTarget(
                                structSymbol,
                                evt.Declaration?.ExplicitInterfaceType,
                                evt.Name
                            )
                            if target != nil {
                                evt.ExplicitInterfaceClauseTarget = target
                                // A custom (non-field-like) event's add/remove/
                                // raise accessors are their OWN FunctionSymbol
                                // (see MemberDefEmitter's EmitFunction branch
                                // for a bound AddMethodSymbol/RemoveMethodSymbol/
                                // RaiseMethodSymbol), whose own Declaration has
                                // no clause of its own — mirrors the property
                                // getter/setter propagation immediately above.
                                if evt.AddMethodSymbol != nil {
                                    evt.AddMethodSymbol!!.ExplicitInterfaceClauseTarget = target
                                }
                                if evt.RemoveMethodSymbol != nil {
                                    evt.RemoveMethodSymbol!!.ExplicitInterfaceClauseTarget = target
                                }
                                if evt.RaiseMethodSymbol != nil {
                                    evt.RaiseMethodSymbol!!.ExplicitInterfaceClauseTarget = target
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
                if !structSymbol.StaticMethods.IsDefaultOrEmpty {
                    for method in structSymbol.StaticMethods {
                        if method.HasExplicitInterfaceClause && method.ExplicitInterfaceClauseTarget == nil {
                            let target TypeSymbol? = ResolveExplicitInterfaceClauseTarget(
                                structSymbol,
                                method.Declaration?.ExplicitInterfaceType,
                                method.Name
                            )
                            if target != nil {
                                method.ExplicitInterfaceClauseTarget = target
                            }
                        }
                    }
                }
                if !structSymbol.StaticProperties.IsDefaultOrEmpty {
                    for prop in structSymbol.StaticProperties {
                        if prop.HasExplicitInterfaceClause && prop.ExplicitInterfaceClauseTarget == nil {
                            let target TypeSymbol? = ResolveExplicitInterfaceClauseTarget(
                                structSymbol,
                                prop.Declaration?.ExplicitInterfaceType,
                                prop.Name
                            )
                            if target != nil {
                                prop.ExplicitInterfaceClauseTarget = target
                                // Mirrors the instance-property getter/setter
                                // propagation above: a computed static
                                // property's accessors are their own
                                // FunctionSymbol with no clause of their own.
                                if prop.GetterSymbol != nil {
                                    prop.GetterSymbol!!.ExplicitInterfaceClauseTarget = target
                                }
                                if prop.SetterSymbol != nil {
                                    prop.SetterSymbol!!.ExplicitInterfaceClauseTarget = target
                                }
                            }
                        }
                    }
                }
            } finally {
                this.binderCtx.CurrentTypeParameters = savedTypeParameters
                $scope.SetCurrentDeclaringPackage(savedPackage)
                $scope.SetCurrentReferencingSyntaxTree(savedTree)
            }
        }
    }

    /// ADR-0149: binds an explicit-interface qualifier clause's type
    /// reference and validates it names an interface implemented by
    /// [`structSymbol`](paramref), returning the MATCHING entry from
    /// (cref:StructSymbol.Interfaces) (not the freshly bound instance —
    /// see (cref:ResolveExplicitInterfaceClauses)). Reports GS0492 when
    /// the clause type is not an interface, or GS0493 when it is an interface
    /// the containing type does not implement; returns `null`
    /// in either case (the caller leaves `ExplicitInterfaceClauseTarget`
    /// unset, so the member is treated as unresolved but does not crash
    /// downstream — (cref:VerifyInterfaceImplementations)'s trailing
    /// unresolved-clause sweep does not re-report a second diagnostic for it).
    private func ResolveExplicitInterfaceClauseTarget(
        structSymbol StructSymbol,
        clauseTypeSyntax TypeClauseSyntax?,
        memberName string
    ) TypeSymbol? {
        if clauseTypeSyntax == nil {
            return nil
        }
        let boundType TypeSymbol? = bindTypeClause(clauseTypeSyntax)
        if boundType is InterfaceSymbol clauseIface {
            if !structSymbol.Interfaces.IsDefaultOrEmpty {
                for candidateIface in structSymbol.Interfaces {
                    if TypeSignaturesEquivalent(candidateIface, clauseIface) {
                        return candidateIface
                    }
                }
            }
            Diagnostics.ReportExplicitInterfaceClauseNotImplemented(
                clauseTypeSyntax.Location,
                structSymbol.Name,
                clauseIface.Name,
                memberName
            )
            return nil
        }
        if boundType?.ClrType?.IsInterface == true {
            for candidateIface in structSymbol.ImplementedClrInterfaces {
                if TypeSignaturesEquivalent(candidateIface, boundType) {
                    return candidateIface
                }
                let candidateClr Type? = candidateIface.ClrType
                var inheritsBoundInterface = false
                if candidateClr != nil {
                    for inherited in candidateClr.GetInterfaces() {
                        if ClrTypeUtilities.AreSame(inherited, boundType!!.ClrType) {
                            inheritsBoundInterface = true
                            break
                        }
                    }
                }
                if inheritsBoundInterface {
                    return boundType!!
                }
            }
            Diagnostics.ReportExplicitInterfaceClauseNotImplemented(
                clauseTypeSyntax.Location,
                structSymbol.Name,
                boundType!!.Name,
                memberName
            )
            return nil
        }
        if boundType != nil && boundType != TypeSymbol.Error {
            Diagnostics.ReportExplicitInterfaceClauseTypeNotInterface(
                clauseTypeSyntax.Location,
                boundType.Name,
                memberName
            )
        }
        return nil
    }

    /// Issue #490 (ADR-0060 follow-up): validates a function's optional `ref` return modifier
    /// against the declared return type and async/iterator constraints, reporting diagnostics
    /// for invalid combinations. Returns (cref:RefKind.Ref) when the function should be
    /// modeled as ref-returning, (cref:RefKind.None) otherwise.
    ///
    /// ADR-0101 / issue #799 + #812 — shared validation for variadic
    /// (`...T`) parameters on any declaration kind (top-level
    /// function, class instance method, class static method, interface
    /// method, constructor, delegate, lambda). Reports
    /// `GS0145` ("variadic parameter must be the last parameter")
    /// for every variadic parameter that is not the last syntactic
    /// parameter, and `GS0364` ("a signature may declare at most
    /// one variadic parameter") for any second-or-later occurrence.
    /// The caller is responsible for wrapping the parameter's element
    /// type in a (cref:SliceTypeSymbol) and setting
    /// (cref:ParameterSymbol.IsVariadic).
    private func ValidateVariadicParameterShape(
        parameters GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ParameterSyntax]
    ) {
        var firstVariadicSeen = false
        for var i = 0; i < parameters.Count; i++ {
            if !parameters[i].IsVariadic {
                continue
            }
            // ADR-0185: a destructured parameter's IsVariadic is always
            // false, so the `continue` above already skipped it here too.
            if firstVariadicSeen {
                Diagnostics.ReportMultipleVariadicParameters(
                    parameters[i].Location,
                    parameters[i].Identifier!!.ValueText
                )
            }
            firstVariadicSeen = true
            if i < parameters.Count - 1 {
                Diagnostics.ReportVariadicParameterMustBeLast(
                    parameters[i].Location,
                    parameters[i].Identifier!!.ValueText
                )
            }
        }
    }

    private func ValidateReturnRefKind(syntax FunctionDeclarationSyntax, returnType TypeSymbol) RefKind {
        if !syntax.IsRefReturn {
            return RefKind.None
        }
        let location = syntax.ReturnRefModifier?.Location ?? syntax.Identifier.Location
        if syntax.Type == nil {
            Diagnostics.ReportRefReturnRequiresReturnType(location)
            return RefKind.None
        }
        if syntax.IsAsync {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(location, "async")
            return RefKind.None
        }
        if returnType is SequenceTypeSymbol {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(location, "sequence")
            return RefKind.None
        }
        if returnType is AsyncSequenceTypeSymbol {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(location, "async sequence")
            return RefKind.None
        }
        if returnType is ByRefTypeSymbol {
            Diagnostics.ReportRefReturnOfByRefType(location)
            return RefKind.None
        }
        return if syntax.ReturnReadOnlyModifier != nil {
            RefKind.RefReadOnly
        } else {
            RefKind.Ref
        }
    }

    /// Issue #3879 (ADR-0060 amendment): validates the `ref` return modifier
    /// on a property or indexer declaration and yields the resulting ref-kind.
    /// This is the property-side counterpart of (cref:ValidateReturnRefKind),
    /// and deliberately does NOT share its rule set — a property has no
    /// `async`/iterator form to reject, and it has two rules of its own.
    ///
    /// The by-ref return is restricted to the COMPUTED, read-only forms:
    ///
    /// - the getter must have a body, because a by-ref return has to name the storage it aliases. An
    /// auto-property's getter copies out of a compiler-synthesized backing field, so `ref` would alias the
    /// field — which is either a lie (the caller thinks it is writing to the property) or a hazard: #3878's
    /// GS0219 sweep found the auto-property backing-field path is exactly where by-ref problems
    /// concentrate. A bodiless `{ get }` — an abstract slot or an interface requirement — is rejected for
    /// the same reason plus a second: nothing in this declaration says what is aliased.
    /// - there must be no `set` / `init` accessor, because the returned reference already IS the write
    /// path. C# spells this same rule CS8147.
    /// @param syntax The property/indexer declaration.
    /// @param propertyName The bound property name, used in the diagnostics.
    /// @param propertyType The bound property type.
    /// @param hasBodiedGetter Whether a `get` accessor with a block body is present.
    /// @param writeAccessor The `set` / `init` accessor, or `null` when the property is read-only.
    /// @returns (cref:RefKind.Ref) when the declaration is a well-formed by-ref property, otherwise
    /// (cref:RefKind.None).
    private func ValidatePropertyReturnRefKind(
        syntax PropertyDeclarationSyntax,
        propertyName string,
        propertyType TypeSymbol,
        hasBodiedGetter bool,
        writeAccessor PropertyAccessorSyntax?
    ) RefKind {
        if !syntax.IsRefReturn {
            return RefKind.None
        }
        let location = syntax.ReturnRefModifier?.Location ?? syntax.Identifier.Location
        // ADR-0039 §4: `ref *T` is redundant — the same rule (and the same
        // diagnostic) a ref-returning function gets.
        if propertyType is ByRefTypeSymbol {
            Diagnostics.ReportRefReturnOfByRefType(location)
            return RefKind.None
        }
        // An explicitly written `set` / `init` is answered FIRST, ahead of the
        // computed-getter rule. Both rules can fire on one declaration — a
        // setter-only `prop P ref T { set(v) { … } }` has a write accessor AND
        // no bodied getter — and GS0579 is the more specific answer: it names
        // the accessor the author actually wrote, whereas GS0578 would send
        // them looking for a getter shape when the real defect is that a by-ref
        // property cannot have a setter at all.
        if writeAccessor != nil {
            Diagnostics.ReportRefPropertyCannotHaveSetter(
                writeAccessor.AccessorKeyword.Location,
                propertyName,
                writeAccessor.AccessorKeyword.Text ?? "set"
            )
            return RefKind.None
        }
        // The bare auto-property form (`prop P ref T`, no accessor list) also
        // implies a setter, but it has no accessor OBJECT to point the GS0579
        // message at — so it falls through to here, and GS0578 is both the only
        // available answer and the more informative one.
        if !hasBodiedGetter {
            Diagnostics.ReportRefPropertyRequiresComputedGetter(location, propertyName)
            return RefKind.None
        }
        return if syntax.ReturnReadOnlyModifier != nil {
            RefKind.RefReadOnly
        } else {
            RefKind.Ref
        }
    }

    internal func BindVariableDeclaration(identifier SyntaxToken, isReadOnly bool, type TypeSymbol) VariableSymbol {
        return BindVariableDeclaration(identifier, isReadOnly, type, Accessibility.Public)
    }

    internal func BindVariableDeclaration(
        identifier SyntaxToken,
        isReadOnly bool,
        type TypeSymbol,
        accessibility Accessibility
    ) VariableSymbol {
        var name = identifier.ValueText ?? "?"
        if name == "_" {
            // `_` is a discard declaration, not a lookup-visible binding.
            // Give every occurrence private storage so repeated `let _` and
            // `using let _` declarations can coexist in one scope.
            name = "<>discard${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}"
        }
        let declare = !identifier.IsMissing
        // Direct top-level declarations become global fields. Variables in a
        // nested TLS scope (loops, catches, blocks, etc.) remain method locals;
        // they are not republished into BoundGlobalScope.Variables.
        let inTopLevelContext = function == nil ||
            (function!!.IsTopLevelEntryPoint && object.ReferenceEquals($scope, binderCtx.InitialScope))
        let variable = if inTopLevelContext {
            cast[VariableSymbol](
                GlobalVariableSymbol(name, isReadOnly, type, accessibility, declaringSyntax: identifier)
            )
        } else {
            cast[VariableSymbol](LocalVariableSymbol(name, isReadOnly, type, declaringSyntax: identifier))
        }
        if declare && !$scope.TryDeclareVariable(variable) {
            Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, name)
        }
        return variable
    }

    shared {
        private func BuildTypeParameterSubstitution(
            originals ImmutableArray[TypeParameterSymbol],
            replacements ImmutableArray[TypeParameterSymbol]
        ) Dictionary[TypeParameterSymbol, TypeSymbol] {
            let substitution = Dictionary[TypeParameterSymbol, TypeSymbol](originals.Length)
            for var i = 0; i < originals.Length; i++ {
                substitution[originals[i]] = replacements[i]
            }
            return substitution
        }

        private func IsExplicitAsyncVoid(
            syntax FunctionDeclarationSyntax,
            returnType TypeSymbol
        ) bool -> syntax.IsAsync &&
            syntax.Type != nil &&
            object.ReferenceEquals(returnType, TypeSymbol.Void)

        private func IsInlineSynthesizedMemberName(methodName string) bool {
            return methodName == "Equals" ||
                methodName == "GetHashCode" ||
                methodName == "ToString" ||
                methodName == "op_Equality" ||
                methodName == "op_Inequality" ||
                methodName == "Deconstruct"
        }

        /// Issue #1017: returns the same-package (cref:StructSymbol) (struct
        /// or class) definition for [`type`](paramref) when it is declared in
        /// [`package`](paramref), or `null` otherwise.
        /// @param type The candidate owner type.
        /// @param package The owning package.
        /// @returns The owning struct definition, or `null`.
        private func TryGetSamePackageOwner(type TypeSymbol, $package PackageSymbol?) StructSymbol? {
            if type is StructSymbol structSymbol && $package != nil && string.Equals(
                structSymbol.PackageName,
                $package.Name,
                StringComparison.Ordinal
            ) {
                return structSymbol.Definition ?? structSymbol
            }
            return nil
        }

        /// Issue #410 / ADR-0029: data structs synthesize the same six member
        /// names as inline structs (`Equals`, `GetHashCode`,
        /// `ToString`, `op_Equality`, `op_Inequality`,
        /// `Deconstruct`). User code may not hand-write any of them.
        /// Issue #2361: `ToString` is the one exception — see
        /// (cref:IsUserOverridableDataMemberName) and
        /// (cref:IsCompatibleDataToStringOverride).
        private func IsDataStructSynthesizedMemberName(methodName string) bool {
            return IsInlineSynthesizedMemberName(methodName)
        }

        /// Issue #2361: names in the ADR-0029 synthesized-member set that MAY be
        /// hand-written on a data class/struct when the declared shape is
        /// compatible (see (cref:IsCompatibleDataToStringOverride)),
        /// suppressing/replacing the synthesized member instead of being
        /// unconditionally rejected. Deliberately narrow today (only
        /// `ToString` — a record's display format is the one synthesized
        /// facet C# lets users override while keeping equality/hash/copy
        /// compiler-controlled), but factored as its own predicate (rather than
        /// inlining a literal string compare at each of the three call sites)
        /// so a future issue can widen the set without touching the call sites
        /// again.
        private func IsUserOverridableDataMemberName(methodName string) bool {
            return methodName == "ToString"
        }

        /// Issue #2361: a data class/struct's hand-written `ToString` is
        /// only allowed to suppress/replace the synthesized one when its shape
        /// exactly matches what `DataStructSynthesizer.EmitDataStructToString`
        /// would have emitted — `public string ToString()`: zero
        /// parameters, non-static (the caller only reaches this for the
        /// instance-method lists, so staticness is never in question here),
        /// non-generic, non-async, non-unsafe, returning `string` by value,
        /// with `public` accessibility (matching
        /// `DataStructSynthesizer.DataObjectOverrideAttributes`'s
        /// unconditional `MethodAttributes.Public`). Any other shape keeps
        /// the name collision but is reported as an incompatible override
        /// (GS0487) rather than silently accepted.
        private func IsCompatibleDataToStringOverride(
            explicitParameterCount int32,
            returnType TypeSymbol,
            returnRefKind RefKind,
            isAsync bool,
            isUnsafe bool,
            methodTypeParameters ImmutableArray[TypeParameterSymbol],
            accessibility Accessibility
        ) bool {
            return explicitParameterCount == 0 &&
                returnType == TypeSymbol.String &&
                returnRefKind == RefKind.None &&
                !isAsync &&
                !isUnsafe &&
                methodTypeParameters.IsDefaultOrEmpty &&
                accessibility == Accessibility.Public
        }

        /// ADR-0199: a data type's hand-written `PrintMembers(StringBuilder)`
        /// replaces the synthesized one only when it has the slot's shape: an
        /// instance, non-generic, synchronous method returning `bool` by value
        /// whose accessibility is the one the type's slot requires (`private`
        /// for a sealed type that starts the slot, `protected` otherwise).
        private func IsCompatibleDataPrintMembers(
            owner StructSymbol,
            returnType TypeSymbol,
            returnRefKind RefKind,
            isAsync bool,
            isSuspend bool,
            isOverride bool,
            methodTypeParameters ImmutableArray[TypeParameterSymbol],
            accessibility Accessibility
        ) bool {
            // Like C#: a type with an inherited slot must say `override`, and a type
            // that starts the slot must not (the emitter would otherwise force a
            // CLR override the normal override checks never saw).
            return returnType == TypeSymbol.Bool &&
                isOverride == (DataPrintMembersModel.GetBase(owner, out _) != nil) &&
                returnRefKind == RefKind.None &&
                !isAsync &&
                !isSuspend &&
                methodTypeParameters.IsDefaultOrEmpty &&
                accessibility == DataPrintMembersModel.GetRequiredAccessibility(owner)
        }

        private func TypeParameterConstraintSignaturesEquivalent(
            left ImmutableArray[TypeParameterSymbol],
            right ImmutableArray[TypeParameterSymbol]
        ) bool {
            if left.Length != right.Length {
                return false
            }
            let typeParameterMap = Dictionary[TypeParameterSymbol, TypeSymbol](left.Length)
            for var i = 0; i < left.Length; i++ {
                typeParameterMap[left[i]] = right[i]
            }
            for var i = 0; i < left.Length; i++ {
                let x = left[i]
                let y = right[i]
                if !string.Equals(x.Name, y.Name, StringComparison.Ordinal) ||
                    x.Ordinal != y.Ordinal ||
                    x.Variance != y.Variance ||
                    x.Constraint != y.Constraint ||
                    x.HasReferenceTypeConstraint != y.HasReferenceTypeConstraint ||
                    x.HasValueTypeConstraint != y.HasValueTypeConstraint ||
                    x.HasDefaultConstructorConstraint != y.HasDefaultConstructorConstraint ||
                    x.HasUnmanagedConstraint != y.HasUnmanagedConstraint ||
                    !TypeSignaturesEquivalent(x.InterfaceConstraint, y.InterfaceConstraint, typeParameterMap) ||
                    !TypeSignaturesEquivalent(x.ClrInterfaceConstraint, y.ClrInterfaceConstraint, typeParameterMap) ||
                    !TypeSignaturesEquivalent(x.ClassConstraint, y.ClassConstraint, typeParameterMap) ||
                    !TypeSignaturesEquivalent(x.TypeParameterBound, y.TypeParameterBound, typeParameterMap) {
                    return false
                }
            }
            return true
        }

        /// Issue #1931: extends [`baseTypeArgSubst`](paramref) (the enclosing
        /// class's base-type-argument substitution) with a positional mapping from
        /// a generic base/candidate method's OWN type parameters onto the new
        /// override's own type parameters, when both declare the same arity. A
        /// generic method's `T` is a distinct (cref:TypeParameterSymbol)
        /// instance per declaration, so without this mapping (cref:SignaturesMatch(FunctionSymbol,
        /// ImmutableArray{ParameterSymbol}, TypeSymbol, RefKind, IReadOnlyDictionary{TypeParameterSymbol,
        /// TypeSymbol}))
        /// never sees the base and override `T`s as equal — cascading into
        /// GS0185 (override mismatch), then GS0387/GS0386 (abstract member treated
        /// as unimplemented). Returns [`baseTypeArgSubst`](paramref) unchanged
        /// when the arities do not match (mirrors (cref:TryBuildMethodTypeParameterMap),
        /// which instead returns `null`/no-match there because that caller is
        /// selecting the correct overload rather than only enriching an existing map).
        private func WithMethodTypeParameterSubstitution(
            baseTypeArgSubst IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]?,
            candidate FunctionSymbol,
            overrideTypeParameters ImmutableArray[TypeParameterSymbol]
        ) IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]? {
            let baseTps = candidate.TypeParameters
            let baseArity = if baseTps.IsDefaultOrEmpty {
                0
            } else {
                baseTps.Length
            }
            let overrideArity = if overrideTypeParameters.IsDefaultOrEmpty {
                0
            } else {
                overrideTypeParameters.Length
            }
            if baseArity == 0 || baseArity != overrideArity {
                return baseTypeArgSubst
            }
            let map_ = if baseTypeArgSubst == nil {
                Dictionary[TypeParameterSymbol, TypeSymbol]()
            } else {
                Dictionary[TypeParameterSymbol, TypeSymbol](baseTypeArgSubst)
            }
            for var i = 0; i < baseArity; i++ {
                map_[baseTps[i]] = overrideTypeParameters[i]
            }
            return map_
        }

        /// Issue #1055: builds the substitution mapping each base class's generic
        /// type parameters onto the concrete type arguments supplied where that base
        /// is inherited as a constructed generic. Walking the (cref:StructSymbol.BaseClass)
        /// chain closest-first lets a deeper base's type arguments (which are expressed
        /// in terms of a shallower base's type parameters) resolve transitively, so a
        /// multi-level chain such as `Leaf : Mid[int32] : Base[T]` maps
        /// `Base.T -> int32`. The resulting map is consumed by
        /// (cref:SignaturesMatch(FunctionSymbol, ImmutableArray{ParameterSymbol}, TypeSymbol, RefKind,
        /// IReadOnlyDictionary{TypeParameterSymbol, TypeSymbol}))
        /// so an override whose concrete signature mentions the substituted types is
        /// matched against the base member's un-substituted (open) signature. Returns
        /// `null` when no constructed base contributes a substitution.
        private func BuildBaseTypeArgumentSubstitution(derived StructSymbol) IReadOnlyDictionary[
            TypeParameterSymbol,
            TypeSymbol
        ]? {
            // Issue #4164: this walked `.BaseClass` with no cycle guard. Reached
            // unconditionally from BindStructInstanceMethods for any `override`
            // method, before the post-bind cycle detector (#973) has run —
            // confirmed hanging (dotnet-stack showed this frame spinning) on a
            // two-class base-class cycle with an `override func` on either side.
            // `derived.GetHierarchy()` is the single guarded walk (fixed by
            // #4162); skip the first entry (`derived` itself) to match this
            // loop's original `derived.BaseClass` starting point.
            var subst Dictionary[TypeParameterSymbol, TypeSymbol]? = nil
            let baseChain List[StructSymbol]? = derived?.GetHierarchy()
            if baseChain == nil {
                return nil
            }
            for var level = 1; level < baseChain.Count; level++ {
                let b = baseChain[level]
                if b.Definition == nil || b.TypeArguments.IsDefaultOrEmpty {
                    continue
                }
                let defParams = b.Definition!!.TypeParameters
                if defParams.IsDefaultOrEmpty {
                    continue
                }
                let count = Math.Min(defParams.Length, b.TypeArguments.Length)
                for var i = 0; i < count; i++ {
                    var arg = b.TypeArguments[i]
                    // A deeper base's type argument may itself be a type parameter of
                    // a shallower (already-processed) base; resolve it transitively so
                    // the map always lands on the concrete type in the derived context.
                    if arg is TypeParameterSymbol tpArg && subst != nil && subst.TryGetValue(tpArg, out var resolved) {
                        arg = resolved
                    }
                    subst ??= Dictionary[TypeParameterSymbol, TypeSymbol]()
                    subst!![defParams[i]] = arg
                }
            }
            return subst
        }

        private func SignaturesMatch(
            baseMethod FunctionSymbol,
            derivedParams ImmutableArray[ParameterSymbol],
            derivedReturnType TypeSymbol
        ) bool -> SignaturesMatch(baseMethod, derivedParams, derivedReturnType, RefKind.None)

        private func SignaturesMatch(
            baseMethod FunctionSymbol,
            derivedParams ImmutableArray[ParameterSymbol],
            derivedReturnType TypeSymbol,
            derivedReturnRefKind RefKind
        ) bool -> SignaturesMatch(
            baseMethod,
            derivedParams,
            derivedReturnType,
            derivedReturnRefKind,
            typeParamMap: nil,
            derivedIsAsync: false
        )

        private func SignaturesMatch(
            baseMethod FunctionSymbol,
            derivedParams ImmutableArray[ParameterSymbol],
            derivedReturnType TypeSymbol,
            derivedReturnRefKind RefKind,
            typeParamMap IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]?
        ) bool -> SignaturesMatch(
            baseMethod,
            derivedParams,
            derivedReturnType,
            derivedReturnRefKind,
            typeParamMap,
            derivedIsAsync: false
        )

        /// Issue #1007: signature matching for interface satisfaction / override
        /// resolution, with optional support for generic methods. When the base
        /// (interface) method and the derived (implementing) method are both
        /// generic with the same arity, [`typeParamMap`](paramref) maps the
        /// base method's type-parameter symbols onto the derived method's so that
        /// the plain type-parameter references in the parameter / return types
        /// compare equal positionally (the interface's `T` carries a distinct
        /// (cref:TypeParameterSymbol) instance from the class's `T`).
        private func SignaturesMatch(
            baseMethod FunctionSymbol,
            derivedParams ImmutableArray[ParameterSymbol],
            derivedReturnType TypeSymbol,
            derivedReturnRefKind RefKind,
            typeParamMap IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]?,
            derivedIsAsync bool,
            derivedIsAsyncVoid bool = false
        ) bool {
            if !ReturnTypesMatch(baseMethod, derivedReturnType, derivedIsAsync, derivedIsAsyncVoid, typeParamMap) {
                return false
            }
            // Issue #490: ref-returning methods must agree on the ref-return-ness with their
            // base or interface; otherwise the override is signature-incompatible.
            if baseMethod.ReturnRefKind != derivedReturnRefKind {
                return false
            }
            let baseParams = GetCallableParameters(baseMethod)
            if baseParams.Length != derivedParams.Length {
                return false
            }
            for var i = 0; i < derivedParams.Length; i++ {
                if !ConformanceSignaturesEquivalent(baseParams[i].Type, derivedParams[i].Type, typeParamMap) {
                    return false
                }
                // ADR-0060 §9: two functions that differ only in a parameter's ref-kind
                // are *different signatures*. Required for CLR-faithful override / interface-
                // implementation matching.
                if baseParams[i].RefKind != derivedParams[i].RefKind {
                    return false
                }
            }
            return true
        }

        /// Issue #1918: an `async func` may spell its return-type clause as an
        /// explicit `Task` / `Task[T]` / `ValueTask` / `ValueTask[T]`
        /// wrapper instead of the bare awaited result `T` (the implicit-wrap
        /// form). When it does, the declared wrapper is unwrapped here so
        /// (cref:FunctionSymbol.Type) always holds the awaited result — the
        /// same invariant the implicit form already established — and the caller
        /// records which wrapper was requested ([`isValueTask`](paramref)) so
        /// the state machine / observable return type can be built to match.
        /// @param declaredType The return-type clause as bound by `bindReturnTypeClause`.
        /// @param isAsync Whether the declaration carries the `async` modifier.
        /// @param isValueTask Set to `true` when the declared wrapper was `ValueTask` / `ValueTask[T]`.
        /// @returns The awaited result type when a wrapper was unwrapped; otherwise [`declaredType`](paramref)
        /// unchanged.
        private func NormalizeAsyncDeclaredReturnType(
            declaredType TypeSymbol,
            isAsync bool,
            out isValueTask bool
        ) TypeSymbol {
            isValueTask = false
            if !isAsync {
                return declaredType
            }
            return if AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(
                declaredType,
                out var awaited,
                out isValueTask
            ) {
                awaited!!
            } else {
                declaredType
            }
        }

        /// Issue #1071: compares the base / interface method's declared return type
        /// against the derived (overriding / implementing) method's <em>effective</em>
        /// return type, normalizing for `async`. An `async func` with no
        /// annotation has effective return type `Task`; `async func ... T`
        /// has effective return type `Task[T]`. When exactly one of the two
        /// methods is async, the non-async side's declared `Task` / `Task[T]`
        /// is unwrapped to its awaited result and compared against the async side's
        /// declared (awaited) return type; otherwise the declared types are compared
        /// directly. Genuine return-type mismatches (e.g. an async `Task` method
        /// against a base declaring `Task[int32]`) are still rejected.
        private func ReturnTypesMatch(
            baseMethod FunctionSymbol,
            derivedReturnType TypeSymbol,
            derivedIsAsync bool,
            derivedIsAsyncVoid bool,
            typeParamMap IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]?
        ) bool {
            let baseIsAsync = baseMethod.IsAsync
            if AsyncIteratorDetection.IsAsyncIteratorReturnType(baseMethod.Type) &&
                AsyncIteratorDetection
                .IsAsyncIteratorReturnType(derivedReturnType) {
                return ConformanceSignaturesEquivalent(baseMethod.Type, derivedReturnType, typeParamMap)
            }
            if baseMethod.IsAsyncVoid || derivedIsAsyncVoid {
                let baseIsEffectivelyVoid = baseMethod.IsAsyncVoid ||
                    (!baseIsAsync && object.ReferenceEquals(baseMethod.Type, TypeSymbol.Void))
                let derivedIsEffectivelyVoid = derivedIsAsyncVoid ||
                    (!derivedIsAsync && object.ReferenceEquals(derivedReturnType, TypeSymbol.Void))
                return baseIsEffectivelyVoid && derivedIsEffectivelyVoid
            }
            if baseIsAsync == derivedIsAsync {
                return ConformanceSignaturesEquivalent(baseMethod.Type, derivedReturnType, typeParamMap)
            }
            if derivedIsAsync {
                // Derived is async (declared = awaited result); the base must declare
                // the matching Task / Task[T] wrapper.
                return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(baseMethod.Type, out var baseAwaited) &&
                    ConformanceSignaturesEquivalent(baseAwaited, derivedReturnType, typeParamMap)
            }
            // Base is async (declared = awaited result); the derived (non-async)
            // method must declare the matching Task / Task[T] wrapper.
            return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(derivedReturnType, out var derivedAwaited) &&
                ConformanceSignaturesEquivalent(baseMethod.Type, derivedAwaited, typeParamMap)
        }

        /// Issue #1007: builds the positional map from a generic interface
        /// method's type-parameter symbols onto a candidate implementing method's
        /// type-parameter symbols. Returns `null` when the candidate is not a
        /// viable generic match (mismatched arity) so the caller treats it as no
        /// match; returns an empty map when neither method is generic.
        internal func TryBuildMethodTypeParameterMap(
            baseMethod FunctionSymbol,
            candidate FunctionSymbol
        ) IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]? {
            let baseTps = baseMethod.TypeParameters
            let candTps = candidate.TypeParameters
            let baseArity = if baseTps.IsDefaultOrEmpty {
                0
            } else {
                baseTps.Length
            }
            let candArity = if candTps.IsDefaultOrEmpty {
                0
            } else {
                candTps.Length
            }
            if baseArity != candArity {
                return nil
            }
            if baseArity == 0 {
                return ImmutableDictionary[TypeParameterSymbol, TypeSymbol].Empty
            }
            let map_ = Dictionary[TypeParameterSymbol, TypeSymbol]()
            for var i = 0; i < baseArity; i++ {
                map_[baseTps[i]] = candTps[i]
            }
            return map_
        }

        /// ADR-0060 §9: when (cref:SignaturesMatch(FunctionSymbol, ImmutableArray{ParameterSymbol},
        /// TypeSymbol)) rejected an override / interface
        /// implementation, returns the index of the first parameter whose ref-kind disagrees
        /// (return type and pointee types all matching). Returns -1 when the disagreement is
        /// something other than a ref-kind mismatch (so the caller can fall back to the generic
        /// "signature mismatch" diagnostic).
        private func FindRefKindMismatchIndex(
            baseMethod FunctionSymbol,
            derivedParams ImmutableArray[ParameterSymbol],
            derivedReturnType TypeSymbol
        ) int32 {
            if !TypeSignaturesEquivalent(baseMethod.Type, derivedReturnType) {
                return -1
            }
            let baseParams = GetCallableParameters(baseMethod)
            if baseParams.Length != derivedParams.Length {
                return -1
            }
            for var i = 0; i < derivedParams.Length; i++ {
                if !TypeSignaturesEquivalent(baseParams[i].Type, derivedParams[i].Type) {
                    return -1
                }
            }
            for var i = 0; i < derivedParams.Length; i++ {
                if baseParams[i].RefKind != derivedParams[i].RefKind {
                    return i
                }
            }
            return -1
        }

        /// ADR-0149: resolves and links a member declared with an explicit-
        /// interface qualifier clause (`func (IFoo) M(...)`) on
        /// [`structSymbol`](paramref) against [`imethod`](paramref), an
        /// abstract member of [`iface`](paramref). Returns the linked method
        /// (setting its (cref:FunctionSymbol.ExplicitInterfaceMember) the
        /// first time it is resolved) or `null` if no such method
        /// exists. Matching requires the candidate's
        /// (cref:FunctionSymbol.ExplicitInterfaceClauseTarget) (already
        /// bound by (cref:ResolveExplicitInterfaceClauses)) to be the SAME
        /// interface as [`iface`](paramref), the candidate's own (plain,
        /// unmangled) name to equal [`imethod`](paramref)'s name, and the
        /// signatures to match exactly — mirroring #2010's original mangled-name
        /// matching rules, minus the string parsing.
        private func TryResolveExplicitInterfaceImplementation(
            structSymbol StructSymbol,
            iface InterfaceSymbol,
            imethod FunctionSymbol
        ) FunctionSymbol? {
            for candidate in GetMembersIncludingInherited(structSymbol, (type StructSymbol) -> type.Methods) {
                if object.ReferenceEquals(candidate.ExplicitInterfaceMember, imethod) &&
                    ConformanceSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) {
                    return candidate
                }
                if !candidate.HasExplicitInterfaceClause || candidate.ExplicitInterfaceMember != nil {
                    continue
                }
                if candidate.ExplicitInterfaceClauseTarget == nil ||
                    !TypeSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) ||
                    candidate.Name != imethod.Name {
                    continue
                }
                let typeParamMap IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]? = TryBuildMethodTypeParameterMap(
                    imethod,
                    candidate
                )
                if typeParamMap == nil {
                    continue
                }
                if SignaturesMatch(
                    imethod,
                    GetCallableParameters(candidate),
                    candidate.Type,
                    candidate.ReturnRefKind,
                    typeParamMap,
                    candidate.IsAsync,
                    candidate.IsAsyncVoid
                ) {
                    candidate.ExplicitInterfaceMember = imethod
                    return candidate
                }
            }
            return nil
        }

        private func GetCallableParameters(method FunctionSymbol) ImmutableArray[
            ParameterSymbol
        ] -> if method.ExplicitReceiverParameter == nil {
            method.Parameters
        } else {
            method.Parameters.RemoveAt(0)
        }

        /// ADR-0149 (extending #2010/#2362's resolution to properties/indexers):
        /// resolves and links a property declared with an explicit-interface
        /// qualifier clause (`prop (IFoo) P T` / `prop (IFoo) this[...] T`)
        /// on [`structSymbol`](paramref) against [`iprop`](paramref), an
        /// abstract property of [`iface`](paramref). Returns the linked
        /// property (setting its (cref:PropertySymbol.ExplicitInterfaceMember)
        /// the first time it is resolved) or `null` if no such
        /// property exists. [`iprop`](paramref) may come from
        /// [`iface`](paramref)'s own definition OR (for a constructed
        /// generic interface, whose (cref:InterfaceSymbol.Properties) are
        /// never substituted — see (cref:InterfaceSymbol)) from
        /// `iface.Definition`; either way [`iface`](paramref) itself
        /// supplies the type-argument substitution used to compare
        /// [`iprop`](paramref)'s declared type against the candidate's own
        /// (concrete) type.
        private func TryResolveExplicitInterfacePropertyImplementation(
            structSymbol StructSymbol,
            iface InterfaceSymbol,
            iprop PropertySymbol,
            out setterKindMismatch bool
        ) PropertySymbol? {
            setterKindMismatch = false
            for candidate in GetMembersIncludingInherited(structSymbol, (type StructSymbol) -> type.Properties) {
                if object.ReferenceEquals(candidate.ExplicitInterfaceMember, iprop) &&
                    ConformanceSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) {
                    setterKindMismatch = InterfacePropertySetterKindsMismatch(iprop, candidate)
                    return candidate
                }
                if !candidate.HasExplicitInterfaceClause || candidate.ExplicitInterfaceMember != nil {
                    continue
                }
                if candidate.ExplicitInterfaceClauseTarget == nil ||
                    !ConformanceSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) ||
                    candidate.Name != iprop.Name {
                    continue
                }
                // ADR-0149 (was issue #2362): an explicit property implementation
                // is its own distinct G# member — unlike #985's covariant-return
                // method bridge, there is no "same name, different return type"
                // slot-sharing concern here, so the concrete implementation's
                // type must match the interface slot after substituting the
                // interface's own type parameters. Getter/setter presence must
                // also match.
                // A set/init disagreement is returned separately so the verifier
                // reports GS0502 without cascading GS0494.
                if iprop.HasGetter != candidate.HasGetter || iprop.HasSetter != candidate.HasSetter {
                    continue
                }
                let typeParamMap = BuildInterfaceTypeParameterMap(iface)
                // ADR-0149 (issue #944 / #2362 follow-up): an INDEXER's plain
                // name is always "Item", so distinguishing which of possibly
                // several explicit indexer slots on the SAME implementer
                // matches THIS particular interface indexer member requires
                // comparing the index-parameter list too (types AND count) —
                // the exact same substitution rules as the element Type check
                // below. A no-op for an ordinary (non-indexer) property, whose
                // Parameters is always empty on both sides.
                if iprop.Parameters.Length != candidate.Parameters.Length {
                    continue
                }
                var parametersMatch = true
                for var i = 0; i < iprop.Parameters.Length; i++ {
                    if !ConformanceSignaturesEquivalent(
                        iprop.Parameters[i].Type,
                        candidate.Parameters[i].Type,
                        typeParamMap
                    ) {
                        parametersMatch = false
                        break
                    }
                }
                if !parametersMatch {
                    continue
                }
                if !IsInterfacePropertyTypeCompatible(candidate.Type, iprop.Type, iprop.HasSetter, typeParamMap) {
                    continue
                }
                candidate.ExplicitInterfaceMember = iprop
                setterKindMismatch = InterfacePropertySetterKindsMismatch(iprop, candidate)
                return candidate
            }
            return nil
        }

        /// ADR-0149: resolves and links an event declared with an explicit-
        /// interface qualifier clause (`event (IFoo) Changed T`) on
        /// [`structSymbol`](paramref) against [`ievent`](paramref), an
        /// abstract event of [`iface`](paramref). Mirrors
        /// (cref:TryResolveExplicitInterfacePropertyImplementation)
        /// exactly (matching on the clause's target interface identity, the
        /// candidate's own plain name, and the handler type after substituting
        /// the interface's own type parameters) — this is the FIRST time the
        /// #2010/#2362 explicit-implementation convention is generalized to
        /// events. Returns the linked event (setting its
        /// (cref:EventSymbol.ExplicitInterfaceMember) the first time it
        /// is resolved) or `null` if no such event exists.
        private func TryResolveExplicitInterfaceEventImplementation(
            structSymbol StructSymbol,
            iface InterfaceSymbol,
            ievent EventSymbol
        ) EventSymbol? {
            if structSymbol.Events.IsDefaultOrEmpty {
                return nil
            }
            for candidate in structSymbol.Events {
                if object.ReferenceEquals(candidate.ExplicitInterfaceMember, ievent) {
                    return candidate
                }
                if !candidate.HasExplicitInterfaceClause || candidate.ExplicitInterfaceMember != nil {
                    continue
                }
                if candidate.ExplicitInterfaceClauseTarget == nil ||
                    !ConformanceSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) ||
                    candidate.Name != ievent.Name {
                    continue
                }
                let typeParamMap = BuildInterfaceTypeParameterMap(iface)
                if !ConformanceSignaturesEquivalent(ievent.Type, candidate.Type, typeParamMap) {
                    continue
                }
                candidate.ExplicitInterfaceMember = ievent
                return candidate
            }
            return nil
        }

        /// ADR-0149 follow-up (issue #2370, static explicit interface members):
        /// resolves and links a STATIC method declared with an explicit-
        /// interface qualifier clause (`func (IFoo) M(...)` inside a
        /// `shared { }` block) on [`structSymbol`](paramref) against
        /// [`imethod`](paramref), a static-virtual method of
        /// [`iface`](paramref) (ADR-0089 / issue #755). Mirrors
        /// (cref:TryResolveExplicitInterfaceImplementation) exactly except
        /// it walks (cref:StructSymbol.StaticMethods) and compares
        /// signatures with (cref:StaticVirtualSignaturesMatch) (no
        /// implicit receiver parameter to strip). Returns the linked method
        /// (setting its (cref:FunctionSymbol.ExplicitInterfaceMember) the
        /// first time it is resolved) or `null` if no such
        /// static method exists.
        private func TryResolveExplicitInterfaceStaticImplementation(
            structSymbol StructSymbol,
            iface InterfaceSymbol,
            imethod FunctionSymbol
        ) FunctionSymbol? {
            if structSymbol.StaticMethods.IsDefaultOrEmpty {
                return nil
            }
            for candidate in structSymbol.StaticMethods {
                if object.ReferenceEquals(candidate.ExplicitInterfaceMember, imethod) {
                    return candidate
                }
                if !candidate.HasExplicitInterfaceClause || candidate.ExplicitInterfaceMember != nil {
                    continue
                }
                if candidate.ExplicitInterfaceClauseTarget == nil ||
                    !TypeSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) ||
                    candidate.Name != imethod.Name {
                    continue
                }
                if !StaticVirtualSignaturesMatch(imethod, candidate) {
                    continue
                }
                candidate.ExplicitInterfaceMember = imethod
                return candidate
            }
            return nil
        }

        /// ADR-0149 follow-up (issue #2370, static explicit interface members):
        /// resolves and links a STATIC property declared with an explicit-
        /// interface qualifier clause (`prop (IFoo) P T` inside a
        /// `shared { }` block) on [`structSymbol`](paramref) against
        /// [`iprop`](paramref), a static-virtual property of
        /// [`iface`](paramref) (ADR-0089 / issue #1019). Mirrors
        /// (cref:TryResolveExplicitInterfacePropertyImplementation)
        /// exactly except it walks (cref:StructSymbol.StaticProperties)
        /// and never considers indexer parameters (a static indexer is not a
        /// legal C#/CLR member form at all — indexers always require an
        /// instance receiver — so [`iprop`](paramref) is never an indexer
        /// here). Returns the linked property (setting its
        /// (cref:PropertySymbol.ExplicitInterfaceMember) the first time it
        /// is resolved) or `null` if no such static property
        /// exists.
        private func TryResolveExplicitInterfaceStaticPropertyImplementation(
            structSymbol StructSymbol,
            iface InterfaceSymbol,
            iprop PropertySymbol
        ) PropertySymbol? {
            if structSymbol.StaticProperties.IsDefaultOrEmpty {
                return nil
            }
            for candidate in structSymbol.StaticProperties {
                if object.ReferenceEquals(candidate.ExplicitInterfaceMember, iprop) &&
                    TypeSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) {
                    return candidate
                }
                if !candidate.HasExplicitInterfaceClause || candidate.ExplicitInterfaceMember != nil {
                    continue
                }
                if candidate.ExplicitInterfaceClauseTarget == nil ||
                    !TypeSignaturesEquivalent(candidate.ExplicitInterfaceClauseTarget, iface) ||
                    candidate.Name != iprop.Name {
                    continue
                }
                if iprop.HasGetter != candidate.HasGetter || iprop.HasSetter != candidate.HasSetter {
                    continue
                }
                let typeParamMap = BuildInterfaceTypeParameterMap(iface)
                if !IsInterfacePropertyTypeCompatible(candidate.Type, iprop.Type, iprop.HasSetter, typeParamMap) {
                    continue
                }
                candidate.ExplicitInterfaceMember = iprop
                return candidate
            }
            return nil
        }

        /// Issue #2362: builds the substitution map from a constructed generic
        /// interface's OWN type parameters (declared on `iface.Definition`)
        /// to [`iface`](paramref)'s type arguments, for comparing an
        /// interface property's declared (open) type against an implementer's
        /// concrete type via (cref:TypeSignaturesEquivalent(TypeSymbol, TypeSymbol,
        /// IReadOnlyDictionary{TypeParameterSymbol, TypeSymbol})).
        /// Returns `null` for a non-generic interface (or the
        /// open definition itself), matching that method's "no substitution"
        /// convention.
        internal func BuildInterfaceTypeParameterMap(iface InterfaceSymbol) Dictionary[
            TypeParameterSymbol,
            TypeSymbol
        ]? {
            let def InterfaceSymbol? = iface.Definition
            if def == nil || object.ReferenceEquals(def, iface) || def.TypeParameters.IsDefaultOrEmpty {
                return nil
            }
            let map_ = Dictionary[TypeParameterSymbol, TypeSymbol]()
            for var i = 0; i < def.TypeParameters.Length && i < iface.TypeArguments.Length; i++ {
                map_[def.TypeParameters[i]] = iface.TypeArguments[i]
            }
            return map_
        }

        private func HasAnyExplicitInterfaceClause(methods ImmutableArray[FunctionSymbol]) bool {
            for m in methods {
                if m.HasExplicitInterfaceClause {
                    return true
                }
            }
            return false
        }

        private func HasAnyExplicitInterfaceClause(properties ImmutableArray[PropertySymbol]) bool {
            for p in properties {
                if p.HasExplicitInterfaceClause {
                    return true
                }
            }
            return false
        }

        private func HasAnyExplicitInterfaceClause(events ImmutableArray[EventSymbol]) bool {
            for e in events {
                if e.HasExplicitInterfaceClause {
                    return true
                }
            }
            return false
        }

        /// Issue #974: structural equivalence used by override / interface-
        /// implementation signature matching. Constructed generic types are not
        /// interned ((cref:ImportedTypeSymbol.GetConstructed) and
        /// (cref:InterfaceSymbol.Construct) can yield fresh instances), so a
        /// raw reference comparison wrongly rejects, for example, the class method
        /// `func Iter() IEnumerator[T]` against the interface requirement
        /// `ISeq[T].Iter() IEnumerator[T]` once the interface's type
        /// parameters have been substituted with the implementing type's
        /// arguments. Reference identity is honoured first (covering plain type
        /// parameters, primitives and cached imported types); constructed generics
        /// are then compared by definition and ordered type arguments, recursing
        /// through slice / array / nullable wrappers. Issue #3093 also projects
        /// `sequence[T]` and `async sequence[T]` onto their matching CLR
        /// enumerable interface shapes. The comparison stays strict —
        /// distinct type arguments (e.g. `IEnumerator[int32]` vs
        /// `IEnumerator[T]`) are not equated — so genuinely mismatched
        /// signatures are still rejected with GS0187.
        internal func TypeSignaturesEquivalent(a TypeSymbol?, b TypeSymbol?) bool -> TypeSignaturesEquivalent(
            a,
            b,
            typeParamMap: nil
        )

        internal func IsCovariantPropertyOverride(
            baseProperty PropertySymbol,
            derivedType TypeSymbol,
            derivedHasGetter bool,
            derivedHasSetter bool,
            derivedReturnRefKind RefKind
        ) bool -> IsCovariantPropertyOverride(
            baseProperty.Type,
            baseProperty.HasGetter,
            baseProperty.HasSetter,
            baseProperty.ReturnRefKind,
            derivedType,
            derivedHasGetter,
            derivedHasSetter,
            derivedReturnRefKind
        )

        internal func IsCovariantPropertyOverride(
            baseType TypeSymbol,
            baseHasGetter bool,
            baseHasSetter bool,
            baseReturnRefKind RefKind,
            derivedType TypeSymbol,
            derivedHasGetter bool,
            derivedHasSetter bool,
            derivedReturnRefKind RefKind
        ) bool -> baseHasGetter &&
            derivedHasGetter &&
            !baseHasSetter &&
            !derivedHasSetter &&
            baseReturnRefKind == RefKind.None &&
            derivedReturnRefKind == RefKind.None &&
            !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(baseType, derivedType) &&
            Conversion.IsImplicitReferenceVariantSlot(derivedType, baseType)

        /// ADR-0187 / issue #4350: finds the base-class property an
        /// `override` targets. A named property is found by name; an indexer
        /// is found by its index-parameter signature, because a type may declare
        /// several overloaded `Item` indexers.
        /// @param baseClass The overriding type's base class.
        /// @param propName The property's CLR name.
        /// @param isIndexer Whether the overriding property is an indexer.
        /// @param indexerParameters The overriding indexer's index parameters.
        /// @param baseProperty The matched base property.
        /// @returns `true` when a candidate was found.
        internal func TryGetOverriddenPropertyCandidate(
            baseClass StructSymbol,
            propName string,
            isIndexer bool,
            indexerParameters ImmutableArray[ParameterSymbol],
            @NotNullWhen(true) out baseProperty PropertySymbol?
        ) bool {
            if !isIndexer {
                return TypeMemberModel.TryGetProperty(baseClass, propName, out baseProperty)
            }
            for level in baseClass.GetHierarchy() {
                for candidate in level.Properties {
                    if candidate.IsIndexer && HaveSameIndexerSignature(candidate.Parameters, indexerParameters) {
                        baseProperty = candidate
                        return true
                    }
                }
            }
            // Keep the historical name-based answer so a signature mismatch still
            // reports the override-signature diagnostic instead of "no base".
            return TypeMemberModel.TryGetProperty(baseClass, propName, out baseProperty)
        }

        /// Issue #4481: whether an override property's type conforms to the base
        /// property's, so the override can reuse the base accessor slot. The base
        /// type is read through the derived type's base-class type arguments, and
        /// reference-type nullability is ignored: `Sym` and `Sym?` have
        /// the same CLR signature, as C# nullability variance allows.
        /// @param derived The overriding type.
        /// @param baseProperty The base property being overridden.
        /// @param overrideType The override's declared type.
        /// @returns `true` when the two types are the same slot type.
        internal func PropertyOverrideTypeConforms(
            derived StructSymbol,
            baseProperty PropertySymbol,
            overrideType TypeSymbol
        ) bool {
            let baseType = baseProperty.Type
            if object.ReferenceEquals(baseType, TypeSymbol.Error) || object.ReferenceEquals(
                overrideType,
                TypeSymbol.Error
            ) {
                // The type already failed to bind and has its own diagnostic.
                return true
            }
            let substitution = BuildBaseTypeArgumentSubstitution(derived)
            if ConformanceSignaturesEquivalent(baseType, overrideType, substitution) {
                return true
            }
            // Reference nullability is metadata only at EVERY nesting level:
            // `List[Sym?]` and `List[Sym]` are one CLR slot type.
            return TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                SubstituteBaseType(baseType, substitution),
                overrideType
            )
        }

        // Issue #4481: reads a base member's type through the derived type's
        // base-class type arguments (`Node[T]`'s `T` is `Sym` in `: Node[Sym]`).
        private func SubstituteBaseType(
            baseType TypeSymbol,
            substitution IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]?
        ) TypeSymbol -> if substitution == nil ||
            substitution.Count == 0 {
            baseType
        } else {
            Binder.SubstituteType(baseType, Dictionary[TypeParameterSymbol, TypeSymbol](substitution))
        }

        /// ADR-0187 / issue #4350: whether two indexers declare the same
        /// index-parameter signature (count, types, and ref-kinds). Indexers
        /// overload by this signature, exactly as in C#.
        /// @param left The first indexer's index parameters.
        /// @param right The second indexer's index parameters.
        /// @returns `true` when the signatures are identical.
        internal func HaveSameIndexerSignature(
            left ImmutableArray[ParameterSymbol],
            right ImmutableArray[ParameterSymbol]
        ) bool {
            if left.Length != right.Length {
                return false
            }
            for var i = 0; i < left.Length; i++ {
                if left[i].RefKind != right[i].RefKind || !TypeSignaturesEquivalent(left[i].Type, right[i].Type) {
                    return false
                }
            }
            return true
        }

        @ThreadStatic
        private var conformanceMatchingDepth int32

        /// ADR-0186: (cref:TypeSignaturesEquivalent(TypeSymbol, TypeSymbol,
        /// IReadOnlyDictionary{TypeParameterSymbol, TypeSymbol}))
        /// asked as a <em>conformance</em> question — does this member implement
        /// or override that slot — which reads through a platform wrapper
        /// (`T!` has `T`'s signature) at every nesting level. Every
        /// other caller keeps the exact comparison. The scope is thread-static and
        /// counted, so it follows the recursion and nests safely.
        /// @param a The slot's type.
        /// @param b The candidate's type.
        /// @param typeParamMap The method type-parameter correspondence, if any.
        /// @returns `true` when the signatures conform.
        internal func ConformanceSignaturesEquivalent(
            a TypeSymbol?,
            b TypeSymbol?,
            typeParamMap IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]? = nil
        ) bool {
            conformanceMatchingDepth++
            try {
                return TypeSignaturesEquivalent(a, b, typeParamMap)
            } finally {
                conformanceMatchingDepth--
            }
        }

        private func StripPlatformOrReferenceNullable(type TypeSymbol?) TypeSymbol? -> switch type {
            case platform is PlatformTypeSymbol: platform.UnderlyingType
            case nullable is NullableTypeSymbol when Conversion.IsReferenceLikeTarget(
                nullable.UnderlyingType
            ): nullable.UnderlyingType
            default: type
        }

        internal func InterfaceEventTypesEquivalent(
            iface InterfaceSymbol?,
            interfaceEvent EventSymbol?,
            implementation EventSymbol?
        ) bool -> iface != nil &&
            interfaceEvent != nil &&
            implementation != nil &&
            ConformanceSignaturesEquivalent(
            interfaceEvent.Type,
            implementation.Type,
            BuildInterfaceTypeParameterMap(iface)
        )

        internal func TypeSignaturesEquivalent(
            a TypeSymbol?,
            b TypeSymbol?,
            typeParamMap IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]?
        ) bool {
            var a = a
            var b = b
            // Issue #1007: substitute a generic interface method's type parameter
            // with the implementing method's positionally-corresponding type
            // parameter before comparing, so `T_iface` and `T_class` match.
            if typeParamMap != nil && a is TypeParameterSymbol tpa && typeParamMap.TryGetValue(tpa, out var mappedA) {
                a = mappedA
            }
            // ADR-0186: signature matching (interface implementation, override,
            // event equivalence) is a conformance relation — and ONLY there does
            // this apply: this predicate is also the exact pointee gate for
            // `ref`/`out`/`in` arguments and the identity test for constructed
            // types, where treating `T!` as `T` would forward a platform slot's
            // address to a non-null `ref T` parameter with no §4 check, or reopen
            // ADR-0186 §3 rule 3 for source generics. So it is scoped to callers
            // that go through ConformanceSignaturesEquivalent. `T!` has `T`'s
            // signature (§1). A member declared in an ADR-0186 §9 oblivious scope
            // (`func Make(x Item) Item` there is `Item! -> Item!`) must match the
            // slot an enabled declaration wrote as `Item` — and, since oblivious
            // means "nothing was stated", one written as `Item?` too, as C#
            // accepts an oblivious override of an annotated member. Recursion
            // applies the same reading to nested positions.
            if conformanceMatchingDepth > 0 && (a is PlatformTypeSymbol || b is PlatformTypeSymbol) {
                a = StripPlatformOrReferenceNullable(a)
                b = StripPlatformOrReferenceNullable(b)
            }
            if object.ReferenceEquals(a, b) {
                return true
            }
            if a == nil || b == nil {
                return false
            }
            // Issue #4446: reference `T?` is a signature annotation over the same
            // CLR type as `T`, but value `T?` is the distinct Nullable<T> storage
            // shape. Do this before recursive constructed-type comparison and the
            // CLR leaf fallback so the distinction holds at every nesting depth.
            if (
                a is NullableTypeSymbol nullableA &&
                    !(b is NullableTypeSymbol) &&
                    NullableLifting.IsAnyValueTypeNullable(nullableA)
            ) ||
                (
                b is NullableTypeSymbol nullableB &&
                    !(a is NullableTypeSymbol) &&
                    NullableLifting.IsAnyValueTypeNullable(nullableB)
            ) {
                return false
            }
            if a is NullableTypeSymbol referenceNullableA && !(b is NullableTypeSymbol) {
                return TypeSignaturesEquivalent(referenceNullableA.UnderlyingType, b, typeParamMap)
            }
            if b is NullableTypeSymbol referenceNullableB && !(a is NullableTypeSymbol) {
                return TypeSignaturesEquivalent(a, referenceNullableB.UnderlyingType, typeParamMap)
            }
            if a is FunctionPointerTypeSymbol || b is FunctionPointerTypeSymbol {
                return a is FunctionPointerTypeSymbol leftPointer &&
                    b is FunctionPointerTypeSymbol rightPointer &&
                    leftPointer
                    .SignatureEquals(
                    rightPointer,
                    (left TypeSymbol, right TypeSymbol) -> TypeSignaturesEquivalent(left, right, typeParamMap)
                )
            }
            let aIsSequence = SequenceTypeSymbol.TryGetEnumerableInterfaceShape(
                a,
                out var aSequenceDefinition,
                out var aSequenceElement
            )
            let bIsSequence = SequenceTypeSymbol.TryGetEnumerableInterfaceShape(
                b,
                out var bSequenceDefinition,
                out var bSequenceElement
            )
            if aIsSequence || bIsSequence {
                return aIsSequence &&
                    bIsSequence &&
                    aSequenceDefinition != nil &&
                    bSequenceDefinition != nil &&
                    ClrTypeUtilities.AreSame(aSequenceDefinition, bSequenceDefinition) &&
                    TypeSignaturesEquivalent(aSequenceElement, bSequenceElement, typeParamMap)
            }
            if a is StructSymbol sa && b is StructSymbol sb {
                return object.ReferenceEquals(sa.Definition, sb.Definition) &&
                    TypeArgumentsEquivalent(sa.TypeArguments, sb.TypeArguments, typeParamMap)
            }
            if a is InterfaceSymbol ia && b is InterfaceSymbol ib {
                return object.ReferenceEquals(ia.Definition, ib.Definition) &&
                    TypeArgumentsEquivalent(ia.TypeArguments, ib.TypeArguments, typeParamMap)
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
            if a is DelegateTypeSymbol dta && b is DelegateTypeSymbol dtb {
                // Unlike StructSymbol/InterfaceSymbol (whose `Definition` self-
                // references on the open definition), DelegateTypeSymbol.Definition
                // is only set on constructed instances (issue #1503) and stays
                // `null` on the open definition / non-generic delegates — so it
                // must be normalized to itself before comparing, or two distinct
                // non-generic (or open-definition) delegate types would both
                // report `Definition == null` and wrongly compare as equivalent.
                let defA = dta.Definition ?? dta
                let defB = dtb.Definition ?? dtb
                return object.ReferenceEquals(defA, defB) &&
                    TypeArgumentsEquivalent(dta.TypeArguments, dtb.TypeArguments, typeParamMap)
            }
            if a is ImportedTypeSymbol pa && b is ImportedTypeSymbol pb {
                // Constructed imported generics carrying symbolic arguments (e.g.
                // `IEnumerator[T]`) are compared by open definition and ordered
                // arguments so an unbound type parameter compares by identity
                // rather than by its erased `object` CLR projection.
                if pa.OpenDefinition != nil && pb.OpenDefinition != nil && pa.OpenDefinition == pb.OpenDefinition {
                    return TypeArgumentsEquivalent(pa.TypeArguments, pb.TypeArguments, typeParamMap)
                }
                // Otherwise (one or both sides expressed as a plain closed CLR
                // type, e.g. a fully concrete `IEnumerator[int32]`) fall back to a
                // closed-type comparison. This is only sound when neither side
                // carries an unbound type parameter, whose CLR shape is erased to
                // `object` and would otherwise equate distinct constructions.
                if !TypeSymbol.ContainsTypeParameter(pa) && !TypeSymbol.ContainsTypeParameter(pb) {
                    return pa.ClrType != nil && pb.ClrType != nil && ClrTypeUtilities.AreSame(pa.ClrType, pb.ClrType)
                }
                return false
            }
            if a is SliceTypeSymbol sla && b is SliceTypeSymbol slb {
                return TypeSignaturesEquivalent(sla.ElementType, slb.ElementType, typeParamMap)
            }
            if a is ArrayTypeSymbol ara && b is ArrayTypeSymbol arb {
                return ara.Length == arb.Length &&
                    TypeSignaturesEquivalent(ara.ElementType, arb.ElementType, typeParamMap)
            }
            if a is RectangularArrayTypeSymbol raa && b is RectangularArrayTypeSymbol rab {
                return raa.Rank == rab.Rank && TypeSignaturesEquivalent(raa.ElementType, rab.ElementType, typeParamMap)
            }
            if a is NullableTypeSymbol na && b is NullableTypeSymbol nb {
                return TypeSignaturesEquivalent(na.UnderlyingType, nb.UnderlyingType, typeParamMap)
            }
            // ADR-0186: under a conformance comparison, the structural shapes
            // that can carry a nested platform position over a same-compilation
            // type — whose ClrType is null, so the leaf fallback below cannot
            // answer — compare element by element, so `(Item) -> Item` conforms to
            // an oblivious `(Item!) -> Item!`. Scoped to conformance so every
            // exact caller keeps its existing answer for these shapes.
            if conformanceMatchingDepth > 0 {
                switch (a, b) {
                    case {Item1: fa is FunctionTypeSymbol, Item2: fb is FunctionTypeSymbol} {
                        return fa
                            .ParameterTypes
                            .Length == fb
                            .ParameterTypes
                            .Length &&
                            fa.HasVariadic == fb.HasVariadic &&
                            TypeArgumentsEquivalent(fa.ParameterTypes, fb.ParameterTypes, typeParamMap) &&
                            TypeSignaturesEquivalent(fa.ReturnType, fb.ReturnType, typeParamMap)
                    }
                    case {Item1: ta is TupleTypeSymbol, Item2: tb is TupleTypeSymbol} {
                        return TypeArgumentsEquivalent(ta.ElementTypes, tb.ElementTypes, typeParamMap)
                    }
                    case {Item1: ma is MapTypeSymbol, Item2: mb is MapTypeSymbol} {
                        return TypeSignaturesEquivalent(ma.KeyType, mb.KeyType, typeParamMap) &&
                            TypeSignaturesEquivalent(ma.ValueType, mb.ValueType, typeParamMap)
                    }
                    case {Item1: ca is ChannelTypeSymbol, Item2: cb is ChannelTypeSymbol} {
                        return ca.Direction == cb.Direction &&
                            TypeSignaturesEquivalent(ca.ElementType, cb.ElementType, typeParamMap)
                    }
                }
            }
            // Leaf fallback for non-generic types that are not reference-interned
            // (e.g. a primitive supplied as a concrete type argument such as the
            // `int32` in `ISeq[int32]`). Type parameters keep an absent ClrType so
            // distinct parameters are never wrongly equated here.
            return a.ClrType != nil && b.ClrType != nil && a.ClrType == b.ClrType
        }

        private func TypeArgumentsEquivalent(
            a ImmutableArray[TypeSymbol],
            b ImmutableArray[TypeSymbol]
        ) bool -> TypeArgumentsEquivalent(a, b, typeParamMap: nil)

        private func TypeArgumentsEquivalent(
            a ImmutableArray[TypeSymbol],
            b ImmutableArray[TypeSymbol],
            typeParamMap IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]?
        ) bool {
            if a.IsDefaultOrEmpty && b.IsDefaultOrEmpty {
                return true
            }
            if a.IsDefaultOrEmpty || b.IsDefaultOrEmpty || a.Length != b.Length {
                return false
            }
            for var i = 0; i < a.Length; i++ {
                if !TypeSignaturesEquivalent(a[i], b[i], typeParamMap) {
                    return false
                }
            }
            return true
        }
    }
}
