// <copyright file="AsyncMethodBuilderInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import System
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis
import System.Runtime.CompilerServices

/// Resolved metadata for the BCL "async method builder" associated with an
/// `async` method's declared return type. The async state-machine
/// rewriter consumes one of these per async method to emit the kickoff body
/// and the per-await sequence inside `MoveNext`.
/// @remarks The selection rules mirror Roslyn's
/// `AsyncMethodBuilderMemberCollection.TryCreate`
/// (see `~/roslyn-async.md` §1, §11 corner case 18, and Roslyn's
/// `Lowering/AsyncRewriter/AsyncMethodBuilderMemberCollection.cs`):
///
/// 1. If the method itself carries a `[AsyncMethodBuilder(typeof(T))]` attribute, `T` is the builder
/// (the method-level attribute takes precedence).
/// 2. Otherwise, if the return type carries `[AsyncMethodBuilder(typeof(T))]`, `T` is the builder. For
/// generic task-likes the builder is constructed with the result type via
/// `builder.MakeGenericType(resultType)`.
/// 3. Otherwise the builder is one of the four well-known BCL types: <list type="bullet">
/// <item><description><c>System.Void</c> → <c>AsyncVoidMethodBuilder</c>.</description></item>
/// <item><description><c>System.Threading.Tasks.Task</c> →
/// <c>AsyncTaskMethodBuilder</c>.</description></item>
/// <item><description><c>System.Threading.Tasks.Task&lt;T&gt;</c> →
/// <c>AsyncTaskMethodBuilder&lt;T&gt;</c>.</description></item>
/// <item><description><c>System.Collections.Generic.IAsyncEnumerable&lt;T&gt;</c> /
/// <c>System.Collections.Generic.IAsyncEnumerator&lt;T&gt;</c> →
/// <c>AsyncIteratorMethodBuilder</c>.</description></item> </list>
///
/// This class is a pure resolution helper. It performs no lowering
/// and produces no diagnostics; callers that need diagnostics should check
/// (cref:IsValid) and route errors through their own diagnostic bag.
///
/// Every resolved member is declared nullable because member binding is
/// a best-effort reflection lookup against whatever builder type the target
/// framework supplies: a builder that does not declare the member yields
/// `null` rather than an exception, and that is precisely what
/// (cref:IsValid) reports. (cref:IsValid) carries
/// (cref:MemberNotNullWhenAttribute) for the four members every valid
/// builder has, so a caller that checks it first needs no further guard for
/// those; the kind-dependent members ((cref:TaskProperty) and the
/// `Set*` methods) still need one, because which of them are required
/// depends on (cref:Kind).
class AsyncMethodBuilderInfo {
    private init(
        kind AsyncMethodBuilderKind,
        builderType Type,
        resultType Type,
        createMethod MethodInfo?,
        taskProperty PropertyInfo?,
        startMethod MethodInfo?,
        setStateMachineMethod MethodInfo?,
        setResultMethod MethodInfo?,
        setExceptionMethod MethodInfo?,
        awaitOnCompletedMethod MethodInfo?,
        awaitUnsafeOnCompletedMethod MethodInfo?
    ) {
        Kind = kind
        BuilderType = builderType
        ResultType = resultType
        CreateMethod = createMethod
        TaskProperty = taskProperty
        StartMethod = startMethod
        SetStateMachineMethod = setStateMachineMethod
        SetResultMethod = setResultMethod
        SetExceptionMethod = setExceptionMethod
        AwaitOnCompletedMethod = awaitOnCompletedMethod
        AwaitUnsafeOnCompletedMethod = awaitUnsafeOnCompletedMethod
    }

    /// Gets the categorisation of this builder.
    prop Kind AsyncMethodBuilderKind {
        get;
    }

    /// Gets the (possibly constructed) builder (cref:Type).
    prop BuilderType Type {
        get;
    }

    /// Gets the unwrapped result type (`T` for `Task<T>`,
    /// `typeof(void)` for `Task`/`void`).
    prop ResultType Type {
        get;
    }

    /// Gets `Builder.Create()` static method.
    /// `null` when the builder type does not declare it, which makes
    /// (cref:IsValid) false.
    prop CreateMethod MethodInfo? {
        get;
    }

    /// Gets the `Task` / `Task<T>` / iterator property.
    /// `null` for `AsyncVoidMethodBuilder`, which has no task to
    /// return, and for an async-iterator builder.
    prop TaskProperty PropertyInfo? {
        get;
    }

    /// Gets the `Start<TStateMachine>(ref TStateMachine)` open generic,
    /// or `MoveNext<TStateMachine>(ref TStateMachine)` when
    /// (cref:Kind) is (cref:AsyncMethodBuilderKind.AsyncIterator).
    /// `null` when the builder type declares neither, which makes
    /// (cref:IsValid) false.
    prop StartMethod MethodInfo? {
        get;
    }

