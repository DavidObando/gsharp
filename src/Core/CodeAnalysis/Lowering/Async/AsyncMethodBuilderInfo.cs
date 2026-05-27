// <copyright file="AsyncMethodBuilderInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Resolved metadata for the BCL "async method builder" associated with an
/// <c>async</c> method's declared return type. The async state-machine
/// rewriter consumes one of these per async method to emit the kickoff body
/// and the per-await sequence inside <c>MoveNext</c>.
/// </summary>
/// <remarks>
/// <para>The selection rules mirror Roslyn's
/// <c>AsyncMethodBuilderMemberCollection.TryCreate</c>
/// (see <c>~/roslyn-async.md</c> §1, §11 corner case 18, and Roslyn's
/// <c>Lowering/AsyncRewriter/AsyncMethodBuilderMemberCollection.cs</c>):</para>
/// <list type="number">
/// <item><description>If the method itself carries a
/// <c>[AsyncMethodBuilder(typeof(T))]</c> attribute, <c>T</c> is the builder
/// (the method-level attribute takes precedence).</description></item>
/// <item><description>Otherwise, if the return type carries
/// <c>[AsyncMethodBuilder(typeof(T))]</c>, <c>T</c> is the builder. For
/// generic task-likes the builder is constructed with the result type via
/// <c>builder.MakeGenericType(resultType)</c>.</description></item>
/// <item><description>Otherwise the builder is one of the four well-known
/// BCL types:
/// <list type="bullet">
/// <item><description><c>System.Void</c> → <c>AsyncVoidMethodBuilder</c>.</description></item>
/// <item><description><c>System.Threading.Tasks.Task</c> → <c>AsyncTaskMethodBuilder</c>.</description></item>
/// <item><description><c>System.Threading.Tasks.Task&lt;T&gt;</c> → <c>AsyncTaskMethodBuilder&lt;T&gt;</c>.</description></item>
/// <item><description><c>System.Collections.Generic.IAsyncEnumerable&lt;T&gt;</c> /
/// <c>System.Collections.Generic.IAsyncEnumerator&lt;T&gt;</c> →
/// <c>AsyncIteratorMethodBuilder</c>.</description></item>
/// </list></description></item>
/// </list>
/// <para>This class is a pure resolution helper. It performs no lowering
/// and produces no diagnostics; callers that need diagnostics should check
/// <see cref="IsValid"/> and route errors through their own diagnostic bag.</para>
/// </remarks>
public sealed class AsyncMethodBuilderInfo
{
    private AsyncMethodBuilderInfo(
        AsyncMethodBuilderKind kind,
        Type builderType,
        Type resultType,
        MethodInfo createMethod,
        PropertyInfo taskProperty,
        MethodInfo startMethod,
        MethodInfo setStateMachineMethod,
        MethodInfo setResultMethod,
        MethodInfo setExceptionMethod,
        MethodInfo awaitOnCompletedMethod,
        MethodInfo awaitUnsafeOnCompletedMethod)
    {
        Kind = kind;
        BuilderType = builderType;
        ResultType = resultType;
        CreateMethod = createMethod;
        TaskProperty = taskProperty;
        StartMethod = startMethod;
        SetStateMachineMethod = setStateMachineMethod;
        SetResultMethod = setResultMethod;
        SetExceptionMethod = setExceptionMethod;
        AwaitOnCompletedMethod = awaitOnCompletedMethod;
        AwaitUnsafeOnCompletedMethod = awaitUnsafeOnCompletedMethod;
    }

    /// <summary>Gets the categorisation of this builder.</summary>
    public AsyncMethodBuilderKind Kind { get; }

    /// <summary>Gets the (possibly constructed) builder <see cref="Type"/>.</summary>
    public Type BuilderType { get; }

    /// <summary>Gets the unwrapped result type (<c>T</c> for <c>Task&lt;T&gt;</c>,
    /// <c>typeof(void)</c> for <c>Task</c>/<c>void</c>).</summary>
    public Type ResultType { get; }

    /// <summary>Gets <c>Builder.Create()</c> static method.</summary>
    public MethodInfo CreateMethod { get; }

    /// <summary>Gets the <c>Task</c> / <c>Task&lt;T&gt;</c> / iterator property.
    /// <c>null</c> for <c>AsyncVoidMethodBuilder</c>.</summary>
    public PropertyInfo TaskProperty { get; }

