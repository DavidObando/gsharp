// <copyright file="BclMember.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import System
import System.Reflection

/// Reflection lookups for members of well-known BCL types the emitter lowers
/// against — `Channel<T>`, `Task`, `ValueTask<T>`,
/// `CancellationToken`, the async-method-builder shapes, and so on.
/// @remarks Every lookup here asserts rather than returns null. The member's absence
/// would mean the target framework's core library does not declare a member
/// the language's own lowering is defined in terms of — malformed metadata,
/// not a condition any emit path can recover from. Asserting at the lookup
/// states that once, instead of at each of the ~50 emit sites that consume a
/// result.
///
/// This is deliberately NOT the right tool for a lookup that can legitimately
/// miss: a record's protected copy constructor (invisible to the public-only
/// (cref:Type.GetConstructor(Type[]))), or an imported type that may or
/// may not declare a parameterless constructor. Those keep their own null test
/// and their own diagnostic.
internal shared class BclMember {
    /// Reads a property's public getter off a BCL type.
    /// @param carrier The (possibly constructed) BCL type, e.g. `Channel<T>`.
    /// @param propertyName The property whose getter is wanted.
    /// @returns The getter.
    func Getter(carrier Type, propertyName string) MethodInfo -> Invariant.Required(
        Invariant.Required(
            carrier.GetProperty(propertyName),
            "${carrier.Name} declares the $propertyName property",
            expression: "carrier.GetProperty(propertyName)"
        )
            .GetGetMethod(),
        "${carrier.Name}.$propertyName declares a public getter",
        expression: `Invariant.Required(
                carrier.GetProperty(propertyName),
                $"{carrier.Name} declares the {propertyName} property").GetGetMethod()`
    )

    /// Reads a constructor off a BCL type.
    /// @param carrier The BCL type.
    /// @param parameterTypes The constructor's parameter types.
    /// @returns The constructor.
    func Ctor(carrier Type, parameterTypes ...Type) ConstructorInfo -> Invariant.Required(
        carrier.GetConstructor(parameterTypes),
        "${carrier.Name} declares a constructor with the expected signature",
        expression: "carrier.GetConstructor(parameterTypes)"
    )

    /// Reads a method off a BCL type by name.
    /// @remarks This overload exists so that naming no parameter types keeps meaning
    /// "the method called [`methodName`](paramref)", as
    /// (cref:Type.GetMethod(string)) does. Routing that through the
    /// `params` overload below would silently ask for the PARAMETERLESS
    /// overload instead (`Type.EmptyTypes`), which is a different
    /// question and returns null for a method that takes arguments.
    /// @param carrier The (possibly constructed) BCL type.
    /// @param methodName The method name.
    /// @returns The method.
    func Method(carrier Type, methodName string) MethodInfo -> Invariant.Required(
        carrier.GetMethod(methodName),
        "${carrier.Name} declares $methodName",
        expression: "carrier.GetMethod(methodName)"
    )

    /// Reads the overload of a BCL type's method with a given signature.
    /// @param carrier The (possibly constructed) BCL type.
    /// @param methodName The method name.
    /// @param parameterTypes The method's parameter types. Pass none to
    /// request the parameterless overload specifically.
    /// @returns The method.
    func Method(carrier Type, methodName string, parameterTypes ...Type) MethodInfo -> Invariant.Required(
        carrier.GetMethod(methodName, parameterTypes),
        "${carrier.Name} declares $methodName with the expected signature",
        expression: "carrier.GetMethod(methodName, parameterTypes)"
    )

    /// Reads a field off a BCL type.
    /// @param carrier The BCL type.
    /// @param fieldName The field name.
    /// @returns The field.
    func Field(carrier Type, fieldName string) FieldInfo -> Invariant.Required(
        carrier.GetField(fieldName),
        "${carrier.Name} declares the $fieldName field",
        expression: "carrier.GetField(fieldName)"
    )
}