    /// Gets `SetStateMachine(IAsyncStateMachine)`.
    /// `null` for an async-iterator builder, whose surface does not
    /// include it.
    prop SetStateMachineMethod MethodInfo? {
        get;
    }

    /// Gets `SetResult([T])`.
    /// `null` for an async-iterator builder, whose surface does not
    /// include it.
    prop SetResultMethod MethodInfo? {
        get;
    }

    /// Gets `SetException(Exception)`.
    /// `null` for an async-iterator builder, whose surface does not
    /// include it.
    prop SetExceptionMethod MethodInfo? {
        get;
    }

    /// Gets `AwaitOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter, ref TStateMachine)`.
    /// `null` when the builder type does not declare it, which makes
    /// (cref:IsValid) false.
    prop AwaitOnCompletedMethod MethodInfo? {
        get;
    }

    /// Gets `AwaitUnsafeOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter, ref TStateMachine)`.
    /// `null` when the builder type does not declare it, which makes
    /// (cref:IsValid) false.
    prop AwaitUnsafeOnCompletedMethod MethodInfo? {
        get;
    }

    /// Gets a value indicating whether every member required for
    /// state-machine lowering was successfully resolved. Iterator builders
    /// have a different member surface and require only the common
    /// members (`Create`, `MoveNext`, `AwaitOnCompleted`,
    /// `AwaitUnsafeOnCompleted`); the rest is bound by the iterator
    /// rewriter directly.
    @MemberNotNullWhen(true, "CreateMethod")
    @MemberNotNullWhen(true, "StartMethod")
    @MemberNotNullWhen(true, "AwaitOnCompletedMethod")
    @MemberNotNullWhen(true, "AwaitUnsafeOnCompletedMethod")
    prop IsValid bool {
        get {
            // BuilderType is not checked here: it is non-nullable, because the
            // only caller of the constructor is BindMembers and Resolve returns
            // null before reaching it when no builder type was chosen.
            if CreateMethod == nil || AwaitOnCompletedMethod == nil || AwaitUnsafeOnCompletedMethod == nil {
                return false
            }
            if Kind == AsyncMethodBuilderKind.AsyncIterator {
                // StartMethod here holds MoveNext<TSM>(ref TSM).
                return StartMethod != nil
            }
            if StartMethod == nil ||
                SetStateMachineMethod == nil ||
                SetResultMethod == nil ||
                SetExceptionMethod == nil {
                return false
            }
            if Kind != AsyncMethodBuilderKind.Void && TaskProperty == nil {
                return false
            }
            return true
        }
    }

