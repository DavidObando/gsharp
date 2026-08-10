// <copyright file="BclMember.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Reflection lookups for members of well-known BCL types the emitter lowers
/// against — <c>Channel&lt;T&gt;</c>, <c>Task</c>, <c>ValueTask&lt;T&gt;</c>,
/// <c>CancellationToken</c>, the async-method-builder shapes, and so on.
/// </summary>
/// <remarks>
/// <para>
/// Every lookup here asserts rather than returns null. The member's absence
/// would mean the target framework's core library does not declare a member
/// the language's own lowering is defined in terms of — malformed metadata,
/// not a condition any emit path can recover from. Asserting at the lookup
/// states that once, instead of at each of the ~50 emit sites that consume a
/// result.
/// </para>
/// <para>
/// This is deliberately NOT the right tool for a lookup that can legitimately
/// miss: a record's protected copy constructor (invisible to the public-only
/// <see cref="Type.GetConstructor(Type[])"/>), or an imported type that may or
/// may not declare a parameterless constructor. Those keep their own null test
/// and their own diagnostic.
/// </para>
/// </remarks>
internal static class BclMember
{
    /// <summary>
    /// Reads a property's public getter off a BCL type.
    /// </summary>
    /// <param name="carrier">The (possibly constructed) BCL type, e.g. <c>Channel&lt;T&gt;</c>.</param>
    /// <param name="propertyName">The property whose getter is wanted.</param>
    /// <returns>The getter.</returns>
    public static MethodInfo Getter(Type carrier, string propertyName)
        => Invariant.Required(
            Invariant.Required(
                carrier.GetProperty(propertyName),
                $"{carrier.Name} declares the {propertyName} property").GetGetMethod(),
            $"{carrier.Name}.{propertyName} declares a public getter");

    /// <summary>
    /// Reads a constructor off a BCL type.
    /// </summary>
    /// <param name="carrier">The BCL type.</param>
    /// <param name="parameterTypes">The constructor's parameter types.</param>
    /// <returns>The constructor.</returns>
    public static ConstructorInfo Ctor(Type carrier, params Type[] parameterTypes)
        => Invariant.Required(
            carrier.GetConstructor(parameterTypes),
            $"{carrier.Name} declares a constructor with the expected signature");

    /// <summary>
    /// Reads a method off a BCL type by name.
    /// </summary>
    /// <remarks>
    /// This overload exists so that naming no parameter types keeps meaning
    /// "the method called <paramref name="methodName"/>", as
    /// <see cref="Type.GetMethod(string)"/> does. Routing that through the
    /// <c>params</c> overload below would silently ask for the PARAMETERLESS
    /// overload instead (<c>Type.EmptyTypes</c>), which is a different
    /// question and returns null for a method that takes arguments.
    /// </remarks>
    /// <param name="carrier">The (possibly constructed) BCL type.</param>
    /// <param name="methodName">The method name.</param>
    /// <returns>The method.</returns>
    public static MethodInfo Method(Type carrier, string methodName)
        => Invariant.Required(
            carrier.GetMethod(methodName),
            $"{carrier.Name} declares {methodName}");

    /// <summary>
    /// Reads the overload of a BCL type's method with a given signature.
    /// </summary>
    /// <param name="carrier">The (possibly constructed) BCL type.</param>
    /// <param name="methodName">The method name.</param>
    /// <param name="parameterTypes">The method's parameter types. Pass none to
    /// request the parameterless overload specifically.</param>
    /// <returns>The method.</returns>
    public static MethodInfo Method(Type carrier, string methodName, params Type[] parameterTypes)
        => Invariant.Required(
            carrier.GetMethod(methodName, parameterTypes),
            $"{carrier.Name} declares {methodName} with the expected signature");

    /// <summary>
    /// Reads a field off a BCL type.
    /// </summary>
    /// <param name="carrier">The BCL type.</param>
    /// <param name="fieldName">The field name.</param>
    /// <returns>The field.</returns>
    public static FieldInfo Field(Type carrier, string fieldName)
        => Invariant.Required(
            carrier.GetField(fieldName),
            $"{carrier.Name} declares the {fieldName} field");
}
