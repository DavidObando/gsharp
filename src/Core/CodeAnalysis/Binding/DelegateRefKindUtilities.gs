// <copyright file="DelegateRefKindUtilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

internal shared class DelegateRefKindUtilities {
    internal func HasNonNoneSourceParameterRefKinds(expression BoundExpression) bool ->
    TryGetSourceParameterRefKinds(expression, out var refKinds) && refKinds.Any((kind RefKind) -> kind != RefKind.None)

    internal func UnwrapSynthesizedRefDelegateBranch(
        branch BoundExpression,
        conversions ConversionClassifier
    ) BoundExpression {
        if branch is BoundConversionExpression{
            Type: DelegateTypeSymbol{Declaration: nil},
            Expression: BoundFunctionLiteralExpression innerLiteral
        } {
            return innerLiteral
        }
        if branch is BoundBlockExpression blockExpr {
            if blockExpr.Expression is BoundVariableExpression{Variable: LocalVariableSymbol resultLocal} &&
                resultLocal
                .Name
                .StartsWith("<blockResult", StringComparison.Ordinal) && conversions.RewriteCleanupBlockExpression(
                blockExpr,
                resultLocal,
                (initExpr BoundExpression) -> UnwrapSynthesizedRefDelegateBranch(initExpr, conversions)
            ) is {} unwrappedCleanupBlock {
                return unwrappedCleanupBlock
            }
            let unwrappedTail = UnwrapSynthesizedRefDelegateBranch(blockExpr.Expression, conversions)
            if !object.ReferenceEquals(unwrappedTail, blockExpr.Expression) {
                return BoundBlockExpression(blockExpr.Syntax, blockExpr.Statements, unwrappedTail)
            }
        }
        if branch is BoundConditionalExpression condExpr && condExpr.Type.StripToBareShape() is DelegateTypeSymbol{
            Declaration: nil
        } synthCondDel {
            let unwrappedTrue = UnwrapSynthesizedRefDelegateBranch(condExpr.WhenTrue, conversions)
            let unwrappedFalse = UnwrapSynthesizedRefDelegateBranch(condExpr.WhenFalse, conversions)
            if (
                !object.ReferenceEquals(unwrappedTrue, condExpr.WhenTrue) || !object.ReferenceEquals(
                    unwrappedFalse,
                    condExpr.WhenFalse
                )
            ) &&
                IsUnwrappedRefDelegateBranch(unwrappedTrue) &&
                IsUnwrappedRefDelegateBranch(unwrappedFalse) {
                let fnType = ReplaceBareShape(condExpr.Type, synthCondDel.EquivalentFunctionType)
                return BoundConditionalExpression(
                    condExpr.Syntax,
                    condExpr.Condition,
                    unwrappedTrue,
                    unwrappedFalse,
                    fnType
                )
            }
        }
        if branch is BoundSwitchExpression switchExpr && switchExpr.Type.StripToBareShape() is DelegateTypeSymbol{
            Declaration: nil
        } synthSwitchDel {
            var anyChanged = false
            var allUnwrapped = switchExpr.Arms.Length > 0
            let unwrappedArms = ImmutableArray.CreateBuilder[BoundSwitchExpressionArm](switchExpr.Arms.Length)
            for arm in switchExpr.Arms {
                let unwrappedArm = UnwrapSynthesizedRefDelegateBranch(arm.Result, conversions)
                anyChanged |= !object.ReferenceEquals(unwrappedArm, arm.Result)
                allUnwrapped &= IsUnwrappedRefDelegateBranch(unwrappedArm)
                unwrappedArms.Add(BoundSwitchExpressionArm(arm.Syntax, arm.Pattern, arm.Guard, unwrappedArm))
            }
            if anyChanged && allUnwrapped {
                let fnType = ReplaceBareShape(switchExpr.Type, synthSwitchDel.EquivalentFunctionType)
                return BoundSwitchExpression(
                    switchExpr.Syntax,
                    switchExpr.Discriminant,
                    unwrappedArms.MoveToImmutable(),
                    fnType
                )
            }
        }
        return branch
    }

    private func IsUnwrappedRefDelegateBranch(branch BoundExpression) bool -> branch.Type == TypeSymbol.Never ||
        branch.Type == TypeSymbol.Null ||
        branch
        .Type
        .StripToBareShape() is FunctionTypeSymbol

    private func ReplaceBareShape(original TypeSymbol, bare TypeSymbol) TypeSymbol -> switch original {
        case NullableTypeSymbol: NullableTypeSymbol.Get(bare)
        case PlatformTypeSymbol: PlatformTypeSymbol.Get(bare)
        default: bare
    }

    internal func MaterializeSynthesizedRefDelegateResultType(
        resultType TypeSymbol?,
        branches IEnumerable[BoundExpression],
        boundScope BoundScope,
        allowFirstArmFallback bool = false
    ) TypeSymbol? {
        if resultType == nil {
            return nil
        }
        let materialized = TypeSymbol.MaterializeNeverFunctionReturns(resultType)
        let isNullable = materialized is NullableTypeSymbol
        let isPlatform = materialized is PlatformTypeSymbol
        if materialized.StripToBareShape() is not FunctionTypeSymbol resultFnType {
            return resultType
        }
        let literals = List[BoundFunctionLiteralExpression]()
        for branch in branches {
            CollectBranchFunctionLiterals(branch, literals)
        }
        var hasRefKindParameter = false
        for lit in literals {
            if lit.Function.Parameters.Any((p ParameterSymbol) -> p.RefKind != RefKind.None) {
                hasRefKindParameter = true
                break
            }
        }
        if !hasRefKindParameter {
            return resultType
        }
        let arity = resultFnType.Arity
        var firstMatching BoundFunctionLiteralExpression? = nil
        var allCompatible = true
        for lit in literals {
            if lit.Function.Parameters.Length != arity {
                allCompatible = false
                break
            }
            if firstMatching == nil {
                firstMatching = lit
            }
            for var i = 0; i < arity; i++ {
                let refKind = firstMatching.Function.Parameters[i].RefKind
                let litParam = lit.Function.Parameters[i]
                if litParam.RefKind != refKind {
                    allCompatible = false
                    break
                }
                if refKind != RefKind.None && !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                    litParam.Type,
                    resultFnType.ParameterTypes[i]
                ) {
                    allCompatible = false
                    break
                }
            }
            if !allCompatible {
                break
            }
        }
        if !allCompatible || firstMatching == nil {
            if !allowFirstArmFallback {
                return nil
            }
            for lit in literals {
                if boundScope.TryGetSynthesizedRefDelegateForLiteral(
                    lit.Function,
                    resultFnType.ReturnType
                ) is {} fallbackDelegate {
                    return if isNullable {
                        NullableTypeSymbol.Get(fallbackDelegate)
                    } else if isPlatform {
                        PlatformTypeSymbol.Get(fallbackDelegate)
                    } else {
                        fallbackDelegate
                    }
                }
            }
            return nil
        }
        let synthesizedParams = ImmutableArray.CreateBuilder[ParameterSymbol](arity)
        for var i = 0; i < arity; i++ {
            let firstParam = firstMatching.Function.Parameters[i]
            let paramType = if firstParam.RefKind != RefKind.None {
                firstParam.Type
            } else {
                resultFnType.ParameterTypes[i]
            }
            var hasDefault = firstParam.HasExplicitDefaultValue &&
                TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(firstParam.Type, paramType)
            if hasDefault {
                for lit in literals {
                    let litParam = lit.Function.Parameters[i]
                    if !litParam.HasExplicitDefaultValue || !FunctionTypeSymbol.DefaultValuesEqual(
                        litParam.ExplicitDefaultValue,
                        firstParam.ExplicitDefaultValue
                    ) ||
                        !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(litParam.Type, paramType) {
                        hasDefault = false
                        break
                    }
                }
            }
            let synthesizedParam = ParameterSymbol(firstParam, paramType, firstParam.DeclaringSyntax)
            if hasDefault {
                synthesizedParam.SetExplicitDefaultValue(firstParam.ExplicitDefaultValue)
            }
            synthesizedParams.Add(synthesizedParam)
        }
        let materializedReturn = if resultFnType.ReturnType == TypeSymbol.Never {
            TypeSymbol.Void
        } else {
            TypeSymbol.MaterializeNeverFunctionReturns(resultFnType.ReturnType)
        }
        let refDelegateType = boundScope.GetSynthesizedRefDelegateCache().GetOrCreate(
            synthesizedParams.MoveToImmutable(),
            materializedReturn,
            boundScope.GetCurrentDeclaringPackageName()
        )
        return if isNullable {
            NullableTypeSymbol.Get(refDelegateType)
        } else if isPlatform {
            PlatformTypeSymbol.Get(refDelegateType)
        } else {
            refDelegateType
        }
    }

    private func CollectBranchFunctionLiterals(branch BoundExpression?, sink List[BoundFunctionLiteralExpression]) {
        var current = branch
        while current != nil {
            if current is BoundFunctionLiteralExpression refLiteral {
                sink.Add(refLiteral)
                return
            }
            if current is BoundConversionExpression conv {
                current = conv.Expression
                continue
            }
            if current is BoundBlockExpression blockExpr {
                if blockExpr.Expression is BoundVariableExpression{Variable: LocalVariableSymbol resultLocal} &&
                    resultLocal
                    .Name
                    .StartsWith("<blockResult", StringComparison.Ordinal) &&
                    TryFindCleanupBlockResultInitializer(blockExpr.Statements, resultLocal) is {} initExpr {
                    current = initExpr
                    continue
                }
                current = blockExpr.Expression
                continue
            }
            if current is BoundConditionalExpression condExpr {
                CollectBranchFunctionLiterals(condExpr.WhenTrue, sink)
                CollectBranchFunctionLiterals(condExpr.WhenFalse, sink)
                return
            }
            if current is BoundSwitchExpression switchExpr {
                for arm in switchExpr.Arms {
                    CollectBranchFunctionLiterals(arm.Result, sink)
                }
                return
            }
            return
        }
    }

    internal func TryFindCleanupBlockResultInitializer(
        statements ImmutableArray[BoundStatement],
        resultLocal LocalVariableSymbol
    ) BoundExpression? {
        for stmt in statements {
            if stmt is BoundVariableDeclaration decl && object.ReferenceEquals(decl.Variable, resultLocal) {
                return decl.Initializer
            }
            if stmt is BoundBlockStatement innerBlock &&
                TryFindCleanupBlockResultInitializer(innerBlock.Statements, resultLocal) is {} innerFound {
                return innerFound
            }
            if stmt is BoundTryStatement tryStmt &&
                tryStmt.TryBlock is BoundBlockStatement tryBlock &&
                TryFindCleanupBlockResultInitializer(tryBlock.Statements, resultLocal) is {} tryFound {
                return tryFound
            }
        }
        return nil
    }

    internal func TryGetSourceParameterRefKinds(expression BoundExpression, out refKinds ImmutableArray[RefKind]) bool {
        var expression = expression
        while true {
            if expression is BoundConversionExpression conversion {
                expression = conversion.Expression
                continue
            }
            if expression is BoundBlockExpression blockExpr {
                if blockExpr.Expression is BoundVariableExpression{Variable: LocalVariableSymbol resultLocal} &&
                    resultLocal
                    .Name
                    .StartsWith("<blockResult", StringComparison.Ordinal) &&
                    TryFindCleanupBlockResultInitializer(blockExpr.Statements, resultLocal) is {} initExpr {
                    expression = initExpr
                    continue
                }
                expression = blockExpr.Expression
                continue
            }
            break
        }
        switch expression {
            case literal is BoundFunctionLiteralExpression {
                refKinds = GetParameterRefKinds(literal.Function, receiver: nil)
                return true
            }
            case group is BoundMethodGroupExpression {
                return TryGetMethodGroupParameterRefKinds(group, out refKinds)
            }
            case group is BoundClrMethodGroupExpression {
                return TryGetClrMethodGroupParameterRefKinds(group, out refKinds)
            }
            case {Type: sourceDelegate is DelegateTypeSymbol} {
                let sourceDelegateKinds = ImmutableArray.CreateBuilder[RefKind](sourceDelegate.Parameters.Length)
                for parameter in sourceDelegate.Parameters {
                    sourceDelegateKinds.Add(parameter.RefKind)
                }
                refKinds = sourceDelegateKinds.MoveToImmutable()
                return true
            }
            case {Type: {ClrType: sourceType is Type}} when ClrTypeUtilities.IsDelegateType(sourceType) {
                // Issue #3752: the third sibling of the same probe. A direct
                // `Invoke` reflection answers null for a delegate closed over
                // a MetadataLoadContext-projected type, which used to abandon
                // the source's ref kinds entirely.
                if ClrLoadContext.TryGetDelegateSignature(sourceType, out var sourceParameters, out _) {
                    refKinds = GetDelegateParameterRefKinds(sourceType, sourceParameters.Length, out _)
                    return true
                }
            }
            case {Type: sourceFunction is FunctionTypeSymbol} {
                let sourceFunctionKinds = ImmutableArray.CreateBuilder[RefKind](sourceFunction.Arity)
                for var i = 0; i < sourceFunction.Arity; i++ {
                    sourceFunctionKinds.Add(RefKind.None)
                }
                refKinds = sourceFunctionKinds.MoveToImmutable()
                return true
            }
        }
        refKinds = default(ImmutableArray[RefKind])
        return false
    }

    /// Issue #3752 (#3705, family 3): reads a delegate type's `Invoke`
    /// parameter ref kinds in a way that survives a cross-reflection-context
    /// closure.
    ///
    /// A native function type over a `MetadataLoadContext`-projected type
    /// (`(Type) -> Type` in any compile with `/reference:`) has a
    /// `System.Reflection.Emit.TypeBuilderInstantiation` as its CLR type,
    /// because `typeof(Func<,>).MakeGenericType` cannot produce a
    /// `RuntimeType` over foreign-context arguments. Reflecting
    /// `Invoke` off it throws (cref:NotSupportedException), so the
    /// direct probe answers `null`. Ref kinds are stable under
    /// generic substitution, so the open definition's `Invoke` — always
    /// reachable in metadata — answers the same question, exactly as
    /// (cref:ClrLoadContext.TryGetDelegateSignature) does for the
    /// parameter and return types.
    /// @param delegateType The delegate (or native function) CLR type.
    /// @param parameterCount The signature's parameter count, used when no `Invoke` is reachable at all.
    /// @param returnRefKind The `Invoke` return's ref kind.
    /// @returns One ref kind per `Invoke` parameter.
    internal func GetDelegateParameterRefKinds(
        delegateType Type?,
        parameterCount int32,
        out returnRefKind RefKind
    ) ImmutableArray[RefKind] {
        returnRefKind = RefKind.None
        let invoke MethodInfo? = delegateType?.GetMethodSafe("Invoke") ?? TryGetOpenDefinitionInvoke(delegateType)
        if invoke == nil {
            return ImmutableArray.CreateRange(Enumerable.Repeat(RefKind.None, parameterCount))
        }
        returnRefKind = RefCapabilities.GetReturnRefKind(invoke)
        return GetParameterRefKinds(invoke)
    }

    internal func GetParameterRefKinds(method MethodInfo, skipFirstParameter bool = false) ImmutableArray[RefKind] {
        let parameters = method.GetParameters()
        let offset = if skipFirstParameter {
            1
        } else {
            0
        }
        let refKinds = ImmutableArray.CreateBuilder[RefKind](parameters.Length - offset)
        for var i = offset; i < parameters.Length; i++ {
            refKinds.Add(GetParameterRefKind(parameters[i]))
        }
        return refKinds.MoveToImmutable()
    }

    private func TryGetMethodGroupParameterRefKinds(
        group BoundMethodGroupExpression,
        out refKinds ImmutableArray[RefKind]
    ) bool {
        if group.FunctionType != nil && group.Function != nil {
            refKinds = GetParameterRefKinds(group.Function, group.Receiver)
            return true
        }
        let candidateKinds = List[ImmutableArray[RefKind]](group.Candidates.Length)
        for candidate in group.Candidates {
            candidateKinds.Add(GetParameterRefKinds(candidate, group.Receiver))
        }
        return TryGetCommonParameterRefKinds(candidateKinds, out refKinds)
    }

    private func TryGetClrMethodGroupParameterRefKinds(
        group BoundClrMethodGroupExpression,
        out refKinds ImmutableArray[RefKind]
    ) bool {
        if group.ResolvedMethod != nil {
            refKinds = GetLogicalParameterRefKinds(
                group.ResolvedMethod,
                skipFirstParameter: group.Receiver != nil && group.ResolvedMethod.IsStatic
            )
            return true
        }
        let candidateKinds = List[ImmutableArray[RefKind]](group.Candidates.Length)
        for candidate in group.Candidates {
            candidateKinds.Add(
                GetLogicalParameterRefKinds(candidate, skipFirstParameter: group.Receiver != nil && candidate.IsStatic)
            )
        }
        return TryGetCommonParameterRefKinds(candidateKinds, out refKinds)
    }

    private func GetLogicalParameterRefKinds(method MethodInfo, skipFirstParameter bool) ImmutableArray[RefKind] {
        let refKinds = GetParameterRefKinds(method, skipFirstParameter)
        return if ImportedFunctionSymbol.HasHiddenContextParameter(method) {
            refKinds.RemoveAt(refKinds.Length - 1)
        } else {
            refKinds
        }
    }

    private func GetParameterRefKinds(function FunctionSymbol, receiver BoundExpression?) ImmutableArray[RefKind] {
        let parameterOffset = if function.IsExtension && receiver != nil {
            1
        } else {
            0
        }
        let refKinds = ImmutableArray.CreateBuilder[RefKind](function.Parameters.Length - parameterOffset)
        for var i = parameterOffset; i < function.Parameters.Length; i++ {
            refKinds.Add(function.Parameters[i].RefKind)
        }
        return refKinds.MoveToImmutable()
    }

    private func TryGetCommonParameterRefKinds(
        candidates IEnumerable[ImmutableArray[RefKind]],
        out refKinds ImmutableArray[RefKind]
    ) bool {
        refKinds = default(ImmutableArray[RefKind])
        for candidate in candidates {
            if refKinds.IsDefault {
                refKinds = candidate
            } else if !RefKindsEqual(refKinds, candidate) {
                refKinds = default(ImmutableArray[RefKind])
                return false
            }
        }
        return !refKinds.IsDefault
    }

    private func RefKindsEqual(left ImmutableArray[RefKind], right ImmutableArray[RefKind]) bool {
        if left.Length != right.Length {
            return false
        }
        for var i = 0; i < left.Length; i++ {
            if (left[i] != right[i]) {
                return false
            }
        }
        return true
    }

    /// Issue #3752: the open generic definition's `Invoke`, the only one
    /// reachable when the closed type is a cross-context
    /// `TypeBuilderInstantiation`.
    /// @param delegateType The closed delegate type.
    /// @returns The open definition's `Invoke`, or `null`.
    private func TryGetOpenDefinitionInvoke(delegateType Type?) MethodInfo? {
        if delegateType == nil || !delegateType.IsGenericType || delegateType.IsGenericTypeDefinition {
            return nil
        }
        try {
            return delegateType.GetGenericTypeDefinition().GetMethodSafe("Invoke")
        } catch (Exception) {
            return nil
        }
    }

    private func GetParameterRefKind(parameter ParameterInfo) RefKind -> if !parameter.ParameterType.IsByRef {
        RefKind.None
    } else {
        (
            if parameter.IsOut {
                RefKind.Out
            } else {
                (
                    if parameter.IsIn {
                        RefKind.In
                    } else {
                        RefKind.Ref
                    }
                )
            }
        )
    }
}