    shared {
        /// Resolves the builder for an async method whose declared kickoff return
        /// type (i.e. the wrapped `Task` / `Task<T>` / etc.) is
        /// [`kickoffReturnClrType`](paramref).
        /// @param kickoffReturnClrType The CLR (cref:Type) the
        /// kickoff method actually returns. For `async void` pass
        /// `typeof(void)`.
        /// @param resolver The reference resolver used to find BCL types
        /// in the target framework. May be `null`, in which case
        /// the host runtime types are used.
        /// @param methodAttributeBuilderType Optional CLR type captured
        /// from a method-level `[AsyncMethodBuilder(typeof(T))]` attribute.
        /// Takes precedence over a return-type attribute when non-null.
        /// @returns A populated (cref:AsyncMethodBuilderInfo), or
        /// `null` when no valid builder could be resolved.
        func Resolve(
            kickoffReturnClrType Type?,
            resolver ReferenceResolver?,
            methodAttributeBuilderType Type? = nil
        ) AsyncMethodBuilderInfo? {
            if kickoffReturnClrType == nil {
                return nil
            }
            let choice = ChooseBuilder(kickoffReturnClrType, resolver, methodAttributeBuilderType)
            if choice.BuilderType == nil {
                return nil
            }
            return BindMembers(choice.Kind, choice.BuilderType!!, choice.ResultType)
        }

        private func ChooseBuilder(
            kickoffReturnClrType Type,
            resolver ReferenceResolver?,
            methodAttributeBuilderType Type?
        )(Kind AsyncMethodBuilderKind, BuilderType Type?, ResultType Type) {
            let CoreType = func (fullName string) Type? {
                if resolver != nil {
                    if resolver.TryResolveType(fullName, requireExternalVisibility: false, out var t) && t != nil {
                        return t
                    }
                }
                return Type.GetType(fullName + ", System.Runtime", throwOnError: false) ?? Type.GetType(
                    fullName,
                    throwOnError: false
                )
            }
            // 1. Method-level [AsyncMethodBuilder] wins.
            if methodAttributeBuilderType != nil {
                let resultType = ExtractResultType(kickoffReturnClrType)
                let constructed = ConstructBuilder(methodAttributeBuilderType, resultType)
                return (AsyncMethodBuilderKind.Custom, constructed, resultType)
            }
            // 2. async void / async Task / async Task<T> / async ValueTask*
            //    / async IAsyncEnumerable<T> / async IAsyncEnumerator<T>.
            if kickoffReturnClrType.IsSameAs(typeof(Void)) {
                let builder = CoreType("System.Runtime.CompilerServices.AsyncVoidMethodBuilder")
                return (AsyncMethodBuilderKind.Void, builder, typeof(Void))
            }
            if IsWellKnownTask(kickoffReturnClrType, out var isGeneric, out var taskResultType) {
                if isGeneric {
                    let open_ = CoreType("System.Runtime.CompilerServices.AsyncTaskMethodBuilder`1")
                    let builder = open_?.MakeGenericType(taskResultType)
                    return (AsyncMethodBuilderKind.GenericTask, builder, taskResultType)
                }
                let nonGeneric = CoreType("System.Runtime.CompilerServices.AsyncTaskMethodBuilder")
                return (AsyncMethodBuilderKind.Task, nonGeneric, typeof(Void))
            }
            if IsAsyncIteratorReturnType(kickoffReturnClrType, out var iteratorElement) {
                let builder = CoreType("System.Runtime.CompilerServices.AsyncIteratorMethodBuilder")
                return (AsyncMethodBuilderKind.AsyncIterator, builder, iteratorElement)
            }
            // 3. Custom task-like via [AsyncMethodBuilder] on the return type.
            // ADR-0047 §6: recognised by type identity, not string name.
            var attributeType CustomAttributeData? = nil
            for attribute in kickoffReturnClrType.GetCustomAttributesData() {
                if attribute.AttributeType.IsSameAs(typeof(AsyncMethodBuilderAttribute)) {
                    attributeType = attribute
                    break
                }
            }
            if attributeType != nil && attributeType.ConstructorArguments.Count == 1 {
                let customBuilder Type? = attributeType.ConstructorArguments[0].Value as Type
                if customBuilder != nil {
                    let resultType = ExtractResultType(kickoffReturnClrType)
                    let constructed = ConstructBuilder(customBuilder, resultType)
                    return (AsyncMethodBuilderKind.Custom, constructed, resultType)
                }
            }
            // No builder. ResultType is unread on this path -- Resolve returns null
            // as soon as it sees the null BuilderType -- so it carries the same
            // "no result" value ExtractResultType produces for a non-generic type.
            return (AsyncMethodBuilderKind.Unknown, nil, typeof(Void))
        }

        private func ConstructBuilder(openOrClosed Type?, resultType Type?) Type? {
            if openOrClosed == nil {
                return nil
            }
            if openOrClosed.IsGenericTypeDefinition {
                if resultType == nil || resultType.IsSameAs(typeof(Void)) {
                    return nil
                }
                return openOrClosed.MakeGenericType(resultType)
            }
            return openOrClosed
        }

        private func IsWellKnownTask(returnType Type?, out isGeneric bool, out resultType Type) bool {
            isGeneric = false
            resultType = typeof(Void)
            if returnType == nil {
                return false
            }
            let full = returnType.FullName
            if full == "System.Threading.Tasks.Task" {
                return true
            }
            if returnType.IsGenericType {
                let open_ = returnType.GetGenericTypeDefinition()
                if open_?.FullName == "System.Threading.Tasks.Task`1" {
                    isGeneric = true
                    resultType = returnType.GetGenericArguments()[0]
                    return true
                }
                if open_?.FullName == "System.Threading.Tasks.ValueTask`1" {
                    // ValueTask<T> resolves through its [AsyncMethodBuilder]
                    // attribute; treat as not-well-known here so the attribute
                    // path runs.
                    return false
                }
            }
            if full == "System.Threading.Tasks.ValueTask" {
                // Same as above — handled via the attribute path.
                return false
            }
            return false
        }

        private func IsAsyncIteratorReturnType(returnType Type?, @NotNullWhen(true) out elementType Type?) bool {
            elementType = nil
            if returnType == nil || !returnType.IsGenericType {
                return false
            }
            let open_ = returnType.GetGenericTypeDefinition()
            if open_?.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                open_?.FullName == "System.Collections.Generic.IAsyncEnumerator`1" {
                elementType = returnType.GetGenericArguments()[0]
                return true
            }
            return false
        }

        private func ExtractResultType(returnType Type?) Type {
            if returnType == nil {
                return typeof(Void)
            }
            if returnType.IsGenericType {
                return returnType.GetGenericArguments()[0]
            }
            return typeof(Void)
        }

        private func BindMembers(
            kind AsyncMethodBuilderKind,
            builderType Type,
            resultType Type
        ) AsyncMethodBuilderInfo {
            let create = builderType.GetMethod(
                "Create",
                BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly,
                binder: nil,
                types: Type.EmptyTypes,
                modifiers: nil
            )
            if kind == AsyncMethodBuilderKind.AsyncIterator {
                // AsyncIteratorMethodBuilder has a different surface:
                // MoveNext<TStateMachine>(ref TStateMachine) + Complete() in
                // place of Start / SetStateMachine / SetResult / SetException.
                // The full iterator binding lives in the iterator rewriter
                // (todo: iterator-rewriter); here we resolve only the members
                // that are common with the Task path, so the kind+builder type
                // are already discoverable by callers.
                let moveNext = FindGenericBuilderMethod(
                    builderType,
                    "MoveNext",
                    genericArgumentCount: nil,
                    parameterCount: 1
                )
                let awaitOnCompletedIter = FindGenericBuilderMethod(
                    builderType,
                    "AwaitOnCompleted",
                    genericArgumentCount: 2,
                    parameterCount: 2
                )
                let awaitUnsafeOnCompletedIter = FindGenericBuilderMethod(
                    builderType,
                    "AwaitUnsafeOnCompleted",
                    genericArgumentCount: 2,
                    parameterCount: 2
                )
                return AsyncMethodBuilderInfo(
                    kind,
                    builderType,
                    resultType,
                    create,
                    taskProperty: nil,
                    startMethod: moveNext,
                    setStateMachineMethod: nil,
                    setResultMethod: nil,
                    setExceptionMethod: nil,
                    awaitOnCompletedMethod: awaitOnCompletedIter,
                    awaitUnsafeOnCompletedMethod: awaitUnsafeOnCompletedIter
                )
            }
            let task = MemberLookup.SafeGetPropertyIncludingSelfAndInterfaces(builderType, "Task")
            // SetResult: no-arg for void / Task, single-arg for generic.
            var setResult MethodInfo
            if kind == AsyncMethodBuilderKind.GenericTask ||
                (kind == AsyncMethodBuilderKind.Custom && !resultType.IsSameAs(typeof(Void))) {
                setResult = Invariant.Required(
                    MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(builderType, "SetResult", []Type{resultType}),
                    "an async method builder has a matching SetResult method",
                    expression: `MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
                    builderType, "SetResult", new[] { resultType })`
                )
            } else {
                setResult = Invariant.Required(
                    MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(builderType, "SetResult", Type.EmptyTypes),
                    "an async method builder has a parameterless SetResult method",
                    expression: "MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(\n                    builderType, \"SetResult\", Type.EmptyTypes)"
                )
            }
            let setException = FindSingleParameterBuilderMethod(builderType, "SetException", "System.Exception")
            let setStateMachine = FindSingleParameterBuilderMethod(
                builderType,
                "SetStateMachine",
                "System.Runtime.CompilerServices.IAsyncStateMachine"
            )
            let start = FindGenericBuilderMethod(builderType, "Start", genericArgumentCount: nil, parameterCount: 1)
            let awaitOnCompleted = FindGenericBuilderMethod(
                builderType,
                "AwaitOnCompleted",
                genericArgumentCount: 2,
                parameterCount: 2
            )
            let awaitUnsafeOnCompleted = FindGenericBuilderMethod(
                builderType,
                "AwaitUnsafeOnCompleted",
                genericArgumentCount: 2,
                parameterCount: 2
            )
            return AsyncMethodBuilderInfo(
                kind,
                builderType,
                resultType,
                create,
                task,
                start,
                setStateMachine,
                setResult,
                setException,
                awaitOnCompleted,
                awaitUnsafeOnCompleted
            )
        }

        private func FindGenericBuilderMethod(
            builderType Type,
            name string,
            genericArgumentCount int32?,
            parameterCount int32
        ) MethodInfo? {
            for method in MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(builderType, name) {
                if method.IsGenericMethodDefinition &&
                    (genericArgumentCount == nil || method.GetGenericArguments().Length == genericArgumentCount) &&
                    method
                    .GetParameters().Length == parameterCount {
                    return method
                }
            }
            return nil
        }

        private func FindSingleParameterBuilderMethod(
            builderType Type,
            name string,
            parameterTypeName string
        ) MethodInfo? {
            for method in MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(builderType, name) {
                let parameters = method.GetParameters()
                if parameters.Length == 1 && parameters[0].ParameterType.FullName == parameterTypeName {
                    return method
                }
            }
            return nil
        }
    }
}
