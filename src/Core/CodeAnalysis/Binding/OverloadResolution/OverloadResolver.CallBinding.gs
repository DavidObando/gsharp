// <copyright file="OverloadResolver.CallBinding.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.OverloadResolution

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import System.Globalization

internal partial class OverloadResolver {
    /// Issues #3760/#3766: the user-generic counterpart of
    /// `ClrOverloadResolution.TryInferMethodGroupArgument`. A method group
    /// argument carries no type, so a type parameter reachable only through
    /// the target delegate never receives a bound from the positional pass.
    /// Closed inputs drive normal overload resolution; otherwise a single
    /// arity-matching candidate can supply parameter and return bounds.
    private func InferFromUserMethodGroupArgument(
        parameterType TypeSymbol,
        argument BoundExpression,
        substitution Dictionary[TypeParameterSymbol, TypeSymbol]
    ) {
        if !(argument is BoundMethodGroupExpression) &&
            !(argument is BoundClrMethodGroupExpression) ||
            !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(parameterType, out var target) ||
            (
            !TypeSymbol.ContainsTypeParameter(target!!.ReturnType) && !target!!.ParameterTypes.Any(
                TypeSymbol.ContainsTypeParameter
            )
        ) {
            return
        }
        var hasUnboundInput = false
        let closedInputs = [target!!.ParameterTypes.Length]TypeSymbol
        for var i = 0; i < closedInputs.Length; i++ {
            let closedInput TypeSymbol? = substituteType(target!!.ParameterTypes[i], substitution)
            if closedInput == nil || closedInput == TypeSymbol.Error || TypeSymbol.ContainsTypeParameter(closedInput) {
                hasUnboundInput = true
                break
            }
            closedInputs[i] = closedInput
        }
        if !hasUnboundInput {
            let selectedReturn TypeSymbol? = if argument is BoundClrMethodGroupExpression clrGroup {
                ResolveClrMethodGroupReturn(clrGroup, closedInputs)
            } else {
                ResolveUserMethodGroupReturn(cast[BoundMethodGroupExpression](argument), closedInputs)
            }
            if selectedReturn != nil {
                inferTypeArguments(target!!.ReturnType, selectedReturn, substitution)
            }
            return
        }
        if !TryGetSingleMethodGroupSignature(
            argument,
            target!!.ParameterTypes.Length,
            out var candidateParameters,
            out var candidateReturn
        ) {
            return
        }
        for var i = 0; i < target!!.ParameterTypes.Length; i++ {
            inferTypeArguments(target!!.ParameterTypes[i], candidateParameters!![i], substitution)
        }
        inferTypeArguments(target!!.ReturnType, candidateReturn!!, substitution)
    }

    private func TryGetSingleMethodGroupSignature(
        argument BoundExpression,
        delegateArity int32,
        @NotNullWhen(true) out parameters[]?TypeSymbol,
        @NotNullWhen(true) out returnType TypeSymbol?
    ) bool {
        parameters = nil
        returnType = nil
        if argument is BoundClrMethodGroupExpression clrGroup {
            var method MethodInfo? = nil
            var parameterOffset = 0
            for possibleMethod in clrGroup.Candidates {
                let candidateOffset = if clrGroup.Receiver != nil && possibleMethod.IsStatic {
                    1
                } else {
                    0
                }
                let candidateParameters = ImportedFunctionSymbol.GetLogicalParameters(possibleMethod, out _)
                if candidateParameters.Length - candidateOffset != delegateArity {
                    continue
                }
                if method != nil {
                    return false
                }
                method = possibleMethod
                parameterOffset = candidateOffset
            }
            if method == nil || method.ContainsGenericParameters {
                return false
            }
            // ADR-0193 Phase 2: read through the funnel, then taken bare. A
            // method group's signature feeds type inference, which has always
            // seen the erased shapes here; inferring from the declared
            // nullability instead is a Phase 4 change (issue #4363).
            let methodParameters = ImportedFunctionSymbol.GetLogicalParameters(method, out _)
            parameters = [delegateArity]TypeSymbol
            for var i = 0; i < parameters!!.Length; i++ {
                parameters!![i] = ClrNullability.GetParameterTypeSymbol(methodParameters[i + parameterOffset])
                    .StripToBareShape()
            }
            returnType = if method.ReturnType.IsSameAs(typeof(Void)) {
                TypeSymbol.Void
            } else {
                ClrNullability.GetReturnTypeSymbol(method).StripToBareShape()
            }
            return true
        }
        if argument is not BoundMethodGroupExpression userGroup {
            return false
        }
        if userGroup
            .Candidates
            .Length == 1 &&
            userGroup.FunctionType is {} naturalType &&
            naturalType
            .ParameterTypes
            .Length == delegateArity {
            parameters = naturalType.ParameterTypes.ToArray()
            returnType = naturalType.ReturnType
            return true
        }
        var candidate FunctionSymbol? = nil
        var parameterOffsetForUser = 0
        for possibleCandidate in userGroup.Candidates {
            let candidateOffset = if possibleCandidate.IsExtension && userGroup.Receiver != nil {
                1
            } else {
                0
            }
            if possibleCandidate.Parameters.Length - candidateOffset != delegateArity {
                continue
            }
            if candidate != nil {
                return false
            }
            candidate = possibleCandidate
            parameterOffsetForUser = candidateOffset
        }
        if candidate == nil || candidate.IsGeneric {
            return false
        }
        var candidateOwner StructSymbol? = if userGroup.StaticOwnerType != nil &&
            candidate.StaticOwnerType is StructSymbol declaredOwner {
            TypeMemberModel.ResolveStaticMemberOwner(userGroup.StaticOwnerType, declaredOwner)
        } else {
            default(StructSymbol?)
        }
        if candidateOwner == nil &&
            !candidate.IsExtension &&
            userGroup
            .Receiver
            ?.Type is StructSymbol receiverStruct &&
            candidate.ReceiverType is StructSymbol declaredReceiver {
            candidateOwner = TypeMemberModel.ResolveStaticMemberOwner(receiverStruct, declaredReceiver)
        }
        parameters = [delegateArity]TypeSymbol
        for var i = 0; i < parameters!!.Length; i++ {
            parameters!![i] = candidateOwner?.SubstituteMemberType(
                candidate.Parameters[i + parameterOffsetForUser].Type
            ) ??
                candidate
                .Parameters[i + parameterOffsetForUser]
                .Type
        }
        var observableReturn = candidate.Type ?? TypeSymbol.Void
        if candidate.IsAsyncOrSuspending && !candidate.IsAsyncVoid && !isAsyncIteratorReturnType(observableReturn) {
            observableReturn = wrapAsTask(observableReturn, candidate.AsyncReturnsValueTask)
        }
        returnType = candidateOwner?.SubstituteMemberType(observableReturn) ?? observableReturn
        return true
    }

    /// Issue #3760: the imported (CLR) sibling of
    /// (cref:ResolveUserMethodGroupReturn). Projects the closed input
    /// types to CLR, runs the ordinary CLR overload selection over the group's
    /// candidates, and maps the winner's return type back to a symbol.
    private func ResolveClrMethodGroupReturn(
        group BoundClrMethodGroupExpression,
        closedInputs[]TypeSymbol
    ) TypeSymbol? {
        if group.Candidates.IsDefaultOrEmpty {
            return nil
        }
        // A group whose receiver is present but whose candidates are all
        // static is an extension group: slot 0 of the CLR signature is the
        // receiver, and the delegate's inputs start at slot 1.
        var closesExtensionReceiver = group.Receiver != nil
        for candidate in group.Candidates {
            closesExtensionReceiver &= candidate.IsStatic
        }
        let offset = if closesExtensionReceiver {
            1
        } else {
            0
        }
        let resolutionArguments = [closedInputs.Length + offset]Type
        if closesExtensionReceiver {
            let receiverType = Invariant.Required(
                group.Receiver,
                "an extension method group has a receiver",
                expression: "group.Receiver"
            )
                .Type
            if receiverType.ClrType is not{} receiverClr {
                return nil
            }
            resolutionArguments[0] = binderCtx.References.MapClrTypeToReferences(receiverClr)!!
        }
        for var i = 0; i < closedInputs.Length; i++ {
            if closedInputs[i].ClrType is not{} inputClr {
                // A same-compilation input has no CLR backing to resolve an
                // imported overload against.
                return nil
            }
            resolutionArguments[i + offset] = binderCtx.References.MapClrTypeToReferences(inputClr)!!
        }
        // #835/#3753: `IsSameAs` rather than reference identity — the
        // candidate may come from a MetadataLoadContext, where the host
        // `typeof(void)` is a different Type instance.
        let resolution = ClrOverloadResolution.Resolve(
            group.Candidates,
            resolutionArguments,
            trailingParameterCountToIgnore: (candidate MethodBase) -> if candidate is MethodInfo method &&
                ImportedFunctionSymbol.HasHiddenContextParameter(method) {
                1
            } else {
                0
            }
        )
        if resolution.Outcome != ClrOverloadResolution
            .ResolutionOutcome
            .Resolved ||
            resolution.Best is not{} best ||
            best.IsGenericMethodDefinition ||
            best
            .ReturnType
            .IsSameAs(typeof(Void)) {
            return nil
        }
        // ADR-0193 Phase 2: read through the funnel and taken bare, as the
        // method-group signature above is.
        return ClrNullability.GetReturnTypeSymbol(best).StripToBareShape()
    }

    private func TryResolveImplicitInheritedTypeArguments(
        typeArgumentList TypeArgumentListSyntax?,
        out clrTypeArguments[]?Type,
        out typeArgumentSymbols ImmutableArray[TypeSymbol]
    ) bool {
        clrTypeArguments = nil
        typeArgumentSymbols = default(ImmutableArray[TypeSymbol])
        if typeArgumentList == nil {
            return true
        }
        clrTypeArguments = [typeArgumentList.Arguments.Count]Type
        let symbols = ImmutableArray.CreateBuilder[TypeSymbol](typeArgumentList.Arguments.Count)
        for var i = 0; i < typeArgumentList.Arguments.Count; i++ {
            let symbol TypeSymbol? = bindTypeClause(typeArgumentList.Arguments[i])
            if symbol == nil {
                return false
            }
            symbols.Add(symbol)
            let clrType Type? = NullableLifting.GetEffectiveClrType(symbol)
            clrTypeArguments!![i] = if clrType != nil {
                binderCtx.References.MapClrTypeToReferences(clrType)!!
            } else {
                binderCtx.References.GetCoreType("System.Object")
            }
        }
        typeArgumentSymbols = symbols.MoveToImmutable()
        return true
    }

    /// Issue #1159: returns the implicit-`this` parameter that an
    /// unqualified instance-member reference should bind against. For a direct
    /// instance method (or interface default method) body this is the enclosing
    /// function's own (cref:FunctionSymbol.ThisParameter). Inside a
    /// lambda body the enclosing function is a synthetic
    /// (cref:FunctionSymbol) with no receiver, so we fall back to the
    /// `this` that is still visible in the current lexical scope — the
    /// enclosing instance method's `this`, which the lambda's child scope
    /// inherits and which capture analysis already captures into the display
    /// class (mirroring how explicit `this.X` and bare field/property
    /// reads already work and capture). In a static context no `this` is
    /// in scope, so this returns `null` and unqualified
    /// resolution stays unchanged.
    private func GetEffectiveThisParameter() ParameterSymbol? {
        if binderCtx.InConstructorInitializer {
            return nil
        }
        let current = getCurrentFunction()
        if current?.ThisParameter != nil {
            return current!!.ThisParameter!!
        }
        return Scope.TryLookupSymbol("this") as ParameterSymbol
    }

    /// Issue #3487: the lexical owner for implicit static-self dispatch. A
    /// member body carries it as the function's own `StaticOwnerType`; a
    /// function literal nested in that body has a synthetic symbol with no
    /// `StaticOwnerType`, only the `LexicalEnclosingType` chained
    /// through `LambdaBinder.ResolveLexicalEnclosingType` — falling back
    /// to it makes bare sibling `shared` calls resolve identically in
    /// both positions (they already did inside instance-method lambdas via
    /// the effective-`this` path).
    private func GetImplicitStaticSelfOwner() TypeSymbol? {
        let current = getCurrentFunction()
        return if current?.ThisParameter != nil {
            default(TypeSymbol?)
        } else {
            current?.StaticOwnerType ?? current?.LexicalEnclosingType
        }
    }

    /// The last-resort unqualified lookup of an inherited static method: the
    /// enclosing class (through `this`, or as the owner of a
    /// `shared` member or of the function literal being bound) inherits
    /// a static method of that name from a source base class or from its
    /// imported base.
    /// @param effThis The effective `this`, or `null` in a static context.
    /// @param syntax The unqualified call.
    /// @param result The bound static call when one was found.
    /// @returns `true` when a base declares a static method of that name.
    private func TryBindInheritedStaticCallAsLastResort(
        effThis ParameterSymbol?,
        syntax CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let owner StructSymbol? = (effThis?.Type ?? GetImplicitStaticSelfOwner()) as StructSymbol
        if owner == nil || !owner.IsClass {
            return false
        }
        if bindUserTypeStaticCall != nil && !TypeMemberModel.GetMethods(
            owner,
            syntax.Identifier.ValueText,
            MemberQuery.InheritedStatic(MemberKinds.Method)
        )
            .IsDefaultOrEmpty {
            result = bindUserTypeStaticCall!!(owner, syntax)
            return true
        }
        return TryBindInheritedImportedStaticCall(owner, syntax, out result)
    }

    /// Binds an unqualified call to a static method a source class inherits
    /// from its imported base — public, or `protected` since the call
    /// site is inside the derived class
    /// (`ValidateMatchTimeout(timeout)` in a class deriving from
    /// `Regex`). C# puts inherited static members in scope unqualified;
    /// the qualified `Regex.ValidateMatchTimeout(...)` spelling binds
    /// through the same imported static-call path.
    /// @param derived The enclosing source class.
    /// @param syntax The unqualified call.
    /// @param result The bound static call when one was found.
    /// @returns `true` when the base declares a visible static method of that name.
    private func TryBindInheritedImportedStaticCall(
        derived StructSymbol,
        syntax CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if bindImportedClrStaticCall == nil ||
            GetInheritedImportedStaticCallBase(derived, syntax.Identifier.ValueText) is not{} importedBase {
            return false
        }
        let bindImportedClrStaticCall = bindImportedClrStaticCall!!
        result = bindImportedClrStaticCall(importedBase, syntax)
        return true
    }

    private func GetInheritedImportedStaticCallBase(derived StructSymbol, name string) Type? {
        if !derived.IsClass || ExpressionBinder.GetInheritedClrBaseType(derived) is not{} importedBase {
            return nil
        }
        let probe = ImportedClassSymbol(importedBase, nil, references: Scope.References).WithFamilyAccessBase(
            importedBase
        )
        return if probe.HasVisibleStaticMethod(name) {
            importedBase
        } else {
            nil
        }
    }

    private func GetConstructorInitializerReceiverType() StructSymbol? {
        return (getCurrentFunction()?.ReceiverType as StructSymbol) ??
            ((Scope.TryLookupSymbol("this") as ParameterSymbol)?.Type as StructSymbol)
    }

    /// ADR-0063: thin wrapper around (cref:SelectBestInstanceOverload)
    /// that reports the standard ambiguity / no-applicable-overload diagnostics
    /// when more than one candidate is supplied. When a single candidate is
    /// supplied the wrapper returns it unchanged so legacy single-overload
    /// callsites keep their existing diagnostics (wrong arity, etc.).
    ///
    /// Issue #1626: finalizes an implicit static-self dispatch (a bare
    /// `Helper(args)` call resolved inside a static interface/struct
    /// helper body) once (cref:SelectInstanceOverloadOrReport) has
    /// picked [`method`](paramref). That selector returns a lone
    /// candidate with NO applicability check, so this helper — mirroring the
    /// arity/named-argument handling every other static-call finalizer
    /// performs — validates argument count and reorders named arguments
    /// before converting, instead of indexing `method.Parameters`
    /// positionally and risking an out-of-range crash (too many args) or an
    /// invalid short (cref:BoundCallExpression) (too few args).
    /// @remarks ponytail: this is only reached when (cref:bindUserTypeStaticCall)
    /// is `null` (e.g. an (cref:OverloadResolver) built
    /// directly, without the production callback wiring). The real binder
    /// always supplies `bindUserTypeStaticCall`, which gives full
    /// optional/variadic/generic fidelity via `BindUserTypeStaticCall`;
    /// this fallback only needs to be crash-safe, not feature-complete.
    private func BindImplicitStaticSelfCallFallback(
        method FunctionSymbol,
        syntax CallExpressionSyntax,
        boundArguments ImmutableArray[BoundExpression],
        argumentNames ImmutableArray[string]
    ) BoundExpression {
        let parameterCount = method.Parameters.Length
        let parameterNameAt(int32) -> string = (parameterIndex int32) -> method.Parameters[parameterIndex].Name
        if boundArguments.Length != parameterCount {
            Diagnostics.ReportWrongArgumentCount(syntax.Location, method.Name, parameterCount, boundArguments.Length)
            return BoundErrorExpression(nil)
        }
        var permutedSyntax[]ExpressionSyntax?
        var permutedArguments ImmutableArray[BoundExpression]
        if !argumentNames.IsDefault {
            if !TryReorderUserCallArguments(
                syntax.Arguments,
                boundArguments,
                parameterCount,
                parameterNameAt,
                method.Name,
                out permutedSyntax,
                out permutedArguments
            ) {
                return BoundErrorExpression(nil)
            }
        } else {
            permutedSyntax = [syntax.Arguments.Count]ExpressionSyntax
            for var i = 0; i < syntax.Arguments.Count; i++ {
                permutedSyntax[i] = syntax.Arguments[i]
            }
            permutedArguments = boundArguments
        }
        let convertedArgs = ImmutableArray.CreateBuilder[BoundExpression](parameterCount)
        for var ai = 0; ai < parameterCount; ai++ {
            convertedArgs.Add(
                conversions.BindConversion(
                    Invariant.Required(
                        permutedSyntax[ai],
                        "a reordered call argument has source syntax",
                        expression: "permutedSyntax[ai]"
                    )
                        .Location,
                    permutedArguments[ai],
                    method.Parameters[ai].Type
                )
            )
        }
        let finalArguments = PreserveNamedArgumentEvaluationOrder(
            syntax.Arguments,
            convertedArgs.MoveToImmutable(),
            parameterNameAt
        )
        return BoundCallExpression(nil, method, finalArguments)
    }