    /// <summary>Gets the <c>Start&lt;TStateMachine&gt;(ref TStateMachine)</c> open generic.</summary>
    public MethodInfo StartMethod { get; }

    /// <summary>Gets <c>SetStateMachine(IAsyncStateMachine)</c>.</summary>
    public MethodInfo SetStateMachineMethod { get; }

    /// <summary>Gets <c>SetResult([T])</c>.</summary>
    public MethodInfo SetResultMethod { get; }

    /// <summary>Gets <c>SetException(Exception)</c>.</summary>
    public MethodInfo SetExceptionMethod { get; }

    /// <summary>Gets <c>AwaitOnCompleted&lt;TAwaiter, TStateMachine&gt;(ref TAwaiter, ref TStateMachine)</c>.</summary>
    public MethodInfo AwaitOnCompletedMethod { get; }

    /// <summary>Gets <c>AwaitUnsafeOnCompleted&lt;TAwaiter, TStateMachine&gt;(ref TAwaiter, ref TStateMachine)</c>.</summary>
    public MethodInfo AwaitUnsafeOnCompletedMethod { get; }

    /// <summary>Gets a value indicating whether every member required for
    /// state-machine lowering was successfully resolved. Iterator builders
    /// have a different member surface and require only the common
    /// members (<c>Create</c>, <c>MoveNext</c>, <c>AwaitOnCompleted</c>,
    /// <c>AwaitUnsafeOnCompleted</c>); the rest is bound by the iterator
    /// rewriter directly.</summary>
    public bool IsValid
    {
        get
        {
            if (BuilderType == null
                || CreateMethod == null
                || AwaitOnCompletedMethod == null
                || AwaitUnsafeOnCompletedMethod == null)
            {
                return false;
            }

            if (Kind == AsyncMethodBuilderKind.AsyncIterator)
            {
                // StartMethod here holds MoveNext<TSM>(ref TSM).
                return StartMethod != null;
            }

            if (StartMethod == null
                || SetStateMachineMethod == null
                || SetResultMethod == null
                || SetExceptionMethod == null)
            {
                return false;
            }

            if (Kind != AsyncMethodBuilderKind.Void && TaskProperty == null)
            {
                return false;
            }

            return true;
        }
    }

    /// <summary>
    /// Resolves the builder for an async method whose declared kickoff return
    /// type (i.e. the wrapped <c>Task</c> / <c>Task&lt;T&gt;</c> / etc.) is
    /// <paramref name="kickoffReturnClrType"/>.
    /// </summary>
    /// <param name="kickoffReturnClrType">The CLR <see cref="Type"/> the
    /// kickoff method actually returns. For <c>async void</c> pass
    /// <c>typeof(void)</c>.</param>
    /// <param name="resolver">The reference resolver used to find BCL types
    /// in the target framework. May be <see langword="null"/>, in which case
    /// the host runtime types are used.</param>
    /// <param name="methodAttributeBuilderType">Optional CLR type captured
    /// from a method-level <c>[AsyncMethodBuilder(typeof(T))]</c> attribute.
    /// Takes precedence over a return-type attribute when non-null.</param>
    /// <returns>A populated <see cref="AsyncMethodBuilderInfo"/>, or
    /// <see langword="null"/> when no valid builder could be resolved.</returns>
    public static AsyncMethodBuilderInfo Resolve(
        Type kickoffReturnClrType,
        ReferenceResolver resolver,
        Type methodAttributeBuilderType = null)
    {
        if (kickoffReturnClrType == null)
        {
            return null;
        }

        var choice = ChooseBuilder(kickoffReturnClrType, resolver, methodAttributeBuilderType);
        if (choice.BuilderType == null)
        {
            return null;
        }

        return BindMembers(choice.Kind, choice.BuilderType, choice.ResultType);
    }

