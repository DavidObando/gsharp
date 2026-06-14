// <copyright file="AwaitableShape.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Resolved per-call-site shape of an awaitable expression. Encapsulates the
/// duck-typed <c>GetAwaiter</c> / <c>IsCompleted</c> / <c>GetResult</c>
/// triple and the awaiter's <c>ICriticalNotifyCompletion</c> flag, which the
/// per-await codegen uses to select between
/// <c>AwaitOnCompleted</c> and <c>AwaitUnsafeOnCompleted</c>
/// (see <c>~/roslyn-async.md</c> §1, §6.4, §12 corner case 2).
/// </summary>
/// <remarks>
/// <para>Resolution is strictly nominal — it searches for instance methods
/// and extension methods named <c>GetAwaiter</c> on the awaitable type, then
/// for an instance <c>IsCompleted</c> property and an instance
/// <c>GetResult</c> method on the awaiter type. This matches the C#
/// language rule: any type exposing those members in the right shape is
/// awaitable, regardless of whether it implements <c>Task</c>.</para>
/// <para>This class does not perform conversions or emit diagnostics; it
/// returns <see langword="null"/> from <see cref="Resolve"/> when the shape
/// does not match, and the caller is responsible for reporting the error.</para>
/// </remarks>
public sealed class AwaitableShape
{
    private AwaitableShape(
        Type awaitableType,
        Type awaiterType,
        Type resultType,
        MethodInfo getAwaiter,
        PropertyInfo isCompleted,
        MethodInfo getResult,
        bool implementsCriticalNotifyCompletion)
    {
        AwaitableType = awaitableType;
        AwaiterType = awaiterType;
        ResultType = resultType;
        GetAwaiterMethod = getAwaiter;
        IsCompletedProperty = isCompleted;
        GetResultMethod = getResult;
        ImplementsCriticalNotifyCompletion = implementsCriticalNotifyCompletion;
    }

    /// <summary>Gets the type of the awaitable expression (e.g. <c>Task&lt;int&gt;</c>).</summary>
    public Type AwaitableType { get; }

    /// <summary>Gets the type of the awaiter returned by <see cref="GetAwaiterMethod"/>.</summary>
    public Type AwaiterType { get; }

    /// <summary>Gets the awaited result type (the return type of
    /// <see cref="GetResultMethod"/>; <c>typeof(void)</c> for void-returning
    /// <c>GetResult</c>).</summary>
    public Type ResultType { get; }

    /// <summary>Gets the resolved instance <c>GetAwaiter()</c> method.</summary>
    public MethodInfo GetAwaiterMethod { get; }

    /// <summary>Gets the resolved instance <c>IsCompleted</c> property
    /// getter.</summary>
    public PropertyInfo IsCompletedProperty { get; }

    /// <summary>Gets the resolved instance <c>GetResult()</c> method.</summary>
    public MethodInfo GetResultMethod { get; }

    /// <summary>Gets a value indicating whether the awaiter implements
    /// <c>System.Runtime.CompilerServices.ICriticalNotifyCompletion</c>. When
    /// <see langword="true"/>, the per-await codegen prefers
    /// <c>AwaitUnsafeOnCompleted</c> (no <c>ExecutionContext</c> flow).</summary>
    public bool ImplementsCriticalNotifyCompletion { get; }

    /// <summary>
    /// Resolves the awaitable shape for the given CLR type, or returns
    /// <see langword="null"/> if the type is not awaitable.
    /// </summary>
    /// <param name="awaitableType">The static type of the awaited expression.</param>
    /// <returns>The resolved shape, or <see langword="null"/>.</returns>
    public static AwaitableShape Resolve(Type awaitableType)
    {
        if (awaitableType == null)
        {
            return null;
        }

        var getAwaiter = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            awaitableType,
            "GetAwaiter",
            Type.EmptyTypes);

        if (getAwaiter == null || getAwaiter.ReturnType == null || getAwaiter.ReturnType.IsSameAs(typeof(void)))
        {
            return null;
        }

        var awaiterType = getAwaiter.ReturnType;
        var isCompleted = MemberLookup.SafeGetPropertyIncludingSelfAndInterfaces(
            awaiterType,
            "IsCompleted");

        if (isCompleted == null || isCompleted.PropertyType.FullName != "System.Boolean" || isCompleted.GetMethod == null)
        {
            return null;
        }

        var getResult = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            awaiterType,
            "GetResult",
            Type.EmptyTypes);

        if (getResult == null)
        {
            return null;
        }

        var implementsNotify = awaiterType.GetInterfaces()
            .Any(i => i.FullName == "System.Runtime.CompilerServices.INotifyCompletion");

        if (!implementsNotify)
        {
            // Not awaitable — must at minimum implement INotifyCompletion.
            return null;
        }

        var implementsCritical = awaiterType.GetInterfaces()
            .Any(i => i.FullName == "System.Runtime.CompilerServices.ICriticalNotifyCompletion");

        return new AwaitableShape(
            awaitableType,
            awaiterType,
            getResult.ReturnType,
            getAwaiter,
            isCompleted,
            getResult,
            implementsCritical);
    }
}
