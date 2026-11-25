// <copyright file="SemanticModel.ExpectedType.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Threading

/// The expected-type query of (cref:SemanticModel) (#6079, #6223, ADR-0225 D6.7).
partial class SemanticModel {
    /// Returns the type that the context expects at [`position`](paramref): the parameter of an argument
    /// slot, the declared type of a variable initializer, the return type of a `return` statement, or
    /// the type of the variable that an assignment writes.
    /// @remarks The innermost of these contexts answers. An argument slot answers when every matching
    /// candidate of the call has the same parameter type at the slot, for both source and imported
    /// functions, methods, extensions and constructors. The candidates are the call's recorded candidate
    /// group when the compilation records it ((cref:Compilation.Compilation.RecordMemberGroups)), and the
    /// called function or constructor otherwise. A named argument resolves by parameter name. A generic
    /// callee answers when explicit type arguments or arguments before the slot uniquely fix the type
    /// parameters that the slot's parameter type uses. An unfixed or conflicting generic parameter, an
    /// unknown or duplicate argument name, a variadic slot and a `return` in a lambda answer nothing.
    /// @param position A character offset into this model's tree.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The expected type, or `null` when the context expects none, the candidates disagree,
    /// or the type is an error or `void`.
    func GetExpectedType(position int32, cancellationToken CancellationToken = default(CancellationToken)) TypeSymbol? {
        cancellationToken.ThrowIfCancellationRequested()
        let path = List[SyntaxNode]()
        var node SyntaxNode = syntaxTree.Root
        while true {
            path.Add(node)
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                let span = child.Span
                if span.Start <= position && position <= span.End && !(child is SyntaxToken) {
                    next = child
                    break
                }
            }
            if next == nil {
                break
            }
            node = next
        }
        for var i = path.Count - 1; i >= 0; i-- {
            let current = path[i]
            if current is ReturnStatementSyntax returnStatement && position >= returnStatement.ReturnKeyword.Span.End {
                return Usable(ReturnType(path, i, position, cancellationToken))
            }
            // An initializer without a declared type expects nothing; the outer context does not reach it.
            if current is VariableDeclarationSyntax{TypeClause: nil, EqualsToken: {} untypedEquals} &&
                position >= untypedEquals.Span.End {
                return nil
            }
            if current is VariableDeclarationSyntax{TypeClause: not nil, EqualsToken: {} equals} declaration &&
                position >= equals.Span.End {
                return if GetDeclaredSymbol(declaration, cancellationToken) is VariableSymbol variable {
                    Usable(variable.Type)
                } else {
                    default(TypeSymbol?)
                }
            }
            if current is AssignmentExpressionSyntax assignment && position >= assignment.EqualsToken.Span.End {
                return if GetSymbolInfo(
                    assignment.IdentifierToken,
                    cancellationToken
                ).Symbol is VariableSymbol variable {
                    Usable(variable.Type)
                } else {
                    default(TypeSymbol?)
                }
            }
            if current is CallExpressionSyntax call &&
                position >= call.OpenParenthesisToken.Span.End &&
                (call.CloseParenthesisToken.IsMissing || position <= call.CloseParenthesisToken.Span.Start) {
                return Usable(ArgumentType(call, position, cancellationToken))
            }
            // A block expression gives its target type to its trailing expression only (the binder's
            // BindBlockExpressionParts).
            if current is BlockExpressionSyntax block &&
                !(block.Expression is {} trailing && Contains(trailing.Span, position)) {
                return nil
            }
            // The body of a function literal or lambda starts another context; its header does not.
            if current is FunctionLiteralExpressionSyntax literal && Contains(literal.Body.Span, position) {
                return nil
            }
            if current is LambdaExpressionSyntax lambda && Contains(lambda.Body.Span, position) {
                return nil
            }
        }
        return nil
    }

    // The return type of the function that a `return` at path[index] leaves: the declared return type of
    // a function literal, or of the enclosing function. A lambda, a literal without a declared return
    // type, and an `async` or suspending function give none, because the type that a `return` expects
    // differs from the declared one or is inferred.
    private func ReturnType(
        path List[SyntaxNode],
        index int32,
        position int32,
        cancellationToken CancellationToken
    ) TypeSymbol? {
        for var i = index - 1; i >= 0; i-- {
            // The nearest declared function or method, a rich object's method included, owns the return.
            if path[i] is FunctionDeclarationSyntax declaration {
                return if GetDeclaredSymbol(declaration, cancellationToken) is FunctionSymbol declared &&
                    !declared.IsAsyncOrSuspending {
                    declared.Type
                } else {
                    default(TypeSymbol?)
                }
            }
            if path[i] is LambdaExpressionSyntax {
                return nil
            }
            if path[i] is FunctionLiteralExpressionSyntax literal {
                if literal.ReturnTypeClause == nil || literal.IsAsync {
                    return nil
                }
                return if GetDeclaredSymbol(literal, cancellationToken) is FunctionSymbol literalFunction &&
                    !literalFunction.IsAsyncOrSuspending {
                    literalFunction.Type
                } else {
                    default(TypeSymbol?)
                }
            }
        }
        return if GetEnclosingSymbol(position, cancellationToken) is FunctionSymbol function &&
            !function.IsAsyncOrSuspending {
            function.Type
        } else {
            default(TypeSymbol?)
        }
    }

    private func Contains(span TextSpan, position int32) bool -> span.Start <= position && position <= span.End

    private class ExpectedCallCandidate {
        internal init(
            sourceFunction FunctionSymbol? = nil,
            sourcePrimaryStruct StructSymbol? = nil,
            importedMethod MethodBase? = nil,
            receiverType TypeSymbol? = nil,
            isExtension bool = false
        ) {
            SourceFunction = sourceFunction
            SourcePrimaryStruct = sourcePrimaryStruct
            ImportedMethod = importedMethod
            ReceiverType = receiverType
            IsExtension = isExtension
        }

        internal prop SourceFunction FunctionSymbol? {
            get;
        }

        internal prop SourcePrimaryStruct StructSymbol? {
            get;
        }

        internal prop ImportedMethod MethodBase? {
            get;
        }

        internal prop ReceiverType TypeSymbol? {
            get;
        }

        internal prop IsExtension bool {
            get;
        }
    }

    // The parameter type that every matching candidate of [`call`](paramref) has at the slot of
    // [`position`](paramref).
    private func ArgumentType(
        call CallExpressionSyntax,
        position int32,
        cancellationToken CancellationToken
    ) TypeSymbol? {
        var slot = 0
        for item in call.Arguments.GetWithSeparators() {
            if item is SyntaxToken{Kind: SyntaxKind.CommaToken, IsMissing: false} separator &&
                separator.Span.End <= position {
                slot++
            }
        }
        let slotArg ExpressionSyntax? = if slot < call.Arguments.Count {
            call.Arguments[slot]
        } else {
            default(ExpressionSyntax?)
        }
        var targetName string? = nil
        if slotArg is NamedArgumentExpressionSyntax namedSlot {
            if namedSlot.EqualsToken.IsMissing ||
                position < namedSlot.EqualsToken.Span.End ||
                namedSlot.NameToken.IsMissing ||
                string.IsNullOrEmpty(namedSlot.NameToken.ValueText) {
                return nil
            }
            targetName = namedSlot.NameToken.ValueText
        }
        // Reject duplicate argument names at or before the slot, or colliding with the target name.
        let seenNames = HashSet[string](StringComparer.Ordinal)
        for var j = 0; j < call.Arguments.Count; j++ {
            if call.Arguments[j] is NamedArgumentExpressionSyntax named &&
                !named.NameToken.IsMissing &&
                !string.IsNullOrEmpty(named.NameToken.ValueText) {
                if !seenNames.Add(named.NameToken.ValueText) &&
                    (j <= slot || string.Equals(named.NameToken.ValueText, targetName, StringComparison.Ordinal)) {
                    return nil
                }
            }
        }
        let isMemberCall = call.Parent is AccessorExpressionSyntax accessor && object.ReferenceEquals(
            accessor.RightPart,
            call
        )
        let memberReceiverType TypeSymbol? = if isMemberCall &&
            call.Parent is AccessorExpressionSyntax parentAccessor &&
            !(GetSymbolInfo(parentAccessor.LeftPart, cancellationToken).Symbol is TypeSymbol) {
            GetReceiverTypeInfo(parentAccessor.LeftPart, cancellationToken).Type ?? GetTypeInfo(
                parentAccessor.LeftPart,
                cancellationToken
            ).Type
        } else {
            default(TypeSymbol?)
        }
        let candidates = CollectExpectedCallCandidates(call, isMemberCall, memberReceiverType, cancellationToken)
        if candidates.Count == 0 {
            return nil
        }
        let explicitTypeArguments = if call.TypeArgumentList != nil {
            ResolveExplicitCallTypeArguments(call, position, cancellationToken)
        } else {
            default(ImmutableArray[TypeSymbol?])
        }
        let minArgumentCount = if targetName != nil {
            0
        } else if slot > 0 {
            slot + 1
        } else if slotArg != nil && !IsMissingArgumentExpression(slotArg) {
            1
        } else {
            0
        }
        var matchedAny = false
        var expected TypeSymbol? = nil
        for candidate in candidates {
            if !TryResolveCandidateExpectedType(
                candidate,
                call,
                slot,
                targetName,
                minArgumentCount,
                explicitTypeArguments,
                cancellationToken,
                out var candidateType
            ) {
                continue
            }
            matchedAny = true
            if candidateType == nil {
                return nil
            }
            if expected == nil {
                expected = candidateType
            } else if !ExpectedTypesMatch(expected, candidateType) {
                return nil
            }
        }
        return if matchedAny {
            expected
        } else {
            default(TypeSymbol?)
        }
    }

    private func IsMissingArgumentExpression(expression ExpressionSyntax) bool ->
    expression is NameExpressionSyntax{IdentifierToken: {IsMissing: true}}

    private func CollectExpectedCallCandidates(
        call CallExpressionSyntax,
        isMemberCall bool,
        memberReceiverType TypeSymbol?,
        cancellationToken CancellationToken
    ) List[ExpectedCallCandidate] {
        let result = List[ExpectedCallCandidate]()
        let memberGroup = GetMemberGroup(call, cancellationToken)
        let failed = FindFailedCallRecord(call, cancellationToken)
        if !memberGroup.IsDefaultOrEmpty {
            for member in memberGroup {
                switch member {
                    case function is FunctionSymbol {
                        let isExtension = function.IsExtension && isMemberCall && memberReceiverType != nil
                        result.Add(
                            ExpectedCallCandidate(
                                sourceFunction: function,
                                receiverType: if isExtension {
                                    memberReceiverType
                                } else {
                                    default(TypeSymbol?)
                                },
                                isExtension: isExtension
                            )
                        )
                    }
                    case imported is ImportedFunctionSymbol {
                        let isExtension = isMemberCall &&
                            memberReceiverType != nil &&
                            imported.Method.IsStatic &&
                            MemberLookup.HasExtensionAttribute(imported.Method)
                        let receiver = if isExtension {
                            memberReceiverType ?? imported.SignatureReceiver ?? failed?.ReceiverType
                        } else {
                            imported.SignatureReceiver ?? failed?.ReceiverType
                        }
                        result.Add(
                            ExpectedCallCandidate(
                                importedMethod: imported.Method,
                                receiverType: receiver,
                                isExtension: isExtension
                            )
                        )
                    }
                    default {
                        result.Clear()
                        return result
                    }
                }
            }
            return result
        }
        if failed != nil && !failed.ConstructorGroup.IsDefaultOrEmpty {
            AddRecordedConstructorCandidates(failed.ConstructorGroup, failed.ReceiverType, call, result)
            return result
        }
        let bound = GetBoundNode(call, cancellationToken)
        if bound is BoundClrConstructorCallExpression clrCtor {
            if !clrCtor.ConstructorGroup.IsDefaultOrEmpty {
                AddRecordedConstructorCandidates(clrCtor.ConstructorGroup, clrCtor.Type, call, result)
            } else {
                result.Add(ExpectedCallCandidate(importedMethod: clrCtor.Constructor, receiverType: clrCtor.Type))
            }
            return result
        }
        if bound is BoundConstructorCallExpression sourceCtor {
            if !sourceCtor.ConstructorGroup.IsDefaultOrEmpty {
                AddRecordedConstructorCandidates(sourceCtor.ConstructorGroup, sourceCtor.StructType, call, result)
            } else if sourceCtor.SelectedConstructor is {} selectedCtor {
                let openDef = sourceCtor.StructType.Definition ?? sourceCtor.StructType
                let ctorFunction = if call.TypeArgumentList == nil && openDef.IsGenericDefinition {
                    selectedCtor.Function
                } else {
                    cast[FunctionSymbol](SubstituteSourceMember(sourceCtor.StructType, selectedCtor.Function))
                }
                result.Add(ExpectedCallCandidate(sourceFunction: ctorFunction))
            } else {
                let openDef = sourceCtor.StructType.Definition ?? sourceCtor.StructType
                let targetStruct = if call.TypeArgumentList == nil && openDef.IsGenericDefinition {
                    openDef
                } else {
                    sourceCtor.StructType
                }
                result.Add(ExpectedCallCandidate(sourcePrimaryStruct: targetStruct))
            }
            return result
        }
        if GetSymbolInfo(call, cancellationToken).Symbol is {} called {
            switch called {
                case function is FunctionSymbol {
                    let isExtension = function.IsExtension && isMemberCall && memberReceiverType != nil
                    result.Add(
                        ExpectedCallCandidate(
                            sourceFunction: function,
                            receiverType: if isExtension {
                                memberReceiverType
                            } else {
                                default(TypeSymbol?)
                            },
                            isExtension: isExtension
                        )
                    )
                }
                case imported is ImportedFunctionSymbol {
                    let isExtension = isMemberCall &&
                        memberReceiverType != nil &&
                        imported.Method.IsStatic &&
                        MemberLookup.HasExtensionAttribute(imported.Method)
                    let receiver = if isExtension {
                        memberReceiverType ?? imported.SignatureReceiver
                    } else {
                        imported.SignatureReceiver
                    }
                    result.Add(
                        ExpectedCallCandidate(
                            importedMethod: imported.Method,
                            receiverType: receiver,
                            isExtension: isExtension
                        )
                    )
                }
            }
        }
        return result
    }

    private func AddRecordedConstructorCandidates(
        group ImmutableArray[object],
        receiverType TypeSymbol?,
        call CallExpressionSyntax,
        result List[ExpectedCallCandidate]
    ) {
        for item in group {
            switch item {
                case ctor is ConstructorInfo {
                    result.Add(ExpectedCallCandidate(importedMethod: ctor, receiverType: receiverType))
                }
                case function is FunctionSymbol {
                    result.Add(ExpectedCallCandidate(sourceFunction: function))
                }
                case structType is StructSymbol {
                    let openDef = structType.Definition ?? structType
                    let targetStruct = if call.TypeArgumentList == nil && openDef.IsGenericDefinition {
                        openDef
                    } else {
                        structType
                    }
                    result.Add(ExpectedCallCandidate(sourcePrimaryStruct: targetStruct))
                }
            }
        }
    }

    private func FindFailedCallRecord(
        call CallExpressionSyntax,
        cancellationToken CancellationToken
    ) BoundErrorExpression? {
        if index.Get(cancellationToken).FailedCalls.TryGetValue(call, out var indexedFailed) {
            return indexedFailed
        }
        if compilation.FailedCalls.TryGetValue(call, out var recordedFailed) {
            return recordedFailed
        }
        return nil
    }

    private func ResolveExplicitCallTypeArguments(
        call CallExpressionSyntax,
        position int32,
        cancellationToken CancellationToken
    ) ImmutableArray[TypeSymbol?] {
        let typeArgList = call.TypeArgumentList!!
        let builder = ImmutableArray.CreateBuilder[TypeSymbol?](typeArgList.Arguments.Count)
        let function = GetEnclosingSymbol(position, cancellationToken) as FunctionSymbol
        let localTypeParameters = EnclosingLocalFunctionTypeParameters(position)
        let references = compilation.References ?? ReferenceResolver.Default()
        using let nullabilityScope = NullabilityOptions.Enter(compilation.Nullability, compilation.PlatformNilChecks)
        for argClause in typeArgList.Arguments {
            builder.Add(
                Binder.BindSpeculativeTypeClause(
                    compilation.GlobalScope,
                    references,
                    function,
                    argClause,
                    syntaxTree,
                    localTypeParameters
                )
            )
        }
        return builder.MoveToImmutable()
    }

    private func TryResolveCandidateExpectedType(
        candidate ExpectedCallCandidate,
        call CallExpressionSyntax,
        slot int32,
        targetName string?,
        minArgumentCount int32,
        explicitTypeArguments ImmutableArray[TypeSymbol?],
        cancellationToken CancellationToken,
        out expectedType TypeSymbol?
    ) bool {
        expectedType = nil
        if candidate.SourceFunction is {} function {
            let isConstructor = function.Name == ".ctor"
            let constructorOwner = function.ReceiverType as StructSymbol
            let candidateTypeParameters = if isConstructor {
                if constructorOwner != nil && constructorOwner.IsGenericDefinition {
                    constructorOwner.TypeParameters
                } else {
                    ImmutableArray[TypeParameterSymbol].Empty
                }
            } else {
                function.TypeParameters
            }
            let ownerType = if isConstructor && constructorOwner != nil && constructorOwner.IsGenericDefinition {
                constructorOwner.ContainingType
            } else {
                (function.ContainingType as InterfaceSymbol) ?? function.StaticOwnerType ?? function.ReceiverType
            }
            return TryResolveSourceExpectedType(
                function.Parameters,
                candidateTypeParameters,
                ownerType,
                parameterOffset: if candidate.IsExtension {
                    1
                } else {
                    0
                },
                receiverType: candidate.ReceiverType,
                allowExplicitTypeArguments: !isConstructor,
                call,
                slot,
                targetName,
                minArgumentCount,
                explicitTypeArguments,
                cancellationToken,
                out expectedType
            )
        }
        if candidate.SourcePrimaryStruct is {} primaryStruct {
            return TryResolveSourceExpectedType(
                primaryStruct.PrimaryConstructorParameters,
                if primaryStruct.IsGenericDefinition {
                    primaryStruct.TypeParameters
                } else {
                    ImmutableArray[TypeParameterSymbol].Empty
                },
                primaryStruct.ContainingType,
                parameterOffset: 0,
                receiverType: nil,
                allowExplicitTypeArguments: false,
                call,
                slot,
                targetName,
                minArgumentCount,
                explicitTypeArguments,
                cancellationToken,
                out expectedType
            )
        }
        if candidate.ImportedMethod is {} importedMethod {
            return TryResolveImportedExpectedType(
                importedMethod,
                candidate.ReceiverType,
                candidate.IsExtension,
                call,
                slot,
                targetName,
                minArgumentCount,
                explicitTypeArguments,
                cancellationToken,
                out expectedType
            )
        }
        return false
    }

    private func TryResolveSourceExpectedType(
        parameters ImmutableArray[ParameterSymbol],
        typeParameters ImmutableArray[TypeParameterSymbol],
        ownerType TypeSymbol?,
        parameterOffset int32,
        receiverType TypeSymbol?,
        allowExplicitTypeArguments bool,
        call CallExpressionSyntax,
        slot int32,
        targetName string?,
        minArgumentCount int32,
        explicitTypeArguments ImmutableArray[TypeSymbol?],
        cancellationToken CancellationToken,
        out expectedType TypeSymbol?
    ) bool {
        expectedType = nil
        let callableCount = parameters.Length - parameterOffset
        if callableCount < 0 {
            return false
        }
        let isVariadic = callableCount > 0 && parameters[parameters.Length - 1].IsVariadic
        if allowExplicitTypeArguments && !explicitTypeArguments.IsDefault {
            if typeParameters.IsDefaultOrEmpty || explicitTypeArguments.Length != typeParameters.Length {
                return false
            }
        }
        if minArgumentCount > 0 && !isVariadic && callableCount < minArgumentCount {
            return false
        }
        // Map preceding arguments (0 ..< slot) to parameter indices to detect named-argument
        // conflicts and drive generic type-argument inference.
        let filled = [callableCount]bool
        let mappedPriorParams = [slot]int32
        var sawOutOfOrderNamed = false
        for var i = 0; i < slot && i < call.Arguments.Count; i++ {
            var localIdx = -1
            if call.Arguments[i] is NamedArgumentExpressionSyntax prevNamed {
                if prevNamed.NameToken.IsMissing || string.IsNullOrEmpty(prevNamed.NameToken.ValueText) {
                    return false
                }
                let prevName = prevNamed.NameToken.ValueText
                for var p = 0; p < callableCount; p++ {
                    if string.Equals(parameters[parameterOffset + p].Name, prevName, StringComparison.Ordinal) {
                        localIdx = p
                        break
                    }
                }
                if localIdx < 0 || filled[localIdx] {
                    return false
                }
                if localIdx != i {
                    sawOutOfOrderNamed = true
                }
            } else {
                if sawOutOfOrderNamed {
                    return false
                }
                localIdx = if isVariadic && i >= callableCount - 1 {
                    callableCount - 1
                } else {
                    i
                }
                if localIdx < 0 ||
                    localIdx >= callableCount ||
                    (filled[localIdx] && !(isVariadic && localIdx == callableCount - 1)) {
                    return false
                }
            }
            filled[localIdx] = true
            mappedPriorParams[i] = localIdx
        }
        var targetLocalIdx = -1
        if targetName != nil {
            for var p = 0; p < callableCount; p++ {
                if string.Equals(parameters[parameterOffset + p].Name, targetName, StringComparison.Ordinal) {
                    targetLocalIdx = p
                    break
                }
            }
            if targetLocalIdx < 0 || filled[targetLocalIdx] {
                return false
            }
        } else {
            if sawOutOfOrderNamed {
                return false
            }
            targetLocalIdx = slot
            if targetLocalIdx < 0 || targetLocalIdx >= callableCount {
                if isVariadic {
                    expectedType = nil
                    return true
                }
                return false
            }
            if filled[targetLocalIdx] {
                return false
            }
        }
        let targetParam = parameters[parameterOffset + targetLocalIdx]
        if targetParam.IsVariadic {
            expectedType = nil
            return true
        }
        var slotType = targetParam.Type
        if !typeParameters.IsDefaultOrEmpty {
            let substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
            OverloadResolver.SeedFixedOwnerTypeParameters(ownerType, substitution)
            let conflicted = HashSet[TypeParameterSymbol](ReferenceEqualityComparer.Instance)
            let unfixed = HashSet[TypeParameterSymbol](ReferenceEqualityComparer.Instance)
            if allowExplicitTypeArguments && !explicitTypeArguments.IsDefault {
                for var i = 0; i < typeParameters.Length; i++ {
                    if explicitTypeArguments[i] is {} explicitArg {
                        substitution[typeParameters[i]] = explicitArg
                    } else {
                        let _ = unfixed.Add(typeParameters[i])
                    }
                }
            } else {
                if parameterOffset == 1 && receiverType != nil && receiverType != TypeSymbol.Error {
                    Binder.InferTypeArguments(
                        parameters[0].Type,
                        RefCapabilities.GetInferenceType(parameters[0], receiverType),
                        substitution
                    )
                }
                for var i = 0; i < slot && i < call.Arguments.Count; i++ {
                    let paramIdx = parameterOffset + mappedPriorParams[i]
                    let param = parameters[paramIdx]
                    if param.IsVariadic {
                        continue
                    }
                    let argType = ArgumentInferenceType(call.Arguments[i], cancellationToken)
                    if argType == nil {
                        continue
                    }
                    Binder.InferTypeArguments(
                        param.Type,
                        RefCapabilities.GetInferenceType(param, argType),
                        substitution
                    )
                }
                for tp in typeParameters {
                    if !MemberLookup.TryResolveExpectedSourceTypeArgument(substitution, tp, out var resolved) {
                        let _ = conflicted.Add(tp)
                    } else if resolved != nil {
                        substitution[tp] = resolved
                    } else {
                        let _ = unfixed.Add(tp)
                    }
                }
            }
            if conflicted.Count > 0 && ContainsAnyTypeParameter(slotType, conflicted) {
                expectedType = nil
                return true
            }
            if unfixed.Count > 0 && ContainsAnyTypeParameter(slotType, unfixed) {
                expectedType = nil
                return true
            }
            if substitution.Count > 0 {
                slotType = Binder.SubstituteType(slotType, substitution)
            }
        }
        expectedType = slotType
        return true
    }

    private func TryResolveImportedExpectedType(
        method MethodBase,
        receiverType TypeSymbol?,
        isExtension bool,
        call CallExpressionSyntax,
        slot int32,
        targetName string?,
        minArgumentCount int32,
        explicitTypeArguments ImmutableArray[TypeSymbol?],
        cancellationToken CancellationToken,
        out expectedType TypeSymbol?
    ) bool {
        expectedType = nil
        let openMethod = if method is MethodInfo{IsGenericMethod: true, IsGenericMethodDefinition: false} closed {
            cast[MethodBase](closed.GetGenericMethodDefinition())
        } else {
            method
        }
        let isGenericMethod = openMethod is MethodInfo{IsGenericMethodDefinition: true}
        let openMethodInfo = openMethod as MethodInfo
        if isGenericMethod && !explicitTypeArguments.IsDefault {
            if explicitTypeArguments.Length != openMethodInfo!!.GetGenericArguments().Length {
                return false
            }
        } else if !isGenericMethod && !explicitTypeArguments.IsDefault && openMethod is MethodInfo {
            return false
        }
        let parameters = if openMethodInfo != nil {
            ImportedFunctionSymbol.GetLogicalParameters(openMethodInfo)
        } else {
            openMethod.GetParameters()
        }
        let parameterOffset = if isExtension {
            1
        } else {
            0
        }
        let callableCount = parameters.Length - parameterOffset
        if callableCount < 0 {
            return false
        }
        let isParams = callableCount > 0 && ClrOverloadResolution.IsParamsArrayParameter(parameters[^1])
        if minArgumentCount > 0 && !isParams && callableCount < minArgumentCount {
            return false
        }
        let filled = [callableCount]bool
        let mappedPriorParams = [slot]int32
        var sawOutOfOrderNamed = false
        for var i = 0; i < slot && i < call.Arguments.Count; i++ {
            var localIdx = -1
            if call.Arguments[i] is NamedArgumentExpressionSyntax prevNamed {
                if prevNamed.NameToken.IsMissing || string.IsNullOrEmpty(prevNamed.NameToken.ValueText) {
                    return false
                }
                localIdx = FindClrCallableParameterIndex(parameters, parameterOffset, prevNamed.NameToken.ValueText)
                if localIdx < 0 || filled[localIdx] {
                    return false
                }
                if localIdx != i {
                    sawOutOfOrderNamed = true
                }
            } else {
                if sawOutOfOrderNamed {
                    return false
                }
                localIdx = if isParams && i >= callableCount - 1 {
                    callableCount - 1
                } else {
                    i
                }
                if localIdx < 0 ||
                    localIdx >= callableCount ||
                    (filled[localIdx] && !(isParams && localIdx == callableCount - 1)) {
                    return false
                }
            }
            filled[localIdx] = true
            mappedPriorParams[i] = localIdx
        }
        var targetLocalIdx = -1
        if targetName != nil {
            targetLocalIdx = FindClrCallableParameterIndex(parameters, parameterOffset, targetName)
            if targetLocalIdx < 0 || filled[targetLocalIdx] {
                return false
            }
        } else {
            if sawOutOfOrderNamed {
                return false
            }
            targetLocalIdx = slot
            if targetLocalIdx < 0 || targetLocalIdx >= callableCount {
                if isParams {
                    expectedType = nil
                    return true
                }
                return false
            }
            if filled[targetLocalIdx] {
                return false
            }
        }
        let targetParamIndex = parameterOffset + targetLocalIdx
        let targetParam = parameters[targetParamIndex]
        if ClrOverloadResolution.IsParamsArrayParameter(targetParam) {
            expectedType = nil
            return true
        }
        var methodTypeArgs = default(ImmutableArray[TypeSymbol?])
        if isGenericMethod && openMethodInfo != nil {
            let genericArity = openMethodInfo.GetGenericArguments().Length
            if !explicitTypeArguments.IsDefault {
                let explicitBuilder = ImmutableArray.CreateBuilder[TypeSymbol?](genericArity)
                for var i = 0; i < genericArity; i++ {
                    explicitBuilder.Add(
                        if explicitTypeArguments[i] is {} explicitArg {
                            MemberLookup.ApplyExplicitMethodTypeArgument(openMethodInfo, i, explicitArg)
                        } else {
                            default(TypeSymbol?)
                        }
                    )
                }
                methodTypeArgs = explicitBuilder.MoveToImmutable()
            } else {
                let argTypes = [parameters.Length]TypeSymbol?
                if isExtension && receiverType != nil && receiverType != TypeSymbol.Error {
                    argTypes[0] = receiverType
                }
                for var i = 0; i < slot && i < call.Arguments.Count; i++ {
                    let paramIdx = parameterOffset + mappedPriorParams[i]
                    if ClrOverloadResolution.IsParamsArrayParameter(parameters[paramIdx]) {
                        continue
                    }
                    let argType = ArgumentInferenceType(call.Arguments[i], cancellationToken)
                    if argType != nil {
                        argTypes[paramIdx] = argType
                    }
                }
                let inferred = MemberLookup.InferSymbolicMethodTypeArguments(
                    openMethodInfo,
                    ImmutableArray.Create(argTypes)
                )
                let builder = ImmutableArray.CreateBuilder[TypeSymbol?](genericArity)
                for var i = 0; i < genericArity; i++ {
                    let inferredArg = if i < inferred.Length {
                        inferred[i]
                    } else {
                        default(TypeSymbol?)
                    }
                    builder.Add(
                        if inferredArg != nil && MemberLookup.IsSymbolicInferenceConflict(inferredArg) {
                            default(TypeSymbol?)
                        } else {
                            inferredArg
                        }
                    )
                }
                methodTypeArgs = builder.MoveToImmutable()
            }
            if ContainsUnfixedMethodTypeParameter(targetParam.ParameterType, methodTypeArgs) {
                expectedType = nil
                return true
            }
        }
        let declaringOwner = if !isExtension && receiverType != nil {
            receiverType
        } else {
            ImportedTypeSymbol.GetWithoutNullability(
                openMethod.DeclaringType ?? typeof(object),
                NullabilityFreeReason.TypeStructure
            )
        }
        let parameterType = MemberLookup.GetClrMethodParameterTypeSymbol(
            declaringOwner,
            openMethod,
            targetParamIndex,
            methodTypeArgs
        )
        if ContainsOpenClrGenericParameter(parameterType) {
            expectedType = nil
            return true
        }
        expectedType = parameterType
        return true
    }

    private func FindClrCallableParameterIndex(parameters[]ParameterInfo, parameterOffset int32, name string) int32 {
        let allNames = parameters.Select((parameter ParameterInfo) -> parameter.Name ?? string.Empty).ToArray()
        for var i = parameterOffset; i < parameters.Length; i++ {
            if parameters[i].Name is {} parameterName && OverloadResolver.ClrParameterNameMatches(
                parameterName,
                name,
                allNames
            ) {
                return i - parameterOffset
            }
        }
        return -1
    }

    private func ArgumentInferenceType(
        argumentSyntax ExpressionSyntax,
        cancellationToken CancellationToken
    ) TypeSymbol? {
        var expr = argumentSyntax
        if expr is NamedArgumentExpressionSyntax named {
            expr = named.Expression
        }
        while expr is ParenthesizedExpressionSyntax parenthesized {
            expr = parenthesized.Expression
        }
        if ExpressionBinder.IsTargetDependentExpressionSyntax(expr) {
            return nil
        }
        var type TypeSymbol? = nil
        if expr is LambdaExpressionSyntax or
            FunctionLiteralExpressionSyntax{ReturnTypeClause: nil} ||
            ExpressionBinder.IsTargetTypedBranchyArgumentSyntax(expr) {
            type = GetSpeculativeTypeInfo(expr.Span.Start, expr, cancellationToken).Type
        } else {
            var bound = GetBoundNode(expr, cancellationToken)
            if bound == nil &&
                expr is RefArgumentExpressionSyntax{IsInlineDeclaration: false, Expression: {} refTarget} {
                bound = GetBoundNode(refTarget, cancellationToken)
            }
            while bound is BoundConversionExpression conversion &&
                (
                object.ReferenceEquals(conversion.ImplicitConversionOperand, conversion.Expression) ||
                    conversion.Expression is BoundMethodGroupExpression or
                    BoundClrMethodGroupExpression
            ) {
                bound = conversion.Expression
            }
            if bound is BoundClrMethodGroupExpression {
                return nil
            }
            if bound is BoundMethodGroupExpression methodGroup {
                type = if methodGroup.HasTargetDelegateType {
                    GetSpeculativeTypeInfo(expr.Span.Start, expr, cancellationToken).Type
                } else {
                    methodGroup.FunctionType
                }
            } else if bound is BoundExpression expression {
                type = expression.Type
            }
        }
        if type == nil ||
            type == TypeSymbol.Error ||
            type == TypeSymbol.Void ||
            type == TypeSymbol.Null ||
            type == TypeSymbol.Never {
            return nil
        }
        return type
    }

    private func ContainsAnyTypeParameter(type TypeSymbol, set HashSet[TypeParameterSymbol]) bool ->
    TypeSymbol.AnyTypeParameter(type, (tp TypeParameterSymbol) -> set.Contains(tp))

    private func ContainsUnfixedMethodTypeParameter(clrType Type?, methodTypeArgs ImmutableArray[TypeSymbol?]) bool {
        if clrType == nil {
            return false
        }
        if clrType.IsGenericParameter {
            if clrType.DeclaringMethod != nil {
                let pos = clrType.GenericParameterPosition
                return methodTypeArgs.IsDefaultOrEmpty ||
                    pos < 0 ||
                    pos >= methodTypeArgs.Length ||
                    methodTypeArgs[pos] == nil ||
                    MemberLookup.IsSymbolicInferenceConflict(methodTypeArgs[pos])
            }
            return false
        }
        if clrType.HasElementType {
            return ContainsUnfixedMethodTypeParameter(clrType.GetElementType(), methodTypeArgs)
        }
        if clrType.IsGenericType {
            for arg in clrType.GetGenericArguments() {
                if ContainsUnfixedMethodTypeParameter(arg, methodTypeArgs) {
                    return true
                }
            }
        }
        return false
    }

    private func ContainsOpenClrGenericParameter(type TypeSymbol) bool {
        if type is TypeParameterSymbol {
            return false
        }
        if type is ImportedTypeSymbol imported && imported.ClrType is {} clr && clr.IsGenericParameter {
            return true
        }
        for wrapped in TypeSymbol.GetWrappedTypes(type) {
            if ContainsOpenClrGenericParameter(wrapped) {
                return true
            }
        }
        return false
    }

    private func ExpectedTypesMatch(left TypeSymbol, right TypeSymbol) bool {
        if object.ReferenceEquals(left, right) {
            return true
        }
        if (left is ByRefTypeSymbol) != (right is ByRefTypeSymbol) {
            return false
        }
        if left is ByRefTypeSymbol leftByRef && right is ByRefTypeSymbol rightByRef {
            return ExpectedTypesMatch(leftByRef.PointeeType, rightByRef.PointeeType)
        }
        if left.ReferenceNullability != right.ReferenceNullability {
            return false
        }
        let leftBare = left.StripToBareShape()
        let rightBare = right.StripToBareShape()
        if leftBare.GetType() != rightBare.GetType() || !DeclarationBinder.TypeSignaturesEquivalent(
            leftBare,
            rightBare
        ) {
            return false
        }
        let leftElements = left.GetElementPositions()
        let rightElements = right.GetElementPositions()
        if leftElements.Length != rightElements.Length {
            return false
        }
        for var i = 0; i < leftElements.Length; i++ {
            if !ExpectedTypesMatch(leftElements[i], rightElements[i]) {
                return false
            }
        }
        return true
    }

    private func Usable(type TypeSymbol?) TypeSymbol? -> if type == nil ||
        type == TypeSymbol.Error ||
        type == TypeSymbol.Void {
        nil
    } else {
        type
    }
}