    private static (AsyncMethodBuilderKind Kind, Type BuilderType, Type ResultType) ChooseBuilder(
        Type kickoffReturnClrType,
        ReferenceResolver resolver,
        Type methodAttributeBuilderType)
    {
        Type CoreType(string fullName)
        {
            if (resolver != null)
            {
                if (resolver.TryResolveType(fullName, out var t) && t != null)
                {
                    return t;
                }
            }

            return Type.GetType(fullName + ", System.Runtime", throwOnError: false)
                ?? Type.GetType(fullName, throwOnError: false);
        }

        // 1. Method-level [AsyncMethodBuilder] wins.
        if (methodAttributeBuilderType != null)
        {
            var resultType = ExtractResultType(kickoffReturnClrType);
            var constructed = ConstructBuilder(methodAttributeBuilderType, resultType);
            return (AsyncMethodBuilderKind.Custom, constructed, resultType);
        }

        // 2. async void / async Task / async Task<T> / async ValueTask*
        //    / async IAsyncEnumerable<T> / async IAsyncEnumerator<T>.
        if (kickoffReturnClrType == typeof(void) || kickoffReturnClrType.FullName == "System.Void")
        {
            var builder = CoreType("System.Runtime.CompilerServices.AsyncVoidMethodBuilder");
            return (AsyncMethodBuilderKind.Void, builder, typeof(void));
        }

        if (IsWellKnownTask(kickoffReturnClrType, out var isGeneric, out var taskResultType))
        {
            if (isGeneric)
            {
                var open = CoreType("System.Runtime.CompilerServices.AsyncTaskMethodBuilder`1");
                var builder = open?.MakeGenericType(taskResultType);
                return (AsyncMethodBuilderKind.GenericTask, builder, taskResultType);
            }

            var nonGeneric = CoreType("System.Runtime.CompilerServices.AsyncTaskMethodBuilder");
            return (AsyncMethodBuilderKind.Task, nonGeneric, typeof(void));
        }

        if (IsAsyncIteratorReturnType(kickoffReturnClrType, out var iteratorElement))
        {
            var builder = CoreType("System.Runtime.CompilerServices.AsyncIteratorMethodBuilder");
            return (AsyncMethodBuilderKind.AsyncIterator, builder, iteratorElement);
        }

        // 3. Custom task-like via [AsyncMethodBuilder] on the return type.
        // ADR-0047 §6: recognised by type identity, not string name.
        var attributeType = kickoffReturnClrType.GetCustomAttributesData()
            .FirstOrDefault(a => a.AttributeType == typeof(System.Runtime.CompilerServices.AsyncMethodBuilderAttribute));
        if (attributeType != null && attributeType.ConstructorArguments.Count == 1)
        {
            var customBuilder = attributeType.ConstructorArguments[0].Value as Type;
            if (customBuilder != null)
            {
                var resultType = ExtractResultType(kickoffReturnClrType);
                var constructed = ConstructBuilder(customBuilder, resultType);
                return (AsyncMethodBuilderKind.Custom, constructed, resultType);
            }
        }

        return (AsyncMethodBuilderKind.Unknown, null, null);
    }

    private static Type ConstructBuilder(Type openOrClosed, Type resultType)
    {
        if (openOrClosed == null)
        {
            return null;
        }

        if (openOrClosed.IsGenericTypeDefinition)
        {
            if (resultType == null || resultType == typeof(void))
            {
                return null;
            }

            return openOrClosed.MakeGenericType(resultType);
        }

        return openOrClosed;
    }

    private static bool IsWellKnownTask(Type returnType, out bool isGeneric, out Type resultType)
    {
        isGeneric = false;
        resultType = typeof(void);

        if (returnType == null)
        {
            return false;
        }

        var full = returnType.FullName;
        if (full == "System.Threading.Tasks.Task")
        {
            return true;
        }

        if (returnType.IsGenericType)
        {
            var open = returnType.GetGenericTypeDefinition();
            if (open?.FullName == "System.Threading.Tasks.Task`1")
            {
                isGeneric = true;
                resultType = returnType.GetGenericArguments()[0];
                return true;
            }

            if (open?.FullName == "System.Threading.Tasks.ValueTask`1")
            {
                // ValueTask<T> resolves through its [AsyncMethodBuilder]
                // attribute; treat as not-well-known here so the attribute
                // path runs.
                return false;
            }
        }

        if (full == "System.Threading.Tasks.ValueTask")
        {
            // Same as above — handled via the attribute path.
            return false;
        }

        return false;
    }