    /// Issue #2403: whether [`syntax`](paramref)'s unqualified callee name
    /// could resolve to a genuine non-constructor callable — a same-compilation
    /// free/extension (cref:FunctionSymbol) or function-valued local
    /// reachable through
    /// (cref:Scope), or an implicit-`this` instance/static sibling
    /// method (including a private one) on the enclosing struct/class or
    /// interface body, or an inherited CLR method on the implicit receiver —
    /// checked BEFORE the CLR constructor/conversion
    /// fallbacks a few lines below in (cref:BindCallExpression) run. A
    /// same-named imported CLR type (e.g. `System.Net.Http.HttpClient`)
    /// must not shadow a colliding user method in call position, mirroring how
    /// a same-named source method always wins over an imported CLR type in
    /// C#.
    /// @remarks Only the EXISTENCE of a same-named candidate is checked here — not full
    /// overload applicability (argument count/types). That is intentional:
    /// when this returns `true`, (cref:BindCallExpression)
    /// simply skips the CLR early-return paths and falls through to its
    /// ordinary implicit-`this` / symbol-lookup call-binding logic further
    /// down, which already performs full overload selection via
    /// (cref:SelectUnifiedInstanceStaticOverload) / (cref:SelectInstanceOverloadOrReport)
    /// / (cref:SelectBestUserOverload) and reports the correct
    /// diagnostic (wrong-argument-count, ambiguity, ...) against the genuine
    /// user candidate — so no overload-resolution logic is duplicated here.
    /// When no such candidate exists, this returns `false` and
    /// the CLR paths run exactly as before, so genuine constructor/conversion
    /// calls (e.g. `StringBuilder(16)`) are unaffected.
    internal func HasNonConstructorCallableCandidate(syntax CallExpressionSyntax) bool {
        let name = syntax.Identifier.ValueText
        // A same-compilation free function or extension function (extension
        // functions are flattened into the global function table — issue
        // #1103) is directly visible through the scope's symbol table.
        let lexicalSymbol = Scope.TryLookupSymbol(name)
        if lexicalSymbol is FunctionSymbol ||
            (
            lexicalSymbol is VariableSymbol callableVariable &&
                (
                callableVariable.Type is FunctionPointerTypeSymbol ||
                    MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(callableVariable.Type, out _)
            )
        ) {
            return true
        }
        if Scope.SubmissionImports is {} submissions {
            if submissions.TryFindFunctionContainer(Scope.References!!, name, out _) {
                return true
            }
            if submissions.TryFindGlobalVariable(Scope.References!!, name, out _, out var declared) &&
                declared is {} previous &&
                (
                previous.Type is FunctionPointerTypeSymbol || MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(
                    previous.Type,
                    out _
                )
            ) {
                return true
            }
        }
        if HasEnclosingMemberCallableCandidate(name) || GetLexicallyEnclosingStaticCallOwner(name) != nil {
            return true
        }
        // Issue #1159: the implicit `this` an unqualified instance-member
        // reference would bind against (mirrors GetEffectiveThisParameter's
        // callers below).
        let effThis = GetEffectiveThisParameter()
        if effThis?.Type is StructSymbol receiverStruct {
            // An imported type with the same simple name as an inherited CLR
            // method must not turn an implicit-receiver call into construction.
            let inheritedClr = ExpressionBinder.GetInheritedClrBaseType(receiverStruct) ?? typeof(object)
            if MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(inheritedClr, name).Count > 0 {
                return true
            }
        }
        return false
    }

    /// ADR-0187 / issue #4350: whether the only non-constructor callables named
    /// [`name`](paramref) are receiver-clause extension functions — no
    /// free function, function-valued local, enclosing-type member, or
    /// inherited CLR method shares the name.
    /// @param name The unqualified callee name.
    /// @returns `true` when every candidate is an extension function.
    private func IsExtensionOnlyCallableName(name string) bool {
        if !(Scope.TryLookupSymbol(name) is FunctionSymbol) {
            return false
        }
        let functions = Scope.TryLookupFunctions(name)
        if functions.IsDefaultOrEmpty || functions.Any((f FunctionSymbol) -> !f.IsExtension) {
            return false
        }
        if HasEnclosingMemberCallableCandidate(name) {
            return false
        }
        let effThis = GetEffectiveThisParameter()
        if effThis?.Type is StructSymbol receiverStruct {
            let inheritedClr = ExpressionBinder.GetInheritedClrBaseType(receiverStruct) ?? typeof(object)
            if MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(inheritedClr, name).Count > 0 {
                return false
            }
        }
        return true
    }

    /// Issue #3527: whether [`name`](paramref) resolves to a genuine
    /// member of the type lexically enclosing the current call — an instance
    /// or static (`shared`) sibling method reached through the implicit
    /// `this` (issue #1147) or implicit static-self (issue #1585) paths,
    /// or a private helper on an enclosing interface default/static method
    /// body (ADR-0085 / ADR-0089 / ADR-0090). Member scope always shadows
    /// package scope inside the declaring type, mirroring C#: an unqualified
    /// call to a same-named member must never fall through to a same-named
    /// top-level package function or a same-named import, even though both
    /// are also visible through (cref:Scope).
    private func HasEnclosingMemberCallableCandidate(name string) bool {
        // Issue #1159: the implicit `this` an unqualified instance-member
        // reference would bind against (mirrors GetEffectiveThisParameter's
        // callers below).
        let effThis = GetEffectiveThisParameter()
        if effThis?.Type is StructSymbol receiverStruct {
            // Issue #1147: an unqualified call inside an instance method
            // resolves against the COMBINED instance + static (`shared`)
            // overload set of the enclosing type — mirror that union here.
            if !TypeMemberModel.GetMethods(receiverStruct, name, MemberQuery.Instance(MemberKinds.Method))
                .IsDefaultOrEmpty ||
                !TypeMemberModel
                .GetMethods(receiverStruct, name, MemberQuery.InheritedStatic(MemberKinds.Method)).IsDefaultOrEmpty {
                return true
            }
        } else if effThis?.Type is InterfaceSymbol receiverIface {
            // ADR-0085 / ADR-0090: implicit `this` inside an interface default
            // method body also sees the interface's own private helpers.
            if !TypeMemberModel.GetMethods(receiverIface, name, MemberQuery.Instance(MemberKinds.Method))
                .IsDefaultOrEmpty ||
                receiverIface
                .GetPrivateMethods(name).Length > 0 {
                return true
            }
        }
        if getCurrentFunction()?.ThisParameter == nil {
            // ADR-0089 / ADR-0090: implicit static-self dispatch inside a
            // static-virtual or private-static interface helper body.
            if GetImplicitStaticSelfOwner() is InterfaceSymbol staticIface {
                if !TypeMemberModel.GetMethods(staticIface, name, MemberQuery.Static(MemberKinds.Method))
                    .IsDefaultOrEmpty ||
                    staticIface
                    .GetStaticPrivateMethods(name).Length > 0 {
                    return true
                }
            } else if GetImplicitStaticSelfOwner() is StructSymbol staticStruct {
                // Issue #1585: implicit static-self dispatch inside a
                // `shared` method body of a user struct/class.
                if !TypeMemberModel.GetMethods(staticStruct, name, MemberQuery.InheritedStatic(MemberKinds.Method))
                    .IsDefaultOrEmpty {
                    return true
                }
            }
        }
        let owner = (effThis?.Type ?? GetImplicitStaticSelfOwner()) as StructSymbol
        return owner != nil && GetInheritedImportedStaticCallBase(owner, name) != nil
    }

    private func GetLexicallyEnclosingStaticCallOwner(name string) StructSymbol? {
        let lexicalSelfType = GetEffectiveThisParameter()?.Type ?? GetImplicitStaticSelfOwner()
        for var enclosing TypeSymbol? = lexicalSelfType?.ContainingType;
            enclosing != nil;
            enclosing = enclosing!!
            .ContainingType {
            if enclosing is StructSymbol enclosingStruct && !TypeMemberModel.GetMethods(
                enclosingStruct,
                name,
                MemberQuery.Static(MemberKinds.Method)
            )
                .IsDefaultOrEmpty {
                return enclosingStruct
            }
        }
        return nil
    }

    private func IsConstructibleSourceType(
        type TypeSymbol?,
        argumentCount int32
    ) bool -> type is StructSymbol aggregate &&
        (
        aggregate.IsClass ||
            aggregate.IsInline ||
            aggregate.HasPrimaryConstructor ||
            (argumentCount == 0 && aggregate.ClrType == nil && aggregate.HasSynthesizedDataConstructor) ||
            !aggregate
            .EffectiveExplicitConstructors
            .IsDefaultOrEmpty
    )

    /// Binds calls with the same conversion and construction rules for simple and qualified targets.
    /// @param syntax The call syntax.
    /// @param resolvedType The exact qualified target, or null for ordinary lookup.
    /// @returns The bound call or conversion.
    func BindCallExpression(syntax CallExpressionSyntax, resolvedType TypeSymbol? = nil) BoundExpression {
        let frame = CallCandidateRecorder.Begin(syntax)
        try {
            let bound = BindCallExpressionCore(syntax, resolvedType)
            CallCandidateRecorder.Stamp(frame, bound)
            return bound
        } finally {
            CallCandidateRecorder.End(frame)
        }
    }

