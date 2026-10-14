// <copyright file="AwaitableShape.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Linq
import System.Reflection

/// Resolved per-call-site shape of an awaitable expression. Encapsulates the
/// duck-typed `GetAwaiter` / `IsCompleted` / `GetResult`
/// triple and the awaiter's `ICriticalNotifyCompletion` flag, which the
/// per-await codegen uses to select between
/// `AwaitOnCompleted` and `AwaitUnsafeOnCompleted`
/// (see `~/roslyn-async.md` §1, §6.4, §12 corner case 2).
/// @remarks Resolution is strictly nominal — it searches for instance methods
/// and extension methods named `GetAwaiter` on the awaitable type, then
/// for an instance `IsCompleted` property and an instance
/// `GetResult` method on the awaiter type. This matches the C#
/// language rule: any type exposing those members in the right shape is
/// awaitable, regardless of whether it implements `Task`.
///
/// This class does not perform conversions or emit diagnostics; it
/// returns `null` from (cref:Resolve) when the shape
/// does not match, and the caller is responsible for reporting the error.
class AwaitableShape {
    private init(
        awaitableType Type,
        awaiterType Type,
        resultType Type,
        getAwaiter MethodInfo,
        isCompleted PropertyInfo,
        getResult MethodInfo,
        implementsCriticalNotifyCompletion bool
    ) {
        AwaitableType = awaitableType
        AwaiterType = awaiterType
        ResultType = resultType
        GetAwaiterMethod = getAwaiter
        IsCompletedProperty = isCompleted
        GetResultMethod = getResult
        ImplementsCriticalNotifyCompletion = implementsCriticalNotifyCompletion
    }

    /// Gets the type of the awaitable expression (e.g. `Task<int>`).
    prop AwaitableType Type {
        get;
    }

    /// Gets the type of the awaiter returned by (cref:GetAwaiterMethod).
    prop AwaiterType Type {
        get;
    }

    /// Gets the awaited result type (the return type of
    /// (cref:GetResultMethod); `typeof(void)` for void-returning
    /// `GetResult`).
    prop ResultType Type {
        get;
    }

    /// Gets the resolved instance `GetAwaiter()` method.
    prop GetAwaiterMethod MethodInfo {
        get;
    }

    /// Gets the resolved instance `IsCompleted` property
    /// getter.
    prop IsCompletedProperty PropertyInfo {
        get;
    }

    /// Gets the resolved instance `GetResult()` method.
    prop GetResultMethod MethodInfo {
        get;
    }

    /// Gets a value indicating whether the awaiter implements
    /// `System.Runtime.CompilerServices.ICriticalNotifyCompletion`. When
    /// `true`, the per-await codegen prefers
    /// `AwaitUnsafeOnCompleted` (no `ExecutionContext` flow).
    prop ImplementsCriticalNotifyCompletion bool {
        get;
    }

    shared {
        /// Resolves the awaitable shape for the given CLR type, or returns
        /// `null` if the type is not awaitable.
        /// @param awaitableType The static type of the awaited expression,
        /// or `null` when it has no CLR projection -- which is not awaitable.
        /// @returns The resolved shape, or `null`.
        func Resolve(awaitableType Type?) AwaitableShape? {
            if awaitableType == nil {
                return nil
            }
            let getAwaiter MethodInfo? = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
                awaitableType,
                "GetAwaiter",
                Type.EmptyTypes
            )
            if getAwaiter == nil || getAwaiter.ReturnType == nil || getAwaiter.ReturnType.IsSameAs(typeof(Void)) {
                return nil
            }
            let awaiterType = getAwaiter.ReturnType
            let isCompleted PropertyInfo? = MemberLookup.SafeGetPropertyIncludingSelfAndInterfaces(
                awaiterType,
                "IsCompleted"
            )
            if isCompleted == nil ||
                isCompleted
                .PropertyType
                .FullName != "System.Boolean" ||
                isCompleted.GetMethod == nil {
                return nil
            }
            let getResult MethodInfo? = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
                awaiterType,
                "GetResult",
                Type.EmptyTypes
            )
            if getResult == nil {
                return nil
            }
            var implementsNotify = false
            var implementsCritical = false
            for interfaceType in awaiterType.GetInterfaces() {
                implementsNotify |= interfaceType.FullName == "System.Runtime.CompilerServices.INotifyCompletion"
                implementsCritical |= interfaceType.FullName == "System.Runtime.CompilerServices.ICriticalNotifyCompletion"
            }
            if !implementsNotify {
                // Not awaitable — must at minimum implement INotifyCompletion.
                return nil
            }
            return AwaitableShape(
                awaitableType,
                awaiterType,
                getResult.ReturnType,
                getAwaiter,
                isCompleted,
                getResult,
                implementsCritical
            )
        }
    }
}