    private static bool IsAsyncIteratorReturnType(Type returnType, out Type elementType)
    {
        elementType = null;
        if (returnType == null || !returnType.IsGenericType)
        {
            return false;
        }

        var open = returnType.GetGenericTypeDefinition();
        if (open?.FullName == "System.Collections.Generic.IAsyncEnumerable`1"
            || open?.FullName == "System.Collections.Generic.IAsyncEnumerator`1")
        {
            elementType = returnType.GetGenericArguments()[0];
            return true;
        }

        return false;
    }

    private static Type ExtractResultType(Type returnType)
    {
        if (returnType == null)
        {
            return typeof(void);
        }

        if (returnType.IsGenericType)
        {
            return returnType.GetGenericArguments()[0];
        }

        return typeof(void);
    }

    private static AsyncMethodBuilderInfo BindMembers(
        AsyncMethodBuilderKind kind,
        Type builderType,
        Type resultType)
    {
        var create = builderType.GetMethod(
            "Create",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly,
            binder: null,
            types: Type.EmptyTypes,
            modifiers: null);

        if (kind == AsyncMethodBuilderKind.AsyncIterator)
        {
            // AsyncIteratorMethodBuilder has a different surface:
            // MoveNext<TStateMachine>(ref TStateMachine) + Complete() in
            // place of Start / SetStateMachine / SetResult / SetException.
            // The full iterator binding lives in the iterator rewriter
            // (todo: iterator-rewriter); here we resolve only the members
            // that are common with the Task path, so the kind+builder type
            // are already discoverable by callers.
            var moveNext = builderType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(m =>
                    m.Name == "MoveNext"
                    && m.IsGenericMethodDefinition
                    && m.GetParameters().Length == 1);
            var awaitOnCompletedIter = builderType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(m =>
                    m.Name == "AwaitOnCompleted"
                    && m.IsGenericMethodDefinition
                    && m.GetGenericArguments().Length == 2
                    && m.GetParameters().Length == 2);
            var awaitUnsafeOnCompletedIter = builderType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(m =>
                    m.Name == "AwaitUnsafeOnCompleted"
                    && m.IsGenericMethodDefinition
                    && m.GetGenericArguments().Length == 2
                    && m.GetParameters().Length == 2);

            return new AsyncMethodBuilderInfo(
                kind,
                builderType,
                resultType,
                create,
                taskProperty: null,
                startMethod: moveNext,
                setStateMachineMethod: null,
                setResultMethod: null,
                setExceptionMethod: null,
                awaitOnCompletedMethod: awaitOnCompletedIter,
                awaitUnsafeOnCompletedMethod: awaitUnsafeOnCompletedIter);
        }

        var task = builderType.GetProperty(
            "Task",
            BindingFlags.Public | BindingFlags.Instance);

        // SetResult: no-arg for void / Task, single-arg for generic.
        MethodInfo setResult;
        if (kind == AsyncMethodBuilderKind.GenericTask
            || (kind == AsyncMethodBuilderKind.Custom && resultType != null && resultType != typeof(void)))
        {
            setResult = builderType.GetMethod("SetResult", new[] { resultType });
        }
        else
        {
            setResult = builderType.GetMethod("SetResult", Type.EmptyTypes);
        }

        var setException = builderType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(m =>
                m.Name == "SetException"
                && m.GetParameters().Length == 1
                && m.GetParameters()[0].ParameterType.FullName == "System.Exception");

        var setStateMachine = builderType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(m =>
                m.Name == "SetStateMachine"
                && m.GetParameters().Length == 1
                && m.GetParameters()[0].ParameterType.FullName == "System.Runtime.CompilerServices.IAsyncStateMachine");

        var start = builderType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(m =>
                m.Name == "Start"
                && m.IsGenericMethodDefinition
                && m.GetParameters().Length == 1);

        var awaitOnCompleted = builderType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(m =>
                m.Name == "AwaitOnCompleted"
                && m.IsGenericMethodDefinition
                && m.GetGenericArguments().Length == 2
                && m.GetParameters().Length == 2);

        var awaitUnsafeOnCompleted = builderType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(m =>
                m.Name == "AwaitUnsafeOnCompleted"
                && m.IsGenericMethodDefinition
                && m.GetGenericArguments().Length == 2
                && m.GetParameters().Length == 2);

        return new AsyncMethodBuilderInfo(
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
            awaitUnsafeOnCompleted);
    }
}