    private func BindCallExpressionCore(syntax CallExpressionSyntax, resolvedType TypeSymbol? = nil) BoundExpression {
        if syntax.ConversionTypeClause != nil {
            let compositeConversionType TypeSymbol? = bindTypeClause(syntax.ConversionTypeClause)
            if compositeConversionType == nil {
                return BoundErrorExpression(syntax)
            }
            if syntax.Arguments.Count != 1 {
                Diagnostics.ReportWrongArgumentCount(
                    syntax.ConversionTypeClause!!.Location,
                    compositeConversionType.Name,
                    expectedCount: 1,
                    actualCount: syntax.Arguments.Count
                )
                return BoundErrorExpression(syntax)
            }
            reportObsoleteUseIfApplicable(
                syntax.ConversionTypeClause!!.Location,
                compositeConversionType,
                compositeConversionType.Name
            )
            return conversions.BindConversion(syntax.Arguments[0], compositeConversionType, allowExplicit: true)
        }
        // Issue #2185: an indirect invocation whose callee is an arbitrary
        // function-typed expression (`(expr)(args)`, `expr!!(args)`, a curried
        // `f()(x)`, ...). The parser tags these with a non-null Callee (there is
        // no identifier to resolve), so dispatch on the bound callee expression's
        // (narrowed / null-forgiven) type rather than any syntactic callee shape.
        if syntax.Callee != nil {
            return BindIndirectCallExpression(syntax)
        }
        // Issue #3421 review: `cast[T](value)` is the unambiguous,
        // constructor-independent explicit-conversion form. Bind it before
        // callable/type lookup so no symbol named `cast` can redirect it.
        if resolvedType == nil &&
            syntax
            .Identifier
            .ValueText == "cast" &&
            tryBindIntrinsicCall(syntax, out var checkedCast) {
            return checkedCast!!
        }
        // ADR-0065 §2: a bare `init(args)` call inside a constructor body is
        // a self-delegation to a sibling constructor on the same aggregate. This
        // is the only legal use of `init` as a callable identifier. Recognise
        // it before any other call-binding path so the generic identifier
        // fallback at the bottom doesn't surface a misleading "unknown
        // function" diagnostic.
        if resolvedType == nil &&
            syntax.TypeArgumentList == nil &&
            syntax
            .Identifier
            .Kind == SyntaxKind.IdentifierToken &&
            syntax
            .Identifier
            .ValueText == "init" {
            let inCtor FunctionSymbol? = getCurrentFunction()
            if inCtor != nil &&
                inCtor.IsSpecialName &&
                inCtor.Name == ".ctor" &&
                inCtor.ReceiverType is StructSymbol owningClass &&
                !owningClass
                .ExplicitConstructors
                .IsDefaultOrEmpty {
                return BindConstructorChainingExpression(syntax, owningClass, inCtor)
            }
        }
        // Issue #2403 / #2549: a resolvable non-constructor callable (same-compilation
        // free/extension function, or an implicit-`this` instance/static
        // sibling/inherited CLR method) with this name takes precedence over ALL THREE CLR
        // constructor/conversion fallback paths below, mirroring how a
        // same-named source method always shadows a colliding imported CLR
        // type (e.g. `System.Net.Http.HttpClient`) in call position. Computed
        // once and reused by all three gates; see HasNonConstructorCallableCandidate's
        // remarks for why only existence (not full overload applicability) is
        // checked here.
        var hasNonConstructorCallable = resolvedType == nil && HasNonConstructorCallableCandidate(syntax)
        // Issue #1263: when the construction carries an explicit type-argument
        // list (`Op[int32](5)`), resolve the constructed type by (name, arity)
        // so a non-generic `Op` and a generic `Op[T]` can coexist. With no type
        // arguments the arity is -1 ("no preference"), preferring the arity-0
        // type — so `Op(...)` keeps picking the non-generic `Op`. This reuses
        // the same #1051 arity-keyed type-alias lookup the type-reference and
        // struct-literal paths already use.
        let ctorPreferredArity = if syntax.TypeArgumentList != nil {
            syntax.TypeArgumentList.Arguments.Count
        } else {
            -1
        }
        // Issue #2455: a genuinely resolvable SOURCE type alias (a struct or
        // class declared in THIS compilation, via BoundScope.TryLookupTypeAlias
        // — which never sees CLR-imported types) that is itself constructible
        // takes precedence over CLR-imported-class construction a few lines
        // below, mirroring (a) how a same-named source function/method already
        // shadows a colliding imported CLR type in call position
        // (HasNonConstructorCallableCandidate, issue #2403), and (b) how the
        // struct/class-literal binder (BindStructLiteralExpression) already
        // checks TryLookupTypeAlias before ever falling back to
        // TryLookupImportedClass. Without this, `Type(...)` for a same-simple-
        // name source struct/class colliding with an imported CLR class (e.g.
        // a package-qualified source construction like
        // `Oahu.Audible.Json.ChapterInfo()` peeled and rebound by simple name
        // — see TryBindQualifiedSourceTypeConstruction) always constructed the
        // CLR type, never the source one, regardless of import order,
        // qualification, or the qualified-construction package hint — because
        // tryBindClrConstructorCall/TryLookupImportedClass ran unconditionally
        // before the source-type-alias checks further down ever got a chance.
        // Issue #3466: a nested source type keeps that precedence only inside
        // its containing lexical scope; outside it, an explicit alias or
        // same-named top-level import remains the visible constructor target.
        let hasImportedType = resolvedType == nil && Scope.TryLookupImportedClassByArity(
            syntax.Identifier.ValueText,
            ctorPreferredArity,
            declaration: nil,
            out var importedCtorCandidate
        )
        var sourceCtorCandidate TypeSymbol? = resolvedType
        let hasSourceConstructibleType = (
            resolvedType != nil || binderCtx.TryLookupSourceType(
                Scope,
                syntax.Identifier.ValueText,
                ctorPreferredArity,
                getCurrentFunction(),
                out sourceCtorCandidate,
                out _
            )
        ) &&
            sourceCtorCandidate is StructSymbol sourceCtorStruct &&
            !(
            hasImportedType && binderCtx.ImportedTypeOverridesSourceType(
                Scope,
                syntax.Identifier.ValueText,
                sourceCtorStruct,
                ctorPreferredArity,
                getCurrentFunction(),
                importedCtorCandidate!!.ClassType
            )
        ) &&
            (
            ctorPreferredArity < 0 ||
                (
                if sourceCtorStruct.IsGenericDefinition {
                    sourceCtorStruct.TypeParameters.Length
                } else {
                    0
                }
            ) == ctorPreferredArity
        ) &&
            IsConstructibleSourceType(sourceCtorStruct, syntax.Arguments.Count)
        // ADR-0187 / issue #4350: construction syntax that names a constructible
        // source type is never shadowed by receiver-clause EXTENSION functions
        // of the same name. C# never considers an extension method for `new
        // T(...)`, and cs2gs translates `new Slice<T>(owner, …)` inside the
        // runtime that also declares `Slice(this Slice<T> s, lo, hi, max)` to
        // exactly this spelling. Extensions stay callable in receiver form
        // (`s.Slice(1, 2)`); a free function, function-valued local, or member
        // of the same name still wins as before (#2403 / #3527).
        if hasNonConstructorCallable &&
            hasSourceConstructibleType &&
            IsExtensionOnlyCallableName(syntax.Identifier.ValueText) {
            hasNonConstructorCallable = false
        }
        // Phase 4-exit: prefer CLR class instantiation over the single-arg
        // conversion-call hijack below, so that `StringBuilder(16)` resolves
        // to a CLR ctor rather than `conversions.BindConversion(int → StringBuilder)`.
        // Also handles closed-generic imports (`List[int]()`,
        // `Dictionary[string, int]()`). Interpreter-only — resolves a
        // ConstructorInfo and emits BoundClrConstructorCallExpression.
        if resolvedType == nil &&
            !hasNonConstructorCallable &&
            !hasSourceConstructibleType &&
            tryBindClrConstructorCall(syntax, out var clrCtorCall) {
            return clrCtorCall!!
        }
        let conversionType = if hasNonConstructorCallable {
            nil
        } else {
            resolvedType ?? lookupTypeWithArity(syntax.Identifier, ctorPreferredArity)
        }
        let hasSingleInlineOutArgument = syntax
            .Arguments
            .Count == 1 &&
            (
            UnwrapNamedArgumentValue(syntax.Arguments[0]) is RefArgumentExpressionSyntax and {IsInlineDeclaration: true}
        )
        if !hasNonConstructorCallable &&
            syntax
            .Arguments
            .Count == 1 &&
            !hasSingleInlineOutArgument &&
            conversionType is TypeSymbol {
            var explicitConversionType TypeSymbol? = TryConstructConversionTarget(syntax, conversionType)
            if explicitConversionType == nil {
                return BoundErrorExpression(syntax)
            }
            // Issue #663: when the call carries a `?` token (e.g. `string?(x)`),
            // wrap the resolved type in NullableTypeSymbol so the conversion
            // targets the nullable form.
            if syntax.NullableQuestionToken != nil {
                explicitConversionType = NullableTypeSymbol.Get(explicitConversionType)
            }
            // A class exposing a one-argument constructor shape reserves
            // `T(value)` for construction. `cast[T](value)` is the unambiguous
            // checked-cast spelling when construction and conversion overlap.
            // This decision uses declaration shape only: binding the argument
            // speculatively here and again in the constructor binder can
            // duplicate capture/spill state even if diagnostics are truncated.
            let singleArgClass StructSymbol? = conversionType as StructSymbol
            let typeArgumentsMatchConversionTarget = syntax.TypeArgumentList == nil ||
                (
                singleArgClass != nil &&
                    singleArgClass.IsGenericDefinition == true &&
                    syntax
                    .TypeArgumentList
                    .Arguments
                    .Count == singleArgClass
                    .TypeParameters
                    .Length
            )
            if singleArgClass != nil &&
                singleArgClass.IsClass &&
                typeArgumentsMatchConversionTarget &&
                (syntax.NullableQuestionToken != nil || !HasSingleArgumentConstructorShape(singleArgClass)) {
                reportObsoleteUseIfApplicable(
                    syntax.Identifier.Location,
                    explicitConversionType!!,
                    explicitConversionType!!.Name
                )
                return conversions.BindConversion(syntax.Arguments[0], explicitConversionType, allowExplicit: true)
            }
            if syntax.NullableQuestionToken != nil ||
                !IsConstructibleSourceType(conversionType, syntax.Arguments.Count) {
                // ADR-0047 §6 / #175: `Type(x)` as an explicit conversion
                // is still a use of the named type.
                reportObsoleteUseIfApplicable(
                    syntax.Identifier.Location,
                    explicitConversionType!!,
                    explicitConversionType!!.Name
                )
                return conversions.BindConversion(syntax.Arguments[0], explicitConversionType, allowExplicit: true)
            }
        }
        // Phase 3.B.3 sub-step 2: `ClassName(arg1, arg2, ...)` invokes the
        // class's primary constructor when the call target resolves to a
        // class type with a declared primary ctor. Issue #524: a class
        // declaring no explicit `init(...)` and no primary constructor is
        // still constructible via `ClassName()` against the synthesized
        // parameterless default constructor — the emitter already produces
        // a `.ctor()` for such classes (see EmitClassDefaultConstructor),
        // so we just need the binder to route `ClassName()` through here.
        // Issue #1069: a value struct (e.g. a `data struct`) declaring a
        // primary constructor is also positionally constructible —
        // `Entry(1, 2)` lowers to a struct literal initializing its fields.
        if !hasNonConstructorCallable &&
            conversionType is StructSymbol classType &&
            IsConstructibleSourceType(classType, syntax.Arguments.Count) {
            return BindConstructorCallExpression(syntax, classType)
        }
        // Issue #988: `T()` constructs the type parameter `T` when the enclosing
        // generic declares an `init()` default-constructor constraint (`[T init()]`).
        // Lowered to a reified `Activator.CreateInstance<T>()` (ADR-0087). A
        // type parameter has no user-callable members, so a zero-argument call
        // to it can only mean construction. When the `init()` constraint is
        // absent we cannot guarantee an accessible parameterless constructor, so
        // report GS0389 pointing at the missing constraint.
        if syntax
            .Arguments
            .Count == 0 &&
            syntax.TypeArgumentList == nil &&
            (resolvedType ?? lookupType(syntax.Identifier.ValueText)) is TypeParameterSymbol typeParam {
            if typeParam.HasDefaultConstructorConstraint {
                return BoundTypeParameterConstructionExpression(syntax, typeParam)
            }
            Diagnostics.ReportConstructedTypeParameterRequiresNewConstraint(syntax.Identifier.Location, typeParam.Name)
            return BoundErrorExpression(nil)
        }
        if resolvedType != nil {
            Diagnostics.ReportNotAFunction(syntax.Identifier.Location, resolvedType.Name)
            return BoundErrorExpression(syntax)
        }
        if tryBindIntrinsicCall(syntax, out var intrinsic) {
            return intrinsic!!
        }
        // Issue #343: pre-validate named-argument layout (positional precedes
        // named, no duplicate names). Errors are reported by the helper so the
        // call short-circuits to a bound error here.
        if !TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames) {
            return BoundErrorExpression(nil)
        }
        var boundArguments = ImmutableArray.CreateBuilder[BoundExpression]()
        // Issue #951: untyped arrow lambdas whose binding
        // is deferred until the callee's parameter types are known, so the
        // target delegate shape can drive lambda-parameter-type inference.
        // Without the deferral the lambda binds with no target, reports GS0304
        // ("cannot infer parameter type"), and aborts the call — even though
        // the parameter (e.g. `Func[int32, int32]` / `(int32) -> int32`)
        // fully determines the lambda's shape.
        var deferredArrowLambdas HashSet[LambdaExpressionSyntax]? = nil
        // ADR-0060: argument binding needs the matching parameter to resolve
        // inline `out var`/`out let`/`out _` payloads. For free-function calls
        // we don't have the FunctionSymbol resolved until below, so we first
        // bind everything with parameter=null (the inline-out form falls back
        // to its declared type) and patch up the type later. The plain
        // lvalue ref/in/out form is parameter-independent.
        for argument in syntax.Arguments {
            // Issue #343: a named-argument wrapper carries the value expression
            // we want to bind; unwrap it so the value is bound on its own.
            let argSyntax = UnwrapNamedArgumentValue(argument)
            let lambdaSyntax = GetLambdaArgumentSyntax(argSyntax)
            var boundArgument BoundExpression
            if argSyntax is RefArgumentExpressionSyntax refArg {
                // The first binding pass has no resolved parameter for inline out arguments.
                boundArgument = bindRefArgumentExpression(refArg, nil)
            } else if bindLambdaWithTarget != nil &&
                lambdaSyntax is {} deferredLambda &&
                IsUntypedArrowLambda(deferredLambda) {
                // Issue #951: defer; bind once the parameter delegate target is
                // known (per-position loop below). A placeholder carrying the
                // lambda syntax keeps argument positions aligned.
                (
                    (
                        if deferredArrowLambdas == nil {
                            (deferredArrowLambdas = HashSet[LambdaExpressionSyntax]())
                        } else {
                            deferredArrowLambdas
                        }
                    )!!
                ).Add(deferredLambda)
                boundArgument = BoundErrorExpression(deferredLambda)
            } else {
                boundArgument = BindOverloadArgumentValue(argSyntax)
            }
            boundArguments.Add(boundArgument)
        }
        let symbol Symbol? = Scope.TryLookupSymbol(syntax.Identifier.ValueText)
        if symbol is VariableSymbol callTarget && AccessibilityChecker.TryGetInaccessibleImplicitMemberRead(
            callTarget,
            getCurrentFunction(),
            out var declaringOwner,
            out var memberName,
            out var memberAccessibility
        ) {
            let owner = Invariant.Required(
                declaringOwner,
                "an inaccessible implicit callable member has a declaring owner",
                expression: "declaringOwner"
            )
            Diagnostics.ReportMemberInaccessible(
                syntax.Identifier.Location,
                memberName,
                owner.Name,
                memberAccessibility
            )
            return BoundErrorExpression(nil)
        }
        // Issue #2066: a smart-cast null-guard (`if x != nil { x(...) }`)
        // narrows the static type seen by a bare *read* of `x`, but the direct
        // call-syntax checks below key off the declared `VariableSymbol.Type`
        // (still `T?`) rather than any bound/narrowed read. Without this,
        // `snapshot(count)` on a null-guarded `TickHandler?` local fails to
        // match the function/delegate call branches and reports "not a
        // function". Mirror the narrowing lookup the name-expression path
        // uses (see ExpressionBinder.TryGetNarrowedType) so a narrowed
        // nullable local dispatches through the same call paths as an
        // already non-nullable one.
        let narrowedCallTargetType TypeSymbol? = if symbol is VariableSymbol callTargetVariable {
            TryGetNarrowedVariableType(callTargetVariable)
        } else {
            default(TypeSymbol?)
        }
        if syntax.NullableQuestionToken == nil &&
            symbol is VariableSymbol narrowedCallTarget &&
            narrowedCallTargetType != nil {
            binderCtx.TrackBackwardGotoNarrowingUse(
                GetNarrowedVariablePath(narrowedCallTarget),
                syntax.Identifier.Location,
                syntax.Identifier.ValueText,
                BackwardGotoNarrowingUseKind.Function
            )
        }
        // Issue #1566: an accessible in-scope member of the enclosing type
        // shadows a same-named top-level EXTENSION function for an unqualified,
        // receiver-less call — mirroring C#, where an in-scope member hides an
        // extension method. Extension functions are flattened into the global
        // function table (issue #1103) so `TryLookupSymbol` returns them for
        // free-call syntax; when the resolved name denotes only extension
        // function(s), route through the implicit-`this` member-resolution path
        // first. If the enclosing type exposes no matching member the block
        // falls through and the extension binds exactly as before (so both the
        // receiver-form `x.Ext(...)` and free-call extension usage, and calls
        // from types with no such member, are unaffected).
        let resolvedIsExtensionOnly = symbol is FunctionSymbol && IsAllExtensionOverloadSet(syntax.Identifier.ValueText)
        // Issue #3527: a same-named PACKAGE-level function is visible through
        // the same scope symbol table as any enclosing-type member (issue
        // #1566's extension case above), but must not shadow a genuine
        // instance/static (`shared`) sibling method — member scope always
        // wins over package scope inside the declaring type. Without this, an
        // unqualified call inside a `shared` method silently bound to a
        // same-named package function ahead of the type's own (possibly
        // private) `shared` method, with no diagnostic.
        // Restricted to `Package != null` so a GENERIC LOCAL FUNCTION —
        // declared into this same scope table via `Scope.TryDeclareFunction`
        // (LambdaBinder.PrepareGenericLocalFunctionDeclaration) but built with
        // the no-package `FunctionSymbol` constructor — is never treated as
        // a shadowable package function. Ordinary lexical shadowing must
        // still let a local function of the same name win over a sibling
        // member, exactly as it did before this fix.
        let resolvedIsShadowedByEnclosingMember = symbol is FunctionSymbol shadowCandidateFunction &&
            shadowCandidateFunction.Package != nil &&
            !resolvedIsExtensionOnly &&
            HasEnclosingMemberCallableCandidate(syntax.Identifier.ValueText)
        if symbol == nil || resolvedIsExtensionOnly || resolvedIsShadowedByEnclosingMember {
            if binderCtx.InConstructorInitializer &&
                GetConstructorInitializerReceiverType() is {} initializerReceiverType {
                let staticMethods = TypeMemberModel.GetMethods(
                    initializerReceiverType,
                    syntax.Identifier.ValueText,
                    MemberQuery.Static(MemberKinds.Method)
                )
                if !staticMethods.IsDefaultOrEmpty {
                    if bindUserTypeStaticCall != nil {
                        return bindUserTypeStaticCall!!(initializerReceiverType, syntax)
                    }
                    let staticMethod FunctionSymbol? = SelectInstanceOverloadOrReport(
                        staticMethods,
                        boundArguments.ToImmutable(),
                        syntax,
                        syntax.Identifier.ValueText,
                        argumentNames
                    )
                    if staticMethod == nil {
                        return BoundErrorExpression(syntax)
                    }
                    return BindImplicitStaticSelfCallFallback(
                        staticMethod,
                        syntax,
                        boundArguments.ToImmutable(),
                        argumentNames
                    )
                } else if !TypeMemberModel.GetMethods(
                    initializerReceiverType,
                    syntax.Identifier.ValueText,
                    MemberQuery.Instance(MemberKinds.Method)
                )
                    .IsDefaultOrEmpty {
                    Diagnostics.ReportConstructorInitializerCannotReferenceInstanceMember(
                        syntax.Identifier.Location,
                        syntax.Identifier.ValueText
                    )
                    return BoundErrorExpression(syntax)
                }
            }
            // Implicit `this`: if we are inside an instance method body and the
            // name matches a sibling method on the receiver type, dispatch via
            // `this.<method>(args)` automatically.
            // Issue #1159: `effThis` is the enclosing instance method's `this`
            // even when this call sits inside a lambda body (whose synthetic
            // enclosing function carries no receiver), so unqualified
            // enclosing-instance member calls resolve and capture `this`.
            let effThis ParameterSymbol? = GetEffectiveThisParameter()
            if effThis != nil && effThis.Type is StructSymbol implicitReceiverStruct {
                // Issue #1147 (Facet B): an unqualified same-named call inside an
                // instance method resolves against the COMBINED instance + static
                // (`shared`) overload set of the enclosing type — mirroring C#'s
                // unified overload resolution — instead of seeing only instance
                // overloads. The selected method's IsStatic routes emission.
                let implicitMethod FunctionSymbol? = SelectUnifiedInstanceStaticOverload(
                    implicitReceiverStruct,
                    syntax.Identifier.ValueText,
                    boundArguments.ToImmutable(),
                    syntax,
                    argumentNames,
                    out var implicitHasCandidates
                )
                if implicitHasCandidates {
                    if implicitMethod == nil {
                        return BoundErrorExpression(nil)
                    }
                    if implicitMethod.IsStatic {
                        // Resolved to a same-named static sibling: finalize as a
                        // static user call (full optional/variadic/generic
                        // fidelity via the shared static-call finalizer).
                        if bindUserTypeStaticCall != nil {
                            return bindUserTypeStaticCall!!(implicitReceiverStruct, syntax)
                        }
                        return BindImplicitStaticSelfCallFallback(
                            implicitMethod,
                            syntax,
                            boundArguments.ToImmutable(),
                            argumentNames
                        )
                    }
                    let implicitReceiver = BoundVariableExpression(nil, effThis)
                    return BindUserInstanceCall(
                        implicitReceiver,
                        implicitMethod,
                        boundArguments.ToImmutable(),
                        syntax,
                        argumentNames
                    )
                }
            }
            // ADR-0085 / ADR-0090 implicit `this` inside an interface default
            // method body. The body's enclosing function is a DIM whose
            // ReceiverType is the owning InterfaceSymbol; an unqualified call
            // (`Helper(args)`) should resolve to a sibling method on the same
            // interface. The visibility rule from ADR-0090 applies: callers
            // inside the interface see both the public surface and the
            // private helpers; external callers go through the receiver-typed
            // path which does its own GS0334 check.
            if effThis != nil && effThis.Type is InterfaceSymbol implicitReceiverIface {
                var implicitIfaceOverloads = TypeMemberModel.GetMethods(
                    implicitReceiverIface,
                    syntax.Identifier.ValueText,
                    MemberQuery.Instance(MemberKinds.Method)
                )
                let implicitPrivateIfaceOverloads = implicitReceiverIface.GetPrivateMethods(syntax.Identifier.ValueText)
                if implicitPrivateIfaceOverloads.Length > 0 {
                    implicitIfaceOverloads = implicitIfaceOverloads.AddRange(implicitPrivateIfaceOverloads)
                }
                if implicitIfaceOverloads.Length > 0 {
                    let implicitIfaceMethod FunctionSymbol? = SelectInstanceOverloadOrReport(
                        implicitIfaceOverloads,
                        boundArguments.ToImmutable(),
                        syntax,
                        syntax.Identifier.ValueText,
                        argumentNames
                    )
                    if implicitIfaceMethod == nil {
                        return BoundErrorExpression(nil)
                    }
                    let implicitReceiver = BoundVariableExpression(nil, effThis)
                    return BindUserInstanceCall(
                        implicitReceiver,
                        implicitIfaceMethod,
                        boundArguments.ToImmutable(),
                        syntax,
                        argumentNames
                    )
                }
            }
            if effThis != nil && (effThis.Type is StructSymbol || effThis.Type is InterfaceSymbol) {
                if !TryResolveImplicitInheritedTypeArguments(
                    syntax.TypeArgumentList,
                    out var inheritedClrTypeArgs,
                    out var inheritedTypeArgSymbols
                ) {
                    return BoundErrorExpression(nil)
                }
                let implicitBaseClr = if effThis.Type is StructSymbol inheritedReceiver {
                    ExpressionBinder.GetInheritedClrBaseType(inheritedReceiver) ?? typeof(object)
                } else {
                    typeof(object)
                }
                let implicitReceiverExpr = BoundVariableExpression(nil, effThis)
                // The callback uses null to mean that no explicit type arguments were supplied.
                if tryBindInheritedClrInstanceCall(
                    implicitReceiverExpr,
                    implicitBaseClr,
                    syntax.Identifier.ValueText,
                    boundArguments.ToImmutable(),
                    syntax,
                    out var implicitInheritedCall,
                    inheritedClrTypeArgs,
                    inheritedTypeArgSymbols,
                    argumentNames,
                    effThis.Type is StructSymbol
                ) {
                    return implicitInheritedCall!!
                }
            }
            // ADR-0089 / ADR-0090: implicit static-self dispatch inside a
            // static-virtual or private-static interface helper body. The
            // enclosing function has no `this` parameter but
            // <c>StaticOwnerType</c> set to the owning InterfaceSymbol. An
            // unqualified call resolves against the interface's static
            // (public + private) buckets.
            if GetImplicitStaticSelfOwner() is InterfaceSymbol implicitStaticIface {
                var implicitStaticOverloads = TypeMemberModel.GetMethods(
                    implicitStaticIface,
                    syntax.Identifier.ValueText,
                    MemberQuery.Static(MemberKinds.Method)
                )
                let implicitStaticPrivateOverloads = implicitStaticIface.GetStaticPrivateMethods(
                    syntax.Identifier.ValueText
                )
                if implicitStaticPrivateOverloads.Length > 0 {
                    implicitStaticOverloads = implicitStaticOverloads.AddRange(implicitStaticPrivateOverloads)
                }
                if implicitStaticOverloads.Length > 0 {
                    let implicitStaticMethod FunctionSymbol? = SelectInstanceOverloadOrReport(
                        implicitStaticOverloads,
                        boundArguments.ToImmutable(),
                        syntax,
                        syntax.Identifier.ValueText,
                        argumentNames
                    )
                    if implicitStaticMethod == nil {
                        return BoundErrorExpression(nil)
                    }
                    // Issue #1626: `implicitStaticMethod` may be a private static
                    // helper (only visible from inside the interface body, via
                    // `GetStaticPrivateMethods` above) that the shared
                    // `bindUserTypeStaticCall` finalizer cannot see — its own
                    // member lookup only walks the public `StaticMethods`
                    // bucket. Finalize directly here instead, but through the
                    // same arity/named-argument-safe helper the struct
                    // static-self path (above) falls back to, so a lone
                    // candidate can no longer be indexed past its parameter
                    // list.
                    return BindImplicitStaticSelfCallFallback(
                        implicitStaticMethod,
                        syntax,
                        boundArguments.ToImmutable(),
                        argumentNames
                    )
                }
            }
            // Issue #1585: implicit static-self dispatch inside a `shared`
            // (static) method body of a user struct/class. The enclosing
            // function has no `this` parameter but carries <c>StaticOwnerType</c>
            // = the owning StructSymbol. An unqualified call (`Helper(args)` /
            // `Helper[T](args)`) must resolve against the type's own static
            // (`shared`) method group — mirroring both the qualified
            // `Type.Helper(args)` path and the instance-body bare-call path
            // (issue #1147), which already reach sibling statics. Routing
            // through the shared static-call finalizer (`bindUserTypeStaticCall`)
            // gives full private/overload/optional/variadic/generic fidelity and
            // walks the same base-type chain as the qualified path. The method
            // group is fetched through the canonical member-resolution layer
            // (ADR-0112) so it holds under both reference resolvers.
            if GetImplicitStaticSelfOwner() is StructSymbol implicitStaticStruct && bindUserTypeStaticCall != nil {
                let implicitStaticStructOverloads = TypeMemberModel.GetMethods(
                    implicitStaticStruct,
                    syntax.Identifier.ValueText,
                    MemberQuery.Static(MemberKinds.Method)
                )
                if !implicitStaticStructOverloads.IsDefaultOrEmpty {
                    return bindUserTypeStaticCall!!(implicitStaticStruct, syntax)
                }
            }
            // Issue #1566 / #3527: reaching here with a non-null symbol means
            // the name denotes only extension function(s), or a package
            // function that looked shadowable, and in either case the
            // enclosing type had no matching member — fall through to the
            // free-function/extension binding below rather than the
            // not-found paths.
            if symbol == nil {
                // ADR-0110 / issue #910 nesting: an unqualified call inside a
                // NESTED type's body may resolve to a `shared` (static) method
                // of a LEXICALLY ENCLOSING type — C# §7.4 scoping, where a
                // nested class sees the outer class's static members (including
                // its private ones) without qualification. The paths above only
                // consult the nested type's own member set and its base chain,
                // so `Outer.Inner.M()` calling `Helper(args)` — declared in
                // `Outer`'s `shared { }` block — reported GS0130. Walk outward
                // through <c>ContainingType</c> (innermost first, so a nearer
                // enclosing type shadows a farther one) and finalize through
                // the shared static-call finalizer for full
                // private/overload/optional/variadic/generic fidelity. Consulted
                // before the type-import (`using static`) and imported-CLR
                // paths because lexical scope outranks imports.
                if bindUserTypeStaticCall != nil &&
                    GetLexicallyEnclosingStaticCallOwner(syntax.Identifier.ValueText) is {} enclosingStruct {
                    return bindUserTypeStaticCall!!(enclosingStruct, syntax)
                }
                // Issue #1201 (C# `using static`): an unqualified call may resolve
                // to a `shared` (static) method of a type brought into scope by a
                // type import (`import Ns.Type`). Mirror C#'s using-static
                // semantics — search every type-import's static member set and bind
                // against the single match, including callable fields/properties.
                // When two or more imported types expose the same name the reference is ambiguous (GS0414), but
                // only here, where the name is actually used. The shared static-call
                // finalizer (`bindUserTypeStaticCall`) provides full
                // optional/variadic/generic fidelity, so an unqualified
                // `GetValues[TEnum]()` resolves exactly like `EnumUtil.GetValues[TEnum]()`.
                if bindUserTypeStaticCall != nil {
                    var matchedStaticImport StructSymbol? = nil
                    var ambiguousStaticImport = false
                    for importedType in binderCtx.GetStaticImportTypes() {
                        if !BinderContext.ImportedTypeExposesStaticMember(importedType, syntax.Identifier.ValueText) {
                            continue
                        }
                        if matchedStaticImport == nil {
                            matchedStaticImport = importedType
                        } else if !object.ReferenceEquals(matchedStaticImport, importedType) {
                            ambiguousStaticImport = true
                            break
                        }
                    }
                    if ambiguousStaticImport {
                        Diagnostics.ReportAmbiguousImportedStaticMember(
                            syntax.Identifier.Location,
                            syntax.Identifier.ValueText
                        )
                        return BoundErrorExpression(nil)
                    }
                    if matchedStaticImport != nil {
                        return bindUserTypeStaticCall!!(matchedStaticImport, syntax)
                    }
                }
                // Issue #3334 / ADR-0134: an unqualified call may also resolve
                // to a `public static` member on an imported CLR type or a
                // referenced package's synthetic `<Program>` holder. Consulted
                // only when no same-compilation source class matched above; the
                // imported qualified static-call binder provides full
                // optional/variadic/generic fidelity.
                if bindImportedClrStaticCall != nil {
                    var matchedClrStaticImport Type? = nil
                    var ambiguousClrStaticImport = false
                    for clrType in Scope.EnumerateStaticImportClrTypes() {
                        if !BinderContext.ClrTypeExposesStaticMember(clrType, syntax.Identifier.ValueText) {
                            continue
                        }
                        if matchedClrStaticImport == nil {
                            matchedClrStaticImport = clrType
                        } else if !matchedClrStaticImport.IsSameAs(clrType) {
                            ambiguousClrStaticImport = true
                            break
                        }
                    }
                    if ambiguousClrStaticImport {
                        Diagnostics.ReportAmbiguousImportedStaticMember(
                            syntax.Identifier.Location,
                            syntax.Identifier.ValueText
                        )
                        return BoundErrorExpression(nil)
                    }
                    if matchedClrStaticImport != nil {
                        return bindImportedClrStaticCall!!(matchedClrStaticImport, syntax)
                    }
                }
                // ADR-0156 Phase 2: an unqualified call may resolve to a
                // top-level function of a prior interactive submission — a
                // static method on that submission's <Program> container.
                // Submissions are consulted newest first and the first one
                // declaring the name wins outright (scope-chain shadowing,
                // not using-static ambiguity).
                if Scope.SubmissionImports is {} submissionImports {
                    if bindImportedClrStaticCall != nil && submissionImports.TryFindFunctionContainer(
                        Scope.References!!,
                        syntax.Identifier.ValueText,
                        out var submissionProgramType
                    ) &&
                        submissionProgramType != nil {
                        return bindImportedClrStaticCall!!(submissionProgramType, syntax)
                    }
                    // A function-typed global from a prior submission (e.g. a
                    // closure stored with `let inc = func() { ... }`) invokes
                    // through the indirect-call path: load the static field,
                    // then dispatch its Func/Action shape.
                    if TryBindSubmissionDelegateGlobalCall(syntax, submissionImports, out var submissionDelegateCall) {
                        return Invariant.Required(
                            submissionDelegateCall,
                            "a matched submission delegate global produces a bound invocation",
                            expression: "submissionDelegateCall"
                        )
                    }
                }
                // Last resort, reached only when every lookup above failed: a
                // static method the enclosing class inherits from a base. C#
                // puts inherited static members in scope unqualified
                // (`ValidateMatchTimeout(timeout)` in a class deriving from
                // `Regex`), but a lexically enclosing type's static, a
                // using-static import or any other earlier match still wins,
                // so no call that bound before this lookup existed changes
                // meaning; only calls that were errors start to bind.
                if TryBindInheritedStaticCallAsLastResort(effThis, syntax, out var inheritedStaticCall) {
                    return inheritedStaticCall!!
                }
                Diagnostics.ReportUndefinedFunction(syntax.Identifier.Location, syntax.Identifier.ValueText)
                return BoundErrorExpression(nil)
            }
        }
        // ADR-0122 §9 / issues #1035 and #3523: invoking a function-pointer-
        // typed variable goes through the shared `calli` path. Implicit field
        // and property symbols must first become real member loads rather than
        // non-existent local slots.
        let fpVar VariableSymbol? = symbol as VariableSymbol
        let fpSym FunctionPointerTypeSymbol? = (narrowedCallTargetType ?? fpVar?.Type) as FunctionPointerTypeSymbol
        if fpVar != nil && fpSym != nil {
            // Issue #4943: a narrowed `(unmanaged[CC] () -> R)?` callee must be
            // unwrapped from its `Nullable<nint>` storage before `calli`.
            let pointer = BuildCalleeLoad(fpVar, syntax.Identifier, narrowedCallTargetType)
            return BindFunctionPointerInvocation(
                syntax,
                pointer,
                fpSym,
                fpVar.Name,
                syntax.Identifier.Location,
                boundArguments.ToImmutable(),
                argumentNames,
                fpVar.CallableParameterNames
            )
        }
        if symbol is VariableSymbol nullableDelegateVar &&
            TryBindNullableDelegateInvocation(
            nullableDelegateVar,
            syntax,
            boundArguments.ToImmutable(),
            argumentNames,
            out var nullableDelegateCall
        ) {
            return nullableDelegateCall
        }
        if symbol is VariableSymbol directDelegateVar &&
            TryReportNullableDelegateReceiver(
            narrowedCallTargetType ?? directDelegateVar.Type,
            syntax.Identifier.Location,
            directDelegateVar.Name,
            nullSafeInvocation: "?(...)"
        ) {
            return BoundErrorExpression(nil)
        }
        // Phase 4.7: invoking a function-typed variable goes through the
        // indirect-call path. Sites like `add(1, 2)` where `add` is `let
        // add func(int, int) int = ...` reduce to BoundIndirectCallExpression.
        let variable VariableSymbol? = symbol as VariableSymbol
        let callableType TypeSymbol? = narrowedCallTargetType ?? variable?.Type
        // ADR-0186: a platform function value (`((string) -> string)!`,
        // routine for a function-typed slot declared in an ADR-0186 §9
        // oblivious scope) is invoked as its underlying function type;
        // BuildIndirectDelegateCall inserts §4's check on the load.
        let fnType FunctionTypeSymbol? = (
            if callableType == nil {
                default(TypeSymbol?)
            } else {
                PlatformTypeSymbol.StripTopLevel(callableType)
            }
        ) as FunctionTypeSymbol
        if variable != nil && fnType != nil {
            if !TryBindFunctionTypeArguments(
                variable.Name,
                fnType,
                syntax,
                boundArguments.ToImmutable(),
                variable.CallableParameterNames,
                out var convertedArgs
            ) {
                return BoundErrorExpression(nil)
            }
            return BuildIndirectDelegateCall(syntax, variable, fnType, convertedArgs, narrowedCallTargetType)
        }
        // ADR-0059 / issue #255: direct call syntax `h(args)` on a variable
        // of a user-declared named delegate type. Mirrors the CLR-delegate
        // branch below — both end up dispatching through Invoke.
        let namedDelegateVar VariableSymbol? = symbol as VariableSymbol
        let namedDelegateCallable TypeSymbol? = narrowedCallTargetType ?? namedDelegateVar?.Type
        let namedDelegateSym DelegateTypeSymbol? = (
            if namedDelegateCallable == nil {
                default(TypeSymbol?)
            } else {
                PlatformTypeSymbol.StripTopLevel(namedDelegateCallable)
            }
        ) as DelegateTypeSymbol
        if namedDelegateVar != nil && namedDelegateSym != nil {
            if !TryBindNamedDelegateArguments(
                namedDelegateVar.Name,
                namedDelegateSym,
                syntax,
                boundArguments.ToImmutable(),
                out var convertedNamedArgs,
                out var namedRefKinds
            ) {
                return BoundErrorExpression(nil)
            }
            return BuildIndirectDelegateCall(
                syntax,
                namedDelegateVar,
                namedDelegateSym.EquivalentFunctionType,
                convertedNamedArgs,
                narrowedCallTargetType,
                namedRefKinds
            )
        }
        // #325: a variable whose type is a CLR delegate (e.g. `Func[int32,
        // int32]`, `RequestDelegate`) is callable with call syntax `f(x)`,
        // mirroring native func-typed variables. Lower the call to an
        // invocation of the delegate's `Invoke` method, identical in behavior
        // to the explicit `f.Invoke(x)` form.
        let delegateVar VariableSymbol? = symbol as VariableSymbol
        let delegateTargetType TypeSymbol? = narrowedCallTargetType ?? delegateVar?.Type
        let delegateClrType Type? = delegateTargetType?.ClrType
        if delegateVar != nil && delegateTargetType != nil && delegateClrType != nil && ClrTypeUtilities.IsDelegateType(
            delegateClrType
        ) {
            // Issue #2799 follow-up: the receiver load must honor every
            // implicit-member variable kind, not only a plain local/parameter
            // (a bare `BoundVariableExpression`) and the field-like event's
            // implicit backing field. A nominal CLR delegate-typed value
            // exposed as a bare static field or instance/static property
            // (`ImplicitStaticFieldVariableSymbol` /
            // `ImplicitPropertyVariableSymbol` /
            // `ImplicitStaticPropertyVariableSymbol`) has no local slot, so a
            // bare `BoundVariableExpression` ICE-d with GS9998 ("no local slot")
            // on any invocation — conditional or not. `TryBuildImplicitMemberLoad`
            // resolves each such symbol to the correct field/property access
            // (the same helper the structural `FunctionTypeSymbol` path uses),
            // leaving locals/parameters to the bare-variable fallback.
            // Issue #2849: preserve the narrowed receiver type on every load
            // shape so emit can parent Invoke at the reified generic TypeSpec
            // instead of the nullable declaration's erased ClrType.
            var receiver = BuildCalleeLoad(delegateVar, syntax.Identifier, narrowedCallTargetType)
            // Issue #2796 / #2798: a null-conditional raise `Evt?(args)` of a
            // CLR delegate-typed value — canonically a field-like event's
            // backing delegate, which PR #2792 (fix/2726) now emits as a
            // nominal `System.EventHandler`/`EventHandler<T>` or a canonicalized
            // CLR `Func<...>`/named delegate — must short-circuit when the
            // delegate is null, mirroring C# `Evt?.Invoke(args)`. Without the
            // guard the emitted `callvirt Invoke` dereferences a null delegate
            // and NREs on a fresh event with no subscribers. The
            // FunctionTypeSymbol and named-delegate call paths above already
            // guard the raise via BuildIndirectDelegateCall; the CLR-delegate
            // path — reached once a structural `(object?, EventArgs) -> void`,
            // nominal `EventHandler`, or nominal `Func<int, int>` event is a CLR
            // delegate — must do the same for both the `void`-returning raise
            // (a plain no-op null branch) and the value-returning raise
            // (Issue #2798: the null branch must yield the correct
            // optional/null result via the established result-slot lowering, so
            // `var r = Evt?(x)` on a subscriber-less event produces null/default
            // instead of NRE-ing). The receiver is evaluated once into
            // `eventRaiseCapture`; a non-null delegate invokes normally.
            if syntax.NullableQuestionToken != nil {
                let eventRaiseCaptureName = "$$ncap_" + (binderCtx.NullConditionalCaptureCounter += 1).ToString(
                    CultureInfo.InvariantCulture
                )
                let eventRaiseCapture = LocalVariableSymbol(
                    eventRaiseCaptureName,
                    isReadOnly: true,
                    type: delegateTargetType
                )
                let eventRaiseCaptureRef = BoundVariableExpression(nil, eventRaiseCapture)
                // The callback uses null to mean that no explicit type arguments were supplied.
                if tryBindInheritedClrInstanceCall(
                    eventRaiseCaptureRef,
                    delegateClrType,
                    "Invoke",
                    boundArguments.ToImmutable(),
                    syntax,
                    out var guardedInvoke,
                    nil,
                    default(ImmutableArray[TypeSymbol]),
                    argumentNames,
                    false
                ) &&
                    !(guardedInvoke is BoundErrorExpression) {
                    return BuildNullConditionalDelegateResult(
                        syntax,
                        receiver,
                        eventRaiseCapture,
                        guardedInvoke!!,
                        guardedInvoke!!.Type
                    )
                }
            }
            // ADR-0186 §4, issue #4325: invoking a delegate VALUE. This is a
            // receiver position — the call lowers to `Invoke` on the delegate
            // — and it reaches this arm rather than any of the
            // `FunctionTypeSymbol` paths above precisely BECAUSE
            // `PlatformTypeSymbol` relays its underlying's `ClrType` (§1), so
            // `ClrTypeUtilities.IsDelegateType(delegateClrType)` is true for a
            // `Func[string]!` while `callableType as FunctionTypeSymbol` is
            // null. Without the check a nil oblivious delegate produced a bare
            // `NullReferenceException` from inside the lowered `Invoke`,
            // naming nothing.
            //
            // Deliberately NOT applied on the `?(...)` branch above: that
            // branch already short-circuits on nil, so no coercion to non-null
            // occurs and §4 inserts nothing for a guarded access.
            receiver = PlatformCoercion.CheckDelegateInvocationTarget(receiver, syntax.Identifier.Location)
            // The callback uses null to mean that no explicit type arguments were supplied.
            if tryBindInheritedClrInstanceCall(
                receiver,
                delegateClrType,
                "Invoke",
                boundArguments.ToImmutable(),
                syntax,
                out var invokeCall,
                nil,
                default(ImmutableArray[TypeSymbol]),
                argumentNames,
                false
            ) {
                return invokeCall!!
            }
            let invoke = delegateClrType.GetMethodSafe("Invoke")
            let expectedArity = invoke?.GetParameters().Length ?? 0
            if syntax.Arguments.Count != expectedArity {
                Diagnostics.ReportWrongArgumentCount(
                    syntax.Identifier.Location,
                    delegateVar.Name,
                    expectedArity,
                    syntax.Arguments.Count
                )
                return BoundErrorExpression(nil)
            }
            Diagnostics.ReportNotAFunction(syntax.Identifier.Location, syntax.Identifier.ValueText)
            return BoundErrorExpression(nil)
        }
        var function FunctionSymbol? = symbol as FunctionSymbol
        if function == nil {
            Diagnostics.ReportNotAFunction(syntax.Identifier.Location, syntax.Identifier.ValueText)
            return BoundErrorExpression(nil)
        }
        // ADR-0063 §11: when multiple top-level functions share this name,
        // perform overload selection over the supplied argument shape (count
        // and, where useful, types). The legacy `TryLookupSymbol` returned the
        // first declared overload; we now consult the overload-set store.
        var overloadSet = Scope.TryLookupFunctions(syntax.Identifier.ValueText)
        var explicitOverloadTypeArguments = default(ImmutableArray[TypeSymbol])
        if overloadSet.Length > 1 {
            if syntax.TypeArgumentList != nil {
                let explicitArguments = ImmutableArray.CreateBuilder[TypeSymbol](
                    syntax.TypeArgumentList.Arguments.Count
                )
                for explicitArgument in syntax.TypeArgumentList!!.Arguments {
                    let boundTypeArgument TypeSymbol? = bindTypeClause(explicitArgument)
                    if boundTypeArgument == nil {
                        return BoundErrorExpression(nil)
                    }
                    explicitArguments.Add(boundTypeArgument)
                }
                explicitOverloadTypeArguments = explicitArguments.MoveToImmutable()
                let constraintMatches = ImmutableArray.CreateBuilder[FunctionSymbol]()
                for candidate in overloadSet {
                    if candidate.TypeParameters.Length != explicitOverloadTypeArguments.Length {
                        continue
                    }
                    // Issue #4043: a DEPENDENT bound is answered on the whole
                    // vector, so build the positional map before asking.
                    let explicitVector = BuildTypeArgumentVector(
                        candidate.TypeParameters,
                        explicitOverloadTypeArguments
                    )
                    var constraintsSatisfied = true
                    for var i = 0; i < candidate.TypeParameters.Length; i++ {
                        constraintsSatisfied &= satisfiesConstraint(
                            explicitOverloadTypeArguments[i],
                            candidate.TypeParameters[i],
                            explicitVector
                        )
                    }
                    if constraintsSatisfied {
                        constraintMatches.Add(candidate)
                    }
                }
                if constraintMatches.Count > 0 {
                    overloadSet = constraintMatches.ToImmutable()
                }
            }
            let selected FunctionSymbol? = SelectBestUserOverload(
                overloadSet,
                syntax.Arguments.Count,
                argumentNames,
                boundArguments,
                syntax,
                out var overloadAmbiguous,
                out var nullSafetyFailure,
                syntax.TypeArgumentList?.Arguments.Count ?? 0
            )
            if selected == nil {
                if nullSafetyFailure != nil {
                    let argLoc = if nullSafetyFailure.Index < syntax.Arguments.Count {
                        syntax.Arguments[nullSafetyFailure.Index].Location
                    } else {
                        syntax.Identifier.Location
                    }
                    Diagnostics.ReportWrongArgumentType(
                        argLoc,
                        nullSafetyFailure.ParamName,
                        nullSafetyFailure.ParamType,
                        nullSafetyFailure.ArgType
                    )
                } else if overloadAmbiguous {
                    if TryGetUnconstrainedNullableIteratorTypeParameter(
                        overloadSet,
                        boundArguments,
                        syntax.Arguments.Count,
                        explicitOverloadTypeArguments,
                        out var unconstrainedTypeParameter
                    ) {
                        Diagnostics.ReportUnconstrainedNullableIteratorCall(
                            syntax.Identifier.Location,
                            syntax.Identifier.ValueText,
                            Invariant.Required(
                                unconstrainedTypeParameter,
                                "an unconstrained nullable iterator diagnostic has a type parameter",
                                expression: "unconstrainedTypeParameter"
                            )
                                .Name
                        )
                    } else {
                        Diagnostics.ReportAmbiguousOverloadResolution(
                            syntax.Identifier.Location,
                            syntax.Identifier.ValueText
                        )
                    }
                } else {
                    Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, syntax.Identifier.ValueText)
                }
                return BoundErrorExpression(nil)
            }
            function = selected
        }
        reportObsoleteUseIfApplicable(syntax.Identifier.Location, function!!, function!!.Name)
        let isVariadic = function!!
            .Parameters
            .Length > 0 &&
            function!!
            .Parameters[function!!.Parameters.Length - 1]
            .IsVariadic
        let fixedParamCount = if isVariadic {
            function!!.Parameters.Length - 1
        } else {
            function!!.Parameters.Length
        }
        var requiredFixedParamCount = fixedParamCount
        for var i = fixedParamCount - 1; i >= 0; i-- {
            if function!!.Parameters[i].HasExplicitDefaultValue {
                requiredFixedParamCount = i
            } else {
                break
            }
        }
        let functionParameterNameAt(int32) -> string = (parameterIndex int32) -> function!!
            .Parameters[parameterIndex]
            .Name
        let functionParameterIsOptional(int32) -> bool = (parameterIndex int32) -> function!!
            .Parameters[parameterIndex]
            .HasExplicitDefaultValue
        // ADR-0063: count of leading non-optional parameters (the minimum a
        // call must supply when there are no variadic parameters).
        var requiredParamCount = function!!.Parameters.Length
        for var i = function!!.Parameters.Length - 1; i >= 0; i-- {
            if function!!.Parameters[i].HasExplicitDefaultValue {
                requiredParamCount = i
            } else {
                break
            }
        }
        if isVariadic &&
            !ValidateExpandedVariadicNamedArguments(
            argumentNames,
            fixedParamCount,
            functionParameterNameAt,
            function!!.Name,
            syntax
        ) {
            return BoundErrorExpression(nil)
        }
        if isVariadic {
            if syntax.Arguments.Count < requiredFixedParamCount {
                Diagnostics.ReportTooFewArgumentsForVariadic(
                    syntax.Identifier.Location,
                    function!!.Name,
                    requiredFixedParamCount,
                    syntax.Arguments.Count
                )
                return BoundErrorExpression(nil)
            }
        } else if syntax.Arguments.Count < requiredParamCount || syntax.Arguments.Count > function!!.Parameters.Length {
            var span TextSpan
            if syntax.Arguments.Count > function!!.Parameters.Length {
                var firstExceedingNode SyntaxNode
                if function!!.Parameters.Length > 0 {
                    firstExceedingNode = Invariant.Required(
                        syntax.Arguments.GetSeparator(function!!.Parameters.Length - 1),
                        "an argument list with too many arguments has a separator before the excess arguments",
                        expression: "syntax.Arguments.GetSeparator(function.Parameters.Length - 1)"
                    )
                } else {
                    firstExceedingNode = syntax.Arguments[0]
                }
                let lastExceedingArgument = Invariant.Required(
                    syntax.Arguments[syntax.Arguments.Count - 1],
                    "an argument list with too many arguments has a last argument",
                    expression: "syntax.Arguments[syntax.Arguments.Count - 1]"
                )
                span = TextSpan.FromBounds(firstExceedingNode.Span.Start, lastExceedingArgument.Span.End)
            } else {
                span = syntax.CloseParenthesisToken.Span
            }
            Diagnostics.ReportWrongArgumentCount(
                TextLocation(
                    Invariant.Required(
                        syntax.Location.Text,
                        "a call syntax location has source text",
                        expression: "syntax.Location.Text"
                    ),
                    span
                ),
                function!!.Name,
                function!!.Parameters.Length,
                syntax.Arguments.Count
            )
            return BoundErrorExpression(nil)
        }
        // Issue #343: when the call site mixes positional and named arguments,
        // reorder the bound arguments into the function's parameter order so
        // the existing per-position passes operate as if every argument were
        // positional. `parameterSyntax[i]` carries the source-syntax node at
        // parameter position `i` (preserving locations for diagnostics).
        // ADR-0063: when there are optional parameters, omitted slots are left
        // empty in the reorder output, then filled with default-value
        // BoundLiteralExpression here.
        var parameterSyntax[]ExpressionSyntax?
        let hasOptional = function!!
            .Parameters
            .Length > 0 &&
            requiredParamCount < function!!
            .Parameters
            .Length &&
            !isVariadic
        if (!argumentNames.IsDefault && !isVariadic) ||
            (hasOptional && syntax.Arguments.Count < function!!.Parameters.Length) {
            if !TryReorderUserCallArguments(
                syntax.Arguments,
                boundArguments.ToImmutable(),
                function!!.Parameters.Length,
                functionParameterNameAt,
                if hasOptional {
                    functionParameterIsOptional
                } else {
                    default(((int32) -> bool)?)
                },
                function!!.Name,
                out parameterSyntax,
                out var permutedBound
            ) {
                return BoundErrorExpression(nil)
            }
            boundArguments = ImmutableArray.CreateBuilder[BoundExpression](permutedBound.Length)
            for var i = 0; i < permutedBound.Length; i++ {
                if permutedBound[i] == nil {
                    // ADR-0063: fill the omitted optional slot with the parameter's default.
                    boundArguments.Add(CreateOptionalUserDefaultArgument(function!!.Parameters[i]))
                } else {
                    boundArguments.Add(permutedBound[i])
                }
            }
        } else {
            parameterSyntax = [syntax.Arguments.Count]ExpressionSyntax
            for var i = 0; i < syntax.Arguments.Count; i++ {
                parameterSyntax[i] = syntax.Arguments[i]
            }
        }
        if isVariadic && boundArguments.Count < fixedParamCount {
            let paddedSyntax = [fixedParamCount]ExpressionSyntax?
            Array.Copy(parameterSyntax, paddedSyntax, parameterSyntax.Length)
            parameterSyntax = paddedSyntax
            for var i = boundArguments.Count; i < fixedParamCount; i++ {
                boundArguments.Add(CreateOptionalUserDefaultArgument(function!!.Parameters[i]))
            }
        }
        var hasErrors = false
        // Phase 4.1 / ADR-0020: if the callee is generic, build the type
        // substitution either from the explicit `[T1, T2]` list at the call
        // site or by left-to-right inference from argument types matched
        // against parameter types.
        var substitution Dictionary[TypeParameterSymbol, TypeSymbol]? = nil
        if function!!.IsGeneric {
            substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
            if syntax.TypeArgumentList is {} typeArgumentList {
                let explicitArgs = typeArgumentList.Arguments
                if explicitArgs.Count != function!!.TypeParameters.Length {
                    Diagnostics.ReportWrongTypeArgumentCount(
                        typeArgumentList.Location,
                        function!!.Name,
                        function!!.TypeParameters.Length,
                        explicitArgs.Count
                    )
                    return BoundErrorExpression(nil)
                }
                for var i = 0; i < explicitArgs.Count; i++ {
                    let ta TypeSymbol? = if !explicitOverloadTypeArguments.IsDefault {
                        explicitOverloadTypeArguments[i]
                    } else {
                        bindTypeClause(explicitArgs[i])
                    }
                    if ta == nil {
                        return BoundErrorExpression(nil)
                    }
                    substitution[function!!.TypeParameters[i]] = ta
                }
            } else {
                for var i = 0; i < function!!.Parameters.Length && i < boundArguments.Count; i++ {
                    let paramType = function!!.Parameters[i].Type
                    // ADR-0101 / issue #799: when the trailing parameter is
                    // variadic (`name ...T`), inference must consider every
                    // packed argument against the element type — *unless* the
                    // caller supplied a single trailing argument whose type
                    // already matches the slice (the C# `params` pass-through
                    // case), in which case the slice itself drives inference.
                    if i == function!!
                        .Parameters
                        .Length - 1 &&
                        function!!
                        .Parameters[i]
                        .IsVariadic &&
                        paramType is SliceTypeSymbol variadicSlice {
                        let trailingCount = boundArguments.Count - i
                        if trailingCount == 1 && RefCapabilities.GetValueArgumentInferenceType(
                            boundArguments[i].Type
                        ) is SliceTypeSymbol {
                            inferTypeArguments(
                                paramType,
                                RefCapabilities.GetValueArgumentInferenceType(boundArguments[i].Type),
                                substitution
                            )
                        } else {
                            for var j = i; j < boundArguments.Count; j++ {
                                inferTypeArguments(
                                    variadicSlice.ElementType,
                                    RefCapabilities.GetValueArgumentInferenceType(boundArguments[j].Type),
                                    substitution
                                )
                            }
                        }
                        break
                    }
                    inferTypeArguments(
                        paramType,
                        RefCapabilities.GetInferenceType(function!!.Parameters[i], boundArguments[i].Type),
                        substitution
                    )
                }
                // Issue #3760: a method group has no type of its own, so the
                // loop above contributes nothing from a `f Func[int32, TOut]`
                // slot and `TOut` — reachable ONLY through the group's return
                // type — never receives a bound (GS0151). The imported-call
                // binder already runs this second step
                // (ClrOverloadResolution.TryInferMethodGroupArgument); the
                // user-generic path had no equivalent (the #3705
                // "inconsistent sibling probe" class). Mirror it here: close
                // the target delegate's INPUT types from the bounds the first
                // pass established, resolve the group against them, and unify
                // the resulting return type back in. Per #3756 this runs ONLY
                // when the first pass left a type parameter unbound, so no
                // call that already infers can change shape.
                if HasUnboundTypeParameter(function!!.TypeParameters, substitution) {
                    for var i = 0; i < function!!.Parameters.Length && i < boundArguments.Count; i++ {
                        InferFromUserMethodGroupArgument(function!!.Parameters[i].Type, boundArguments[i], substitution)
                    }
                }
                for tp in function!!.TypeParameters {
                    if !substitution.ContainsKey(tp) {
                        Diagnostics.ReportTypeArgumentInferenceFailed(
                            syntax.Identifier.Location,
                            function!!.Name,
                            tp.Name
                        )
                        return BoundErrorExpression(nil)
                    }
                }
            }
            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            let constraintLocation = if syntax.TypeArgumentList != nil {
                syntax.TypeArgumentList.Location
            } else {
                syntax.Identifier.Location
            }
            if TryReportByRefLikeTypeArgument(function!!.TypeParameters, substitution, constraintLocation) {
                return BoundErrorExpression(nil)
            }
            for tp in function!!.TypeParameters {
                let typeArg = substitution[tp]
                if !satisfiesConstraint(typeArg, tp, substitution) {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                        constraintLocation,
                        tp.Name,
                        typeArg,
                        describeConstraint(tp)
                    )
                    return BoundErrorExpression(nil)
                }
            }
        }
        for var i = 0; i < fixedParamCount; i++ {
            var argument = boundArguments[i]
            let parameter = function!!.Parameters[i]
            let expectedType TypeSymbol? = if substitution != nil {
                substituteType(parameter.Type, substitution)
            } else {
                parameter.Type
            }
            // Issue #1238: a deferred target-typed conditional/if/switch
            // argument is re-bound here against the resolved parameter type so
            // each branch is target-typed before the convertibility checks
            // below (which would otherwise reject the suppressed-error
            // placeholder).
            boundArguments[i] = (
                argument = FinalizeBranchyArgument(
                    argument,
                    if i < parameterSyntax.Length {
                        parameterSyntax[i]
                    } else {
                        default(ExpressionSyntax?)
                    },
                    expectedType
                )
            )
            // bound against the resolved parameter's delegate target so its
            // omitted parameter type(s) and inferred return type are filled in
            // from the parameter shape (e.g. `func F(f Func[int32, int32])`
            // accepts `F((x) -> x + 1)`). The bound lambda is then converted to
            // the exact parameter type so the correct delegate adapter
            // (`Func`/`Action`/`Predicate`/a named delegate) is materialised.
            // If the parameter is not a delegate type, fall back to binding the
            // lambda with no target, which surfaces the established GS0304
            // diagnostic through the regular conversion checks below.
            if deferredArrowLambdas != nil &&
                i < parameterSyntax.Length &&
                parameterSyntax[i] is {} deferredArgument &&
                GetLambdaArgumentSyntax(deferredArgument) is {} deferredLambda &&
                deferredArrowLambdas
                .Remove(deferredLambda) {
                let lambdaLoc = deferredArgument.Location
                if bindLambdaWithTarget != nil &&
                    expectedType != nil &&
                    expectedType != TypeSymbol.Error &&
                    !TypeSymbol.ContainsTypeParameter(expectedType) &&
                    MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(expectedType, out var deferredTarget) &&
                    deferredTarget != nil {
                    let targeted = bindLambdaWithTarget!!(deferredLambda, deferredTarget)
                    // Issue #4400: at an `in` delegate parameter the target-
                    // bound lambda is a value; pass it by readonly reference.
                    boundArguments[i] = if parameter.RefKind == RefKind.In {
                        conversions.BindImplicitInArgument(lambdaLoc, targeted, expectedType, parameter)
                    } else {
                        conversions.BindConversion(lambdaLoc, targeted, expectedType)
                    }
                    hasErrors |= parameter.RefKind == RefKind.In && boundArguments[i] is BoundErrorExpression
                    continue
                }
                boundArguments[i] = (argument = bindExpression(deferredLambda))
            }
            let lambdaTargetLoc = if i < parameterSyntax.Length {
                parameterSyntax[i]?.Location ?? syntax.Identifier.Location
            } else {
                syntax.Identifier.Location
            }
            let lambdaSyntax = if i < parameterSyntax.Length && parameterSyntax[i] is {} sourceArgument {
                GetLambdaArgumentSyntax(sourceArgument)
            } else {
                default(LambdaExpressionSyntax?)
            }
            if (parameter.RefKind is RefKind.None or RefKind.In) &&
                TryConvertLambdaArgumentWithTarget(
                argument,
                expectedType,
                lambdaTargetLoc,
                out var targetTypedLambda,
                lambdaSyntax,
                parameter
            ) {
                let typedLambda = Invariant.Required(
                    targetTypedLambda,
                    "a successfully target-typed lambda produces a bound expression",
                    expression: "targetTypedLambda"
                )
                // Issue #4400: at an `in` delegate parameter the target-typed
                // lambda is a value; pass it by readonly reference.
                boundArguments[i] = if parameter.RefKind == RefKind.In && !(typedLambda is BoundErrorExpression) {
                    conversions.CreateImplicitInReference(
                        typedLambda,
                        Invariant.Required(
                            expectedType,
                            "a bound parameter has a target type",
                            expression: "expectedType"
                        )
                    )
                } else {
                    typedLambda
                }
                continue
            }
            // ADR-0100 / issue #795: materialise a bare-`default`
            // placeholder argument (BoundDefaultExpression with Error
            // type and bare DefaultExpressionSyntax) against the
            // expected parameter type. The placeholder originates in
            // ExpressionBinder.BindDefaultExpression when the bare form
            // is encountered through the eager argument-binding loop
            // above; by this point we know the target type and can pin
            // it down.
            if argument is BoundDefaultExpression bareDefArg &&
                argument.Type == TypeSymbol.Error &&
                argument.Syntax is DefaultExpressionSyntax bareDefArgSyntax &&
                bareDefArgSyntax.TypeClause == nil &&
                expectedType != nil &&
                expectedType != TypeSymbol.Error {
                boundArguments[i] = (argument = BoundDefaultExpression(bareDefArgSyntax, expectedType))
            }
            // ADR-0060: ref-kind argument matching. The argument's syntax must
            // carry the same `ref`/`out`/`in` modifier as the parameter; for `in`
            // the modifier is required (warning GS0242 is reported when omitted).
            // ADR-0060 §1 back-compat: a bare `&x` (BoundAddressOfExpression
            // without a RefArgumentExpressionSyntax wrapper) is universally
            // compatible with any ref-kind parameter (existing ADR-0039 behaviour).
            if parameter.RefKind != RefKind.None ||
                (i < parameterSyntax.Length && parameterSyntax[i] is RefArgumentExpressionSyntax) {
                let argSyntax ExpressionSyntax? = if i < parameterSyntax.Length {
                    parameterSyntax[i]
                } else {
                    default(ExpressionSyntax?)
                }
                var argRefKind = RefKind.None
                if argSyntax is RefArgumentExpressionSyntax refArgSyntax {
                    argRefKind = getRefKindFromModifier(refArgSyntax.RefKindModifier)
                }
                // Back-compat: bare `&x` (UnaryExpression with AmpersandToken,
                // bound to BoundAddressOfExpression) is universally compatible
                // with any ref-kind parameter. Treat it as if the user wrote the
                // matching keyword. ADR-0061: same back-compat applies to the
                // bare `&(cond ? a : b)` conditional address-of form.
                let isBareAddressOf = argRefKind == RefKind.None &&
                    (argument is BoundAddressOfExpression || argument is BoundConditionalAddressExpression) &&
                    parameter.RefKind != RefKind.None
                if isBareAddressOf {
                    argRefKind = parameter.RefKind
                }
                if argRefKind != parameter.RefKind {
                    if parameter.RefKind == RefKind.In && argRefKind == RefKind.None {
                        // Issue #4400 (ADR-0060 amendment): `in` without the
                        // call-site modifier passes a readonly reference, as in
                        // C# — the lvalue's own address, or a spilled temp's.
                        // An interpolated string at an `in IFormattable` /
                        // `in FormattableString` parameter is re-lowered to
                        // the formattable first, exactly as a by-value one is.
                        var inValue = argument
                        if argSyntax != nil &&
                            UnwrapNamedArgumentValue(
                            argSyntax
                        ) is InterpolatedStringExpressionSyntax interpolatedInArg &&
                            expectedType != nil &&
                            isFormattableStringTargetType(expectedType) {
                            inValue = bindInterpolatedStringAsFormattable(interpolatedInArg, expectedType)
                        }
                        let implicitIn = conversions.BindImplicitInArgument(
                            argSyntax?.Location ?? syntax.Location,
                            inValue,
                            Invariant.Required(
                                expectedType,
                                "a bound parameter has a target type",
                                expression: "expectedType"
                            ),
                            parameter
                        )
                        boundArguments[i] = implicitIn
                        hasErrors |= implicitIn is BoundErrorExpression
                        continue
                    }
                    Diagnostics.ReportRefKindMismatch(
                        argSyntax?.Location ?? syntax.Location,
                        i + 1,
                        parameter.Name,
                        refKindToString(parameter.RefKind),
                        refKindToString(argRefKind)
                    )
                    hasErrors = true
                    continue
                }
                // Modifiers match. The bound argument is BoundAddressOfExpression
                // (or, ADR-0061, BoundConditionalAddressExpression) whose
                // operand/pointee type must match the parameter's pointee type.
                if argument is BoundAddressOfExpression addr {
                    let operandType = addr.Operand.Type
                    // ADR-0060: an inline-decl `out var n` / `out let n` / `out _`
                    // was bound with TypeSymbol.Error in the first pass because
                    // the parameter was unknown. Re-bind now that overload
                    // resolution has chosen the function and the parameter
                    // pointee type is known.
                    if operandType == TypeSymbol.Error &&
                        i < parameterSyntax.Length &&
                        parameterSyntax[i] is RefArgumentExpressionSyntax refArgFixup &&
                        refArgFixup.IsInlineDeclaration &&
                        refArgFixup.DeclaredType == nil {
                        boundArguments[i] = bindRefArgumentExpression(refArgFixup, parameter)
                        continue
                    }
                    let refArgumentLocation = Invariant.Required(
                        parameterSyntax[i],
                        "a ref argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location
                    let refParameterType = Invariant.Required(
                        expectedType,
                        "a bound parameter has a target type",
                        expression: "expectedType"
                    )
                    if operandType != TypeSymbol.Error && !conversions.CheckByRefArgumentStorage(
                        refArgumentLocation,
                        parameter,
                        operandType,
                        refParameterType
                    ) {
                        conversions.ReportByRefStorageMismatch(
                            refArgumentLocation,
                            parameter.Name,
                            refParameterType,
                            operandType
                        )
                        hasErrors = true
                    }
                } else if argument is BoundConditionalAddressExpression condAddrArg {
                    let pointeeType = condAddrArg.PointeeType
                    if pointeeType != TypeSymbol.Error && !conversions.CheckByRefArgumentStorage(
                        Invariant.Required(
                            parameterSyntax[i],
                            "a conditional ref argument has source syntax",
                            expression: "parameterSyntax[i]"
                        )
                            .Location,
                        parameter,
                        pointeeType,
                        Invariant.Required(
                            expectedType,
                            "a bound parameter has a target type",
                            expression: "expectedType"
                        )
                    ) {
                        conversions.ReportByRefStorageMismatch(
                            Invariant.Required(
                                parameterSyntax[i],
                                "a conditional ref argument has source syntax",
                                expression: "parameterSyntax[i]"
                            )
                                .Location,
                            parameter.Name,
                            Invariant.Required(
                                expectedType,
                                "a bound parameter has a target type",
                                expression: "expectedType"
                            ),
                            pointeeType
                        )
                        hasErrors = true
                    }
                }
                continue
            }
            if substitution != nil &&
                parameter.Type is FunctionTypeSymbol openFunctionParameter &&
                tryGetFunctionLiteral(argument, out var functionLiteralArgument) {
                // ADR-0087 §3 R6: substitute the open target before
                // routing through the adapter so the identity-check
                // inside the adapter can drop the wrapper when the
                // literal already matches.
                let substitutedOpenTarget = (
                    substituteType(openFunctionParameter, substitution) as FunctionTypeSymbol
                ) ??
                    openFunctionParameter
                boundArguments[i] = createErasedFunctionLiteralAdapter(functionLiteralArgument!!, substitutedOpenTarget)
                continue
            }
            // Issue #1150: a func/arrow literal argument whose natural numeric
            // return type implicitly, losslessly widens to the (non-generic)
            // delegate parameter's return type (e.g. `(x int32) -> uint16(x)`
            // into a `Func<int32,int64>` parameter) is routed through
            // BindConversion, which reshapes it via the erased adapter so the
            // produced delegate's return type already matches the target —
            // inserting the widening conversion in the body. Without this the
            // literal would materialise as a narrower-returning delegate flowing
            // into a wider delegate slot (unverifiable IL).
            if !(substitution != nil && TypeSymbol.ContainsTypeParameter(parameter.Type)) &&
                tryGetFunctionLiteral(argument, out var widenLiteralArg) {
                let widenLiteralFnType FunctionTypeSymbol? = widenLiteralArg!!.FunctionType as FunctionTypeSymbol
                if widenLiteralFnType != nil &&
                    widenLiteralFnType.ReturnType != TypeSymbol.Void &&
                    widenLiteralFnType.ReturnType != TypeSymbol.Error &&
                    expectedType != nil &&
                    MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(expectedType, out var widenTargetFn) &&
                    widenTargetFn != nil &&
                    widenTargetFn.Arity == widenLiteralFnType.Arity &&
                    widenTargetFn.ReturnType != TypeSymbol.Void &&
                    widenTargetFn.ReturnType != TypeSymbol.Error &&
                    !object.ReferenceEquals(widenLiteralFnType.ReturnType, widenTargetFn.ReturnType) &&
                    Conversion
                    .Classify(widenLiteralFnType.ReturnType, widenTargetFn.ReturnType).IsImplicit {
                    let widenLoc = if i < parameterSyntax.Length {
                        Invariant.Required(
                            parameterSyntax[i],
                            "a widened lambda argument has source syntax",
                            expression: "parameterSyntax[i]"
                        )
                            .Location
                    } else {
                        syntax.Identifier.Location
                    }
                    boundArguments[i] = conversions.BindConversion(widenLoc, argument, expectedType)
                    continue
                }
            }
            // ADR-0055 Tier 4 (#369): an interpolated-string argument bound
            // against an IFormattable/FormattableString parameter is re-lowered
            // to FormattableStringFactory.Create instead of an eager string. Only
            // applies in the non-generic case (a type parameter is never a
            // formattable target).
            if substitution == nil &&
                i < parameterSyntax.Length &&
                parameterSyntax[i] is InterpolatedStringExpressionSyntax interpolatedArg &&
                isFormattableStringTargetType(
                Invariant.Required(
                    expectedType,
                    "a non-generic interpolated-string argument has a target type",
                    expression: "expectedType"
                )
            ) {
                boundArguments[i] = bindInterpolatedStringAsFormattable(
                    interpolatedArg,
                    Invariant.Required(
                        expectedType,
                        "a formattable-string argument has a target type",
                        expression: "expectedType"
                    )
                )
                continue
            }
            // ADR-0112 / ADR-0063 §9: every method-group argument must pass
            // through BindConversion once the delegate parameter is known.
            // Unresolved groups need its signature-directed overload pick;
            // already-resolved user groups need it to retain that a real target
            // delegate supplied their value context (issue #4065).
            // Issue #3760: the generic guard below must look at the SUBSTITUTED
            // target (`expectedType`), not the declared `parameter.Type`. A
            // generic callee's delegate parameter — `func Map[TOut](value
            // int32, f Func[int32, TOut])` — always mentions a type parameter
            // in its declared form, so testing the declared type skipped this
            // branch even when the call site had already pinned `TOut` (by
            // inference or an explicit `[string]`) and `expectedType` was the
            // fully closed `Func[int32, string]`. The group then fell through
            // every branch below still unresolved and Error-typed, and reached
            // the emitter as GS9998 (internal compiler error). Only a target
            // that is STILL open after substitution has no signature to drive
            // the pick, and only that case may skip.
            if (
                argument is BoundMethodGroupExpression ||
                    argument is BoundClrMethodGroupExpression &&
                    argument.ResolvedMethod == nil
            ) &&
                !(substitution != nil && (expectedType == nil || TypeSymbol.ContainsTypeParameter(expectedType))) {
                let groupLoc = if i < parameterSyntax.Length {
                    Invariant.Required(
                        parameterSyntax[i],
                        "a method group argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location
                } else {
                    syntax.Identifier.Location
                }
                let resolvedGroupArg = conversions.BindConversion(
                    groupLoc,
                    argument,
                    Invariant.Required(
                        expectedType,
                        "a method group argument has a target type",
                        expression: "expectedType"
                    )
                )
                boundArguments[i] = resolvedGroupArg
                if resolvedGroupArg is BoundErrorExpression {
                    hasErrors = true
                }
                continue
            }
            // Issue #1256: an element-wise tuple conversion `(T1, …) -> (U1, …)`
            // is implicit but NOT representation-preserving — the source and
            // target `ValueTuple<…>` are different CLR instantiations, so the
            // argument must be lowered (rebuilt) via BindConversion rather than
            // passed through unchanged. The generic implicit-conversion branch
            // below only inserts a conversion node for value-type nullable
            // targets, leaving every other "implicit" conversion as a no-op, so
            // tuple arguments would otherwise reach the call site still typed as
            // the source tuple and produce unverifiable IL.
            if argument.Type is TupleTypeSymbol argTuple &&
                expectedType is TupleTypeSymbol paramTuple &&
                argTuple.Arity == paramTuple.Arity &&
                argTuple != paramTuple &&
                Conversion
                .Classify(argTuple, paramTuple).IsImplicit {
                let tupleLoc = if i < parameterSyntax.Length {
                    Invariant.Required(
                        parameterSyntax[i],
                        "a tuple argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location
                } else {
                    syntax.Identifier.Location
                }
                boundArguments[i] = conversions.BindConversion(
                    tupleLoc,
                    argument,
                    Invariant.Required(expectedType, "a tuple argument has a target type", expression: "expectedType")
                )
                continue
            }
            // Issue #2069: force the wrap for a func/arrow literal argument
            // flowing into a NAMED delegate parameter — see the matching
            // comment at the constructor-argument path (above in this file)
            // for the full rationale. This is the general free-function /
            // method call-argument path, the one that reproduces the issue's
            // exact repro (`Apply((n int32) -> ...)` against a `func
            // Apply(h TickHandler)` parameter).
            // Issue #2850: strip reference nullability on both sides and use
            // the substituted target, whether it is closed at this call site
            // or remains open during generic forwarding. A direct generic
            // free-function call must materialize the structural value as the
            // nominal delegate just like the instance/static method paths do.
            let nominalDelegateCallTarget = if expectedType is NullableTypeSymbol nullableDelegateTarget {
                nullableDelegateTarget.UnderlyingType
            } else {
                expectedType
            }
            let structuralArgumentType = if argument.Type is NullableTypeSymbol nullableFunctionArgument {
                nullableFunctionArgument.UnderlyingType
            } else {
                argument.Type
            }
            if nominalDelegateCallTarget is DelegateTypeSymbol && structuralArgumentType is FunctionTypeSymbol {
                let namedDelegateLoc = if i < parameterSyntax.Length {
                    Invariant.Required(
                        parameterSyntax[i],
                        "a delegate argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location
                } else {
                    syntax.Identifier.Location
                }
                boundArguments[i] = conversions.BindConversion(
                    namedDelegateLoc,
                    argument,
                    Invariant.Required(
                        expectedType,
                        "a delegate argument has a target type",
                        expression: "expectedType"
                    )
                )
                continue
            }
            // Issue #3988: the `ContainsTypeParameter` clause below is a
            // deliberate bypass — when the substituted parameter type still
            // mentions a type parameter, `Conversion.Classify` is not asked at
            // all and the argument flows through unchecked. That is right for
            // the general lattice (an open pair has no closed answer to give),
            // but it also swallowed the ONE rule that needs no closed answer:
            // Kotlin-model null safety. `IsNullableReferenceGateRejected` is a
            // pure SHAPE question — "is the argument a nullable REFERENCE and
            // the parameter a non-null-tolerant reference?" — and both halves
            // are decidable on an open type (`chan[T]` is a reference in every
            // instantiation; a `[T class]` parameter is one by constraint).
            // Without this the `chan[T]?` spelling was silently accepted where
            // the closed `chan[int32]?` correctly reported GS0154, and a `nil`
            // reached the non-nullable slot with no diagnostic — measured, it
            // throws `close of nil channel` at run time. `[]T?`, `D?` over an
            // open element and a reference-constrained `T?` had the identical
            // hole. An UNCONSTRAINED `T?` stays ungated, because the gate's
            // reference-likeness test (now `Conversion.IsReferenceLikeTarget`
            // itself — see #3988's other half) deliberately answers false for
            // it: its `T?` erases to `Nullable<T>` and it keeps the value-type
            // rules.
            // Issue #4010: the same bypass swallows the OTHER half of the same
            // rule. #3988 taught it to look at a `NullableTypeSymbol` argument,
            // but a bare `nil` LITERAL has type `TypeSymbol.Null` — not a
            // nullable annotation — so the gate above never sees it and the
            // argument again flowed through unchecked. `nil` at a non-nullable
            // slot is a pure SHAPE question too, and `Conversion.Classify`
            // already decides it for EVERY target without needing the pair
            // closed: `Classify(nil, X)` consults
            // `Conversion.IsNilAssignableWithoutNullableWrapper`, which answers
            // from `X`'s symbol kind alone (a G#-declared class, an interface,
            // a reference-CONSTRAINED type parameter, or any nullable target
            // accepts `nil`; a `chan[T]`, `[]T`, `map[K,V]`, `sequence[T]`,
            // `[4]T`, `(T) -> T` or an unconstrained `T` does not). Asking it
            // is therefore not a closed-world judgement — it makes the OPEN
            // spelling answer exactly what the CLOSED spelling already
            // answered. Measured on the parent: `takesMap[K, V](nil)` forwarded
            // out of a generic compiled with no diagnostic, IL-verified, and
            // threw `NullReferenceException` when the callee read `m.Count`.
            if argument.Type != expectedType &&
                (
                !TypeSymbol.ContainsTypeParameter(
                    Invariant.Required(
                        expectedType,
                        "an argument conversion has a target type",
                        expression: "expectedType"
                    )
                ) ||
                    argument.Type == TypeSymbol.Null ||
                    IsNullableReferenceGateRejected(
                    argument.Type,
                    Invariant.Required(
                        expectedType,
                        "an argument conversion has a target type",
                        expression: "expectedType"
                    )
                ) ||
                    // Issue #5536: whether a function value keeps its delegate is decidable on an open target too.
                !ConversionClassifier.KeepsConvertedDelegate(
                    argument,
                    Invariant.Required(
                        expectedType,
                        "an argument conversion has a target type",
                        expression: "expectedType"
                    )
                )
            ) &&
                (
                !Conversion.Classify(
                    argument.Type,
                    Invariant.Required(
                        expectedType,
                        "an argument conversion has a target type",
                        expression: "expectedType"
                    )
                )
                    .IsImplicit ||
                    !ConversionClassifier
                    .KeepsConvertedDelegate(
                    argument,
                    Invariant.Required(
                        expectedType,
                        "an argument conversion has a target type",
                        expression: "expectedType"
                    )
                )
            ) {
                // Issue #889: arrow/func literal → void-returning delegate.
                let voidDelegateLoc = if i < parameterSyntax.Length {
                    Invariant.Required(
                        parameterSyntax[i],
                        "a delegate argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location
                } else {
                    syntax.Identifier.Location
                }
                let targetType = Invariant.Required(
                    expectedType,
                    "a delegate argument has a target type",
                    expression: "expectedType"
                )
                if TryConvertLiteralArgumentToExpressionTree(
                    argument,
                    targetType,
                    voidDelegateLoc,
                    out var expressionTreeArg
                ) {
                    boundArguments[i] = Invariant.Required(
                        expressionTreeArg,
                        "a successful expression-tree argument conversion produces a bound expression",
                        expression: "expressionTreeArg"
                    )
                    continue
                }
                if TryConvertLambdaArgumentWithTarget(
                    argument,
                    targetType,
                    voidDelegateLoc,
                    out var targetTypedLambdaArg,
                    parameter: parameter
                ) {
                    boundArguments[i] = Invariant.Required(
                        targetTypedLambdaArg,
                        "a successful target-typed lambda conversion produces a bound expression",
                        expression: "targetTypedLambdaArg"
                    )
                    continue
                }
                // Issue #1281: a constant integer argument that fits a narrower /
                // cross-sign integer parameter converts implicitly (C# §10.2.11).
                // Re-materialise it as a literal of exactly the parameter type so
                // emit produces a correctly-typed constant — matching `var x
                // uint16 = 5` at a declaration target (ADR-0129).
                if TryBindConstantNarrowingArgument(argument, targetType, voidDelegateLoc, out var narrowedArg) {
                    boundArguments[i] = Invariant.Required(
                        narrowedArg,
                        "a successful constant narrowing conversion produces a bound expression",
                        expression: "narrowedArg"
                    )
                    continue
                }
                if conversions.TryApplyUserDefinedImplicitArgumentConversion(
                    argument,
                    targetType,
                    out var convertedArg
                ) {
                    boundArguments[i] = convertedArg
                    continue
                }
                if argument.Type != TypeSymbol.Error {
                    conversions.ReportCallArgumentConversionFailure(
                        Invariant.Required(
                            parameterSyntax[i],
                            "an argument with a conversion error has source syntax",
                            expression: "parameterSyntax[i]"
                        )
                            .Location,
                        parameter,
                        targetType,
                        argument.Type
                    )
                }
                hasErrors = true
            } else if argument.Type != expectedType &&
                expectedType is NullableTypeSymbol ntConv &&
                (
                ntConv.UnderlyingType?.ClrType is {IsValueType: true} || NullableLifting.IsUserValueTypeNullable(ntConv)
            ) {
                // Issue #533: conversions to a value-type Nullable<T> parameter
                // need explicit lowering:
                // - nil → Nullable<T> becomes BoundDefaultExpression (initobj)
                // - T → Nullable<T> becomes BoundConversionExpression (newobj ctor)
                //
                // Issue #1572: a user-declared value-type underlying (struct? /
                // enum?) has a null ClrType, so the primitive probe above misses
                // it and the argument would otherwise pass through unlifted (a
                // bare `UserT` where `Nullable<UserT>` is expected). Include the
                // symbol-aware predicate so the `UserT → UserT?` argument lift is
                // lowered to a `newobj Nullable<UserT>::.ctor` here too.
                let argLoc = if i < parameterSyntax.Length {
                    Invariant.Required(
                        parameterSyntax[i],
                        "a nullable-lifted argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location
                } else {
                    syntax.Identifier.Location
                }
                boundArguments[i] = conversions.BindConversion(
                    argLoc,
                    argument,
                    Invariant.Required(
                        expectedType,
                        "a nullable-lifted argument has a target type",
                        expression: "expectedType"
                    )
                )
            } else if argument.Type == TypeSymbol.Null && expectedType is TypeParameterSymbol {
                // Issue #4027: a `nil` LITERAL at a BARE open type-parameter
                // slot must be materialised, and the #3222 branch below
                // deliberately skips exactly this shape (a bare erased slot
                // whose substituted target is still open), so the raw literal
                // reached the emitter and came out as `ldnull` against a `!!T`
                // slot — which ILVerify rejects
                // (`[found Nullobjref] [expected value 'T']`), constraint or
                // no constraint. This does NOT reopen the skip: the skip's
                // purpose is to avoid re-materialising an open-to-open pair
                // whose conversion has no closed answer, and `nil` needs no
                // closed answer. `nil` only REACHES here at all when the first
                // branch above classified it implicit, which per
                // `Conversion.IsNilAssignableWithoutNullableWrapper` means the
                // parameter is reference-CONSTRAINED — an unconstrained `T`
                // was already refused with GS0154 by #4010. `BindConversion`
                // lowers it to `BoundDefaultExpression(T)`, which emits the
                // `ldloca; initobj !!T; ldloc` shape `csc` emits for the same
                // C# program and which verifies. The value is unchanged: for a
                // `[T class]` slot `default(T)` IS the null reference, so the
                // `nil` still arrives.
                let nilArgLoc = if i < parameterSyntax.Length {
                    Invariant.Required(
                        parameterSyntax[i],
                        "a nil argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location
                } else {
                    syntax.Identifier.Location
                }
                boundArguments[i] = conversions.BindConversion(
                    nilArgLoc,
                    argument,
                    Invariant.Required(expectedType, "a nil argument has a target type", expression: "expectedType")
                )
            } else if argument.Type != expectedType &&
                !(
                substitution != nil && parameter.Type is TypeParameterSymbol && TypeSymbol.ContainsTypeParameter(
                    Invariant.Required(
                        expectedType,
                        "a substituted argument has a target type",
                        expression: "expectedType"
                    )
                )
            ) &&
                (
                !(substitution != nil && TypeSymbol.ContainsTypeParameter(parameter.Type)) ||
                    (
                    Conversion.Classify(
                        argument.Type,
                        Invariant.Required(
                            expectedType,
                            "a substituted argument has a target type",
                            expression: "expectedType"
                        )
                    )
                        .IsImplicit &&
                        !(structuralArgumentType is FunctionTypeSymbol)
                )
            ) {
                // Issue #2335 (audit follow-up): every OTHER implicit
                // conversion reaches this point already classified
                // `IsImplicit` by the negation in the very first `if` above
                // (that branch's `!IsImplicit` guard is what routed
                // execution past it), yet none of the specific branches
                // above (delegate/tuple/named-delegate/nullable-lift)
                // materializes it. Left unconverted, the raw argument would
                // flow straight to the emitter — which, for a plain
                // (non-imported) function call, applies NO further implicit
                // widening/boxing of its own (contrast the CLR-call and
                // instance/shared/extension-call paths, which always run
                // their argument through `BindCallArgumentWithRefKind` /
                // `BindConversion`). The most common manifestation is a
                // value-type/generic-type-parameter argument passed to an
                // `object`/interface-typed plain-function parameter (e.g.
                // `func Show(x object) {…}; Show(42)`): the missing `box`
                // opcode produces IL ilverify rejects
                // (`StackUnexpected: found Int32, expected ref 'object'`).
                // The same gap silently dropped numeric widening
                // (`int32 → int64`) and other representation-changing
                // implicit conversions.
                //
                // Issue #3222: only a BARE erased slot whose substituted target
                // remains open is skipped. Once explicit substitution closes
                // the slot, this branch must materialize conversions such as
                // value-type boxing, matching the instance and extension paths.
                // A parameter that merely CONTAINS a type parameter (e.g. a
                // constructed generic interface `IHolder[T]`) emits as a real
                // constructed slot (`IHolder<!!T>`), so a value-type argument
                // still needs its materialized conversion (`box StringBox` →
                // `IHolder<string>`); skipping it produced
                // InvalidProgramException at the call site. Substituted
                // non-bare slots whose conversion is NOT implicit keep the
                // historical skip (status quo) rather than surfacing new
                // diagnostics from this branch. A FUNCTION-shaped argument
                // (lambda/method group into a substituted delegate slot like
                // `Func[A, T]`) also keeps the historical skip: the emitter's
                // delegate-materialization path already builds the accurate
                // nullable-preserving `Func<…,Nullable<T>>` shape (#1518), and
                // re-materializing it here rebuilt the delegate from the
                // collapsed structural shape (`Func<int32,int32>`), tripping
                // ilverify's DelegateCtor check.
                let argLoc = if i < parameterSyntax.Length {
                    Invariant.Required(
                        parameterSyntax[i],
                        "an implicitly converted argument has source syntax",
                        expression: "parameterSyntax[i]"
                    )
                        .Location
                } else {
                    syntax.Identifier.Location
                }
                boundArguments[i] = conversions.BindConversion(
                    argLoc,
                    argument,
                    Invariant.Required(
                        expectedType,
                        "an implicitly converted argument has a target type",
                        expression: "expectedType"
                    )
                )
            }
        }
        // Issue #951: any deferred un-typed arrow lambda that did not map to a
        // fixed parameter (e.g. it landed in a trailing variadic slot) is bound
        // here with no target so the established GS0304 diagnostic surfaces
        // rather than leaving an unbound placeholder.
        if deferredArrowLambdas != nil {
            for var idx = 0; idx < boundArguments.Count; idx++ {
                if idx < boundArguments.Count &&
                    boundArguments[idx] is BoundErrorExpression placeholder &&
                    placeholder.Syntax is LambdaExpressionSyntax pendingLambda &&
                    deferredArrowLambdas.Remove(pendingLambda) {
                    boundArguments[idx] = bindExpression(pendingLambda)
                }
            }
        }
        // Phase 4.8: type-check trailing variadic arguments against the slice
        // element type, then pack them into a single slice-typed argument.
        // ADR-0101 / issue #799: a single trailing argument whose type already
        // matches the variadic slice type is passed through unchanged
        // (parity with the C# `params T[]` call-site semantics so the
        // dogfooded `Sequences.Of` port accepts `Sequences.Of(arr)`).
        if isVariadic {
            let variadicParam = function!!.Parameters[function!!.Parameters.Length - 1]
            let paramCarrierType = variadicParam.Type
            let sliceType = if substitution != nil {
                substituteType(paramCarrierType, substitution)
            } else {
                paramCarrierType
            }
            // Issue #1630: pack/pass-through through the canonical helper
            // (applies #1493 element coercion when packing).
            let argumentLocation(int32) -> TextLocation = (argumentIndex int32) -> syntax
                .Arguments[argumentIndex]
                .Location
            let packedArgs = PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                syntax,
                boundArguments.ToImmutable(),
                fixedParamCount,
                sliceType,
                variadicParam.Name,
                argumentLocation,
                &hasErrors
            )
            if !hasErrors {
                boundArguments = packedArgs.ToBuilder()
            }
        }
        if hasErrors {
            return BoundErrorExpression(syntax)
        }
        // Issue #1931: stash the function's own (explicit or inferred) type
        // arguments on the bound node so the emitter's MethodSpec construction
        // can use this authoritative bind-time result instead of re-deriving
        // it via structural unification (which can fail for uninformative
        // argument shapes like a bare `nil`).
        var methodTypeArguments = default(ImmutableArray[TypeSymbol])
        if function!!.IsGeneric && substitution != nil {
            let methodTypeArgsBuilder = ImmutableArray.CreateBuilder[TypeSymbol](function!!.TypeParameters.Length)
            for tp in function!!.TypeParameters {
                methodTypeArgsBuilder.Add(substitution[tp])
            }
            methodTypeArguments = methodTypeArgsBuilder.MoveToImmutable()
        }
        let finalBoundArguments = PreserveNamedArgumentEvaluationOrder(
            syntax.Arguments,
            boundArguments.ToImmutable(),
            functionParameterNameAt
        )
        if substitution != nil {
            var returnType = substituteType(function!!.Type, substitution)
            if function!!.IsAsync && !function!!.IsAsyncVoid && !isAsyncIteratorReturnType(function!!.Type) {
                returnType = wrapAsTask(returnType, function!!.AsyncReturnsValueTask)
            }
            if function!!.IsSuspending {
                // ADR-0174 D4: the call is typed ValueTask[R]; the caller sees R.
                let suspendingCall = CreatePossiblyElidedCall(
                    syntax,
                    function!!,
                    finalBoundArguments,
                    wrapAsTask(returnType, true),
                    methodTypeArguments
                )
                return completeSuspendingCall(suspendingCall, returnType, syntax.Location, function!!.Name)
            }
            return CreatePossiblyElidedCall(syntax, function!!, finalBoundArguments, returnType, methodTypeArguments)
        }
        if function!!.IsAsync && !function!!.IsAsyncVoid && !isAsyncIteratorReturnType(function!!.Type) {
            let asyncReturn = wrapAsTask(function!!.Type, function!!.AsyncReturnsValueTask)
            return CreatePossiblyElidedCall(syntax, function!!, finalBoundArguments, asyncReturn, methodTypeArguments)
        }
        if function!!.IsSuspending {
            let suspendingCall = CreatePossiblyElidedCall(
                syntax,
                function!!,
                finalBoundArguments,
                wrapAsTask(function!!.Type, true),
                methodTypeArguments
            )
            return completeSuspendingCall(suspendingCall, function!!.Type, syntax.Location, function!!.Name)
        }
        return CreatePossiblyElidedCall(syntax, function!!, finalBoundArguments, returnType: nil, methodTypeArguments)
    }

    private func TryConstructConversionTarget(syntax CallExpressionSyntax, type TypeSymbol) TypeSymbol? {
        // A computed property read drops member-path narrowing (ADR-0208 R12), so keep a local copy.
        let typeArgumentList = syntax.TypeArgumentList
        if typeArgumentList == nil {
            return type
        }
        var typeParameters ImmutableArray[TypeParameterSymbol]
        if type is StructSymbol{IsGenericDefinition: true} genericStruct {
            typeParameters = genericStruct.TypeParameters
        } else if type is InterfaceSymbol{IsGenericDefinition: true} genericInterface {
            typeParameters = genericInterface.TypeParameters
        } else {
            return type
        }
        if typeArgumentList.Arguments.Count != typeParameters.Length {
            Diagnostics.ReportWrongTypeArgumentCount(
                typeArgumentList.Location,
                type.Name,
                typeParameters.Length,
                typeArgumentList.Arguments.Count
            )
            return nil
        }
        // Issue #4043: bind EVERY argument before checking any constraint. A
        // DEPENDENT bound (`class Pair[TBase, TDerived TBase]`) is answered on
        // the whole vector, and the bounding parameter is not required to come
        // first — `[TDerived TBase, TBase]` is legal C# — so a single pass that
        // checked as it bound would ask about an argument it had not read yet.
        let typeArguments = ImmutableArray.CreateBuilder[TypeSymbol](typeParameters.Length)
        for var i = 0; i < typeParameters.Length; i++ {
            let typeArgument TypeSymbol? = bindTypeClause(syntax.TypeArgumentList!!.Arguments[i])
            if typeArgument == nil {
                return nil
            }
            typeArguments.Add(typeArgument)
        }
        let arguments = typeArguments.MoveToImmutable()
        let clauseVector = BuildTypeArgumentVector(typeParameters, arguments)
        for var i = 0; i < typeParameters.Length; i++ {
            if !satisfiesConstraint(arguments[i], typeParameters[i], clauseVector) {
                Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                    syntax.TypeArgumentList!!.Arguments[i].Location,
                    typeParameters[i].Name,
                    arguments[i],
                    describeConstraint(typeParameters[i])
                )
                return nil
            }
        }
        return switch type {
            case targetStruct is StructSymbol: cast[TypeSymbol](
                if MapClrType is {} structMapClrType {
                    StructSymbol.Construct(targetStruct, arguments, structMapClrType)
                } else {
                    StructSymbol.Construct(targetStruct, arguments)
                }
            )
            case targetInterface is InterfaceSymbol: cast[TypeSymbol](
                if MapClrType is {} interfaceMapClrType {
                    InterfaceSymbol.Construct(targetInterface, arguments, interfaceMapClrType)
                } else {
                    InterfaceSymbol.Construct(targetInterface, arguments)
                }
            )
            default: type
        }
    }

    /// Constructs a (cref:BoundCallExpression) for a direct function
    /// call, applying ADR-0047 §6 / issue #176 `[Conditional]` call-site
    /// elision. When elision applies, the resulting call carries an empty
    /// argument list (C# semantics: arguments to a conditional method are
    /// not evaluated when the symbol is undefined) and the
    /// (cref:BoundCallExpression.IsConditionalElided) flag is set so
    /// the emitter and interpreter skip both argument evaluation and the
    /// method invocation. The validation that the function returns
    /// `void` was performed at declaration time (GS0212), so callers
    /// can rely on the elided call being a no-op of type `void`.
    /// Argument binding still ran above so wrong-type diagnostics on the
    /// elided arguments are reported normally.
    private func CreatePossiblyElidedCall(
        syntax CallExpressionSyntax,
        function FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        returnType TypeSymbol?,
        methodTypeArguments ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol])
    ) BoundExpression {
        if KnownAttributes.IsConditionallyElided(function.Attributes, Scope.PreprocessorSymbols) {
            return BoundCallExpression(
                nil,
                function,
                ImmutableArray[BoundExpression].Empty,
                returnType,
                isConditionalElided: true
            ){MethodTypeArguments = methodTypeArguments}
        }
        return BoundCallExpression(syntax, function, arguments, returnType){MethodTypeArguments = methodTypeArguments}
    }

    /// ADR-0156 Phase 2: binds an unqualified call whose name matches a
    /// function-typed global (a `System.Func`/`System.Action`-shaped
    /// static field) declared by a prior interactive submission. The field is
    /// loaded from the submission's `<Program>` container and the
    /// invocation dispatches through the ordinary indirect-call path.
    /// @param syntax The call syntax.
    /// @param submissionImports The active submission import set.
    /// @param result The bound invocation, when the name matched an invocable global.
    /// @returns `true` when the call was bound (or errored) against a submission global.
    private func TryBindSubmissionDelegateGlobalCall(
        syntax CallExpressionSyntax,
        submissionImports SubmissionImports,
        out result BoundExpression?
    ) bool {
        result = nil
        let name = syntax.Identifier.ValueText
        if !submissionImports.TryFindGlobalVariable(Scope.References!!, name, out var programType, out _) {
            return false
        }
        if programType == nil {
            return false
        }
        let field FieldInfo? = programType.GetField(name, BindingFlags.Public | BindingFlags.Static)
        if field == nil || !TryMapClrDelegateToFunctionType(field.FieldType, out var functionType) {
            return false
        }
        // Static field access has no instance receiver; this constructor's
        // non-null annotation predates its use for static fields.
        let calleeLoad = BoundClrPropertyAccessExpression(
            syntax,
            receiver: nil,
            field,
            Invariant.Required(functionType, "a mapped CLR delegate has a function type", expression: "functionType")
        )
        // The callback uses null to mean that no null-safe invocation token was present.
        result = BindIndirectCallExpression(
            syntax,
            calleeLoad,
            name,
            syntax.Identifier.Location,
            nullSafeInvocation: nil
        )
        return true
    }

    shared {
        /// Issue #3760: whether at least one of [`typeParameters`](paramref)
        /// is still without a bound after the positional inference pass.
        private func HasUnboundTypeParameter(
            typeParameters ImmutableArray[TypeParameterSymbol],
            substitution Dictionary[TypeParameterSymbol, TypeSymbol]
        ) bool {
            for typeParameter in typeParameters {
                if !substitution.ContainsKey(typeParameter) {
                    return true
                }
            }
            return false
        }

        /// Issue #3760: resolves a user method group against a fully closed input
        /// list, returning the single applicable candidate's return type (or
        /// `null` when none or several apply).
        private func ResolveUserMethodGroupReturn(
            group BoundMethodGroupExpression,
            closedInputs[]TypeSymbol
        ) TypeSymbol? {
            if group.Candidates.IsDefaultOrEmpty {
                return nil
            }
            var selectedReturn TypeSymbol? = nil
            for candidate in group.Candidates {
                let candidateOwner = if group.StaticOwnerType != nil &&
                    candidate.StaticOwnerType is StructSymbol declaredOwner {
                    TypeMemberModel.ResolveStaticMemberOwner(group.StaticOwnerType, declaredOwner)
                } else {
                    default(StructSymbol?)
                }
                if !ExpressionBinder.TryCloseMethodGroupCandidate(
                    candidate,
                    group.Receiver,
                    candidateOwner,
                    closedInputs,
                    out var closedParameters,
                    out var closedReturn,
                    out _
                ) {
                    continue
                }
                // The candidate must ACCEPT what the delegate provides — the same
                // contravariant admissibility the CLR sibling applies (#3501 A5).
                var applicable = true
                for var i = 0; i < closedInputs.Length; i++ {
                    if closedParameters[i] != closedInputs[i] && !Conversion.Classify(
                        closedInputs[i],
                        closedParameters[i]
                    )
                        .IsImplicit {
                        applicable = false
                        break
                    }
                }
                if !applicable || closedReturn == TypeSymbol.Void || closedReturn == TypeSymbol.Error {
                    continue
                }
                if selectedReturn != nil && selectedReturn != closedReturn {
                    // Two applicable candidates disagree on the return type: the
                    // group is ambiguous at this slot, so it must not bind.
                    return nil
                }
                selectedReturn = closedReturn
            }
            return selectedReturn
        }

        private func HasSingleArgumentConstructorShape(classType StructSymbol) bool {
            if !classType.EffectiveExplicitConstructors.IsDefaultOrEmpty {
                for constructor in classType.EffectiveExplicitConstructors {
                    if ParametersAcceptSingleArgument(constructor.Parameters) {
                        return true
                    }
                }
                return false
            }
            return ParametersAcceptSingleArgument(classType.PrimaryConstructorParameters)
        }

        private func ParametersAcceptSingleArgument(parameters ImmutableArray[ParameterSymbol]) bool {
            if parameters.IsDefaultOrEmpty {
                return false
            }
            for var i = 1; i < parameters.Length; i++ {
                if !parameters[i].HasExplicitDefaultValue && !parameters[i].IsVariadic {
                    return false
                }
            }
            return true
        }

        /// Issue #951: determines whether the supplied expression is an arrow
        /// lambda with at least one parameter whose type clause is omitted, so its
        /// parameter type(s) must be inferred from a target delegate.
        /// @param inner The (already name-unwrapped) argument expression.
        /// @returns `true` for an arrow lambda carrying an
        /// untyped parameter slot.
        private func IsUntypedArrowLambda(inner ExpressionSyntax) bool {
            var inner = inner
            inner = UnwrapArgumentValueWrappers(inner)
            if inner is not LambdaExpressionSyntax lambda {
                return false
            }
            return ContainsTargetDependentLambda(lambda)
        }

        internal func ContainsTargetDependentLambda(syntax ExpressionSyntax) bool {
            var syntax = syntax
            syntax = UnwrapArgumentValueWrappers(syntax)
            if syntax is LambdaExpressionSyntax lambda {
                for var i = 0; i < lambda.Parameters.Count; i++ {
                    if lambda.Parameters[i].Type == nil {
                        return true
                    }
                }
                return ContainsTargetDependentLambda(lambda.Body)
            }
            return switch syntax {
                case block is BlockExpressionSyntax: (
                    block.Expression != nil && ContainsTargetDependentLambda(block.Expression)
                ) ||
                    ContainsTargetDependentLambdaInReturns(block)
                case conditional is ConditionalExpressionSyntax: ContainsTargetDependentLambda(conditional.WhenTrue) ||
                    ContainsTargetDependentLambda(conditional.WhenFalse)
                case ifExpression is IfExpressionSyntax: ContainsTargetDependentLambda(ifExpression.ThenBlock) ||
                    (ifExpression.ElseExpression != nil && ContainsTargetDependentLambda(ifExpression.ElseExpression))
                case ifLetExpression is IfLetExpressionSyntax: ContainsTargetDependentLambda(
                    ifLetExpression.ThenBlock
                ) ||
                    (
                    ifLetExpression.ElseExpression != nil &&
                        ContainsTargetDependentLambda(ifLetExpression.ElseExpression)
                )
                case switchExpression is SwitchExpressionSyntax: switchExpression.Arms.Any(
                    (arm SwitchExpressionArmSyntax) -> ContainsTargetDependentLambda(arm.Result)
                )
                case binary is BinaryExpressionSyntax when binary
                    .OperatorToken
                    .Kind == SyntaxKind.QuestionQuestionToken: ContainsTargetDependentLambda(binary.Left) ||
                    ContainsTargetDependentLambda(binary.Right)
                default: false
            }
        }

        private func ContainsTargetDependentLambdaInReturns(block BlockExpressionSyntax) bool {
            for returnStatement in EnumerateExplicitReturns(block) {
                if ContainsTargetDependentLambda(
                    Invariant.Required(
                        returnStatement.Expression,
                        "explicit value-return enumeration excludes bare returns",
                        expression: "returnStatement.Expression"
                    )
                ) {
                    return true
                }
            }
            return false
        }

        private func EnumerateExplicitReturns(block BlockExpressionSyntax) sequence[ReturnStatementSyntax] {
            let stack = Stack[SyntaxNode](block.Statements.Cast[SyntaxNode]())
            while stack.Count > 0 {
                let node = stack.Pop()
                if (node is LambdaExpressionSyntax or FunctionLiteralExpressionSyntax or FunctionDeclarationSyntax) {
                    continue
                }
                if node is ReturnStatementSyntax{Expression: {} expression} {
                    yield cast[ReturnStatementSyntax](node)
                    continue
                }
                for child in node.GetChildren() {
                    stack.Push(child)
                }
            }
        }

        // Maps a System.Func`N / System.Action`N CLR delegate shape back to the
        // equivalent G# function type so the indirect-call binder (and the
        // emitter's Invoke dispatch) can consume it. Other delegate shapes (named
        // G# delegates, custom CLR delegates) are not mapped here.
        private func TryMapClrDelegateToFunctionType(clrType Type?, out functionType FunctionTypeSymbol?) bool {
            functionType = nil
            if clrType == nil || !ClrTypeUtilities.IsDelegateType(clrType) {
                return false
            }
            let fullName = if clrType.IsGenericType {
                clrType.GetGenericTypeDefinition().FullName
            } else {
                clrType.FullName
            }
            let isAction = string.Equals(fullName, "System.Action", StringComparison.Ordinal) ||
                (fullName?.StartsWith("System.Action`", StringComparison.Ordinal) ?? false)
            let isFunc = fullName?.StartsWith("System.Func`", StringComparison.Ordinal) ?? false
            if !isAction && !isFunc {
                return false
            }
            let args = if clrType.IsGenericType {
                clrType.GetGenericArguments()
            } else {
                Type.EmptyTypes
            }
            let parameterCount = if isFunc {
                args.Length - 1
            } else {
                args.Length
            }
            let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](parameterCount)
            for var i = 0; i < parameterCount; i++ {
                let mapped TypeSymbol? = TypeSymbol.FromClrTypeWithoutNullability(
                    args[i],
                    NullabilityFreeReason.TypeStructure
                )
                if mapped == nil || mapped == TypeSymbol.Error {
                    return false
                }
                parameterTypes.Add(mapped)
            }
            let returnType TypeSymbol? = if isFunc {
                TypeSymbol.FromClrTypeWithoutNullability(args[^1], NullabilityFreeReason.TypeStructure)
            } else {
                TypeSymbol.Void
            }
            if returnType == nil || returnType == TypeSymbol.Error {
                return false
            }
            functionType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), returnType)
            return true
        }
    }
}
